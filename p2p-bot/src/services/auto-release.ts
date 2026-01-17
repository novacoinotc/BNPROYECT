// =====================================================
// AUTO RELEASE ORCHESTRATOR
// Coordinates payment verification and crypto release
// =====================================================

import { EventEmitter } from 'events';
import { OrderManager, OrderEvent } from './order-manager.js';
import { ChatHandler, ChatEvent, ImageMessage } from './chat-handler.js';
import { WebhookReceiver, WebhookEvent } from './webhook-receiver.js';
import { OCRService } from './ocr-service.js';
import { getBinanceClient, BinanceC2CClient } from './binance-client.js';
import { BuyerRiskAssessor, BuyerRiskAssessment } from './buyer-risk-assessor.js';
import { getTOTPService } from './totp-service.js';
import { logger } from '../utils/logger.js';
import * as db from './database-pg.js';
import {
  OrderData,
  OrderStatus,
  AuthType,
  BankWebhookPayload,
  OrderMatch,
  VerificationStatus,
  TradeType,
} from '../types/binance.js';

export interface AutoReleaseConfig {
  enableAutoRelease: boolean;
  requireBankMatch: boolean;
  requireOcrVerification: boolean;
  enableBuyerRiskCheck: boolean;  // Check buyer history before auto-release
  skipRiskCheckThreshold: number; // Skip risk check for amounts ≤ this value
  authType: AuthType;
  minConfidence: number;
  releaseDelayMs: number;
  maxAutoReleaseAmount: number;
}

export interface ReleaseEvent {
  type: 'verification_started' | 'verification_complete' | 'release_queued' | 'release_success' | 'release_failed' | 'manual_required';
  orderNumber: string;
  reason?: string;
  data?: any;
}

interface PendingRelease {
  orderNumber: string;
  order: OrderData;
  bankMatch?: BankWebhookPayload;
  ocrVerified: boolean;
  ocrConfidence: number;
  nameVerified: boolean;  // CRITICAL: Must verify bank sender matches Binance buyer
  receiptUrl?: string;
  queuedAt: Date;
  attempts: number;
  buyerRiskAssessment?: BuyerRiskAssessment;  // Buyer risk evaluation
}

export class AutoReleaseOrchestrator extends EventEmitter {
  private config: AutoReleaseConfig;
  private orderManager: OrderManager;
  private chatHandler: ChatHandler;
  private webhookReceiver: WebhookReceiver;
  private ocrService: OCRService;
  private binanceClient: BinanceC2CClient;
  private buyerRiskAssessor: BuyerRiskAssessor;

  // Queues
  private pendingReleases: Map<string, PendingRelease> = new Map();
  private releaseQueue: string[] = [];
  private processing: boolean = false;

  // Track already-logged blocked orders to avoid log spam
  private loggedBlockedOrders: Map<string, string> = new Map(); // orderNumber -> reason

  // Throttle checkReadyForRelease to prevent duplicate processing
  private lastCheckTime: Map<string, number> = new Map(); // orderNumber -> timestamp
  private readonly CHECK_THROTTLE_MS = 5000; // Only check once per 5 seconds per order

  // Processing lock to prevent race conditions
  private processingOrders: Set<string> = new Set();

  // 2FA code callback (for manual entry or TOTP generation)
  private getVerificationCode: ((orderNumber: string, authType: AuthType) => Promise<string>) | null = null;

  constructor(
    config: AutoReleaseConfig,
    orderManager: OrderManager,
    chatHandler: ChatHandler,
    webhookReceiver: WebhookReceiver,
    ocrService: OCRService
  ) {
    super();
    this.config = config;
    this.orderManager = orderManager;
    this.chatHandler = chatHandler;
    this.webhookReceiver = webhookReceiver;
    this.ocrService = ocrService;
    this.binanceClient = getBinanceClient();
    this.buyerRiskAssessor = new BuyerRiskAssessor();

    this.setupEventListeners();

    // EXPLICIT startup logging
    logger.info(
      `🤖 [AUTO-RELEASE CONFIG] ` +
      `enableAutoRelease=${config.enableAutoRelease}, ` +
      `maxAmount=$${config.maxAutoReleaseAmount} MXN, ` +
      `requireOcr=${config.requireOcrVerification}, ` +
      `requireBankMatch=${config.requireBankMatch}, ` +
      `buyerRiskCheck=${config.enableBuyerRiskCheck}, ` +
      `authType=${config.authType}`
    );

    if (!config.enableAutoRelease) {
      logger.warn('⚠️ [AUTO-RELEASE] Auto-release is DISABLED. Set ENABLE_AUTO_RELEASE=true to enable.');
    } else {
      logger.info(`✅ [AUTO-RELEASE] Auto-release ENABLED for orders up to $${config.maxAutoReleaseAmount} MXN`);
      if (config.enableBuyerRiskCheck) {
        logger.info(
          `🛡️ [AUTO-RELEASE] Buyer risk check ENABLED (skip for ≤$${config.skipRiskCheckThreshold} MXN)`
        );
      }
    }
  }

  // ==================== EVENT SETUP ====================

  /**
   * Setup event listeners for all services
   */
  private setupEventListeners(): void {
    // Order events
    this.orderManager.on('order', (event: OrderEvent) => {
      this.handleOrderEvent(event);
    });

    // Chat events (receipt images)
    this.chatHandler.on('chat', (event: ChatEvent) => {
      this.handleChatEvent(event);
    });

    // Bank webhook events
    this.webhookReceiver.on('payment', (event: WebhookEvent) => {
      this.handleBankPayment(event);
    });

    this.webhookReceiver.on('reversal', (event: WebhookEvent) => {
      this.handleBankReversal(event);
    });

    // Sync endpoint matched a payment - trigger auto-release check
    this.webhookReceiver.on('sync_matched', (event: { order: OrderData; payment: { transactionId: string; amount: number; senderName: string } }) => {
      this.handleSyncMatched(event);
    });
  }

