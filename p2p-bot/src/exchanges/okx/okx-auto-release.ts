// =====================================================
// OKX AUTO RELEASE ORCHESTRATOR
// Verification pipeline + crypto release for OKX
// NO TOTP, NO chat integration — simpler than Binance
// =====================================================

import { EventEmitter } from 'events';
import { OkxOrderManager, OkxOrderManagerConfig } from './okx-order-manager.js';
import { getOkxClient, OkxClient } from './okx-client.js';
import { logger } from '../../utils/logger.js';
import * as db from '../../services/database-pg.js';
import {
  OrderData,
  BankWebhookPayload,
  OrderMatch,
  VerificationStatus,
  OkxOrderEvent,
  OkxReleaseEvent,
} from './okx-types.js';

const log = logger.child({ module: 'okx-release' });

// ==================== CONFIG ====================

export interface OkxAutoReleaseConfig {
  enableAutoRelease: boolean;
  requireBankMatch: boolean;
  enableBuyerRiskCheck: boolean;
  skipRiskCheckThreshold: number;
  minConfidence: number;
  releaseDelayMs: number;
  maxAutoReleaseAmount: number;
}

// ==================== PENDING RELEASE ====================

interface PendingRelease {
  orderNumber: string;
  order: OrderData;
  bankMatch?: BankWebhookPayload;
  nameVerified: boolean;
  queuedAt: Date;
  attempts: number;
  isTrustedBuyer: boolean;
  riskCheckPassed: boolean;
}

// ==================== BUYER RISK CONFIG ====================

interface OkxBuyerRiskConfig {
  minTotalOrders: number;
  min30DayOrders: number;
  minCompletionRate: number;
  maxAutoReleaseAmount: number;
}

// ==================== AUTO RELEASE ====================

export class OkxAutoRelease extends EventEmitter {
  private config: OkxAutoReleaseConfig;
  private orderManager: OkxOrderManager;
  private okxClient: OkxClient;

  private pendingReleases: Map<string, PendingRelease> = new Map();
  private releaseQueue: string[] = [];
  private processing = false;
  private processingOrders: Set<string> = new Set();
  private loggedBlockedOrders: Map<string, string> = new Map();
  private lastCheckTime: Map<string, number> = new Map();
  private readonly CHECK_THROTTLE_MS = 5000;

  private riskConfig: OkxBuyerRiskConfig;

  constructor(
    config: OkxAutoReleaseConfig,
    orderManager: OkxOrderManager
  ) {
    super();
    this.config = config;
    this.orderManager = orderManager;
    this.okxClient = getOkxClient();

    this.riskConfig = {
      minTotalOrders: parseInt(process.env.MIN_BUYER_TOTAL_ORDERS || '100'),
      min30DayOrders: parseInt(process.env.MIN_BUYER_30DAY_ORDERS || '15'),
      minCompletionRate: parseFloat(process.env.MIN_BUYER_POSITIVE_RATE || '0.85'),
      maxAutoReleaseAmount: config.maxAutoReleaseAmount,
    };

    this.setupEventListeners();

    log.info({
      enableAutoRelease: config.enableAutoRelease,
      maxAmount: config.maxAutoReleaseAmount,
      requireBankMatch: config.requireBankMatch,
      buyerRiskCheck: config.enableBuyerRiskCheck,
    }, 'OKX Auto-Release initialized');
  }

  // ==================== EVENT SETUP ====================

  private setupEventListeners(): void {
    // Order events from OKX order manager
    this.orderManager.on('order', (event: OkxOrderEvent) => {
      this.handleOrderEvent(event);
    });
  }

  /**
   * Connect to webhook receiver for bank payment events
   * Called externally from okx-index.ts to avoid circular deps
   */
  connectWebhook(webhookEmitter: EventEmitter): void {
    webhookEmitter.on('payment', (event: { payload: BankWebhookPayload }) => {
      this.handleBankPayment(event.payload);
    });

    webhookEmitter.on('reversal', (event: { payload: BankWebhookPayload }) => {
      this.handleBankReversal(event.payload);
    });

    log.info('OKX Auto-Release connected to webhook receiver');
  }

