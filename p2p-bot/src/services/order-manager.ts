// =====================================================
// ORDER MANAGER
// Handles P2P order lifecycle and payment verification
// =====================================================

import { EventEmitter } from 'events';
import { getBinanceClient, BinanceC2CClient } from './binance-client.js';
import { orderLogger as logger } from '../utils/logger.js';
import { saveOrder } from './database-pg.js';
import {
  OrderData,
  OrderStatus,
  TradeType,
  OrderMatch,
  UserStats,
  BankWebhookPayload,
  AuthType,
} from '../types/binance.js';

export interface OrderManagerConfig {
  pollIntervalMs: number;
  autoCancelTimeoutMinutes: number;
  minBuyerCompletionRate: number;
  minBuyerOrders: number;
  maxOpenOrders: number;
}

export interface OrderEvent {
  type: 'new' | 'paid' | 'released' | 'cancelled' | 'expired' | 'matched';
  order: OrderData;
  match?: OrderMatch;
}

export class OrderManager extends EventEmitter {
  private client: BinanceC2CClient;
  private config: OrderManagerConfig;
  private activeOrders: Map<string, OrderData> = new Map();
  private pendingMatches: Map<string, OrderMatch> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  constructor(config: OrderManagerConfig) {
    super();
    this.client = getBinanceClient();
    this.config = config;

    logger.info({ config }, 'Order manager initialized');
  }

  // ==================== ORDER POLLING ====================

  /**
   * Start polling for order updates
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Order manager already running');
      return;
    }

    this.isRunning = true;
    logger.info({ interval: this.config.pollIntervalMs }, 'Starting order polling');

    // Sync existing orders from Binance to database first
    await this.syncAllOrders();

    // Initial poll
    this.pollOrders();

    // Schedule periodic polling
    this.pollInterval = setInterval(
      () => this.pollOrders(),
      this.config.pollIntervalMs
    );
  }

  /**
   * Sync all orders from Binance to database (runs at startup)
   * This ensures orders created before bot restart are in the DB
   */
  private async syncAllOrders(): Promise<void> {
    logger.info('Syncing all orders from Binance to database...');

    try {
      // Get pending orders (includes TRADING and BUYER_PAYED)
      const pendingOrders = await this.client.listPendingOrders(50);
      logger.info({ count: pendingOrders.length }, 'Found pending orders to sync');

      // Also get orders via listOrders which may include more statuses
      let activeOrders: OrderData[] = [];
      try {
        activeOrders = await this.client.listOrders({
          tradeType: TradeType.SELL,
          rows: 50,
        });
        logger.info({ count: activeOrders.length }, 'Found active orders via listOrders');
      } catch (err) {
        logger.warn({ error: err }, 'listOrders failed, continuing with pendingOrders only');
      }

      // Get recent order history (includes COMPLETED, CANCELLED)
      const recentOrders = await this.client.listOrderHistory({
        tradeType: TradeType.SELL,
        rows: 100, // Get more history
      });
      logger.info({ count: recentOrders.length }, 'Found recent orders to sync');

      // Combine and deduplicate
      const allOrders = new Map<string, OrderData>();
      for (const order of [...pendingOrders, ...activeOrders, ...recentOrders]) {
        allOrders.set(order.orderNumber, order);
      }

      logger.info({ total: allOrders.size }, 'Total unique orders to sync');

      // Log order statuses for debugging
      const statusCounts: Record<string, number> = {};
      for (const order of allOrders.values()) {
        statusCounts[order.orderStatus] = (statusCounts[order.orderStatus] || 0) + 1;
      }
      logger.info({ statusCounts }, 'Order status breakdown');

      // Save all orders to database
      let savedCount = 0;
      for (const order of allOrders.values()) {
        try {
          await saveOrder(order);
          savedCount++;

          // Track active orders in memory (not completed/cancelled)
          if (!['COMPLETED', 'CANCELLED', 'CANCELLED_BY_SYSTEM'].includes(order.orderStatus)) {
            this.activeOrders.set(order.orderNumber, order);
            this.pendingMatches.set(order.orderNumber, {
              orderNumber: order.orderNumber,
              expectedAmount: parseFloat(order.totalPrice),
              verified: false,
            });
          }
        } catch (err) {
          // Continue on error (might be duplicate)
          logger.debug({ orderNumber: order.orderNumber }, 'Order sync skipped (likely exists)');
        }
      }

      logger.info({ savedCount, activeTracking: this.activeOrders.size }, 'Order sync complete');
    } catch (error) {
      logger.error({ error }, 'Failed to sync orders from Binance');
    }
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.isRunning = false;
    logger.info('Order manager stopped');
  }

