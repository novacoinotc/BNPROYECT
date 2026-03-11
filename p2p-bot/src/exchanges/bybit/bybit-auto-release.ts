// =====================================================
// BYBIT AUTO RELEASE
// Verification pipeline + crypto release for Bybit
// NO TOTP needed — Bybit uses /v5/p2p/order/finish
// ZERO dependency on Binance or OKX code
// =====================================================

import { EventEmitter } from 'events';
import { BybitOrderManager } from './bybit-order-manager.js';
import { BybitClient, getBybitClient } from './bybit-client.js';
import { logger } from '../../utils/logger.js';
import * as db from '../../services/database-pg.js';
import {
  OrderData,
  BankWebhookPayload,
  OrderMatch,
  VerificationStatus,
  BybitOrderEvent,
  BybitReleaseEvent,
} from './bybit-types.js';

const log = logger.child({ module: 'bybit-release' });

// ==================== CONFIG ====================

export interface BybitAutoReleaseConfig {
  enableAutoRelease: boolean;
  requireBankMatch: boolean;
  enableBuyerRiskCheck: boolean;
  skipRiskCheckThreshold: number;
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

interface BybitBuyerRiskConfig {
  minTotalOrders: number;
  min30DayOrders: number;
  minRegisterDays: number;
  minCompletionRate: number;
  maxAutoReleaseAmount: number;
}

// ==================== AUTO RELEASE ====================

export class BybitAutoRelease extends EventEmitter {
  private config: BybitAutoReleaseConfig;
  private orderManager: BybitOrderManager;
  private bybitClient: BybitClient;

  private pendingReleases: Map<string, PendingRelease> = new Map();
  private releaseQueue: string[] = [];
  private processing = false;
  private processingOrders: Set<string> = new Set();
  private loggedBlockedOrders: Map<string, string> = new Map();
  private lastCheckTime: Map<string, number> = new Map();
  private readonly CHECK_THROTTLE_MS = 5000;

  private riskConfig: BybitBuyerRiskConfig;

  constructor(
    config: BybitAutoReleaseConfig,
    orderManager: BybitOrderManager
  ) {
    super();
    this.config = config;
    this.orderManager = orderManager;
    this.bybitClient = getBybitClient();

    this.riskConfig = {
      minTotalOrders: parseInt(process.env.MIN_BUYER_TOTAL_ORDERS || '50'),
      min30DayOrders: parseInt(process.env.MIN_BUYER_30DAY_ORDERS || '1'),
      minRegisterDays: parseInt(process.env.MIN_BUYER_REGISTER_DAYS || '60'),
      minCompletionRate: parseFloat(process.env.MIN_BUYER_POSITIVE_RATE || '0.85'),
      maxAutoReleaseAmount: config.maxAutoReleaseAmount,
    };

    this.setupEventListeners();

    log.info({
      enableAutoRelease: config.enableAutoRelease,
      maxAmount: config.maxAutoReleaseAmount,
      skipRiskThreshold: config.skipRiskCheckThreshold,
      requireBankMatch: config.requireBankMatch,
      buyerRiskCheck: config.enableBuyerRiskCheck,
      riskConfig: this.riskConfig,
    }, 'Bybit Auto-Release initialized');

    // Periodic re-check for pending orders that may have been missed
    // This is a safety net — runs every 10s to catch orders stuck by throttle or race conditions
    this.pendingRecheckInterval = setInterval(() => this.recheckPendingOrders(), 10_000);
  }

  private pendingRecheckInterval?: ReturnType<typeof setInterval>;

  private async recheckPendingOrders(): Promise<void> {
    for (const [orderNumber, pending] of this.pendingReleases) {
      // Only re-check orders that have BOTH bank match and name verified but haven't been released
      if (pending.bankMatch && pending.nameVerified && !this.processingOrders.has(orderNumber) && !this.releaseQueue.includes(orderNumber)) {
        log.debug({ orderId: orderNumber }, 'Bybit: Periodic re-check for pending order');
        this.lastCheckTime.delete(orderNumber);
        await this.checkReadyForRelease(orderNumber);
      }
    }
  }

  // ==================== EVENT SETUP ====================

  private setupEventListeners(): void {
    this.orderManager.on('order', (event: BybitOrderEvent) => {
      this.handleOrderEvent(event);
    });
  }