  // ==================== ORDER EVENTS ====================

  private async handleOrderEvent(event: OkxOrderEvent): Promise<void> {
    switch (event.type) {
      case 'new':
        // Track new order
        log.info({ orderId: event.order.orderNumber, amount: event.order.totalPrice }, 'OKX new order - tracking');
        break;

      case 'paid':
        // Buyer marked as paid — start verification pipeline
        await this.startVerification(event.order);
        break;

      case 'released':
      case 'cancelled':
        // Clean up
        this.pendingReleases.delete(event.order.orderNumber);
        this.processingOrders.delete(event.order.orderNumber);
        this.loggedBlockedOrders.delete(event.order.orderNumber);
        break;

      case 'matched':
        // Bank payment matched to order
        if (event.match?.bankTransactionId) {
          const pending = this.pendingReleases.get(event.order.orderNumber);
          if (pending) {
            await this.checkReadyForRelease(event.order.orderNumber);
          }
        }
        break;
    }
  }

  // ==================== VERIFICATION PIPELINE ====================

  private async startVerification(order: OrderData): Promise<void> {
    const orderNumber = order.orderNumber;

    if (!this.config.enableAutoRelease) {
      log.info({ orderId: orderNumber }, 'OKX auto-release disabled — manual release required');
      return;
    }

    const orderAmount = parseFloat(order.totalPrice);
    if (orderAmount > this.config.maxAutoReleaseAmount) {
      log.warn({
        orderId: orderNumber,
        amount: orderAmount,
        max: this.config.maxAutoReleaseAmount,
      }, 'OKX order exceeds max auto-release amount — manual review');
      this.emitRelease('manual_required', orderNumber, 'Amount exceeds limit');
      return;
    }

    // Create or update pending release
    let pending = this.pendingReleases.get(orderNumber);
    if (!pending) {
      pending = {
        orderNumber,
        order,
        nameVerified: false,
        queuedAt: new Date(),
        attempts: 0,
        isTrustedBuyer: false,
        riskCheckPassed: false,
      };
      this.pendingReleases.set(orderNumber, pending);
    }

    this.emitRelease('verification_started', orderNumber);

    // Save verification step
    try {
      await db.addVerificationStep(
        orderNumber,
        VerificationStatus.BUYER_MARKED_PAID,
        'Buyer marked as paid on OKX',
        { exchange: 'okx', amount: orderAmount }
      );
    } catch { /* non-critical */ }

    // Check if we already have a bank match from webhook
    await this.tryMatchExistingPayments(order);

    // Check readiness
    await this.checkReadyForRelease(orderNumber);
  }

  // ==================== BANK PAYMENT HANDLING ====================

  private async handleBankPayment(payment: BankWebhookPayload): Promise<void> {
    log.info({
      transactionId: payment.transactionId,
      amount: payment.amount,
      sender: payment.senderName,
    }, 'OKX: Processing bank payment');

    // Try to match to a pending OKX order
    for (const [orderNumber, pending] of this.pendingReleases) {
      if (pending.bankMatch) continue; // Already matched

      const order = pending.order;
      if (order.orderStatus !== 'BUYER_PAYED') continue;

      const expectedAmount = parseFloat(order.totalPrice);
      const tolerance = expectedAmount * 0.01; // 1% tolerance
      const amountDiff = Math.abs(expectedAmount - payment.amount);

      if (amountDiff <= tolerance) {
        log.info({
          orderId: orderNumber,
          expected: expectedAmount,
          received: payment.amount,
          sender: payment.senderName,
        }, 'OKX: Bank payment matched to order');

        pending.bankMatch = payment;

        // Save match to DB
        try {
          await db.addVerificationStep(
            orderNumber,
            VerificationStatus.PAYMENT_MATCHED,
            `Bank payment matched: $${payment.amount} from ${payment.senderName}`,
            { transactionId: payment.transactionId, sender: payment.senderName }
          );
        } catch { /* non-critical */ }

        // Verify name
        await this.verifyName(pending);

        // Check readiness
        await this.checkReadyForRelease(orderNumber);
        return;
      }
    }

    log.debug({ amount: payment.amount, sender: payment.senderName }, 'OKX: No matching order for payment');
  }