  /**
   * Handle payment matched during sync endpoint
   */
  private async handleSyncMatched(event: { order: OrderData; payment: { transactionId: string; amount: number; senderName: string } }): Promise<void> {
    const { order, payment } = event;

    logger.info(
      `📥 [SYNC_MATCHED] Order ${order.orderNumber}: ` +
      `amount=$${order.totalPrice} MXN, payment=$${payment.amount} from ${payment.senderName}`
    );

    // CRITICAL: Fetch order detail to get buyer's KYC verified real name
    // listPendingOrders does NOT include buyerName field
    let buyerRealName: string | null = null;
    let orderWithDetails = order;

    try {
      logger.info({ orderNumber: order.orderNumber }, '🔍 [SYNC_MATCHED] Fetching order detail for buyer name...');
      const orderDetail = await this.binanceClient.getOrderDetail(order.orderNumber);
      buyerRealName = (orderDetail as any).buyerRealName || null;
      orderWithDetails = { ...order, ...orderDetail };

      logger.info({
        orderNumber: order.orderNumber,
        buyerRealName: buyerRealName || '(not available)',
      }, '📋 [SYNC_MATCHED] Got buyer real name');

      // Save to DB for future lookups
      if (buyerRealName) {
        await db.updateOrderBuyerName(order.orderNumber, buyerRealName);
      }
    } catch (error) {
      logger.warn({ orderNumber: order.orderNumber, error }, '⚠️ [SYNC_MATCHED] Failed to fetch order detail');
    }

    // Verify name match
    const senderName = payment.senderName || '';
    const nameMatchScore = buyerRealName ? this.compareNames(senderName, buyerRealName) : 0;
    const hasRealName = !!buyerRealName;
    const nameMatches = hasRealName && nameMatchScore > 0.3;

    logger.info({
      orderNumber: order.orderNumber,
      senderName,
      buyerRealName: buyerRealName || '(not available)',
      nameMatchScore: nameMatchScore.toFixed(2),
      nameMatches,
    }, nameMatches
      ? '✅ [SYNC_MATCHED] Name verification PASSED'
      : '❌ [SYNC_MATCHED] Name verification FAILED');

    // Add verification step for name check
    if (hasRealName) {
      await db.addVerificationStep(
        order.orderNumber,
        nameMatches ? VerificationStatus.NAME_VERIFIED : VerificationStatus.NAME_MISMATCH,
        nameMatches
          ? `✅ Nombre verificado: "${senderName}" ≈ "${buyerRealName}" (${(nameMatchScore * 100).toFixed(0)}%)`
          : `⚠️ Nombre NO coincide: "${senderName}" vs "${buyerRealName}" (${(nameMatchScore * 100).toFixed(0)}%)`,
        { senderName, buyerRealName, matchScore: nameMatchScore }
      );
    } else {
      await db.addVerificationStep(
        order.orderNumber,
        VerificationStatus.NAME_MISMATCH,
        '⚠️ No se pudo obtener nombre real del comprador - Requiere verificación manual',
        { senderName, reason: 'real_name_not_available' }
      );
    }

    // Create pending release record - ensure amount is a number
    const paymentAmount = this.toNumber(payment.amount);
    const pending: PendingRelease = {
      orderNumber: order.orderNumber,
      order: orderWithDetails,
      bankMatch: {
        transactionId: payment.transactionId,
        amount: paymentAmount,
        currency: order.fiat || 'MXN',
        senderName: payment.senderName,
        senderAccount: '',
        receiverAccount: '',
        concept: '',
        timestamp: new Date().toISOString(),
        bankReference: '',
        status: 'completed',
      },
      ocrVerified: true, // Skip OCR for sync matches
      ocrConfidence: 1.0,
      nameVerified: nameMatches, // Set based on actual name verification
      queuedAt: new Date(),
      attempts: 0,
    };

    this.pendingReleases.set(order.orderNumber, pending);

    // CRITICAL: If name verification FAILED, unmatch the payment so it can match other orders
    // This handles the case where two orders have the same amount but different buyers
    if (!nameMatches && payment.transactionId) {
      logger.warn({
        orderNumber: order.orderNumber,
        transactionId: payment.transactionId,
        senderName: payment.senderName,
        buyerRealName: buyerRealName || '(unknown)',
      }, '🔄 [SYNC NAME MISMATCH] Unmatching payment so it can match other orders with same amount');

      try {
        await db.unmatchPayment(payment.transactionId);
        // Clear bankMatch from pending so this order can match a different payment
        pending.bankMatch = undefined;
      } catch (unmatchError) {
        logger.error({ unmatchError, transactionId: payment.transactionId }, '❌ Failed to unmatch payment');
      }
    }

    // CRITICAL: Clear throttle before checking - this is a significant state change
    // (name verification completed) that must be evaluated immediately
    this.lastCheckTime.delete(order.orderNumber);

    // Check if ready for release
    await this.checkReadyForRelease(order.orderNumber);
  }

  // ==================== EVENT HANDLERS ====================

  /**
   * Handle order events
   */
  private async handleOrderEvent(event: OrderEvent): Promise<void> {
    switch (event.type) {
      case 'new':
        // New order - watch chat and send auto-reply
        this.chatHandler.watchOrder(event.order.orderNumber);
        await this.chatHandler.sendAutoReply(event.order.orderNumber);
        break;

      case 'paid':
        // Buyer marked as paid - start verification process
        await this.startVerification(event.order);
        break;

      case 'matched':
        // Bank payment matched to order
        if (event.match) {
          await this.handlePaymentMatch(event.order, event.match);
        }
        break;

      case 'released':
      case 'cancelled':
        // Cleanup all maps for this order
        this.pendingReleases.delete(event.order.orderNumber);
        this.lastCheckTime.delete(event.order.orderNumber);
        this.loggedBlockedOrders.delete(event.order.orderNumber);
        this.chatHandler.unwatchOrder(event.order.orderNumber);
        break;
    }
  }

  /**
   * Handle chat events
   */
  private async handleChatEvent(event: ChatEvent): Promise<void> {
    if (event.type === 'image' && event.message) {
      await this.handleReceiptImage({
        orderNo: event.message.orderNo,
        imageUrl: event.message.imageUrl || '',
        thumbnailUrl: event.message.thumbnailUrl,
        senderId: '',
        senderName: event.message.fromNickName,
        timestamp: new Date(event.message.createTime),
      });
    }
  }

