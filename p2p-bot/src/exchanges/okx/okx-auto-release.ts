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

    // STEP 1: Try to match in-memory (pendingReleases — orders already PAID)
    for (const [orderNumber, pending] of this.pendingReleases) {
      if (pending.bankMatch) continue;

      const order = pending.order;
      if (order.orderStatus !== 'BUYER_PAYED') continue;

      const expectedAmount = parseFloat(order.totalPrice);
      const tolerance = expectedAmount * 0.01;
      const amountDiff = Math.abs(expectedAmount - payment.amount);

      if (amountDiff <= tolerance) {
        log.info({
          orderId: orderNumber,
          expected: expectedAmount,
          received: payment.amount,
          sender: payment.senderName,
        }, 'OKX: Bank payment matched to order (in-memory)');

        const matched = await this.matchAndVerifyPayment(pending, payment);
        if (matched) return;
      }
    }

    // STEP 2: Smart match — search DB for order by amount AND buyer name
    // This handles the case where payment arrives BEFORE buyer marks as paid
    try {
      const smartMatch = await db.findOrderByAmountAndName(
        payment.amount,
        payment.senderName,
        1 // 1% tolerance
      );

      if (smartMatch) {
        log.info({
          orderNumber: smartMatch.orderNumber,
          transactionId: payment.transactionId,
          buyerRealName: smartMatch.buyerRealName,
          nameMatchScore: smartMatch.nameMatchScore,
        }, 'OKX: Smart match — payment matched by amount AND name in DB');

        // Match payment in DB
        const matchSuccess = await db.matchPaymentToOrder(
          payment.transactionId,
          smartMatch.orderNumber,
          'BANK_WEBHOOK'
        );

        if (!matchSuccess) {
          log.warn({ transactionId: payment.transactionId }, 'OKX: Smart match payment could not be matched in DB');
          return;
        }

        try {
          await db.addVerificationStep(
            smartMatch.orderNumber,
            VerificationStatus.PAYMENT_MATCHED,
            `Smart match: $${payment.amount} from ${payment.senderName} (${(smartMatch.nameMatchScore * 100).toFixed(0)}%)`,
            { transactionId: payment.transactionId, sender: payment.senderName, matchType: 'smart_match' }
          );
        } catch { /* non-critical */ }

        // If order is already in pendingReleases, update it
        const pending = this.pendingReleases.get(smartMatch.orderNumber);
        if (pending) {
          pending.bankMatch = payment;
          await this.verifyName(pending);
          await this.checkReadyForRelease(smartMatch.orderNumber);
        } else {
          // Order not yet PAID in memory — it will pick up the matched payment via tryMatchExistingPayments
          log.info({ orderNumber: smartMatch.orderNumber }, 'OKX: Payment pre-matched — will auto-link when order becomes PAID');
        }
        return;
      }
    } catch (error) {
      log.error({ error }, 'OKX: Error during smart payment matching');
    }

    // STEP 3: Check if sender is a KNOWN buyer in any open order
    // If known → keep as PENDING (will match later when order becomes PAID)
    // If unknown → mark as THIRD_PARTY
    try {
      const knownBuyerCheck = await db.hasOrderWithMatchingBuyerName(payment.senderName, 0.3);

      if (knownBuyerCheck.hasMatch) {
        log.info({
          transactionId: payment.transactionId,
          amount: payment.amount,
          sender: payment.senderName,
          potentialOrders: knownBuyerCheck.matchedOrders?.map((o: any) => ({
            orderNumber: o.orderNumber,
            buyerRealName: o.buyerRealName,
          })),
        }, 'OKX: Payment from known buyer — keeping as PENDING for later match');
        // Payment stays as PENDING in DB — will be found by tryMatchExistingPayments
        return;
      }
    } catch (error) {
      log.error({ error, transactionId: payment.transactionId }, 'OKX: Error checking known buyer');
      // On error, keep as PENDING for safety
      return;
    }

    // STEP 4: Sender is NOT a known buyer — mark as THIRD_PARTY
    log.warn({
      amount: payment.amount,
      sender: payment.senderName,
      transactionId: payment.transactionId,
    }, 'OKX: Payment sender not recognized — marking as THIRD_PARTY');

    try {
      await db.markPaymentAsThirdParty(
        payment.transactionId,
        `Sender "${payment.senderName}" does not match any buyer in open orders`
      );
      await db.createAlert({
        type: 'third_party_payment',
        severity: 'warning',
        title: 'Pago de Tercero Detectado (OKX)',
        message: `Pago de $${payment.amount} de "${payment.senderName}" no coincide con ningún comprador conocido`,
        metadata: {
          exchange: 'okx',
          transactionId: payment.transactionId,
          amount: payment.amount,
          senderName: payment.senderName,
        },
      });
    } catch { /* non-critical */ }
  }

  /**
   * Helper: match a payment to a pending order, verify name, and check readiness
   */
  private async matchAndVerifyPayment(pending: PendingRelease, payment: BankWebhookPayload): Promise<boolean> {
    pending.bankMatch = payment;

    try {
      const matched = await db.matchPaymentToOrder(
        payment.transactionId,
        pending.orderNumber,
        'BANK_WEBHOOK'
      );
      if (!matched) {
        log.warn({
          orderId: pending.orderNumber,
          transactionId: payment.transactionId,
        }, 'OKX: Payment could not be matched in DB (already used?) — blocking release');
        pending.bankMatch = undefined;
        return false;
      }
    } catch (matchError) {
      log.error({ error: matchError, orderId: pending.orderNumber }, 'OKX: Failed to match payment in DB');
    }

    try {
      await db.addVerificationStep(
        pending.orderNumber,
        VerificationStatus.PAYMENT_MATCHED,
        `Bank payment matched: $${payment.amount} from ${payment.senderName}`,
        { transactionId: payment.transactionId, sender: payment.senderName }
      );
    } catch { /* non-critical */ }

    await this.verifyName(pending);
    await this.checkReadyForRelease(pending.orderNumber);
    return true;
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
   * Searches PENDING payments first, then THIRD_PARTY (may have been mis-classified due to timing)
   */
  private async tryMatchExistingPayments(order: OrderData): Promise<void> {
    const pending = this.pendingReleases.get(order.orderNumber);
    if (!pending || pending.bankMatch) return;

    try {
      const expectedAmount = parseFloat(order.totalPrice);

      // First: search for PENDING unmatched payments within tolerance
      let recentPayments = await db.findUnmatchedPaymentsByAmount(expectedAmount, 1);

      // Second: if no PENDING found, also check THIRD_PARTY payments (race condition recovery)
      if (recentPayments.length === 0) {
        try {
          recentPayments = await db.findThirdPartyPaymentsByAmount(expectedAmount, 1);
          if (recentPayments.length > 0) {
            log.info({
              orderId: order.orderNumber,
              paymentId: recentPayments[0].transactionId,
            }, 'OKX: Recovering THIRD_PARTY payment that arrived before PAID status');
          }
        } catch {
          // findThirdPartyPaymentsByAmount may not exist yet — fall through
        }
      }

      if (recentPayments.length > 0) {
        const payment = recentPayments[0];
        log.info({
          orderId: order.orderNumber,
          paymentId: payment.transactionId,
          amount: payment.amount,
          sender: payment.senderName,
        }, 'OKX: Found existing bank payment match');

        // Mark payment as MATCHED in DB
        try {
          const matched = await db.matchPaymentToOrder(
            payment.transactionId,
            order.orderNumber,
            'BANK_WEBHOOK'
          );
          if (!matched) {
            log.warn({
              orderId: order.orderNumber,
              transactionId: payment.transactionId,
            }, 'OKX: Existing payment could not be matched in DB (already used?) — skipping');
            return;
          }
        } catch (matchError) {
          log.error({ error: matchError, orderId: order.orderNumber }, 'OKX: Failed to match existing payment in DB');
        }

        pending.bankMatch = payment as unknown as BankWebhookPayload;

        try {
          await db.addVerificationStep(
            order.orderNumber,
            VerificationStatus.PAYMENT_MATCHED,
            `Existing payment matched: $${payment.amount} from ${payment.senderName}`,
            { transactionId: payment.transactionId, sender: payment.senderName, matchType: 'existing_payment' }
          );
        } catch { /* non-critical */ }

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
    const kycLevel = buyer.userGrade || 0;
    const registerDays = buyer.registerDays || 0;
    const minRegisterDays = parseInt(process.env.MIN_BUYER_REGISTER_DAYS || '60');

    if (totalOrders < this.riskConfig.minTotalOrders) {
      failedCriteria.push(`Orders ${totalOrders} < ${this.riskConfig.minTotalOrders}`);
    }
    if (completionRate < this.riskConfig.minCompletionRate) {
      failedCriteria.push(`Rate ${(completionRate * 100).toFixed(1)}% < ${(this.riskConfig.minCompletionRate * 100).toFixed(0)}%`);
    }
    if (orderAmount > this.riskConfig.maxAutoReleaseAmount) {
      failedCriteria.push(`Amount $${orderAmount} > $${this.riskConfig.maxAutoReleaseAmount}`);
    }
    if (registerDays > 0 && registerDays < minRegisterDays) {
      failedCriteria.push(`Account age ${registerDays}d < ${minRegisterDays}d`);
    }

    const passed = failedCriteria.length === 0;

    if (passed) {
      log.info(`OKX: Buyer risk check PASSED — order=${pending.orderNumber} orders=${totalOrders} rate=${(completionRate * 100).toFixed(0)}% age=${registerDays}d amount=$${orderAmount}`);
    } else {
      log.warn(`OKX: Buyer risk check FAILED — order=${pending.orderNumber} orders=${totalOrders} rate=${(completionRate * 100).toFixed(0)}% age=${registerDays}d amount=$${orderAmount} | FAILED: ${failedCriteria.join(', ')}`);
    }

    return passed;
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

    // Check if buyer is blacklisted on OKX
    if (pending.order.buyer?.blocked === '1') {
      if (!this.loggedBlockedOrders.has(orderNumber)) {
        log.warn({
          orderId: orderNumber,
          buyerNickName: pending.order.buyer?.nickName,
          buyerUserNo: pending.order.buyer?.userNo,
        }, 'OKX: Buyer is BLACKLISTED — blocking release');
        this.loggedBlockedOrders.set(orderNumber, 'blacklisted');
        this.emitRelease('manual_required', orderNumber, 'Buyer is blacklisted on OKX');
      }
      return;
    }

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

    // CRITICAL: Name verification is ALWAYS required — even for VIP/trusted buyers
    // Third-party payments are prohibited (fraud/money laundering risk)
    if (hasBankMatch && !hasNameVerified) {
      if (!this.loggedBlockedOrders.has(orderNumber)) {
        log.warn({
          orderId: orderNumber,
          senderName: pending.bankMatch?.senderName,
          buyerName: pending.order.buyer?.realName,
        }, 'OKX: Name mismatch — manual review needed (even VIP cannot bypass)');
        this.loggedBlockedOrders.set(orderNumber, 'name_mismatch');
        this.emitRelease('manual_required', orderNumber, 'Name mismatch between bank sender and OKX buyer');
      }
      return;
    }

    // Check trusted buyer (skips risk check, NOT name check)
    if (!pending.isTrustedBuyer) {
      const isTrusted = await this.checkTrustedBuyer(pending);
      pending.isTrustedBuyer = isTrusted;
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

    // Fix 3: Double-spend protection — check if payment was already released
    if (pending.bankMatch?.transactionId) {
      try {
        const doubleSpendCheck = await db.isPaymentAlreadyReleased(pending.bankMatch.transactionId);
        if (doubleSpendCheck.released) {
          log.error({
            orderId: orderNumber,
            transactionId: pending.bankMatch.transactionId,
            previousOrder: doubleSpendCheck.orderNumber,
            previousReleasedAt: doubleSpendCheck.releasedAt,
          }, 'OKX: [DOUBLE-SPEND BLOCKED] Payment already used for another order!');

          try {
            await db.createAlert({
              type: 'double_spend_attempt',
              severity: 'critical',
              title: 'Intento de Doble Gasto Bloqueado (OKX)',
              message: `Pago ${pending.bankMatch.transactionId} ya fue usado para orden ${doubleSpendCheck.orderNumber}`,
              metadata: {
                exchange: 'okx',
                currentOrder: orderNumber,
                previousOrder: doubleSpendCheck.orderNumber,
                transactionId: pending.bankMatch.transactionId,
              },
            });
          } catch { /* non-critical */ }

          this.pendingReleases.delete(orderNumber);
          this.emitRelease('release_failed', orderNumber, 'Double-spend attempt blocked');
          return;
        }
      } catch (dsError) {
        log.error({ error: dsError, orderId: orderNumber }, 'OKX: Failed to check double-spend — blocking release for safety');
        return;
      }
    }

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

      // Fix 4: Mark payment as RELEASED in DB (prevents reuse)
      if (pending.bankMatch?.transactionId) {
        try {
          await db.markPaymentReleased(orderNumber);
        } catch (markError) {
          log.error({ error: markError, orderId: orderNumber }, 'OKX: Failed to mark payment as released');
        }
      }

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

      // Fix 7: Check order status on OKX before deciding to retry
      if (isNonRetryable) {
        // Verify order status — might already be completed
        try {
          const orderDetail = await this.okxClient.getOrder(orderNumber);
          const currentStatus = orderDetail?.orderStatus;
          log.info({ orderId: orderNumber, currentStatus }, 'OKX: Order status after release error');

          if (currentStatus === 'COMPLETED') {
            log.info({ orderId: orderNumber }, 'OKX: Order already COMPLETED — release was successful');
            if (pending.bankMatch?.transactionId) {
              try { await db.markPaymentReleased(orderNumber); } catch { /* */ }
            }
            this.emitRelease('release_success', orderNumber, undefined, {
              amount: pending.order.totalPrice,
              asset: pending.order.asset,
              note: 'Detected as completed after API error',
            });
            this.pendingReleases.delete(orderNumber);
            this.loggedBlockedOrders.delete(orderNumber);
            return;
          } else if (currentStatus === 'CANCELLED') {
            log.warn({ orderId: orderNumber }, 'OKX: Order was CANCELLED — skipping');
            this.pendingReleases.delete(orderNumber);
            this.loggedBlockedOrders.delete(orderNumber);
            return;
          }
        } catch (statusError) {
          log.warn({ orderId: orderNumber, error: statusError }, 'OKX: Could not verify order status');
        }

        log.error({ orderId: orderNumber, attempts: pending.attempts }, 'OKX: Release failed permanently');
        this.emitRelease('release_failed', orderNumber, errorMsg);
        this.pendingReleases.delete(orderNumber);
      } else if (pending.attempts >= 3) {
        log.error({ orderId: orderNumber, attempts: pending.attempts }, 'OKX: Release failed after max retries');
        this.emitRelease('release_failed', orderNumber, errorMsg);
        this.pendingReleases.delete(orderNumber);
      } else {
        // Before retrying, verify order is still in releasable state
        let shouldRetry = true;
        try {
          const orderDetail = await this.okxClient.getOrder(orderNumber);
          const currentStatus = orderDetail?.orderStatus;

          if (currentStatus === 'COMPLETED') {
            log.info({ orderId: orderNumber }, 'OKX: Order already COMPLETED — no retry needed');
            if (pending.bankMatch?.transactionId) {
              try { await db.markPaymentReleased(orderNumber); } catch { /* */ }
            }
            this.emitRelease('release_success', orderNumber, undefined, {
              amount: pending.order.totalPrice,
              asset: pending.order.asset,
              note: 'Detected as completed after API error',
            });
            this.pendingReleases.delete(orderNumber);
            this.loggedBlockedOrders.delete(orderNumber);
            shouldRetry = false;
          } else if (currentStatus === 'CANCELLED') {
            log.warn({ orderId: orderNumber }, 'OKX: Order CANCELLED — no retry needed');
            this.pendingReleases.delete(orderNumber);
            this.loggedBlockedOrders.delete(orderNumber);
            shouldRetry = false;
          }
        } catch (statusError) {
          log.warn({ orderId: orderNumber, error: statusError }, 'OKX: Could not verify order status — will retry anyway');
        }

        if (shouldRetry) {
          log.info({ orderId: orderNumber, nextAttempt: pending.attempts + 1 }, 'OKX: Will retry release');
          this.releaseQueue.push(orderNumber);
          setTimeout(() => this.processReleaseQueue(), 5000);
        }
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