  private handleBankReversal(payment: BankWebhookPayload): void {
    // Find order matched to this payment
    for (const [orderNumber, pending] of this.pendingReleases) {
      if (pending.bankMatch?.transactionId === payment.transactionId) {
        log.warn({ orderId: orderNumber, transactionId: payment.transactionId }, 'OKX: Bank reversal detected!');
        pending.bankMatch = undefined;
        pending.nameVerified = false;
        this.releaseQueue = this.releaseQueue.filter(id => id !== orderNumber);
        break;
      }
    }
  }

  /**
   * Try to match existing payments (already in DB) to a new order
   */
  private async tryMatchExistingPayments(order: OrderData): Promise<void> {
    const pending = this.pendingReleases.get(order.orderNumber);
    if (!pending || pending.bankMatch) return;

    try {
      const expectedAmount = parseFloat(order.totalPrice);
      // Search for recent unmatched payments within tolerance
      const recentPayments = await db.findUnmatchedPaymentsByAmount(expectedAmount, 1);

      if (recentPayments.length > 0) {
        const payment = recentPayments[0];
        log.info({
          orderId: order.orderNumber,
          paymentId: payment.transactionId,
          amount: payment.amount,
          sender: payment.senderName,
        }, 'OKX: Found existing bank payment match');

        pending.bankMatch = payment as unknown as BankWebhookPayload;
        await this.verifyName(pending);
      }
    } catch (error) {
      log.debug({ error }, 'OKX: Could not search existing payments');
    }
  }

  // ==================== NAME VERIFICATION ====================

  private async verifyName(pending: PendingRelease): Promise<void> {
    if (!pending.bankMatch) return;

    const senderName = pending.bankMatch.senderName || '';
    const buyerRealName = pending.order.buyer?.realName || '';

    if (!senderName || !buyerRealName) {
      log.warn({
        orderId: pending.orderNumber,
        senderName: senderName || '(empty)',
        buyerRealName: buyerRealName || '(empty)',
      }, 'OKX: Cannot verify name — missing data');
      pending.nameVerified = false;
      return;
    }

    const score = this.compareNames(senderName, buyerRealName);
    pending.nameVerified = score >= 0.70;

    log.info({
      orderId: pending.orderNumber,
      senderName,
      buyerRealName,
      score: (score * 100).toFixed(0) + '%',
      passed: pending.nameVerified,
    }, 'OKX: Name verification result');

    // Save to DB
    const status = pending.nameVerified ? VerificationStatus.NAME_VERIFIED : VerificationStatus.NAME_MISMATCH;
    try {
      await db.addVerificationStep(
        pending.orderNumber,
        status,
        `Name comparison: "${senderName}" vs "${buyerRealName}" = ${(score * 100).toFixed(0)}%`,
        { senderName, buyerRealName, score }
      );
    } catch { /* non-critical */ }
  }