  /**
   * Connect to webhook receiver for bank payment events
   */
  connectWebhook(webhookEmitter: EventEmitter): void {
    webhookEmitter.on('payment', (event: { payload: BankWebhookPayload }) => {
      this.handleBankPayment(event.payload);
    });

    webhookEmitter.on('reversal', (event: { payload: BankWebhookPayload }) => {
      this.handleBankReversal(event.payload);
    });

    log.info('Bybit Auto-Release connected to webhook receiver');
  }

  // ==================== ORDER EVENTS ====================

  private async handleOrderEvent(event: BybitOrderEvent): Promise<void> {
    switch (event.type) {
      case 'new':
        log.info({ orderId: event.order.orderNumber, amount: event.order.totalPrice }, 'Bybit new order - tracking');
        break;

      case 'paid':
        await this.startVerification(event.order);
        break;

      case 'released':
      case 'cancelled':
        this.pendingReleases.delete(event.order.orderNumber);
        this.processingOrders.delete(event.order.orderNumber);
        this.loggedBlockedOrders.delete(event.order.orderNumber);
        break;

      case 'matched':
        if (event.match?.bankTransactionId) {
          const pending = this.pendingReleases.get(event.order.orderNumber);
          if (pending) {
            this.lastCheckTime.delete(event.order.orderNumber);
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
      log.info({ orderId: orderNumber }, 'Bybit auto-release disabled — manual release required');
      return;
    }

    const orderAmount = parseFloat(order.totalPrice);
    if (orderAmount > this.config.maxAutoReleaseAmount) {
      log.warn({
        orderId: orderNumber,
        amount: orderAmount,
        max: this.config.maxAutoReleaseAmount,
      }, 'Bybit order exceeds max auto-release amount — manual review');
      this.emitRelease('manual_required', orderNumber, 'Amount exceeds limit');
      return;
    }

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

    // Enrich buyer info from order detail
    try {
      const detail = await this.bybitClient.getOrderDetail(orderNumber);
      if (detail) {
        const isSell = detail.side === 1;
        if (pending.order.buyer) {
          if (detail.buyerRealName) {
            pending.order.buyer.realName = detail.buyerRealName;
          }
          // Set buyerUserNo from the counterparty userId
          if (isSell && detail.targetUserId) {
            pending.order.buyer.userNo = detail.targetUserId;
          } else if (!isSell && detail.userId) {
            pending.order.buyer.userNo = detail.userId;
          }
          // Set buyer nickName
          if (isSell && detail.targetNickName) {
            pending.order.buyer.nickName = detail.targetNickName;
          }
        }
        // Also update seller info
        if (detail.sellerRealName && pending.order.seller) {
          pending.order.seller.realName = detail.sellerRealName;
        }
        // Update counterPartNickName if missing
        if (!pending.order.counterPartNickName || pending.order.counterPartNickName === 'unknown') {
          pending.order.counterPartNickName = detail.targetNickName || pending.order.counterPartNickName;
        }

        // Fetch full buyer profile via counterparty endpoint
        const buyerUserId = pending.order.buyer?.userNo;
        if (buyerUserId && pending.order.buyer) {
          try {
            const profile = await this.bybitClient.getCounterpartyInfo(buyerUserId, orderNumber);
            if (profile) {
              pending.order.buyer.monthOrderCount = profile.recentFinishCount || 0;
              pending.order.buyer.monthFinishRate = typeof profile.recentRate === 'number'
                ? profile.recentRate / 100  // API returns integer (e.g. 68 = 68%)
                : parseFloat(String(profile.recentRate)) / 100 || 0;
              pending.order.buyer.totalOrders = profile.totalFinishCount || 0;
              pending.order.buyer.totalBuyOrders = profile.totalFinishBuyCount || 0;
              pending.order.buyer.totalSellOrders = profile.totalFinishSellCount || 0;
              pending.order.buyer.registerDays = profile.accountCreateDays || 0;
              pending.order.buyer.firstTradeDays = profile.firstTradeDays || 0;
              pending.order.buyer.positiveRate = parseFloat(profile.goodAppraiseRate || '0');
              pending.order.buyer.kycLevel = profile.kycLevel;
              pending.order.buyer.blocked = profile.blocked;
              pending.order.buyer.authStatus = profile.authStatus;

              log.info({
                orderId: orderNumber,
                buyerNickName: profile.nickName,
                monthOrders: profile.recentFinishCount,
                totalOrders: profile.totalFinishCount,
                completionRate: profile.recentRate,
                goodRating: profile.goodAppraiseRate,
                badReviews: profile.badAppraiseCount,
                accountDays: profile.accountCreateDays,
                firstTradeDays: profile.firstTradeDays,
                kycLevel: profile.kycLevel,
                authStatus: profile.authStatus,
                blocked: profile.blocked,
                vipLevel: profile.vipLevel,
              }, 'Bybit: Buyer profile enriched from counterparty API');

              // CRITICAL: Block release if buyer is blocked/banned
              // blocked field: "1" = blocked, "0" or undefined/null = not blocked
              const blockedValue = String(profile.blocked ?? '0').trim();
              if (blockedValue === '1') {
                log.error({
                  orderId: orderNumber,
                  buyerNickName: profile.nickName,
                  blocked: blockedValue,
                }, 'Bybit: BUYER IS BLOCKED/BANNED — blocking auto-release');
                this.emitRelease('manual_required', orderNumber, 'Buyer account is blocked/banned on Bybit');
                return;  // Stop verification — do NOT auto-release
              } else if (blockedValue !== '0') {
                log.warn({
                  orderId: orderNumber,
                  blocked: profile.blocked,
                  blockedType: typeof profile.blocked,
                }, 'Bybit: Unexpected blocked field value — treating as not blocked');
              }
            }
          } catch (profileError) {
            log.debug({ error: profileError, orderId: orderNumber }, 'Bybit: Could not fetch buyer profile');
          }
        }
      }
    } catch { /* non-critical */ }

    this.emitRelease('verification_started', orderNumber);

    try {
      await db.addVerificationStep(
        orderNumber,
        VerificationStatus.BUYER_MARKED_PAID,
        'Buyer marked as paid on Bybit',
        { exchange: 'bybit', amount: orderAmount }
      );
    } catch { /* non-critical */ }

    // Check if we already have a bank match
    await this.tryMatchExistingPayments(order);

    await this.checkReadyForRelease(orderNumber);
  }

  // ==================== BANK PAYMENT HANDLING ====================

  private async handleBankPayment(payment: BankWebhookPayload): Promise<void> {
    log.info({
      transactionId: payment.transactionId,
      amount: payment.amount,
      sender: payment.senderName,
    }, 'Bybit: Processing bank payment');

    // Collect all amount-matching orders with name scores
    const amountMatches: Array<{ orderNumber: string; pending: PendingRelease; nameScore: number }> = [];

    for (const [orderNumber, pending] of this.pendingReleases) {
      if (pending.bankMatch) continue;

      const order = pending.order;
      if (order.orderStatus !== 'BUYER_PAYED') continue;

      const expectedAmount = parseFloat(order.totalPrice);
      const tolerance = expectedAmount * 0.01;
      const amountDiff = Math.abs(expectedAmount - payment.amount);

      if (amountDiff <= tolerance) {
        const buyerRealName = pending.order.buyer?.realName || '';
        const senderName = payment.senderName || '';
        const nameScore = (senderName && buyerRealName)
          ? this.compareNames(senderName, buyerRealName)
          : 0;

        amountMatches.push({ orderNumber, pending, nameScore });
      }
    }

    if (amountMatches.length === 0) {
      log.debug({ amount: payment.amount, sender: payment.senderName }, 'Bybit: No matching order for payment');
      return;
    }

    // Pick best match: highest name score above 0.50, otherwise fall back to first amount match
    amountMatches.sort((a, b) => b.nameScore - a.nameScore);
    const bestNameMatch = amountMatches.find(m => m.nameScore > 0.50);
    const selected = bestNameMatch || amountMatches[0];

    log.info({
      orderId: selected.orderNumber,
      expected: parseFloat(selected.pending.order.totalPrice),
      received: payment.amount,
      sender: payment.senderName,
      nameScore: (selected.nameScore * 100).toFixed(0) + '%',
      matchedByName: !!bestNameMatch,
      candidateCount: amountMatches.length,
    }, 'Bybit: Bank payment matched to order');

    selected.pending.bankMatch = payment;

    try {
      await db.addVerificationStep(
        selected.orderNumber,
        VerificationStatus.PAYMENT_MATCHED,
        `Bank payment matched: $${payment.amount} from ${payment.senderName}`,
        { transactionId: payment.transactionId, sender: payment.senderName }
      );
    } catch { /* non-critical */ }

    await this.verifyName(selected.pending);
    // Clear throttle so checkReadyForRelease runs immediately after bank match
    this.lastCheckTime.delete(selected.orderNumber);
    await this.checkReadyForRelease(selected.orderNumber);
  }

  private handleBankReversal(payment: BankWebhookPayload): void {
    for (const [orderNumber, pending] of this.pendingReleases) {
      if (pending.bankMatch?.transactionId === payment.transactionId) {
        log.warn({ orderId: orderNumber, transactionId: payment.transactionId }, 'Bybit: Bank reversal detected!');
        pending.bankMatch = undefined;
        pending.nameVerified = false;
        this.releaseQueue = this.releaseQueue.filter(id => id !== orderNumber);
        break;
      }
    }
  }

  private async tryMatchExistingPayments(order: OrderData): Promise<void> {
    const pending = this.pendingReleases.get(order.orderNumber);
    if (!pending || pending.bankMatch) return;

    try {
      const expectedAmount = parseFloat(order.totalPrice);
      const recentPayments = await db.findUnmatchedPaymentsByAmount(expectedAmount, 1);

      if (recentPayments.length > 0) {
        const payment = recentPayments[0];
        log.info({
          orderId: order.orderNumber,
          paymentId: payment.transactionId,
          amount: payment.amount,
          sender: payment.senderName,
        }, 'Bybit: Found existing bank payment match');

        pending.bankMatch = payment as unknown as BankWebhookPayload;
        await this.verifyName(pending);
      }
    } catch (error) {
      log.debug({ error }, 'Bybit: Could not search existing payments');
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
      }, 'Bybit: Cannot verify name — missing data');
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
    }, 'Bybit: Name verification result');

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