  /**
   * Handle bank payment webhook
   * Implements SMART MATCHING: First finds orders with matching amount AND name
   * Only matches if confident - prevents "bouncing" between orders with same amount
   */
  private async handleBankPayment(event: WebhookEvent): Promise<void> {
    const payment = event.payload;

    logger.info({
      transactionId: payment.transactionId,
      amount: payment.amount,
      sender: payment.senderName,
    }, '💰 Processing bank payment webhook');

    // STEP 1: Populate missing buyer names for PAID orders with matching amount
    // This ensures we can compare names even when the order was synced before details were fetched
    try {
      const ordersNeedingNames = await db.getOrdersNeedingBuyerName(payment.amount, 1);
      if (ordersNeedingNames.length > 0) {
        logger.info({
          count: ordersNeedingNames.length,
          orders: ordersNeedingNames.map(o => o.orderNumber),
        }, '🔄 [PRE-MATCH] Fetching buyer names for orders missing buyerRealName');

        for (const order of ordersNeedingNames) {
          try {
            const orderDetail = await this.binanceClient.getOrderDetail(order.orderNumber);
            const buyerRealName = (orderDetail as any).buyerRealName;
            if (buyerRealName) {
              await db.updateOrderBuyerName(order.orderNumber, buyerRealName);
            }
          } catch (err) {
            logger.warn({ orderNumber: order.orderNumber, error: err }, '⚠️ [PRE-MATCH] Failed to fetch order detail');
          }
        }
      }
    } catch (err) {
      logger.warn({ error: err }, '⚠️ [PRE-MATCH] Error populating buyer names');
    }

    // STEP 2: SMART MATCH - Find order with matching amount AND buyer name
    // This prevents payment from "bouncing" between orders with same amount
    try {
      const smartMatch = await db.findOrderByAmountAndName(
        payment.amount,
        payment.senderName,
        1 // 1% tolerance
      );

      if (smartMatch) {
        logger.info({
          orderNumber: smartMatch.orderNumber,
          transactionId: payment.transactionId,
          buyerRealName: smartMatch.buyerRealName,
          nameMatchScore: smartMatch.nameMatchScore,
        }, '✅ [SMART MATCH] Payment matched to order by amount AND name');

        // Track: payment received and matched
        await db.addVerificationStep(
          smartMatch.orderNumber,
          VerificationStatus.BANK_PAYMENT_RECEIVED,
          `Pago bancario recibido de ${payment.senderName}`,
          {
            transactionId: payment.transactionId,
            receivedAmount: payment.amount,
            senderName: payment.senderName,
          }
        );

        await db.addVerificationStep(
          smartMatch.orderNumber,
          VerificationStatus.PAYMENT_MATCHED,
          `✅ Pago vinculado por monto Y nombre (${(smartMatch.nameMatchScore * 100).toFixed(0)}% similitud)`,
          {
            transactionId: payment.transactionId,
            receivedAmount: payment.amount,
            expectedAmount: smartMatch.totalPrice,
            nameMatch: smartMatch.nameMatchScore.toFixed(2),
            matchType: 'smart_match',
          }
        );

        // Update DB - match payment to order
        const matchSuccess = await db.matchPaymentToOrder(
          payment.transactionId,
          smartMatch.orderNumber,
          'BANK_WEBHOOK'
        );

        if (!matchSuccess) {
          logger.warn({
            transactionId: payment.transactionId,
            orderNumber: smartMatch.orderNumber,
          }, '⚠️ Payment could not be matched (may already be released)');
          return;
        }

        // Create order match data
        const orderMatch: OrderMatch = {
          orderNumber: smartMatch.orderNumber,
          bankTransactionId: payment.transactionId,
          receivedAmount: payment.amount,
          expectedAmount: parseFloat(smartMatch.totalPrice),
          senderName: payment.senderName,
          verified: true,
          matchedAt: new Date(),
        };

        // Get full order from order manager or create minimal
        let order = this.orderManager.getOrder(smartMatch.orderNumber);

        if (!order) {
          // Order not in memory - create minimal order
          order = {
            orderNumber: smartMatch.orderNumber,
            orderStatus: 'BUYER_PAYED',
            totalPrice: smartMatch.totalPrice,
            unitPrice: '0',
            amount: '0',
            asset: 'USDT',
            fiat: 'MXN',
            fiatSymbol: 'Mex$',
            counterPartNickName: smartMatch.buyerNickName,
            buyerRealName: smartMatch.buyerRealName,
            tradeType: TradeType.SELL,
            createTime: smartMatch.createdAt?.getTime() || Date.now(),
            payMethodName: 'BANK',
            commission: '0',
            advNo: '',
          } as OrderData;

          logger.info({
            orderNumber: smartMatch.orderNumber,
            amount: smartMatch.totalPrice,
          }, '📦 Order not in memory - created minimal order for auto-release');
        }

        // Process the payment match
        await this.handlePaymentMatch(order, orderMatch);
        return;
      }

      // No confident match found - check if there are orders with matching amount (for logging)
      const ordersWithAmount = await db.findOrdersAwaitingPayment(payment.amount, 1);
      if (ordersWithAmount.length > 0) {
        logger.warn({
          transactionId: payment.transactionId,
          amount: payment.amount,
          sender: payment.senderName,
          ordersWithSameAmount: ordersWithAmount.length,
          orderBuyers: ordersWithAmount.map(o => ({
            orderNumber: o.orderNumber,
            buyerRealName: o.buyerRealName,
            buyerNickName: o.buyerNickName,
          })),
        }, '⚠️ [SMART MATCH] Payment NOT matched - amount matches but NO buyer name matches sender');
      }

    } catch (error) {
      logger.error({ error }, 'Error during smart payment matching');
    }

    // No match found - mark as THIRD_PARTY
    // Any payment that doesn't immediately match an order by amount AND name is suspicious
    logger.warn({
      transactionId: payment.transactionId,
      amount: payment.amount,
      sender: payment.senderName,
    }, '🚨 [THIRD_PARTY] Payment did not match any order - marking as THIRD_PARTY');

    try {
      await db.markPaymentAsThirdParty(
        payment.transactionId,
        `No order matched for sender "${payment.senderName}" with amount $${payment.amount}`
      );

      // Create alert for manual review
      await db.createAlert({
        type: 'third_party_payment',
        severity: 'warning',
        title: 'Pago de Tercero Detectado',
        message: `Pago de $${payment.amount} de "${payment.senderName}" no coincide con ninguna orden`,
        metadata: {
          transactionId: payment.transactionId,
          amount: payment.amount,
          senderName: payment.senderName,
        },
      });
    } catch (error) {
      logger.error({ error, transactionId: payment.transactionId }, 'Error marking payment as third-party');
    }
  }

  /**
   * Handle bank reversal (chargeback)
   */
  private handleBankReversal(event: WebhookEvent): void {
    logger.warn({
      transactionId: event.payload.transactionId,
      amount: event.payload.amount,
    }, 'ALERT: Bank reversal detected!');

    // Find any orders associated with this transaction
    for (const [orderNumber, pending] of this.pendingReleases) {
      if (pending.bankMatch?.transactionId === event.payload.transactionId) {
        // Cleanup all maps for this order
        this.pendingReleases.delete(orderNumber);
        this.lastCheckTime.delete(orderNumber);
        this.loggedBlockedOrders.delete(orderNumber);
        this.releaseQueue = this.releaseQueue.filter(o => o !== orderNumber);

        logger.error({
          orderNumber,
          transactionId: event.payload.transactionId,
        }, 'Order removed from release queue due to reversal');

        this.emit('release', {
          type: 'release_failed',
          orderNumber,
          reason: 'Bank reversal detected',
        } as ReleaseEvent);
      }
    }
  }

  // ==================== VERIFICATION ====================