  /**
   * Compare two names with accent normalization and word matching
   * Same algorithm as Binance auto-release (70% threshold)
   */
  private compareNames(name1: string, name2: string): number {
    if (!name1 || !name2) return 0;

    const normalize = (s: string) => {
      return s
        .toLowerCase()
        .trim()
        .replace(/[,\/\.\-\_\|]/g, ' ')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ñ/g, 'n')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const n1 = normalize(name1);
    const n2 = normalize(name2);

    if (n1 === n2) return 1;
    if (n1.includes(n2) || n2.includes(n1)) return 0.8;

    const words1 = new Set(n1.split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(n2.split(/\s+/).filter(w => w.length > 2));

    let matches = 0;
    for (const word of words1) {
      if (words2.has(word)) {
        matches++;
      } else {
        for (const word2 of words2) {
          if (word.length >= 6 && word2.length >= 6) {
            if (word.startsWith(word2) || word2.startsWith(word)) {
              matches++;
              break;
            }
          }
        }
      }
    }

    const totalWords = Math.max(words1.size, words2.size);
    return totalWords > 0 ? matches / totalWords : 0;
  }

  // ==================== BUYER RISK ASSESSMENT ====================

  private async assessBuyerRisk(pending: PendingRelease): Promise<boolean> {
    if (!this.config.enableBuyerRiskCheck) return true;

    const orderAmount = parseFloat(pending.order.totalPrice);
    if (orderAmount <= this.config.skipRiskCheckThreshold) return true;

    // OKX provides counterparty stats inline in order data
    const buyer = pending.order.buyer;
    if (!buyer) {
      log.warn({ orderId: pending.orderNumber }, 'OKX: No buyer info for risk check');
      return false;
    }

    const failedCriteria: string[] = [];

    const totalOrders = buyer.monthOrderCount || 0;
    const completionRate = buyer.monthFinishRate || 0;

    if (totalOrders < this.riskConfig.minTotalOrders) {
      failedCriteria.push(`Orders ${totalOrders} < ${this.riskConfig.minTotalOrders}`);
    }
    if (completionRate < this.riskConfig.minCompletionRate) {
      failedCriteria.push(`Rate ${(completionRate * 100).toFixed(1)}% < ${(this.riskConfig.minCompletionRate * 100).toFixed(0)}%`);
    }
    if (orderAmount > this.riskConfig.maxAutoReleaseAmount) {
      failedCriteria.push(`Amount $${orderAmount} > $${this.riskConfig.maxAutoReleaseAmount}`);
    }

    const isTrusted = failedCriteria.length === 0;

    if (isTrusted) {
      log.info({ orderId: pending.orderNumber, totalOrders, completionRate }, 'OKX: Buyer risk check PASSED');
    } else {
      log.warn({
        orderId: pending.orderNumber,
        totalOrders,
        completionRate,
        failures: failedCriteria,
      }, 'OKX: Buyer risk check FAILED');
    }

    return isTrusted;
  }

  /**
   * Check trusted buyer status (by userId)
   */
  private async checkTrustedBuyer(pending: PendingRelease): Promise<boolean> {
    const buyerUserNo = pending.order.buyer?.userNo;
    const buyerNickName = pending.order.counterPartNickName || pending.order.buyer?.nickName || '';
    const buyerRealName = pending.order.buyer?.realName || null;

    if (!buyerUserNo && !buyerNickName) return false;

    try {
      const isTrusted = await db.isTrustedBuyer(buyerNickName, buyerRealName || null, buyerUserNo || null);
      if (isTrusted) {
        log.info({
          orderId: pending.orderNumber,
          buyerNickName,
          buyerUserNo,
        }, 'OKX: Trusted buyer detected');
      }
      return isTrusted;
    } catch {
      return false;
    }
  }

  // ==================== RELEASE CHECK ====================

  private async checkReadyForRelease(orderNumber: string): Promise<void> {
    // Throttle
    const now = Date.now();
    const lastCheck = this.lastCheckTime.get(orderNumber) || 0;
    if (now - lastCheck < this.CHECK_THROTTLE_MS) return;
    this.lastCheckTime.set(orderNumber, now);

    const pending = this.pendingReleases.get(orderNumber);
    if (!pending) return;

    if (this.processingOrders.has(orderNumber)) return;

    // Kill switch check
    try {
      const releaseEnabled = await db.isReleaseEnabled();
      if (!releaseEnabled) {
        if (!this.loggedBlockedOrders.has(orderNumber)) {
          log.warn({ orderId: orderNumber }, 'OKX: Release kill switch is OFF');
          this.loggedBlockedOrders.set(orderNumber, 'kill_switch');
        }
        return;
      }
    } catch { /* continue */ }

    const hasBankMatch = !!pending.bankMatch;
    const hasNameVerified = pending.nameVerified;

    // Require bank match if configured
    if (this.config.requireBankMatch && !hasBankMatch) {
      if (!this.loggedBlockedOrders.has(orderNumber)) {
        log.info({ orderId: orderNumber }, 'OKX: Waiting for bank payment match');
        this.loggedBlockedOrders.set(orderNumber, 'no_bank_match');
      }
      return;
    }

    // Name must match if bank match exists
    if (hasBankMatch && !hasNameVerified) {
      // Check trusted buyer bypass
      const isTrusted = await this.checkTrustedBuyer(pending);
      pending.isTrustedBuyer = isTrusted;

      if (!isTrusted) {
        if (!this.loggedBlockedOrders.has(orderNumber)) {
          log.warn({
            orderId: orderNumber,
            senderName: pending.bankMatch?.senderName,
            buyerName: pending.order.buyer?.realName,
          }, 'OKX: Name mismatch — manual review needed');
          this.loggedBlockedOrders.set(orderNumber, 'name_mismatch');
          this.emitRelease('manual_required', orderNumber, 'Name mismatch between bank sender and OKX buyer');
        }
        return;
      }
    }

    // Buyer risk check
    if (!pending.riskCheckPassed && !pending.isTrustedBuyer) {
      const passed = await this.assessBuyerRisk(pending);
      pending.riskCheckPassed = passed;

      if (!passed) {
        this.emitRelease('manual_required', orderNumber, 'Buyer failed risk assessment');
        return;
      }
    }

    // All checks passed — queue for release
    log.info({ orderId: orderNumber }, 'OKX: All checks passed — queuing for release');

    try {
      await db.addVerificationStep(
        orderNumber,
        VerificationStatus.READY_TO_RELEASE,
        'All verification checks passed',
        { nameVerified: hasNameVerified, bankMatch: hasBankMatch, trusted: pending.isTrustedBuyer }
      );
    } catch { /* non-critical */ }

    if (!this.releaseQueue.includes(orderNumber)) {
      this.releaseQueue.push(orderNumber);
      this.emitRelease('release_queued', orderNumber);

      setTimeout(
        () => this.processReleaseQueue(),
        this.config.releaseDelayMs
      );
    }
  }

  // ==================== RELEASE EXECUTION ====================

  private async processReleaseQueue(): Promise<void> {
    if (this.processing || this.releaseQueue.length === 0) return;

    this.processing = true;
    try {
      while (this.releaseQueue.length > 0) {
        const orderNumber = this.releaseQueue.shift()!;
        await this.executeRelease(orderNumber);
        await new Promise(r => setTimeout(r, 1000));
      }
    } finally {
      this.processing = false;
    }
  }

  private async executeRelease(orderNumber: string): Promise<void> {
    // Kill switch check
    try {
      const releaseEnabled = await db.isReleaseEnabled();
      if (!releaseEnabled) {
        log.warn({ orderId: orderNumber }, 'OKX: Release blocked by kill switch');
        return;
      }
    } catch { /* continue */ }

    const pending = this.pendingReleases.get(orderNumber);
    if (!pending) return;

    if (this.processingOrders.has(orderNumber)) return;
    this.processingOrders.add(orderNumber);

    pending.attempts++;

    log.info({
      orderId: orderNumber,
      amount: pending.order.totalPrice,
      attempt: pending.attempts,
    }, 'OKX: Executing crypto release');

    try {
      // OKX release — NO TOTP needed, just verificationType="2"
      await this.okxClient.releaseCrypto(orderNumber);

      log.info({
        orderId: orderNumber,
        amount: pending.order.totalPrice,
        asset: pending.order.asset,
      }, 'OKX: Crypto released successfully!');

      // Record in DB
      try {
        await db.addVerificationStep(
          orderNumber,
          VerificationStatus.RELEASED,
          'Crypto released via OKX auto-release',
          {
            exchange: 'okx',
            amount: pending.order.totalPrice,
            bankTx: pending.bankMatch?.transactionId,
            attempt: pending.attempts,
          }
        );
      } catch { /* non-critical */ }

      // Update trusted buyer stats
      try {
        const buyerNickName = pending.order.counterPartNickName || pending.order.buyer?.nickName || '';
        const buyerRealName = pending.order.buyer?.realName || null;
        const buyerUserNo = pending.order.buyer?.userNo || null;

        if (buyerUserNo) {
          const isTrusted = await db.isTrustedBuyer(buyerNickName, buyerRealName, buyerUserNo);
          if (isTrusted) {
            const orderAmount = parseFloat(pending.order.totalPrice);
            await db.incrementTrustedBuyerStats(buyerUserNo, orderAmount);
          }
        }
      } catch { /* non-critical */ }

      this.emitRelease('release_success', orderNumber, undefined, {
        amount: pending.order.totalPrice,
        asset: pending.order.asset,
      });

      // Cleanup
      this.pendingReleases.delete(orderNumber);
      this.loggedBlockedOrders.delete(orderNumber);

    } catch (error: any) {
      const errorMsg = error.message || 'Unknown error';

      log.error({
        orderId: orderNumber,
        error: errorMsg,
        attempt: pending.attempts,
      }, 'OKX: Release failed');

      // Check if retryable
      const isNonRetryable = this.isNonRetryableError(errorMsg);

      if (isNonRetryable || pending.attempts >= 3) {
        log.error({ orderId: orderNumber, attempts: pending.attempts }, 'OKX: Release failed permanently');
        this.emitRelease('release_failed', orderNumber, errorMsg);
        this.pendingReleases.delete(orderNumber);
      } else {
        // Retry
        log.info({ orderId: orderNumber, nextAttempt: pending.attempts + 1 }, 'OKX: Will retry release');
        this.releaseQueue.push(orderNumber);
        setTimeout(() => this.processReleaseQueue(), 5000);
      }
    } finally {
      this.processingOrders.delete(orderNumber);
    }
  }

  private isNonRetryableError(errorMsg: string): boolean {
    const nonRetryable = [
      'order already completed',
      'order already cancelled',
      'order not found',
      'order status error',
    ];
    const msgLower = errorMsg.toLowerCase();
    return nonRetryable.some(m => msgLower.includes(m));
  }

  // ==================== HELPERS ====================

  private emitRelease(type: OkxReleaseEvent['type'], orderNumber: string, reason?: string, data?: any): void {
    this.emit('release', { type, orderNumber, reason, data } as OkxReleaseEvent);
  }

  getStatus() {
    return {
      pendingReleases: this.pendingReleases.size,
      releaseQueue: this.releaseQueue.length,
      processing: this.processing,
    };
  }
}

// ==================== FACTORY ====================

export function createOkxAutoRelease(
  config: Partial<OkxAutoReleaseConfig>,
  orderManager: OkxOrderManager
): OkxAutoRelease {
  const defaultConfig: OkxAutoReleaseConfig = {
    enableAutoRelease: process.env.OKX_ENABLE_AUTO_RELEASE === 'true',
    requireBankMatch: process.env.OKX_REQUIRE_BANK_MATCH !== 'false',
    enableBuyerRiskCheck: process.env.OKX_ENABLE_BUYER_RISK_CHECK !== 'false',
    skipRiskCheckThreshold: parseFloat(process.env.OKX_SKIP_RISK_THRESHOLD || '500'),
    minConfidence: 0.8,
    releaseDelayMs: parseInt(process.env.OKX_RELEASE_DELAY_MS || '2000'),
    maxAutoReleaseAmount: parseFloat(process.env.OKX_MAX_AUTO_RELEASE_AMOUNT || '50000'),
  };

  return new OkxAutoRelease({ ...defaultConfig, ...config }, orderManager);
}
