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

    // Create pending release record
    const pending: PendingRelease = {
      orderNumber: order.orderNumber,
      order,
      bankMatch: {
        transactionId: payment.transactionId,
        amount: payment.amount,
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
      queuedAt: new Date(),
      attempts: 0,
    };

    this.pendingReleases.set(order.orderNumber, pending);

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
        // Cleanup
        this.pendingReleases.delete(event.order.orderNumber);
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
   * Implements bidirectional matching: searches for orders awaiting this payment
   */
  private async handleBankPayment(event: WebhookEvent): Promise<void> {
    const payment = event.payload;

    logger.info({
      transactionId: payment.transactionId,
      amount: payment.amount,
      sender: payment.senderName,
    }, '💰 Processing bank payment webhook');

    // First try in-memory match (for orders already being tracked)
    const match = this.orderManager.matchBankPayment(payment);

    if (match) {
      const order = this.orderManager.getOrder(match.orderNumber);
      if (order) {
        logger.info({
          orderNumber: match.orderNumber,
          transactionId: payment.transactionId,
        }, '✅ Bank payment matched (in-memory)');

        await db.matchPaymentToOrder(payment.transactionId, match.orderNumber, 'BANK_WEBHOOK');
        await this.handlePaymentMatch(order, match);
        return;
      }
    }

    // BIDIRECTIONAL MATCH: Search database for orders awaiting payment
    try {
      const awaitingOrders = await db.findOrdersAwaitingPayment(payment.amount, 1); // 1% tolerance

      if (awaitingOrders.length > 0) {
        logger.info({
          transactionId: payment.transactionId,
          foundOrders: awaitingOrders.length,
          orderNumbers: awaitingOrders.map(o => o.orderNumber),
        }, '🔍 Found orders awaiting this payment amount');

        // Try to match with best candidate
        for (const dbOrder of awaitingOrders) {
          // Use real name if available (matches bank sender name better than nickname)
          const buyerNameToCompare = dbOrder.buyerRealName || dbOrder.buyerNickName;
          const nameMatch = this.compareNames(payment.senderName, buyerNameToCompare);

          logger.info({
            orderNumber: dbOrder.orderNumber,
            paymentSender: payment.senderName,
            orderBuyerNick: dbOrder.buyerNickName,
            orderBuyerReal: dbOrder.buyerRealName,
            comparingWith: buyerNameToCompare,
            nameMatch,
          }, 'Comparing payment sender with order buyer');

          // Match if: name similarity > 30%, OR only one order matches the amount, OR we have real name
          if (nameMatch > 0.3 || awaitingOrders.length === 1 || dbOrder.buyerRealName) {
            // Found a match!
            logger.info({
              orderNumber: dbOrder.orderNumber,
              transactionId: payment.transactionId,
            }, '✅ Bank payment matched to order (order was marked paid first)');

            // Track: payment received and matched
            await db.addVerificationStep(
              dbOrder.orderNumber,
              VerificationStatus.BANK_PAYMENT_RECEIVED,
              `Pago bancario recibido de ${payment.senderName}`,
              {
                transactionId: payment.transactionId,
                receivedAmount: payment.amount,
                senderName: payment.senderName,
              }
            );

            await db.addVerificationStep(
              dbOrder.orderNumber,
              VerificationStatus.PAYMENT_MATCHED,
              `Pago vinculado a orden (orden marcada primero)`,
              {
                transactionId: payment.transactionId,
                receivedAmount: payment.amount,
                expectedAmount: dbOrder.totalPrice,
                nameMatch: nameMatch.toFixed(2),
                matchType: 'order_marked_first',
              }
            );

            // Update DB
            await db.matchPaymentToOrder(payment.transactionId, dbOrder.orderNumber, 'BANK_WEBHOOK');

            // Create order match data
            const orderMatch: OrderMatch = {
              orderNumber: dbOrder.orderNumber,
              bankTransactionId: payment.transactionId,
              receivedAmount: payment.amount,
              expectedAmount: parseFloat(dbOrder.totalPrice),
              senderName: payment.senderName,
              verified: true,
              matchedAt: new Date(),
            };

            // Get full order from order manager
            const order = this.orderManager.getOrder(dbOrder.orderNumber);

            if (order) {
              await this.handlePaymentMatch(order, orderMatch);
            } else {
              // Order not in memory - create minimal order for auto-release check
              logger.info({
                orderNumber: dbOrder.orderNumber,
                amount: dbOrder.totalPrice,
              }, '📦 Order not in memory - processing from DB for auto-release');

              // Create a minimal order object from DB data for auto-release
              const minimalOrder: OrderData = {
                orderNumber: dbOrder.orderNumber,
                orderStatus: 'BUYER_PAYED',
                totalPrice: dbOrder.totalPrice,
                unitPrice: '0',
                amount: '0',
                asset: 'USDT',
                fiat: 'MXN',
                fiatSymbol: 'Mex$',
                counterPartNickName: dbOrder.buyerNickName,
                tradeType: TradeType.SELL,
                createTime: dbOrder.createdAt?.getTime() || Date.now(),
                payMethodName: 'BANK',
                commission: '0',
                advNo: '',
              };

              // Process for auto-release even if order isn't in memory
              await this.handlePaymentMatch(minimalOrder, orderMatch);

              // Also create alert for visibility
              await db.createAlert({
                type: 'payment_matched',
                severity: 'info',
                title: 'Bank payment matched (auto-release triggered)',
                message: `Payment ${payment.transactionId} matched to order ${dbOrder.orderNumber} - checking auto-release`,
                orderNumber: dbOrder.orderNumber,
                metadata: { transactionId: payment.transactionId, amount: payment.amount },
              });
            }

            return;
          }
        }

        // No name match found
        logger.warn({
          transactionId: payment.transactionId,
          amount: payment.amount,
          sender: payment.senderName,
        }, '⚠️ Payment amount matches orders but names do not match');
      }
    } catch (error) {
      logger.error({ error }, 'Error searching for matching orders');
    }

    // No match found - payment is saved in DB by webhook-receiver for future matching
    logger.info({
      transactionId: payment.transactionId,
      amount: payment.amount,
    }, '📝 Payment saved, waiting for order to be marked as paid');
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
        // Remove from release queue
        this.pendingReleases.delete(orderNumber);
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
   */
  private async startVerification(order: OrderData): Promise<void> {
    logger.info({
      orderNumber: order.orderNumber,
      amount: order.totalPrice,
    }, 'Starting payment verification');

    // Track: buyer marked as paid
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

    this.emit('release', {
      type: 'verification_started',
      orderNumber: order.orderNumber,
    } as ReleaseEvent);

    // Initialize pending release record
    const pending: PendingRelease = {
      orderNumber: order.orderNumber,
      order,
      ocrVerified: false,
      ocrConfidence: 0,
      queuedAt: new Date(),
      attempts: 0,
    };

    this.pendingReleases.set(order.orderNumber, pending);

    // BIDIRECTIONAL MATCH: Check if bank payment already arrived before order was marked paid
    try {
      const expectedAmount = parseFloat(order.totalPrice);
      const existingPayments = await db.findUnmatchedPaymentsByAmount(expectedAmount, 1, 120); // 1% tolerance, last 2 hours

      if (existingPayments.length > 0) {
        logger.info({
          orderNumber: order.orderNumber,
          foundPayments: existingPayments.length,
          amounts: existingPayments.map(p => p.amount),
        }, '🔍 Found existing bank payment(s) for order');

        // Try to match with the best candidate
        for (const payment of existingPayments) {
          const nameMatch = this.compareNames(
            payment.senderName,
            order.counterPartNickName || order.buyer?.nickName || ''
          );

          logger.info({
            orderNumber: order.orderNumber,
            paymentSender: payment.senderName,
            orderBuyer: order.counterPartNickName,
            nameMatch,
          }, 'Comparing payment sender with order buyer');

          // If amount matches (already filtered) and name is somewhat similar, consider it a match
          if (nameMatch > 0.3 || existingPayments.length === 1) {
            // Found a match!
            const match: OrderMatch = {
              orderNumber: order.orderNumber,
              bankTransactionId: payment.transactionId,
              receivedAmount: payment.amount,
              expectedAmount: expectedAmount,
              senderName: payment.senderName,
              verified: true,
              matchedAt: new Date(),
            };

            logger.info({
              orderNumber: order.orderNumber,
              transactionId: payment.transactionId,
              amount: payment.amount,
            }, '✅ Bank payment matched to order (payment arrived first)');

            // Track: payment matched
            await db.addVerificationStep(
              order.orderNumber,
              VerificationStatus.PAYMENT_MATCHED,
              `Pago bancario vinculado (pago llegó primero)`,
              {
                transactionId: payment.transactionId,
                receivedAmount: payment.amount,
                senderName: payment.senderName,
                matchType: 'payment_arrived_first',
              }
            );

            // Update DB
            await db.matchPaymentToOrder(payment.transactionId, order.orderNumber, 'BANK_WEBHOOK');

            // Handle the match
            await this.handlePaymentMatch(order, match);
            break;
          }
        }
      }
    } catch (error) {
      logger.error({ error }, 'Error checking for existing payments');
    }

    // Look for existing receipt images in chat
    const existingImages = await this.chatHandler.findReceiptImages(order.orderNumber);

    if (existingImages.length > 0) {
      // Process the most recent image
      await this.handleReceiptImage(existingImages[existingImages.length - 1]);
    }
  }

  /**
   * Compare two names and return similarity score (0-1)
   */
  private compareNames(name1: string, name2: string): number {
    if (!name1 || !name2) return 0;

    const normalize = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
    const n1 = normalize(name1);
    const n2 = normalize(name2);

    if (n1 === n2) return 1;

    // Check if one contains the other
    if (n1.includes(n2) || n2.includes(n1)) return 0.8;

    // Check word overlap
    const words1 = new Set(n1.split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(n2.split(/\s+/).filter(w => w.length > 2));

    let matches = 0;
    for (const word of words1) {
      if (words2.has(word)) matches++;
    }

    const totalWords = Math.max(words1.size, words2.size);
    return totalWords > 0 ? matches / totalWords : 0;
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
   */
  private async handlePaymentMatch(order: OrderData, match: OrderMatch): Promise<void> {
    let pending = this.pendingReleases.get(order.orderNumber);

    if (!pending) {
      // Create pending record if doesn't exist
      pending = {
        orderNumber: order.orderNumber,
        order,
        ocrVerified: false,
        ocrConfidence: 0,
        queuedAt: new Date(),
        attempts: 0,
      };
      this.pendingReleases.set(order.orderNumber, pending);
    }

    // Store bank match info
    pending.bankMatch = {
      transactionId: match.bankTransactionId || '',
      amount: match.receivedAmount || 0,
      currency: order.fiat || order.fiatUnit || 'MXN',
      senderName: match.senderName || '',
      senderAccount: '',
      receiverAccount: '',
      concept: '',
      timestamp: match.matchedAt?.toISOString() || new Date().toISOString(),
      bankReference: '',
      status: 'completed',
    };

    logger.info({
      orderNumber: order.orderNumber,
      bankAmount: match.receivedAmount,
      expectedAmount: match.expectedAmount,
    }, 'Bank payment matched to order');

    // VERIFY AMOUNT
    const expectedAmount = match.expectedAmount || parseFloat(order.totalPrice);
    const receivedAmount = match.receivedAmount || 0;
    const amountDiff = Math.abs(receivedAmount - expectedAmount);
    const amountTolerance = expectedAmount * 0.01; // 1% tolerance
    const amountMatches = amountDiff <= amountTolerance;

    if (amountMatches) {
      await db.addVerificationStep(
        order.orderNumber,
        VerificationStatus.AMOUNT_VERIFIED,
        `Monto verificado: $${receivedAmount.toFixed(2)} ≈ $${expectedAmount.toFixed(2)} (diferencia: $${amountDiff.toFixed(2)})`,
        {
          receivedAmount,
          expectedAmount,
          difference: amountDiff,
          tolerance: amountTolerance,
          withinTolerance: true,
        }
      );
    } else {
      await db.addVerificationStep(
        order.orderNumber,
        VerificationStatus.AMOUNT_MISMATCH,
        `⚠️ ALERTA: Monto no coincide - Recibido: $${receivedAmount.toFixed(2)} vs Esperado: $${expectedAmount.toFixed(2)}`,
        {
          receivedAmount,
          expectedAmount,
          difference: amountDiff,
          tolerance: amountTolerance,
          withinTolerance: false,
        }
      );
    }

    // VERIFY NAME - Use real name if available
    const buyerRealName = (order as any).buyerRealName || order.buyer?.realName;
    const buyerName = buyerRealName || order.counterPartNickName || order.buyer?.nickName || '';
    const senderName = match.senderName || '';
    const nameMatchScore = this.compareNames(senderName, buyerName);
    const hasRealName = !!buyerRealName;
    const nameMatches = hasRealName && nameMatchScore > 0.3;

    if (!hasRealName) {
      await db.addVerificationStep(
        order.orderNumber,
        VerificationStatus.NAME_MISMATCH,
        `⚠️ No se pudo obtener nombre real del comprador - Requiere verificación manual`,
        {
          senderName,
          buyerNickName: order.counterPartNickName,
          reason: 'real_name_not_available',
        }
      );
    } else if (nameMatches) {
      await db.addVerificationStep(
        order.orderNumber,
        VerificationStatus.NAME_VERIFIED,
        `Nombre verificado: "${senderName}" ≈ "${buyerName}" (similitud: ${(nameMatchScore * 100).toFixed(0)}%)`,
        {
          senderName,
          buyerName,
          matchScore: nameMatchScore,
        }
      );
    } else {
      await db.addVerificationStep(
        order.orderNumber,
        VerificationStatus.NAME_MISMATCH,
        `⚠️ ALERTA: Nombre no coincide - SPEI: "${senderName}" vs Binance: "${buyerName}" (similitud: ${(nameMatchScore * 100).toFixed(0)}%)`,
        {
          senderName,
          buyerName,
          matchScore: nameMatchScore,
        }
      );
    }

    // FINAL DETERMINATION
    if (amountMatches && nameMatches) {
      await db.addVerificationStep(
        order.orderNumber,
        VerificationStatus.READY_TO_RELEASE,
        `✅ VERIFICACIÓN COMPLETA - Todas las validaciones pasaron`,
        {
          amountVerified: true,
          nameVerified: true,
          recommendation: 'RELEASE',
          autoReleaseEnabled: this.config.enableAutoRelease,
        }
      );

      if (!this.config.enableAutoRelease) {
        logger.info({
          orderNumber: order.orderNumber,
          amount: receivedAmount,
          sender: senderName,
        }, '🔒 [MODO AUDITORÍA] Verificación completa - Auto-release DESHABILITADO');
      }
    } else {
      await db.addVerificationStep(
        order.orderNumber,
        VerificationStatus.MANUAL_REVIEW,
        `👤 REQUIERE REVISIÓN MANUAL - ${!amountMatches ? 'Monto no coincide' : ''} ${!nameMatches ? 'Nombre no coincide' : ''}`,
        {
          amountVerified: amountMatches,
          nameVerified: nameMatches,
          recommendation: 'MANUAL_REVIEW',
        }
      );
    }

    // Check if ready for release
    await this.checkReadyForRelease(order.orderNumber);
  }

  /**
   * Check if order is ready for automatic release
   */
  private async checkReadyForRelease(orderNumber: string): Promise<void> {
    const pending = this.pendingReleases.get(orderNumber);

    if (!pending) return;

    // Check conditions
    const hasBankMatch = !this.config.requireBankMatch || !!pending.bankMatch;
    const hasOcrVerification = !this.config.requireOcrVerification || pending.ocrVerified;
    const meetsConfidence = pending.ocrConfidence >= this.config.minConfidence || !this.config.requireOcrVerification;
    const orderAmount = parseFloat(pending.order.totalPrice);
    const underLimit = orderAmount <= this.config.maxAutoReleaseAmount;

    // EXPLICIT LOGGING - Show exactly why auto-release may fail
    logger.info(
      `🔍 [AUTO-RELEASE CHECK] Order ${orderNumber}: ` +
      `amount=$${orderAmount} MXN, limit=$${this.config.maxAutoReleaseAmount} MXN, ` +
      `underLimit=${underLimit}, autoReleaseEnabled=${this.config.enableAutoRelease}, ` +
      `hasBankMatch=${hasBankMatch}, hasOcrVerification=${hasOcrVerification}, ` +
      `requireOcr=${this.config.requireOcrVerification}`
    );

    if (!this.config.enableAutoRelease) {
      logger.warn(`❌ [AUTO-RELEASE BLOCKED] Order ${orderNumber}: Auto-release is DISABLED (ENABLE_AUTO_RELEASE env var not set to 'true')`);
      this.emit('release', {
        type: 'manual_required',
        orderNumber,
        reason: 'Auto-release disabled',
      } as ReleaseEvent);
      return;
    }

    if (!underLimit) {
      logger.warn(`❌ [AUTO-RELEASE BLOCKED] Order ${orderNumber}: Amount $${orderAmount} exceeds limit $${this.config.maxAutoReleaseAmount}`);
      this.emit('release', {
        type: 'manual_required',
        orderNumber,
        reason: `Amount ${pending.order.totalPrice} exceeds auto-release limit ${this.config.maxAutoReleaseAmount}`,
      } as ReleaseEvent);
      return;
    }

    // BUYER RISK CHECK - Evaluate buyer trustworthiness before auto-release
    // Skip risk check for small amounts (≤ threshold) - bank match is sufficient
    const skipRiskCheck = orderAmount <= this.config.skipRiskCheckThreshold;

    if (skipRiskCheck && this.config.enableBuyerRiskCheck) {
      logger.info(
        `💚 [BUYER-RISK SKIP] Order ${orderNumber}: Amount $${orderAmount} ≤ $${this.config.skipRiskCheckThreshold} - skipping buyer risk check`
      );
    }

    if (this.config.enableBuyerRiskCheck && hasBankMatch && !skipRiskCheck) {
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

    if (hasBankMatch && hasOcrVerification && meetsConfidence) {
      // Ready for release!
      logger.info(`✅ [AUTO-RELEASE READY] Order ${orderNumber}: All conditions met, queueing for release`);

      this.emit('release', {
        type: 'verification_complete',
        orderNumber,
        data: {
          bankMatch: !!pending.bankMatch,
          ocrVerified: pending.ocrVerified,
          confidence: pending.ocrConfidence,
        },
      } as ReleaseEvent);

      await this.queueForRelease(orderNumber);
    } else {
      const missing: string[] = [];
      if (!hasBankMatch) missing.push('bank confirmation');
      if (!hasOcrVerification) missing.push('OCR verification');
      if (!meetsConfidence) missing.push(`confidence too low (${(pending.ocrConfidence * 100).toFixed(0)}% < ${(this.config.minConfidence * 100).toFixed(0)}%)`);

      logger.info(`⏳ [AUTO-RELEASE WAITING] Order ${orderNumber}: Missing ${missing.join(', ')}`);
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

        this.emit('release', {
          type: 'release_success',
          orderNumber,
          data: {
            amount: pending.order.totalPrice,
            asset: pending.order.asset,
          },
        } as ReleaseEvent);

        this.pendingReleases.delete(orderNumber);
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
        // Retry
        this.releaseQueue.push(orderNumber);
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
          queuedAt: new Date(),
          attempts: 0,
        });
      }
    } else {
      pending.ocrVerified = true;
      pending.ocrConfidence = 1.0;
    }

    await this.queueForRelease(orderNumber);
    logger.info({ orderNumber }, 'Manual release approved');
  }

  /**
   * Cancel pending release
   */
  cancelRelease(orderNumber: string): void {
    this.pendingReleases.delete(orderNumber);
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
