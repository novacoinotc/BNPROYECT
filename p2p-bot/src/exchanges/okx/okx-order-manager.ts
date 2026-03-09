// =====================================================
// OKX ORDER MANAGER
// Handles P2P order polling, status tracking, events
// Mirrors order-manager.ts patterns for OKX
// =====================================================

import { EventEmitter } from 'events';
import { getOkxClient, OkxClient } from './okx-client.js';
import { logger } from '../../utils/logger.js';
import { saveOrder, getStaleOrders } from '../../services/database-pg.js';
import {
  OkxOrderData,
  OkxOrderEvent,
  OrderData,
  OrderMatch,
  BankWebhookPayload,
  toOrderData,
  mapOkxOrderStatus,
} from './okx-types.js';

const log = logger.child({ module: 'okx-orders' });

// ==================== CONFIG ====================

export interface OkxOrderManagerConfig {
  pollIntervalMs: number;
  maxOpenOrders: number;
  tradeType: 'buy' | 'sell';
}

// ==================== ORDER MANAGER ====================

export class OkxOrderManager extends EventEmitter {
  private client: OkxClient;
  private config: OkxOrderManagerConfig;
  private activeOrders: Map<string, OrderData> = new Map();
  private pendingMatches: Map<string, OrderMatch> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private staleCheckInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isPolling = false;
  private isCheckingStale = false;

  constructor(config: OkxOrderManagerConfig) {
    super();
    this.client = getOkxClient();
    this.config = config;
    log.info({ config }, 'OKX Order manager initialized');
  }

  // ==================== LIFECYCLE ====================