  /**
   * Start verification process for paid order
   * Implements bidirectional matching: checks for existing bank payments
   * NOTE: This method is designed to be resilient to DB errors
   */
  private async startVerification(order: OrderData): Promise<void> {
    logger.info({
      orderNumber: order.orderNumber,
      amount: order.totalPrice,
    }, 'Starting payment verification');

    // Track: buyer marked as paid (non-blocking on DB errors)
    try {
      await db.addVerificationStep(
        order.orderNumber,
        VerificationStatus.BUYER_MARKED_PAID,
        `Comprador marcó como pagado - Esperando confirmación bancaria`,
        {
          expectedAmount: order.totalPrice,
          buyerName: order.counterPartNickName,
          timestamp: new Date().toISOString(),
        }
      );
    } catch (dbError) {
      logger.warn({ orderNumber: order.orderNumber, error: dbError },
        '⚠️ [DB] Failed to add BUYER_MARKED_PAID step - continuing');
    }

    this.emit('release', {
      type: 'verification_started',
      orderNumber: order.orderNumber,
    } as ReleaseEvent);

    // CRITICAL: Check if pending record already exists (e.g., from sync_matched flow)
    // Preserve bankMatch and nameVerified if they were already set
    const existingPending = this.pendingReleases.get(order.orderNumber);

    if (existingPending) {
      // Update existing record but preserve critical fields
      logger.info({
        orderNumber: order.orderNumber,
        hasBankMatch: !!existingPending.bankMatch,
        nameVerified: existingPending.nameVerified,
      }, '📋 [VERIFICATION] Preserving existing pending record data');

      existingPending.order = order; // Update order data
      // Don't overwrite bankMatch, nameVerified, ocrVerified if already set
    } else {
      // Initialize new pending release record
      const pending: PendingRelease = {
        orderNumber: order.orderNumber,
        order,
        ocrVerified: false,
        ocrConfidence: 0,
        nameVerified: false, // Must verify name match before release
        queuedAt: new Date(),
        attempts: 0,
      };
      this.pendingReleases.set(order.orderNumber, pending);
    }

    // BIDIRECTIONAL MATCH: Check if bank payment already arrived before order was marked paid
    // Skip if payment was already matched via sync_matched flow
    const currentPending = this.pendingReleases.get(order.orderNumber);
    if (currentPending?.bankMatch?.transactionId) {
      logger.info({
        orderNumber: order.orderNumber,
        transactionId: currentPending.bankMatch.transactionId,
      }, '📋 [VERIFICATION] Payment already matched via sync - skipping bidirectional search');
    } else try {
      const expectedAmount = parseFloat(order.totalPrice);
      const existingPayments = await db.findUnmatchedPaymentsByAmount(expectedAmount, 1, 120); // 1% tolerance, last 2 hours

      if (existingPayments.length > 0) {
        logger.info({
          orderNumber: order.orderNumber,
          foundPayments: existingPayments.length,
          amounts: existingPayments.map(p => p.amount),
          senders: existingPayments.map(p => p.senderName),
        }, '🔍 Found existing bank payment(s) for order');

        // Get buyer's real name for comparison (need to fetch from order detail)
        let buyerRealName = (order as any).buyerRealName || null;
        if (!buyerRealName) {
          try {
            const orderDetail = await this.binanceClient.getOrderDetail(order.orderNumber);
            buyerRealName = (orderDetail as any).buyerRealName || null;
            // Save to DB for future lookups
            if (buyerRealName) {
              await db.updateOrderBuyerName(order.orderNumber, buyerRealName);
            }
          } catch (err) {
            logger.warn({ orderNumber: order.orderNumber }, '⚠️ Could not fetch buyer real name');
          }
        }

        const buyerNameToCompare = buyerRealName || order.counterPartNickName || order.buyer?.nickName || '';

        // SMART MATCH: Find payment with matching name (not just first one with matching amount)
        let bestPayment: typeof existingPayments[0] | null = null;
        let bestScore = 0;

        for (const payment of existingPayments) {
          const nameMatch = this.compareNames(payment.senderName, buyerNameToCompare);

          logger.debug({
            orderNumber: order.orderNumber,
            paymentSender: payment.senderName,
            buyerName: buyerNameToCompare,
            nameMatch: nameMatch.toFixed(2),
          }, 'Comparing payment sender with order buyer');

          if (nameMatch > bestScore) {
            bestScore = nameMatch;
            bestPayment = payment;
          }
        }

        // Only match if name similarity > 30%
        if (bestPayment && bestScore > 0.3) {
          const match: OrderMatch = {
            orderNumber: order.orderNumber,
            bankTransactionId: bestPayment.transactionId,
            receivedAmount: bestPayment.amount,
            expectedAmount: expectedAmount,
            senderName: bestPayment.senderName,
            verified: true,
            matchedAt: new Date(),
          };

          logger.info({
            orderNumber: order.orderNumber,
            transactionId: bestPayment.transactionId,
            amount: bestPayment.amount,
            senderName: bestPayment.senderName,
            buyerName: buyerNameToCompare,
            nameMatchScore: bestScore.toFixed(2),
          }, '✅ [SMART MATCH] Bank payment matched to order (payment arrived first, name verified)');

          // Track: payment matched (non-blocking on DB errors)
          try {
            await db.addVerificationStep(
              order.orderNumber,
              VerificationStatus.PAYMENT_MATCHED,
              `✅ Pago bancario vinculado por nombre (${(bestScore * 100).toFixed(0)}% similitud)`,
              {
                transactionId: bestPayment.transactionId,
                receivedAmount: bestPayment.amount,
                senderName: bestPayment.senderName,
                buyerName: buyerNameToCompare,
                nameMatchScore: bestScore,
                matchType: 'smart_match_payment_first',
              }
            );
          } catch (dbError) {
            logger.warn({ orderNumber: order.orderNumber, error: dbError },
              '⚠️ [DB] Failed to add PAYMENT_MATCHED step - continuing');
          }

          // Update DB (non-blocking on errors)
          try {
            const matchSuccess = await db.matchPaymentToOrder(bestPayment.transactionId, order.orderNumber, 'BANK_WEBHOOK');
            if (!matchSuccess) {
              logger.warn({ orderNumber: order.orderNumber }, '⚠️ Payment could not be matched (may already be used)');
            }
          } catch (dbError) {
            logger.warn({ orderNumber: order.orderNumber, error: dbError },
              '⚠️ [DB] Failed to update payment match - continuing');
          }

          // Handle the match
          await this.handlePaymentMatch(order, match);
        } else if (existingPayments.length > 0) {
          // Payments exist with matching amount but names don't match
          logger.warn({
            orderNumber: order.orderNumber,
            buyerName: buyerNameToCompare,
            availablePayments: existingPayments.map(p => ({
              sender: p.senderName,
              amount: p.amount,
            })),
            bestScore: bestScore.toFixed(2),
          }, '⚠️ [SMART MATCH] Payments available but no name match - waiting for correct payment');
        }
      }
    } catch (error) {
      logger.error({ error, orderNumber: order.orderNumber }, 'Error checking for existing payments - continuing with verification');
    }

    // Look for existing receipt images in chat
    try {
      const existingImages = await this.chatHandler.findReceiptImages(order.orderNumber);

      if (existingImages.length > 0) {
        // Process the most recent image
        await this.handleReceiptImage(existingImages[existingImages.length - 1]);
      }
    } catch (error) {
      logger.warn({ error, orderNumber: order.orderNumber }, 'Error finding receipt images - continuing');
    }

    // ALWAYS check if ready for release at the end
    // This ensures the order gets processed even if DB errors occurred above
    await this.checkReadyForRelease(order.orderNumber);
  }