  /**
   * Poll for order updates
   */
  private async pollOrders(): Promise<void> {
    try {
      logger.info('Polling orders from Binance...');

      // Get pending orders using the working endpoint
      let pendingOrders: OrderData[] = [];
      try {
        pendingOrders = await this.client.listPendingOrders(20);
        logger.info({ count: pendingOrders.length }, 'Got pending orders from Binance');
      } catch (pendingError) {
        logger.error({ error: pendingError }, 'Failed to get pending orders from Binance');
      }

      // Get recent order history (includes completed/cancelled)
      let recentOrders: OrderData[] = [];
      try {
        recentOrders = await this.client.listOrderHistory({
          tradeType: TradeType.SELL,
          rows: 20,
        });
        logger.info({ count: recentOrders.length }, 'Got recent orders from Binance');
      } catch (recentError) {
        logger.error({ error: recentError }, 'Failed to get recent orders from Binance');
      }

      // Process pending orders first
      for (const order of pendingOrders) {
        await this.processOrder(order);
      }

      // Check recent orders for status changes on orders we're tracking
      // This catches COMPLETED/CANCELLED orders that are no longer in pending
      for (const order of recentOrders) {
        const trackedOrder = this.activeOrders.get(order.orderNumber);
        if (trackedOrder && trackedOrder.orderStatus !== order.orderStatus) {
          // Status changed! Process it
          logger.info({
            orderNumber: order.orderNumber,
            oldStatus: trackedOrder.orderStatus,
            newStatus: order.orderStatus,
          }, 'Detected status change from recent orders');
          await this.processOrder(order);
        }
      }

      // Check for expired/cancelled orders
      await this.checkExpiredOrders();

      // Log poll results (info level so it shows up)
      if (pendingOrders.length > 0 || this.activeOrders.size > 0) {
        logger.info({
          pending: pendingOrders.length,
          recent: recentOrders.length,
          tracking: this.activeOrders.size,
        }, 'Order poll complete');
      }
    } catch (error) {
      logger.error({ error }, 'Error polling orders');
    }
  }

  /**
   * Process individual order
   */
  private async processOrder(order: OrderData): Promise<void> {
    const existingOrder = this.activeOrders.get(order.orderNumber);

    if (!existingOrder) {
      // New order detected - only track if not completed/cancelled
      if (!['COMPLETED', 'CANCELLED', 'CANCELLED_BY_SYSTEM'].includes(order.orderStatus)) {
        await this.handleNewOrder(order);
        this.activeOrders.set(order.orderNumber, order);
      }
    } else if (existingOrder.orderStatus !== order.orderStatus) {
      // Status changed
      await this.handleStatusChange(existingOrder, order);

      // Only keep in activeOrders if still active
      if (['COMPLETED', 'CANCELLED', 'CANCELLED_BY_SYSTEM'].includes(order.orderStatus)) {
        // Already removed by handleOrderCompleted/handleOrderCancelled
      } else {
        this.activeOrders.set(order.orderNumber, order);
      }
    }
  }

  // ==================== ORDER HANDLERS ====================