    const buyer = pending.order.buyer;
    if (!buyer) {
      log.warn({ orderId: pending.orderNumber }, 'Bybit: No buyer info for risk check');
      return false;
    }

    const failedCriteria: string[] = [];

    // Use enriched profile data (from getCounterpartyInfo)
    const monthOrders = buyer.monthOrderCount || 0;
    const totalOrders = buyer.totalOrders || 0;
    const completionRate = buyer.monthFinishRate || 0;  // Already 0-1 from enrichment
    const registerDays = buyer.registerDays || 0;
    const firstTradeDays = buyer.firstTradeDays || 0;
    const positiveRate = buyer.positiveRate || 0;
    const kycLevel = buyer.kycLevel || '';
    const authStatus = buyer.authStatus;

    // CRITICAL: Blocked buyer — never auto-release (should have been caught earlier, but double check)
    if (String(buyer.blocked ?? '0').trim() === '1') {
      failedCriteria.push(`BLOCKED buyer (blocked=${buyer.blocked})`);
    }

    // Check KYC — buyer should have at least basic identity verification
    if (!kycLevel || kycLevel === '0' || kycLevel === '') {
      failedCriteria.push(`No KYC verification (kycLevel=${kycLevel})`);
    }

    // Check total orders (lifetime) — min 100 by default
    if (totalOrders < this.riskConfig.minTotalOrders) {
      failedCriteria.push(`TotalOrders ${totalOrders} < ${this.riskConfig.minTotalOrders}`);
    }
    // Check 30-day orders
    if (monthOrders < this.riskConfig.min30DayOrders) {
      failedCriteria.push(`MonthOrders ${monthOrders} < ${this.riskConfig.min30DayOrders}`);
    }
    // Check completion rate (0-1)
    if (completionRate < this.riskConfig.minCompletionRate) {
      failedCriteria.push(`CompletionRate ${(completionRate * 100).toFixed(1)}% < ${(this.riskConfig.minCompletionRate * 100).toFixed(0)}%`);
    }
    // Check account age
    if (registerDays < this.riskConfig.minRegisterDays) {
      failedCriteria.push(`AccountAge ${registerDays} days < ${this.riskConfig.minRegisterDays} days`);
    }
    // Check max auto-release amount
    if (orderAmount > this.riskConfig.maxAutoReleaseAmount) {
      failedCriteria.push(`Amount $${orderAmount} > $${this.riskConfig.maxAutoReleaseAmount}`);
    }