  /**
   * Compare two names and return similarity score (0-1)
   * Handles Mexican bank formats like "SAIB,BRIBIESCA/LOPEZ" vs "BRIBIESCA LOPEZ SAIB"
   */
  private compareNames(name1: string, name2: string): number {
    if (!name1 || !name2) return 0;

    // Normalize: convert separators to spaces, remove special chars, lowercase
    const normalize = (s: string) => {
      return s
        .toLowerCase()
        .trim()
        // Replace common bank separators with spaces (Mexican SPEI format uses comma and slash)
        .replace(/[,\/\.\-\_\|]/g, ' ')
        // Remove remaining special characters (keep letters, numbers, spaces, and Spanish chars)
        .replace(/[^a-z0-9\sáéíóúüñ]/g, '')
        // Normalize multiple spaces to single space
        .replace(/\s+/g, ' ')
        .trim();
    };

    const n1 = normalize(name1);
    const n2 = normalize(name2);

    logger.debug({ original1: name1, normalized1: n1, original2: name2, normalized2: n2 }, 'Name comparison normalization');

    if (n1 === n2) return 1;

    // Check if one contains the other
    if (n1.includes(n2) || n2.includes(n1)) return 0.8;

    // Check word overlap (names can be in different order)
    const words1 = new Set(n1.split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(n2.split(/\s+/).filter(w => w.length > 2));

    let matches = 0;
    for (const word of words1) {
      if (words2.has(word)) matches++;
    }

    // Calculate similarity based on word overlap
    const totalWords = Math.max(words1.size, words2.size);
    const wordScore = totalWords > 0 ? matches / totalWords : 0;

    logger.debug({
      words1: Array.from(words1),
      words2: Array.from(words2),
      matches,
      totalWords,
      wordScore
    }, 'Name comparison word analysis');

    return wordScore;
  }

  /**
   * Handle receipt image from chat
   */
  private async handleReceiptImage(image: ImageMessage): Promise<void> {
    const pending = this.pendingReleases.get(image.orderNo);

    if (!pending) {
      logger.debug({ orderNo: image.orderNo }, 'Receipt image for unknown order');
      return;
    }

    logger.info({
      orderNumber: image.orderNo,
      imageUrl: image.imageUrl,
    }, 'Processing receipt image');

    if (this.config.requireOcrVerification) {
      // Run OCR
      const ocrResult = await this.ocrService.processReceiptUrl(image.imageUrl);

      // Verify against order
      // Note: API returns counterPartNickName, not buyer.realName
      const expectedAmount = parseFloat(pending.order.totalPrice);
      const counterPartName = pending.order.counterPartNickName || pending.order.buyer?.realName;
      const verification = this.ocrService.verifyReceipt(
        ocrResult,
        expectedAmount,
        counterPartName
      );

      pending.ocrVerified = verification.verified;
      pending.ocrConfidence = verification.confidence;
      pending.receiptUrl = image.imageUrl;

      // Update order manager
      this.orderManager.verifyPayment(
        image.orderNo,
        image.imageUrl,
        ocrResult.amount,
        ocrResult.senderName
      );

      if (verification.verified) {
        logger.info({
          orderNumber: image.orderNo,
          confidence: verification.confidence.toFixed(2),
        }, 'Receipt verified via OCR');
      } else {
        logger.warn({
          orderNumber: image.orderNo,
          issues: verification.issues,
        }, 'Receipt verification failed');
      }
    } else {
      // No OCR required - just mark as having receipt
      pending.receiptUrl = image.imageUrl;
      pending.ocrVerified = true;
      pending.ocrConfidence = 0.5;
    }

    // Check if ready for release
    await this.checkReadyForRelease(image.orderNo);
  }

  /**
   * Handle bank payment match
   * NOTE: This method is designed to be COMPLETELY resilient to errors - it will catch
   * ALL errors and continue processing so that checkReadyForRelease is always called
   * with the correct nameVerified status
   */
  private async handlePaymentMatch(order: OrderData, match: OrderMatch): Promise<void> {
    // Prevent duplicate processing (race condition protection)
    if (this.processingOrders.has(order.orderNumber)) {
      logger.debug({ orderNumber: order.orderNumber }, 'Order already being processed, skipping duplicate call');
      return;
    }
    this.processingOrders.add(order.orderNumber);

    let pending = this.pendingReleases.get(order.orderNumber);

    if (!pending) {
      // Create pending record if doesn't exist
      pending = {
        orderNumber: order.orderNumber,
        order,
        ocrVerified: false,
        ocrConfidence: 0,
        nameVerified: false, // Must verify name match before release
        queuedAt: new Date(),
        attempts: 0,
      };
      this.pendingReleases.set(order.orderNumber, pending);
    }

    // Variables for verification - declared at top level so they're available in finally
    let amountMatches = false;
    let nameMatches = false;
    let buyerRealName: string | null = (order as any).buyerRealName || null;
    const senderName = match.senderName || '';
    // CRITICAL: Use toNumber() to safely convert - PostgreSQL returns Decimal as string
    const expectedAmount = this.toNumber(match.expectedAmount) || this.toNumber(order.totalPrice) || 0;
    const receivedAmount = this.toNumber(match.receivedAmount) || 0;
    const buyerNickName = order.counterPartNickName || (order as any).buyerNickname || order.buyer?.nickName || '';

    // Helper to safely add verification steps (non-blocking on DB errors)
    const safeAddVerificationStep = async (
      status: VerificationStatus,
      message: string,
      details?: Record<string, any>
    ) => {
      try {
        await db.addVerificationStep(order.orderNumber, status, message, details);
      } catch (dbError) {
        logger.warn({ orderNumber: order.orderNumber, error: dbError },
          '⚠️ [DB] Failed to add verification step - continuing processing');
      }
    };

    try {
      // Store bank match info
      pending.bankMatch = {
        transactionId: match.bankTransactionId || '',
        amount: receivedAmount,
        currency: order.fiat || order.fiatUnit || 'MXN',
        senderName: senderName,
        senderAccount: '',
        receiverAccount: '',
        concept: '',
        timestamp: match.matchedAt?.toISOString() || new Date().toISOString(),
        bankReference: '',
        status: 'completed',
      };

      logger.info({
        orderNumber: order.orderNumber,
        bankAmount: receivedAmount,
        expectedAmount: expectedAmount,
      }, 'Bank payment matched to order');

      // VERIFY AMOUNT
      const amountDiff = Math.abs(receivedAmount - expectedAmount);
      const amountTolerance = expectedAmount * 0.01; // 1% tolerance
      amountMatches = amountDiff <= amountTolerance;

      if (amountMatches) {
        await safeAddVerificationStep(
          VerificationStatus.AMOUNT_VERIFIED,
          `Monto verificado: $${receivedAmount.toFixed(2)} ≈ $${expectedAmount.toFixed(2)} (diferencia: $${amountDiff.toFixed(2)})`,
          { receivedAmount, expectedAmount, difference: amountDiff, tolerance: amountTolerance, withinTolerance: true }
        );
      } else {
        await safeAddVerificationStep(
          VerificationStatus.AMOUNT_MISMATCH,
          `⚠️ ALERTA: Monto no coincide - Recibido: $${receivedAmount.toFixed(2)} vs Esperado: $${expectedAmount.toFixed(2)}`,
          { receivedAmount, expectedAmount, difference: amountDiff, tolerance: amountTolerance, withinTolerance: false }
        );
      }

      // VERIFY NAME - Fetch order detail to get buyer's KYC verified real name
      if (!buyerRealName) {
        try {
          logger.info({ orderNumber: order.orderNumber }, '🔍 [NAME CHECK] Fetching order detail to get buyer real name...');
          const orderDetail = await this.binanceClient.getOrderDetail(order.orderNumber);
          buyerRealName = (orderDetail as any).buyerRealName || null;

          if (pending) {
            pending.order = { ...pending.order, ...orderDetail };
          }

          logger.info({
            orderNumber: order.orderNumber,
            buyerRealName: buyerRealName || '(not available)',
          }, '📋 [NAME CHECK] Got buyer real name from order detail');
        } catch (error) {
          logger.warn({ orderNumber: order.orderNumber, error }, '⚠️ [NAME CHECK] Failed to fetch order detail');
        }
      }

      // Calculate name match
      const hasRealName = !!buyerRealName;
      const nameMatchScore = buyerRealName ? this.compareNames(senderName, buyerRealName) : 0;
      nameMatches = hasRealName && nameMatchScore > 0.3;

      // Log and save name verification result
      if (!hasRealName) {
        await safeAddVerificationStep(
          VerificationStatus.NAME_MISMATCH,
          `⚠️ No se pudo obtener nombre real del comprador desde Binance API - Requiere verificación manual`,
          { senderName, buyerNickName, reason: 'real_name_not_available_from_api' }
        );
      } else if (nameMatches) {
        await safeAddVerificationStep(
          VerificationStatus.NAME_VERIFIED,
          `✅ Nombre verificado: "${senderName}" ≈ "${buyerRealName}" (similitud: ${(nameMatchScore * 100).toFixed(0)}%)`,
          { senderName, buyerRealName, buyerNickName, matchScore: nameMatchScore }
        );
      } else {
        await safeAddVerificationStep(
          VerificationStatus.NAME_MISMATCH,
          `⚠️ ALERTA: Nombre NO coincide - SPEI: "${senderName}" vs Binance KYC: "${buyerRealName}" (similitud: ${(nameMatchScore * 100).toFixed(0)}%)`,
          { senderName, buyerRealName, buyerNickName, matchScore: nameMatchScore }
        );
      }

      // Log name verification result
      logger.info({
        orderNumber: order.orderNumber,
        nameVerified: nameMatches,
        hasRealName,
        senderName,
        buyerRealName: buyerRealName || '(not available)',
        buyerNickName,
        matchScore: nameMatchScore.toFixed(2),
      }, nameMatches
        ? '✅ [NAME VERIFIED] Bank sender matches Binance buyer KYC name'
        : '❌ [NAME NOT VERIFIED] Bank sender does NOT match - manual release required');

      // FINAL DETERMINATION - save to DB
      if (amountMatches && nameMatches) {
        await safeAddVerificationStep(
          VerificationStatus.READY_TO_RELEASE,
          `✅ VERIFICACIÓN COMPLETA - Todas las validaciones pasaron`,
          { amountVerified: true, nameVerified: true, recommendation: 'RELEASE', autoReleaseEnabled: this.config.enableAutoRelease }
        );
      } else {
        await safeAddVerificationStep(
          VerificationStatus.MANUAL_REVIEW,
          `👤 REQUIERE REVISIÓN MANUAL - ${!amountMatches ? 'Monto no coincide' : ''} ${!nameMatches ? 'Nombre no coincide' : ''}`,
          { amountVerified: amountMatches, nameVerified: nameMatches, recommendation: 'MANUAL_REVIEW' }
        );
      }

    } catch (error) {
      // Log error with full details for debugging
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({
        orderNumber: order.orderNumber,
        errorMessage: err.message,
        errorStack: err.stack,
        receivedAmountType: typeof match.receivedAmount,
        receivedAmountValue: match.receivedAmount,
        expectedAmountType: typeof order.totalPrice,
        expectedAmountValue: order.totalPrice,
      }, '❌ [PAYMENT MATCH] Error during verification - will still check release status');
    } finally {
      // CRITICAL: Always update pending.nameVerified regardless of errors
      // This ensures checkReadyForRelease has the correct state
      const finalPending = this.pendingReleases.get(order.orderNumber);
      if (finalPending) {
        finalPending.nameVerified = nameMatches;
        logger.info({
          orderNumber: order.orderNumber,
          nameVerified: nameMatches,
          amountMatches,
        }, '📋 [PAYMENT MATCH] Final verification status set');

        // CRITICAL: If name verification FAILED, unmatch the payment so it can match other orders
        // This handles the case where two orders have the same amount but different buyers
        if (!nameMatches && finalPending.bankMatch?.transactionId) {
          const transactionId = finalPending.bankMatch.transactionId;
          logger.warn({
            orderNumber: order.orderNumber,
            transactionId,
            senderName: finalPending.bankMatch.senderName,
          }, '🔄 [NAME MISMATCH] Unmatching payment so it can match other orders with same amount');

          try {
            await db.unmatchPayment(transactionId);
            // Clear bankMatch from pending so this order can match a different payment
            finalPending.bankMatch = undefined;
          } catch (unmatchError) {
            logger.error({ unmatchError, transactionId }, '❌ Failed to unmatch payment');
          }
        }
      }

      // Release the processing lock
      this.processingOrders.delete(order.orderNumber);

      // CRITICAL: Clear throttle before checking - name verification is a significant state change
      this.lastCheckTime.delete(order.orderNumber);

      // ALWAYS call checkReadyForRelease
      await this.checkReadyForRelease(order.orderNumber);
    }
  }

  /**
   * Check if order is ready for automatic release
   */
  private async checkReadyForRelease(orderNumber: string): Promise<void> {
    const pending = this.pendingReleases.get(orderNumber);

    if (!pending) return;

    // Throttle: Skip if we checked this order recently (prevents duplicate processing)
    const now = Date.now();
    const lastCheck = this.lastCheckTime.get(orderNumber) || 0;
    if (now - lastCheck < this.CHECK_THROTTLE_MS) {
      return; // Skip - already checked recently
    }
    this.lastCheckTime.set(orderNumber, now);

    // Check conditions
    const hasBankMatch = !this.config.requireBankMatch || !!pending.bankMatch;
    const hasOcrVerification = !this.config.requireOcrVerification || pending.ocrVerified;
    const meetsConfidence = pending.ocrConfidence >= this.config.minConfidence || !this.config.requireOcrVerification;
    const orderAmount = parseFloat(pending.order.totalPrice);
    const underLimit = orderAmount <= this.config.maxAutoReleaseAmount;

    // Detailed logging only at debug level (reduce noise)
    logger.debug({
      orderNumber,
      amount: orderAmount,
      limit: this.config.maxAutoReleaseAmount,
      underLimit,
      autoReleaseEnabled: this.config.enableAutoRelease,
      hasBankMatch,
      hasOcrVerification,
    }, '[AUTO-RELEASE CHECK]');

    // Helper to log blocked order only once per reason
    const logBlockedOnce = (reason: string, message: string) => {
      const prevReason = this.loggedBlockedOrders.get(orderNumber);
      if (prevReason !== reason) {
        logger.warn(message);
        this.loggedBlockedOrders.set(orderNumber, reason);
      }
    };

    if (!this.config.enableAutoRelease) {
      logBlockedOnce('disabled', `❌ [AUTO-RELEASE BLOCKED] Order ${orderNumber}: Auto-release is DISABLED`);
      this.emit('release', {
        type: 'manual_required',
        orderNumber,
        reason: 'Auto-release disabled',
      } as ReleaseEvent);
      return;
    }

    if (!underLimit) {
      logBlockedOnce('exceeds_limit', `❌ [AUTO-RELEASE BLOCKED] Order ${orderNumber}: Amount $${orderAmount} exceeds limit $${this.config.maxAutoReleaseAmount}`);

      // Update verification status to show in dashboard that manual release is needed
      await db.addVerificationStep(
        orderNumber,
        VerificationStatus.MANUAL_REVIEW,
        `Monto $${orderAmount} excede límite de auto-liberación ($${this.config.maxAutoReleaseAmount}) - Requiere liberación manual`,
        { orderAmount, limit: this.config.maxAutoReleaseAmount, reason: 'exceeds_limit' }
      );

      this.emit('release', {
        type: 'manual_required',
        orderNumber,
        reason: `Amount ${pending.order.totalPrice} exceeds auto-release limit ${this.config.maxAutoReleaseAmount}`,
      } as ReleaseEvent);
      return;
    }

    // BUYER RISK CHECK - Evaluate buyer trustworthiness before auto-release
    // Skip risk check for:
    // 1. Small amounts (≤ threshold) - bank match is sufficient
    // 2. TRUSTED BUYERS - manually verified by admin (STILL requires name match!)
    const skipRiskCheck = orderAmount <= this.config.skipRiskCheckThreshold;

    // Check if buyer is in our trusted buyers list (by nickname OR realName)
    // This handles censored nicknames like "lui***" by also matching on verified real name
    const buyerNickName = pending.order.counterPartNickName || pending.order.buyer?.nickName || '';
    const buyerRealName = (pending.order as any).buyerRealName || pending.order.buyer?.realName || null;
    let isTrustedBuyer = false;

    if (buyerNickName || buyerRealName) {
      try {
        isTrustedBuyer = await db.isTrustedBuyer(buyerNickName, buyerRealName);
        if (isTrustedBuyer) {
          logger.info(
            `⭐ [TRUSTED BUYER] Order ${orderNumber}: Buyer "${buyerNickName}" (${buyerRealName || 'no real name'}) is in trusted list - skipping risk check`
          );
          await db.addVerificationStep(
            orderNumber,
            VerificationStatus.READY_TO_RELEASE,
            `⭐ Comprador de confianza verificado manualmente`,
            {
              buyerNickName,
              buyerRealName,
              trustedBuyer: true,
              noteToCheck: 'Still requires name match verification',
            }
          );
        }
      } catch (error) {
        logger.warn({ error, buyerNickName, buyerRealName }, 'Error checking trusted buyer status');
      }
    }

    if (skipRiskCheck && this.config.enableBuyerRiskCheck && !isTrustedBuyer) {
      logger.info(
        `💚 [BUYER-RISK SKIP] Order ${orderNumber}: Amount $${orderAmount} ≤ $${this.config.skipRiskCheckThreshold} - skipping buyer risk check`
      );
    }

    // Skip risk assessment if:
    // - Amount is below threshold, OR
    // - Buyer is in trusted list
    // NOTE: Name match is ALWAYS required for auto-release (checked earlier in handlePaymentMatch)
    if (this.config.enableBuyerRiskCheck && hasBankMatch && !skipRiskCheck && !isTrustedBuyer) {
      try {
        // Use the new endpoint that gets counterparty stats directly by order number
        // No need to get userNo - queryCounterPartyOrderStatistic returns stats for the buyer
        const riskAssessment = await this.buyerRiskAssessor.assessBuyerByOrder(orderNumber, orderAmount);
        pending.buyerRiskAssessment = riskAssessment;

        if (!riskAssessment.isTrusted) {
          logger.warn(
            `⚠️ [BUYER-RISK BLOCKED] Order ${orderNumber}: Counterparty failed risk assessment - ` +
            `${riskAssessment.failedCriteria.join(', ')}`
          );

          await db.addVerificationStep(
            orderNumber,
            VerificationStatus.MANUAL_REVIEW,
            `👤 REQUIERE VERIFICACIÓN MANUAL - Comprador no cumple criterios de confianza`,
            {
              stats: riskAssessment.stats,
              failedCriteria: riskAssessment.failedCriteria,
              recommendation: riskAssessment.recommendation,
            }
          );

          this.emit('release', {
            type: 'manual_required',
            orderNumber,
            reason: `Buyer risk assessment failed: ${riskAssessment.failedCriteria.join(', ')}`,
            data: { riskAssessment },
          } as ReleaseEvent);
          return;
        }

        // Buyer is trusted - log and continue
        logger.info(
          `✅ [BUYER-RISK OK] Order ${orderNumber}: Counterparty passed risk assessment - ` +
          `orders=${riskAssessment.stats?.totalOrders}, days=${riskAssessment.stats?.registerDays}, ` +
          `positive=${((riskAssessment.stats?.positiveRate || 0) * 100).toFixed(0)}%`
        );

        await db.addVerificationStep(
          orderNumber,
          VerificationStatus.READY_TO_RELEASE,
          `✅ Comprador verificado - Historial confiable`,
          {
            totalOrders: riskAssessment.stats?.totalOrders,
            orders30Day: riskAssessment.stats?.orders30Day,
            registerDays: riskAssessment.stats?.registerDays,
            positiveRate: riskAssessment.stats?.positiveRate,
          }
        );
      } catch (error) {
        logger.error({ error, orderNumber }, '❌ [BUYER-RISK] Error during buyer risk assessment');
        // On error, require manual verification for safety
        this.emit('release', {
          type: 'manual_required',
          orderNumber,
          reason: 'Error during buyer risk assessment',
        } as ReleaseEvent);
        return;
      }
    }

    // SAFETY: Always require actual bank transaction ID before queueing for release
    // This prevents the race condition where release is attempted before bank payment arrives
    const hasActualBankMatch = !!pending.bankMatch?.transactionId;

    // CRITICAL SAFETY CHECK: Name must be verified to prevent third-party payments
    // Third-party payments are PROHIBITED in Binance P2P (fraud/money laundering risk)
    const nameVerified = pending.nameVerified;

    if (!nameVerified && hasActualBankMatch) {
      // Bank payment received but name doesn't match - BLOCK auto-release
      const logBlockedOnce = (reason: string, message: string) => {
        const prevReason = this.loggedBlockedOrders.get(orderNumber);
        if (prevReason !== reason) {
          logger.warn(message);
          this.loggedBlockedOrders.set(orderNumber, reason);
        }
      };

      logBlockedOnce('name_not_verified',
        `🚫 [AUTO-RELEASE BLOCKED] Order ${orderNumber}: Name verification FAILED - ` +
        `Bank sender does not match Binance buyer (possible third-party payment)`);

      this.emit('release', {
        type: 'manual_required',
        orderNumber,
        reason: 'Name verification failed - bank sender does not match Binance buyer',
      } as ReleaseEvent);
      return;
    }

    if (hasActualBankMatch && hasBankMatch && hasOcrVerification && meetsConfidence && nameVerified) {
      // Ready for release!
      logger.info(`✅ [AUTO-RELEASE READY] Order ${orderNumber}: All conditions met (including name verification), queueing for release`);

      this.emit('release', {
        type: 'verification_complete',
        orderNumber,
        data: {
          bankMatch: !!pending.bankMatch,
          ocrVerified: pending.ocrVerified,
          confidence: pending.ocrConfidence,
          nameVerified: true,
        },
      } as ReleaseEvent);

      await this.queueForRelease(orderNumber);
    } else {
      const missing: string[] = [];
      if (!hasActualBankMatch) missing.push('bank transaction');
      if (!hasBankMatch) missing.push('bank verification');
      if (!hasOcrVerification) missing.push('OCR verification');
      if (!meetsConfidence) missing.push(`confidence too low (${(pending.ocrConfidence * 100).toFixed(0)}% < ${(this.config.minConfidence * 100).toFixed(0)}%)`);
      if (!nameVerified) missing.push('NAME VERIFICATION (bank sender must match Binance buyer)');

      logger.debug(`⏳ [AUTO-RELEASE WAITING] Order ${orderNumber}: Missing ${missing.join(', ')}`);
    }
  }

  // ==================== RELEASE EXECUTION ====================

  /**
   * Queue order for release
   */
  private async queueForRelease(orderNumber: string): Promise<void> {
    if (this.releaseQueue.includes(orderNumber)) {
      return; // Already queued
    }

    this.releaseQueue.push(orderNumber);

    this.emit('release', {
      type: 'release_queued',
      orderNumber,
    } as ReleaseEvent);

    logger.info({
      orderNumber,
      queuePosition: this.releaseQueue.length,
    }, 'Order queued for release');

    // Add delay before release
    setTimeout(
      () => this.processReleaseQueue(),
      this.config.releaseDelayMs
    );
  }

  /**
   * Process release queue
   */
  private async processReleaseQueue(): Promise<void> {
    if (this.processing || this.releaseQueue.length === 0) {
      return;
    }

    this.processing = true;

    try {
      while (this.releaseQueue.length > 0) {
        const orderNumber = this.releaseQueue.shift()!;
        await this.executeRelease(orderNumber);

        // Small delay between releases
        await this.sleep(1000);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Execute crypto release
   */
  private async executeRelease(orderNumber: string): Promise<void> {
    const pending = this.pendingReleases.get(orderNumber);

    if (!pending) {
      logger.warn({ orderNumber }, 'Order not found for release');
      return;
    }

    // CRITICAL: Double-spend protection - verify payment wasn't already used
    if (pending.bankMatch?.transactionId) {
      const doubleSpendCheck = await db.isPaymentAlreadyReleased(pending.bankMatch.transactionId);
      if (doubleSpendCheck.released) {
        logger.error({
          orderNumber,
          transactionId: pending.bankMatch.transactionId,
          previousOrder: doubleSpendCheck.orderNumber,
          previousReleasedAt: doubleSpendCheck.releasedAt,
        }, '🚫 [DOUBLE-SPEND BLOCKED] This payment was already used to release another order!');

        // Create critical alert
        await db.createAlert({
          type: 'double_spend_attempt',
          severity: 'critical',
          title: 'Intento de doble uso de pago detectado',
          message: `El pago ${pending.bankMatch.transactionId} ya fue usado para liberar la orden ${doubleSpendCheck.orderNumber}`,
          orderNumber,
          metadata: {
            transactionId: pending.bankMatch.transactionId,
            currentOrder: orderNumber,
            previousOrder: doubleSpendCheck.orderNumber,
            previousReleasedAt: doubleSpendCheck.releasedAt,
          },
        });

        // Cleanup
        this.pendingReleases.delete(orderNumber);
        this.emit('release', {
          type: 'release_failed',
          orderNumber,
          reason: 'Double-spend attempt blocked - payment already used for another order',
        } as ReleaseEvent);
        return;
      }
    }

    // Check order is still in BUYER_PAYED status (waiting for release)
    let currentOrder = this.orderManager.getOrder(orderNumber);

    // If order not in orderManager memory, use the one from pending (DB order)
    if (!currentOrder && pending.order) {
      logger.info(
        `🔗 [AUTO-RELEASE] Order ${orderNumber} not in orderManager memory - ` +
        `using pending order (amount: ${pending.order.totalPrice})`
      );
      currentOrder = pending.order;
    }

    // ALWAYS register/update the order with bank transaction info for release verification
    // This ensures pendingMatches has the bankTransactionId even if order was already in memory
    if (currentOrder && pending.bankMatch?.transactionId) {
      logger.info(
        `🔗 [AUTO-RELEASE] Registering order ${orderNumber} with bank transaction ${pending.bankMatch.transactionId}`
      );
      this.orderManager.registerOrderForRelease(
        currentOrder,
        pending.bankMatch.transactionId
      );
    }

    if (!currentOrder || currentOrder.orderStatus !== 'BUYER_PAYED') {
      logger.warn({
        orderNumber,
        status: currentOrder?.orderStatus,
      }, 'Order status changed, skipping release');
      return;
    }

    pending.attempts++;

    try {
      // Get verification code
      if (!this.getVerificationCode) {
        throw new Error('No verification code provider set');
      }

      const verificationCode = await this.getVerificationCode(
        orderNumber,
        this.config.authType
      );

      // Send confirmation message to buyer
      await this.chatHandler.sendPaymentConfirmation(orderNumber);

      // Release crypto
      const success = await this.orderManager.releaseCrypto(
        orderNumber,
        this.config.authType,
        verificationCode
      );

      if (success) {
        logger.info({
          orderNumber,
          amount: pending.order.totalPrice,
          asset: pending.order.asset,
        }, 'Crypto released successfully');

        // Update trusted buyer stats if applicable
        const buyerNickName = pending.order.counterPartNickName || pending.order.buyer?.nickName || '';
        const buyerRealName = (pending.order as any).buyerRealName || pending.order.buyer?.realName || null;
        if (buyerNickName || buyerRealName) {
          try {
            const isTrusted = await db.isTrustedBuyer(buyerNickName, buyerRealName);
            if (isTrusted) {
              const orderAmount = parseFloat(pending.order.totalPrice);
              await db.incrementTrustedBuyerStats(buyerNickName, orderAmount);
              logger.info(
                `⭐ [TRUSTED BUYER] Updated stats for "${buyerNickName}" (${buyerRealName || 'no name'}) - auto-released $${orderAmount}`
              );
            }
          } catch (err) {
            logger.warn({ err, buyerNickName, buyerRealName }, 'Error updating trusted buyer stats');
          }
        }

        this.emit('release', {
          type: 'release_success',
          orderNumber,
          data: {
            amount: pending.order.totalPrice,
            asset: pending.order.asset,
          },
        } as ReleaseEvent);

        // Cleanup all maps for this order
        this.pendingReleases.delete(orderNumber);
        this.lastCheckTime.delete(orderNumber);
        this.loggedBlockedOrders.delete(orderNumber);
      } else {
        throw new Error('Release API call failed');
      }
    } catch (error) {
      logger.error({
        orderNumber,
        error,
        attempts: pending.attempts,
      }, 'Failed to release crypto');

      if (pending.attempts < 3) {
        // Wait for next TOTP window before retrying to ensure fresh code
        try {
          const totpService = getTOTPService();
          if (totpService.isConfigured()) {
            logger.info({ orderNumber }, '🔄 [RETRY] Waiting for next TOTP window before retry...');
            await totpService.waitForNextWindowAndGenerate(); // This waits and generates, we discard the code
          }
        } catch (totpError) {
          logger.warn({ orderNumber, totpError }, 'Failed to wait for TOTP window');
        }

        // Retry with fresh code
        this.releaseQueue.push(orderNumber);
        logger.info({ orderNumber, attempt: pending.attempts }, '🔄 [RETRY] Order re-queued for release with fresh TOTP code');
      } else {
        this.emit('release', {
          type: 'release_failed',
          orderNumber,
          reason: error instanceof Error ? error.message : 'Unknown error',
        } as ReleaseEvent);

        this.emit('release', {
          type: 'manual_required',
          orderNumber,
          reason: 'Max release attempts exceeded',
        } as ReleaseEvent);
      }
    }
  }

  // ==================== CONFIGURATION ====================

  /**
   * Set verification code provider
   */
  setVerificationCodeProvider(
    provider: (orderNumber: string, authType: AuthType) => Promise<string>
  ): void {
    this.getVerificationCode = provider;
    logger.info('Verification code provider set');
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<AutoReleaseConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info({ config: this.config }, 'Auto-release config updated');
  }

  // ==================== MANUAL OPERATIONS ====================

  /**
   * Manually approve release
   */
  async manualApprove(orderNumber: string): Promise<void> {
    const pending = this.pendingReleases.get(orderNumber);

    if (!pending) {
      const order = this.orderManager.getOrder(orderNumber);
      if (order) {
        this.pendingReleases.set(orderNumber, {
          orderNumber,
          order,
          ocrVerified: true,
          ocrConfidence: 1.0,
          nameVerified: true, // Manual approval overrides name check
          queuedAt: new Date(),
          attempts: 0,
        });
      }
    } else {
      pending.ocrVerified = true;
      pending.ocrConfidence = 1.0;
      pending.nameVerified = true; // Manual approval overrides name check
    }

    await this.queueForRelease(orderNumber);
    logger.info({ orderNumber }, 'Manual release approved');
  }

  /**
   * Cancel pending release
   */
  cancelRelease(orderNumber: string): void {
    // Cleanup all maps for this order
    this.pendingReleases.delete(orderNumber);
    this.lastCheckTime.delete(orderNumber);
    this.loggedBlockedOrders.delete(orderNumber);
    this.releaseQueue = this.releaseQueue.filter(o => o !== orderNumber);
    logger.info({ orderNumber }, 'Release cancelled');
  }

  // ==================== STATUS ====================

  /**
   * Get pending releases
   */
  getPendingReleases(): PendingRelease[] {
    return Array.from(this.pendingReleases.values());
  }

  /**
   * Get release queue
   */
  getReleaseQueue(): string[] {
    return [...this.releaseQueue];
  }

  /**
   * Get stats
   */
  getStats(): {
    pendingVerification: number;
    queuedForRelease: number;
    processing: boolean;
  } {
    return {
      pendingVerification: this.pendingReleases.size,
      queuedForRelease: this.releaseQueue.length,
      processing: this.processing,
    };
  }

  // ==================== UTILITIES ====================

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Safely convert any amount value to a number
   * PostgreSQL Decimal comes as string, this handles all cases
   */
  private toNumber(value: any): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return parseFloat(value) || 0;
    if (value && typeof value.toNumber === 'function') return value.toNumber();
    return Number(value) || 0;
  }
}

// Factory function
export function createAutoReleaseOrchestrator(
  config: Partial<AutoReleaseConfig>,
  orderManager: OrderManager,
  chatHandler: ChatHandler,
  webhookReceiver: WebhookReceiver,
  ocrService: OCRService
): AutoReleaseOrchestrator {
  const defaultConfig: AutoReleaseConfig = {
    // Auto-release controlado por variable de entorno
    // ENABLE_AUTO_RELEASE=true para habilitar
    enableAutoRelease: process.env.ENABLE_AUTO_RELEASE === 'true',
    requireBankMatch: process.env.REQUIRE_BANK_MATCH === 'true',
    requireOcrVerification: process.env.REQUIRE_OCR_VERIFICATION !== 'false',
    // Buyer risk check - evaluates buyer history before auto-release
    // ENABLE_BUYER_RISK_CHECK=true para habilitar
    enableBuyerRiskCheck: process.env.ENABLE_BUYER_RISK_CHECK === 'true',
    // Skip risk check for small amounts - default $800 MXN
    skipRiskCheckThreshold: parseFloat(process.env.SKIP_RISK_CHECK_THRESHOLD || '800'),
    authType: (process.env.RELEASE_AUTH_TYPE as AuthType) || AuthType.GOOGLE,
    minConfidence: parseFloat(process.env.OCR_MIN_CONFIDENCE || '0.7'),
    releaseDelayMs: parseInt(process.env.RELEASE_DELAY_MS || '5000'),
    maxAutoReleaseAmount: parseFloat(process.env.MAX_AUTO_RELEASE_AMOUNT || '50000'),
  };

  return new AutoReleaseOrchestrator(
    { ...defaultConfig, ...config },
    orderManager,
    chatHandler,
    webhookReceiver,
    ocrService
  );
}