  /**
   * Handle new order
   */
  private async handleNewOrder(order: OrderData): Promise<void> {
    logger.info({
      orderNumber: order.orderNumber,
      amount: order.totalPrice,
      asset: order.asset,
      status: order.orderStatus,
    }, 'New order detected');

    // Save order to database
    try {
      await saveOrder(order);
      logger.info({ orderNumber: order.orderNumber }, 'Order saved to database');
    } catch (dbError) {
      logger.error({ orderNumber: order.orderNumber, error: dbError }, 'Failed to save order to database');
    }

    // Check if buyer meets requirements (for SELL orders, counterpart is the buyer)
    if (order.tradeType === TradeType.SELL && order.counterPartNickName) {
      // Note: API doesn't provide userNo for counterpart, skip validation for now
      logger.info({
        orderNumber: order.orderNumber,
        counterPart: order.counterPartNickName,
      }, 'SELL order - counterpart is buyer');
    }

    // Check max open orders
    if (this.activeOrders.size >= this.config.maxOpenOrders) {
      logger.warn({
        orderNumber: order.orderNumber,
        maxOrders: this.config.maxOpenOrders,
      }, 'Max open orders reached');
    }

    // Initialize order match tracking
    this.pendingMatches.set(order.orderNumber, {
      orderNumber: order.orderNumber,
      expectedAmount: parseFloat(order.totalPrice),
      verified: false,
    });

    // Emit new order event
    this.emit('order', {
      type: 'new',
      order,
    } as OrderEvent);
  }

  /**
   * Handle order status change
   */
  private async handleStatusChange(
    oldOrder: OrderData,
    newOrder: OrderData
  ): Promise<void> {
    logger.info({
      orderNumber: newOrder.orderNumber,
      oldStatus: oldOrder.orderStatus,
      newStatus: newOrder.orderStatus,
    }, 'Order status changed');

    // Update order in database
    try {
      await saveOrder(newOrder);
    } catch (dbError) {
      logger.error({ orderNumber: newOrder.orderNumber, error: dbError }, 'Failed to update order in database');
    }

    // Status is now a string like "TRADING", "BUYER_PAYED", etc.
    switch (newOrder.orderStatus) {
      case 'BUYER_PAYED':
        // Buyer marked as paid - fetch order detail to get real buyer name
        try {
          const orderDetail = await this.client.getOrderDetail(newOrder.orderNumber);
          // The detail API returns buyer.realName if available
          if (orderDetail.buyer?.realName) {
            (newOrder as any).buyerRealName = orderDetail.buyer.realName;
            logger.info({
              orderNumber: newOrder.orderNumber,
              buyerRealName: orderDetail.buyer.realName,
            }, 'Got real buyer name from order detail');
          }
        } catch (detailError) {
          logger.warn({ orderNumber: newOrder.orderNumber, error: detailError }, 'Could not fetch order detail for buyer name');
        }
        this.emit('order', { type: 'paid', order: newOrder } as OrderEvent);
        break;

      case 'COMPLETED':
        // Order completed (crypto released)
        this.handleOrderCompleted(newOrder);
        break;

      case 'CANCELLED':
      case 'CANCELLED_BY_SYSTEM':
        // Order cancelled
        this.handleOrderCancelled(newOrder);
        break;

      case 'APPEALING':
        logger.warn({
          orderNumber: newOrder.orderNumber,
        }, 'Order in appeal');
        break;
    }
  }

  /**
   * Handle completed order
   */
  private handleOrderCompleted(order: OrderData): void {
    this.activeOrders.delete(order.orderNumber);
    this.pendingMatches.delete(order.orderNumber);

    this.emit('order', { type: 'released', order } as OrderEvent);

    logger.info({
      orderNumber: order.orderNumber,
      amount: order.totalPrice,
    }, 'Order completed');
  }

  /**
   * Handle cancelled order
   */
  private handleOrderCancelled(order: OrderData): void {
    this.activeOrders.delete(order.orderNumber);
    this.pendingMatches.delete(order.orderNumber);

    this.emit('order', { type: 'cancelled', order } as OrderEvent);

    logger.info({
      orderNumber: order.orderNumber,
      status: order.orderStatus,
    }, 'Order cancelled');
  }