    const passed = failedCriteria.length === 0;

    const profileSummary = {
      totalOrders,
      monthOrders,
      completionRate: (completionRate * 100).toFixed(1) + '%',
      positiveRate: (positiveRate * 100).toFixed(0) + '%',
      registerDays,
      firstTradeDays,
      kycLevel,
      authStatus: authStatus === 1 ? 'VA' : 'Not VA',
    };

    if (passed) {
      log.info({ orderId: pending.orderNumber, ...profileSummary }, 'Bybit: Buyer risk check PASSED');
    } else {
      log.warn({ orderId: pending.orderNumber, ...profileSummary, failures: failedCriteria }, 'Bybit: Buyer risk check FAILED');
    }

    try {
      await db.addVerificationStep(
        pending.orderNumber,
        passed ? VerificationStatus.RISK_CHECK_PASSED : VerificationStatus.RISK_CHECK_FAILED,
        passed
          ? `Buyer profile OK: ${totalOrders} total orders, ${monthOrders}/30d, ${(completionRate * 100).toFixed(0)}% rate, ${registerDays}d old, KYC:${kycLevel}`
          : `Buyer risk: ${failedCriteria.join(', ')}`,
        { ...profileSummary, firstTradeDays }
      );
    } catch { /* non-critical */ }

    return passed;
  }

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
        }, 'Bybit: Trusted buyer detected');
      }
      return isTrusted;
    } catch {
      return false;
    }
  }

  // ==================== RELEASE CHECK ====================

  private async checkReadyForRelease(orderNumber: string): Promise<void> {
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
          log.warn({ orderId: orderNumber }, 'Bybit: Release kill switch is OFF');
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
        log.info({ orderId: orderNumber }, 'Bybit: Waiting for bank payment match');
        this.loggedBlockedOrders.set(orderNumber, 'no_bank_match');
      }
      return;
    }

    // Name MUST ALWAYS match — even for VIP/TrustedBuyers
    // A name mismatch could mean third-party payment (fraud)
    if (hasBankMatch && !hasNameVerified) {
      // Unmatch the payment so it can be reused for other orders with the same amount
      try {
        if (pending.bankMatch?.transactionId) {
          await db.unmatchPayment(pending.bankMatch.transactionId);
          log.info({
            orderId: orderNumber,
            transactionId: pending.bankMatch.transactionId,
          }, 'Bybit: Payment unmatched — available for other orders');
        }
      } catch { /* non-critical */ }

      if (!this.loggedBlockedOrders.has(orderNumber)) {
        log.warn({
          orderId: orderNumber,
          senderName: pending.bankMatch?.senderName,
          buyerName: pending.order.buyer?.realName,
        }, 'Bybit: Name mismatch — manual review needed (VIP does NOT bypass name check)');
        this.loggedBlockedOrders.set(orderNumber, 'name_mismatch');
        this.emitRelease('manual_required', orderNumber, 'Name mismatch between bank sender and Bybit buyer');
      }
      return;
    }

    // Check trusted buyer status (for risk check bypass only, NOT name bypass)
    if (!pending.isTrustedBuyer) {
      pending.isTrustedBuyer = await this.checkTrustedBuyer(pending);
    }

    // Buyer risk check — VIP skips this, non-VIP must pass
    if (!pending.riskCheckPassed && !pending.isTrustedBuyer) {
      const passed = await this.assessBuyerRisk(pending);
      pending.riskCheckPassed = passed;

      if (!passed) {
        this.emitRelease('manual_required', orderNumber, 'Buyer failed risk assessment');
        return;
      }
    }

    // All checks passed — queue for release
    log.info({ orderId: orderNumber }, 'Bybit: All checks passed — queuing for release');

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
        log.warn({ orderId: orderNumber }, 'Bybit: Release blocked by kill switch');
        return;
      }
    } catch { /* continue */ }

    const pending = this.pendingReleases.get(orderNumber);
    if (!pending) return;

    if (this.processingOrders.has(orderNumber)) return;
    this.processingOrders.add(orderNumber);

    // Double-spend protection: check if bankMatch transactionId is used by another pending release
    if (pending.bankMatch?.transactionId) {
      for (const [otherOrderNum, otherPending] of this.pendingReleases) {
        if (otherOrderNum !== orderNumber &&
            otherPending.bankMatch?.transactionId === pending.bankMatch.transactionId) {
          log.error({
            orderId: orderNumber,
            existingOrder: otherOrderNum,
            transactionId: pending.bankMatch.transactionId,
          }, 'Bybit: DOUBLE-SPEND DETECTED — payment already used');
          this.emitRelease('manual_required', orderNumber, 'Payment already used for another order');
          this.pendingReleases.delete(orderNumber);
          this.processingOrders.delete(orderNumber);
          return;
        }
      }
    }

    pending.attempts++;

    log.info({
      orderId: orderNumber,
      amount: pending.order.totalPrice,
      attempt: pending.attempts,
    }, 'Bybit: Executing crypto release');

    try {
      // Bybit release — NO TOTP needed, just POST /v5/p2p/order/finish
      await this.bybitClient.releaseCrypto(orderNumber);

      log.info({
        orderId: orderNumber,
        amount: pending.order.totalPrice,
        asset: pending.order.asset,
      }, 'Bybit: Crypto released successfully!');

      try {
        await db.addVerificationStep(
          orderNumber,
          VerificationStatus.RELEASED,
          'Crypto released via Bybit auto-release',
          {
            exchange: 'bybit',
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

      this.pendingReleases.delete(orderNumber);
      this.loggedBlockedOrders.delete(orderNumber);

      // Verify release was successful after 3 seconds
      setTimeout(async () => {
        try {
          const detail = await this.bybitClient.getOrderDetail(orderNumber);
          if (detail && (detail.status === 30 || detail.status === 40)) {
            log.info({ orderId: orderNumber }, 'Bybit: Release verified - order completed');
          } else if (detail) {
            log.warn({ orderId: orderNumber, status: detail.status }, 'Bybit: Release may not have completed');
          }
        } catch { /* non-critical */ }
      }, 3000);

    } catch (error: any) {
      const errorMsg = error.message || 'Unknown error';

      log.error({
        orderId: orderNumber,
        error: errorMsg,
        attempt: pending.attempts,
      }, 'Bybit: Release failed');

      const isNonRetryable = this.isNonRetryableError(errorMsg);

      if (isNonRetryable || pending.attempts >= 3) {
        log.error({ orderId: orderNumber, attempts: pending.attempts }, 'Bybit: Release failed permanently');
        this.emitRelease('release_failed', orderNumber, errorMsg);
        this.pendingReleases.delete(orderNumber);
      } else {
        log.info({ orderId: orderNumber, nextAttempt: pending.attempts + 1 }, 'Bybit: Will retry release');
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

  private emitRelease(type: BybitReleaseEvent['type'], orderNumber: string, reason?: string, data?: any): void {
    this.emit('release', { type, orderNumber, reason, data } as BybitReleaseEvent);
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

export function createBybitAutoRelease(
  config: Partial<BybitAutoReleaseConfig>,
  orderManager: BybitOrderManager
): BybitAutoRelease {
  const defaultConfig: BybitAutoReleaseConfig = {
    enableAutoRelease: process.env.BYBIT_ENABLE_AUTO_RELEASE === 'true',
    requireBankMatch: process.env.BYBIT_REQUIRE_BANK_MATCH !== 'false',
    enableBuyerRiskCheck: process.env.BYBIT_ENABLE_BUYER_RISK_CHECK !== 'false',
    skipRiskCheckThreshold: parseFloat(process.env.BYBIT_SKIP_RISK_THRESHOLD || '1500'),
    releaseDelayMs: parseInt(process.env.BYBIT_RELEASE_DELAY_MS || '2000'),
    maxAutoReleaseAmount: parseFloat(process.env.BYBIT_MAX_AUTO_RELEASE_AMOUNT || '50000'),
  };

  return new BybitAutoRelease({ ...defaultConfig, ...config }, orderManager);
}