  async start(): Promise<void> {
    if (this.isRunning) {
      log.warn('OKX Order manager already running');
      return;
    }

    this.isRunning = true;
    log.info({ interval: this.config.pollIntervalMs }, 'Starting OKX order polling');

    // Sync existing orders first
    await this.syncAllOrders();

    // Initial poll
    await this.pollOrders();

    // Schedule periodic polling
    this.pollInterval = setInterval(
      () => this.pollOrders(),
      this.config.pollIntervalMs
    );

    // Stale order check every 60s
    this.staleCheckInterval = setInterval(
      () => this.checkStaleOrders(),
      60_000
    );
    setTimeout(() => this.checkStaleOrders(), 15_000);
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.staleCheckInterval) {
      clearInterval(this.staleCheckInterval);
      this.staleCheckInterval = null;
    }
    this.isRunning = false;
    log.info('OKX Order manager stopped');
  }

  // ==================== SYNC ====================

  private async syncAllOrders(): Promise<void> {
    log.info('Syncing all orders from OKX to database...');

    try {
      // Get pending orders
      const pendingOrders = await this.client.listOrders({
        side: this.config.tradeType,
        completionStatus: 'pending',
        pageSize: 50,
      });
      log.info({ count: pendingOrders.length }, 'Found pending OKX orders');

      // Get completed orders (recent history)
      const completedOrders = await this.client.listOrders({
        side: this.config.tradeType,
        completionStatus: 'completed',
        pageSize: 50,
      });
      log.info({ count: completedOrders.length }, 'Found completed OKX orders');

      // Get cancelled orders
      const cancelledOrders = await this.client.listOrders({
        side: this.config.tradeType,
        completionStatus: 'cancelled',
        pageSize: 20,
      });

      // Also get unreleased orders
      const unreleasedOrders = await this.client.getUnreleasedOrders();
      log.info({ count: unreleasedOrders.length }, 'Found unreleased OKX orders');

      // Combine and deduplicate by orderId
      const allOkxOrders = new Map<string, OkxOrderData>();
      for (const order of [...cancelledOrders, ...completedOrders, ...unreleasedOrders, ...pendingOrders]) {
        allOkxOrders.set(order.orderId, order);
      }

      log.info({ total: allOkxOrders.size }, 'Total unique OKX orders to sync');

      let savedCount = 0;
      for (const okxOrder of allOkxOrders.values()) {
        const order = toOrderData(okxOrder);

        try {
          await saveOrder(order);
          savedCount++;

          // Track active orders
          if (!['COMPLETED', 'CANCELLED', 'CANCELLED_BY_SYSTEM'].includes(order.orderStatus)) {
            this.activeOrders.set(order.orderNumber, order);
            this.pendingMatches.set(order.orderNumber, {
              orderNumber: order.orderNumber,
              expectedAmount: parseFloat(order.totalPrice),
              verified: false,
            });

            // Emit paid event for BUYER_PAYED orders
            if (order.orderStatus === 'BUYER_PAYED') {
              log.info({ orderId: order.orderNumber }, 'Synced order in BUYER_PAYED - emitting paid event');
              setTimeout(() => {
                this.emit('order', { type: 'paid', order } as OkxOrderEvent);
              }, 1000);
            }
          }
        } catch {
          // Likely duplicate, skip
        }
      }

      log.info({ savedCount, activeTracking: this.activeOrders.size }, 'OKX order sync complete');
    } catch (error) {
      log.error({ error }, 'Failed to sync OKX orders');
    }
  }

  // ==================== POLLING ====================

  private async pollOrders(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      // Get pending orders
      const pendingOrders = await this.client.listOrders({
        side: this.config.tradeType,
        completionStatus: 'pending',
        pageSize: 50,
      });

      // Process each pending order
      for (const okxOrder of pendingOrders) {
        const order = toOrderData(okxOrder);
        await this.processOrder(order, okxOrder);
      }

      // Get recent completed/cancelled to detect status changes
      const recentCompleted = await this.client.listOrders({
        side: this.config.tradeType,
        completionStatus: 'completed',
        pageSize: 20,
      });

      for (const okxOrder of recentCompleted) {
        const order = toOrderData(okxOrder);
        const tracked = this.activeOrders.get(order.orderNumber);
        if (tracked && tracked.orderStatus !== order.orderStatus) {
          await this.processOrder(order, okxOrder);
        }
      }

      const recentCancelled = await this.client.listOrders({
        side: this.config.tradeType,
        completionStatus: 'cancelled',
        pageSize: 20,
      });

      for (const okxOrder of recentCancelled) {
        const order = toOrderData(okxOrder);
        const tracked = this.activeOrders.get(order.orderNumber);
        if (tracked && tracked.orderStatus !== order.orderStatus) {
          await this.processOrder(order, okxOrder);
        }
      }
    } catch (error) {
      log.error({ error }, 'Error polling OKX orders');
    } finally {
      this.isPolling = false;
    }
  }

  // ==================== ORDER PROCESSING ====================

  private async processOrder(order: OrderData, okxOrder: OkxOrderData): Promise<void> {
    const existing = this.activeOrders.get(order.orderNumber);

    if (!existing) {
      if (!['COMPLETED', 'CANCELLED', 'CANCELLED_BY_SYSTEM'].includes(order.orderStatus)) {
        await this.handleNewOrder(order, okxOrder);
        this.activeOrders.set(order.orderNumber, order);
      } else {
        // Just save completed/cancelled to DB
        try { await saveOrder(order); } catch { /* skip */ }
      }
    } else if (existing.orderStatus !== order.orderStatus) {
      await this.handleStatusChange(existing, order);
      if (['COMPLETED', 'CANCELLED', 'CANCELLED_BY_SYSTEM'].includes(order.orderStatus)) {
        // Removed from active in handleOrderCompleted/Cancelled
      } else {
        this.activeOrders.set(order.orderNumber, order);
      }
    } else {
      // No change, silently update
      this.activeOrders.set(order.orderNumber, order);
    }
  }

  private async handleNewOrder(order: OrderData, okxOrder: OkxOrderData): Promise<void> {
    log.info({
      orderId: order.orderNumber,
      amount: order.totalPrice,
      asset: order.asset,
      status: order.orderStatus,
      buyer: okxOrder.counterpartyDetail?.nickName,
    }, 'New OKX order detected');

    // OKX provides counterparty info inline — no separate API call needed
    // buyer info is already in order via toOrderData()

    try {
      await saveOrder(order);
    } catch (dbError) {
      log.error({ orderId: order.orderNumber, error: dbError }, 'Failed to save OKX order');
    }

    // Track order
    this.pendingMatches.set(order.orderNumber, {
      orderNumber: order.orderNumber,
      expectedAmount: parseFloat(order.totalPrice),
      verified: false,
    });

    // Emit new order event
    this.emit('order', { type: 'new', order } as OkxOrderEvent);

    // If already paid, also emit paid event
    if (order.orderStatus === 'BUYER_PAYED') {
      log.info({ orderId: order.orderNumber }, 'New OKX order already BUYER_PAYED - triggering verification');
      this.emit('order', { type: 'paid', order } as OkxOrderEvent);
    }
  }

  private async handleStatusChange(oldOrder: OrderData, newOrder: OrderData): Promise<void> {
    log.info({
      orderId: newOrder.orderNumber,
      oldStatus: oldOrder.orderStatus,
      newStatus: newOrder.orderStatus,
    }, 'OKX order status changed');

    try { await saveOrder(newOrder); } catch { /* continue */ }

    switch (newOrder.orderStatus) {
      case 'BUYER_PAYED':
        this.emit('order', { type: 'paid', order: newOrder } as OkxOrderEvent);
        break;

      case 'COMPLETED':
        this.activeOrders.delete(newOrder.orderNumber);
        this.pendingMatches.delete(newOrder.orderNumber);
        this.emit('order', { type: 'released', order: newOrder } as OkxOrderEvent);
        log.info({ orderId: newOrder.orderNumber, amount: newOrder.totalPrice }, 'OKX order completed');
        break;

      case 'CANCELLED':
      case 'CANCELLED_BY_SYSTEM':
        this.activeOrders.delete(newOrder.orderNumber);
        this.pendingMatches.delete(newOrder.orderNumber);
        this.emit('order', { type: 'cancelled', order: newOrder } as OkxOrderEvent);
        log.info({ orderId: newOrder.orderNumber }, 'OKX order cancelled');
        break;
    }
  }

  // ==================== STALE ORDER CHECK ====================

  private async checkStaleOrders(): Promise<void> {
    if (this.isCheckingStale) return;
    this.isCheckingStale = true;

    try {
      // Use OKX's unreleased-orders endpoint for stale detection
      const unreleased = await this.client.getUnreleasedOrders();

      for (const okxOrder of unreleased) {
        const orderId = okxOrder.orderId;
        if (!this.activeOrders.has(orderId)) {
          // Order exists on OKX but not tracked locally — add it
          const order = toOrderData(okxOrder);
          if (!['COMPLETED', 'CANCELLED'].includes(order.orderStatus)) {
            this.activeOrders.set(orderId, order);
            this.pendingMatches.set(orderId, {
              orderNumber: orderId,
              expectedAmount: parseFloat(order.totalPrice),
              verified: false,
            });
            try { await saveOrder(order); } catch { /* skip */ }
            log.info({ orderId }, 'Recovered unreleased OKX order');
          }
        }
      }
    } catch (error) {
      log.error({ error }, 'Error checking stale OKX orders');
    } finally {
      this.isCheckingStale = false;
    }
  }

  // ==================== PAYMENT MATCHING ====================

  matchBankPayment(payment: BankWebhookPayload): OrderMatch | null {
    log.info({
      transactionId: payment.transactionId,
      amount: payment.amount,
      sender: payment.senderName,
    }, 'Attempting to match bank payment to OKX order');

    const tolerance = 0.01;

    for (const [orderNumber, match] of this.pendingMatches) {
      const order = this.activeOrders.get(orderNumber);
      if (!order || order.orderStatus !== 'BUYER_PAYED') continue;

      const amountDiff = Math.abs(match.expectedAmount - payment.amount);
      if (amountDiff <= tolerance) {
        match.receivedAmount = payment.amount;
        match.bankTransactionId = payment.transactionId;
        match.senderName = payment.senderName;
        match.matchedAt = new Date();

        log.info({
          orderNumber,
          expectedAmount: match.expectedAmount,
          receivedAmount: payment.amount,
          sender: payment.senderName,
        }, 'Payment matched to OKX order');

        this.emit('order', { type: 'matched', order, match } as OkxOrderEvent);
        return match;
      }
    }

    log.warn({ amount: payment.amount, sender: payment.senderName }, 'No matching OKX order for payment');
    return null;
  }

  // ==================== GETTERS ====================

  getActiveOrders(): OrderData[] {
    return Array.from(this.activeOrders.values());
  }

  getPendingMatches(): OrderMatch[] {
    return Array.from(this.pendingMatches.values());
  }

  getOrder(orderNumber: string): OrderData | undefined {
    return this.activeOrders.get(orderNumber);
  }

  getMatch(orderNumber: string): OrderMatch | undefined {
    return this.pendingMatches.get(orderNumber);
  }

  getStats() {
    const verifiedMatches = Array.from(this.pendingMatches.values()).filter(m => m.verified).length;
    return {
      activeOrders: this.activeOrders.size,
      pendingMatches: this.pendingMatches.size,
      verifiedMatches,
    };
  }

  /**
   * Register an order for release (for orders loaded from DB)
   */
  registerOrderForRelease(order: OrderData, bankTransactionId?: string): void {
    log.info({ orderId: order.orderNumber, bankTx: bankTransactionId }, 'Registering OKX order for release');
    this.activeOrders.set(order.orderNumber, order);
    this.pendingMatches.set(order.orderNumber, {
      orderNumber: order.orderNumber,
      expectedAmount: parseFloat(order.totalPrice),
      verified: !!bankTransactionId,
      bankTransactionId,
    });
  }
}

// ==================== FACTORY ====================

export function createOkxOrderManager(config?: Partial<OkxOrderManagerConfig>): OkxOrderManager {
  const defaultConfig: OkxOrderManagerConfig = {
    pollIntervalMs: parseInt(process.env.OKX_ORDER_POLL_INTERVAL_MS || '5000'),
    maxOpenOrders: parseInt(process.env.OKX_MAX_OPEN_ORDERS || '5'),
    tradeType: (process.env.OKX_TRADE_TYPE?.toLowerCase() || 'sell') as 'buy' | 'sell',
  };

  return new OkxOrderManager({ ...defaultConfig, ...config });
}