  /**
   * Check for expired orders
   */
  private async checkExpiredOrders(): Promise<void> {
    const now = Date.now();

    for (const [orderNumber, order] of this.activeOrders) {
      // Check payment timeout (TRADING = waiting for payment)
      if (
        order.orderStatus === 'TRADING' &&
        order.confirmPayEndTime &&
        now > order.confirmPayEndTime
      ) {
        logger.warn({ orderNumber }, 'Order payment expired');

        // Try to cancel
        try {
          await this.client.cancelOrder(orderNumber);
        } catch (error) {
          logger.error({ orderNumber, error }, 'Failed to cancel expired order');
        }
      }
    }
  }

  // ==================== BUYER VALIDATION ====================

  /**
   * Validate buyer meets minimum requirements
   */
  private async validateBuyer(userNo: string): Promise<boolean> {
    try {
      const stats = await this.client.getUserStats(userNo);

      const meetsCompletionRate =
        stats.finishRateLatest30Day >= this.config.minBuyerCompletionRate;
      const meetsMinOrders =
        stats.completedOrderNumOfLatest30day >= this.config.minBuyerOrders;

      logger.debug({
        userNo,
        completionRate: stats.finishRateLatest30Day,
        orders: stats.completedOrderNumOfLatest30day,
        meetsRequirements: meetsCompletionRate && meetsMinOrders,
      }, 'Buyer validation');

      return meetsCompletionRate && meetsMinOrders;
    } catch (error) {
      logger.error({ userNo, error }, 'Failed to validate buyer');
      return true; // Allow by default on error
    }
  }

  // ==================== PAYMENT MATCHING ====================

  /**
   * Match bank payment to order
   */
  matchBankPayment(payment: BankWebhookPayload): OrderMatch | null {
    logger.info({
      transactionId: payment.transactionId,
      amount: payment.amount,
      sender: payment.senderName,
    }, 'Attempting to match bank payment');

    // Find matching order by amount (with small tolerance)
    const tolerance = 0.01; // 1 cent tolerance

    for (const [orderNumber, match] of this.pendingMatches) {
      const order = this.activeOrders.get(orderNumber);

      // BUYER_PAYED = buyer marked as paid, waiting for release
      if (!order || order.orderStatus !== 'BUYER_PAYED') {
        continue;
      }

      const amountDiff = Math.abs(match.expectedAmount - payment.amount);

      if (amountDiff <= tolerance) {
        // Match found!
        match.receivedAmount = payment.amount;
        match.bankTransactionId = payment.transactionId;
        match.senderName = payment.senderName;
        match.matchedAt = new Date();

        logger.info({
          orderNumber,
          expectedAmount: match.expectedAmount,
          receivedAmount: payment.amount,
          sender: payment.senderName,
        }, 'Payment matched to order');

        this.emit('order', {
          type: 'matched',
          order,
          match,
        } as OrderEvent);

        return match;
      }
    }

    logger.warn({
      amount: payment.amount,
      sender: payment.senderName,
    }, 'No matching order found for payment');

    return null;
  }

  /**
   * Verify payment with receipt (OCR result)
   */
  verifyPayment(
    orderNumber: string,
    receiptUrl: string,
    ocrAmount?: number,
    ocrSenderName?: string
  ): boolean {
    const match = this.pendingMatches.get(orderNumber);
    const order = this.activeOrders.get(orderNumber);

    if (!match || !order) {
      logger.warn({ orderNumber }, 'Order not found for verification');
      return false;
    }

    match.receiptUrl = receiptUrl;

    // Verify amount if OCR provided
    if (ocrAmount) {
      const amountDiff = Math.abs(match.expectedAmount - ocrAmount);
      const tolerance = match.expectedAmount * 0.01; // 1% tolerance

      if (amountDiff > tolerance) {
        logger.warn({
          orderNumber,
          expected: match.expectedAmount,
          ocr: ocrAmount,
        }, 'OCR amount mismatch');
        return false;
      }
    }

    // Optional: Verify sender name
    // Note: API returns counterPartNickName, not buyer.realName
    const counterPartName = order.counterPartNickName || order.buyer?.realName;
    if (ocrSenderName && counterPartName) {
      const nameMatch = this.fuzzyNameMatch(ocrSenderName, counterPartName);
      if (!nameMatch) {
        logger.warn({
          orderNumber,
          expected: counterPartName,
          ocr: ocrSenderName,
        }, 'Sender name mismatch');
        // Don't fail on name mismatch, just log
      }
    }

    match.verified = true;
    logger.info({ orderNumber }, 'Payment verified');

    return true;
  }

  /**
   * Fuzzy name matching
   */
  private fuzzyNameMatch(name1: string, name2: string): boolean {
    const normalize = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]/g, '');

    const n1 = normalize(name1);
    const n2 = normalize(name2);

    // Simple contains check
    return n1.includes(n2) || n2.includes(n1);
  }

  // ==================== RELEASE CRYPTO ====================

  /**
   * Release crypto for verified order
   */
  async releaseCrypto(
    orderNumber: string,
    authType: AuthType,
    verificationCode: string
  ): Promise<boolean> {
    const match = this.pendingMatches.get(orderNumber);
    const order = this.activeOrders.get(orderNumber);

    if (!order) {
      logger.error({ orderNumber }, 'Order not found for release');
      return false;
    }

    if (!match?.verified && !match?.bankTransactionId) {
      logger.warn({ orderNumber }, 'Payment not verified, refusing to release');
      return false;
    }

    try {
      await this.client.releaseCoin({
        orderNumber,
        authType,
        code: verificationCode,
      });

      logger.info({
        orderNumber,
        amount: order.totalPrice,
        asset: order.asset,
      }, 'Crypto released successfully');

      return true;
    } catch (error) {
      logger.error({ orderNumber, error }, 'Failed to release crypto');
      return false;
    }
  }

  // ==================== GETTERS ====================

  /**
   * Get active orders
   */
  getActiveOrders(): OrderData[] {
    return Array.from(this.activeOrders.values());
  }

  /**
   * Get pending matches
   */
  getPendingMatches(): OrderMatch[] {
    return Array.from(this.pendingMatches.values());
  }

  /**
   * Get order by number
   */
  getOrder(orderNumber: string): OrderData | undefined {
    return this.activeOrders.get(orderNumber);
  }

  /**
   * Get match by order number
   */
  getMatch(orderNumber: string): OrderMatch | undefined {
    return this.pendingMatches.get(orderNumber);
  }

  /**
   * Get statistics
   */
  getStats(): {
    activeOrders: number;
    pendingMatches: number;
    verifiedMatches: number;
  } {
    const verifiedMatches = Array.from(this.pendingMatches.values()).filter(
      (m) => m.verified
    ).length;

    return {
      activeOrders: this.activeOrders.size,
      pendingMatches: this.pendingMatches.size,
      verifiedMatches,
    };
  }
}

// Factory function
export function createOrderManager(config?: Partial<OrderManagerConfig>): OrderManager {
  const defaultConfig: OrderManagerConfig = {
    pollIntervalMs: parseInt(process.env.ORDER_POLL_INTERVAL_MS || '5000'),
    autoCancelTimeoutMinutes: parseInt(process.env.AUTO_CANCEL_TIMEOUT_MINUTES || '15'),
    minBuyerCompletionRate: parseFloat(process.env.BUYER_MIN_COMPLETION_RATE || '0.95'),
    minBuyerOrders: parseInt(process.env.BUYER_MIN_ORDERS || '10'),
    maxOpenOrders: parseInt(process.env.MAX_OPEN_ORDERS || '5'),
  };

  return new OrderManager({ ...defaultConfig, ...config });
}
