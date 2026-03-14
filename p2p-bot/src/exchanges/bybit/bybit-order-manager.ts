// =====================================================
// BYBIT ORDER MANAGER
// Handles P2P order polling, status tracking, events
// ZERO dependency on Binance or OKX code
// =====================================================

import { EventEmitter } from 'events';
import { BybitClient, getBybitClient } from './bybit-client.js';
import { logger } from '../../utils/logger.js';
import { saveOrder, getStaleOrders, getVerificationTimeline } from '../../services/database-pg.js';
import {
  BybitOrderData,
  BybitOrderEvent,
  OrderData,
  OrderMatch,
  BankWebhookPayload,
  toOrderData,
  mapBybitOrderStatus,
} from './bybit-types.js';

const log = logger.child({ module: 'bybit-orders' });

// ==================== CONFIG ====================

export interface BybitOrderManagerConfig {
  pollIntervalMs: number;
  tradeType: 'buy' | 'sell';
}

// ==================== ORDER MANAGER ====================

export class BybitOrderManager extends EventEmitter {
  private client: BybitClient;
  private config: BybitOrderManagerConfig;
  private activeOrders: Map<string, OrderData> = new Map();
  private pendingMatches: Map<string, OrderMatch> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private staleInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isPolling = false;
  private isCheckingStale = false;

  constructor(config: BybitOrderManagerConfig) {
    super();
    this.client = getBybitClient();
    this.config = config;
    log.info({ config }, 'Bybit Order manager initialized');
  }

  // ==================== LIFECYCLE ====================

  async start(): Promise<void> {
    if (this.isRunning) {
      log.warn('Bybit Order manager already running');
      return;
    }

    this.isRunning = true;
    log.info({ interval: this.config.pollIntervalMs }, 'Starting Bybit order polling');

    // Sync existing orders first
    await this.syncAllOrders();

    // Initial poll
    await this.pollOrders();

    // Schedule periodic polling
    this.pollInterval = setInterval(
      () => this.pollOrders(),
      this.config.pollIntervalMs
    );

    // Schedule stale order recovery every 60 seconds
    this.staleInterval = setInterval(
      () => this.checkStaleOrders(),
      60_000
    );
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.staleInterval) {
      clearInterval(this.staleInterval);
      this.staleInterval = null;
    }
    this.isRunning = false;
    log.info('Bybit Order manager stopped');
  }

  // ==================== SYNC ====================

  private async syncAllOrders(): Promise<void> {
    log.info('Syncing all orders from Bybit to database...');

    try {
      const side = this.config.tradeType === 'sell' ? 1 : 0;

      // Get pending orders
      const { items: pendingOrders } = await this.client.listPendingOrders({ side, size: 30 });
      log.info({ count: pendingOrders.length }, 'Found pending Bybit orders');

      // Get recent completed orders
      const { items: recentOrders } = await this.client.listOrders({
        page: 1,
        size: 30,
        side,
      });
      log.info({ count: recentOrders.length }, 'Found recent Bybit orders');

      // Combine and deduplicate
      const allOrders = new Map<string, BybitOrderData>();
      for (const order of [...recentOrders, ...pendingOrders]) {
        allOrders.set(order.id, order);
      }

      log.info({ total: allOrders.size }, 'Total unique Bybit orders to sync');

      let savedCount = 0;
      for (const bybitOrder of allOrders.values()) {
        const order = toOrderData(bybitOrder);

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
                this.emit('order', { type: 'paid', order } as BybitOrderEvent);
              }, 1000);
            }
          }
        } catch {
          // Likely duplicate, skip
        }
      }

      log.info({ savedCount, activeTracking: this.activeOrders.size }, 'Bybit order sync complete');

      // Also sync BUY orders to database (side: 0) — save only, don't track in activeOrders
      if (side !== 0) {
        try {
          const buySide = 0;
          const { items: buyPending } = await this.client.listPendingOrders({ side: buySide, size: 30 });
          const { items: buyRecent } = await this.client.listOrders({ page: 1, size: 30, side: buySide });

          const allBuyOrders = new Map<string, BybitOrderData>();
          for (const order of [...buyRecent, ...buyPending]) {
            allBuyOrders.set(order.id, order);
          }

          let buySavedCount = 0;
          for (const bybitOrder of allBuyOrders.values()) {
            const order = toOrderData(bybitOrder);
            try {
              await saveOrder(order);
              buySavedCount++;
            } catch { /* skip duplicates */ }
          }
          log.info({ buySavedCount, total: allBuyOrders.size }, 'Bybit BUY order sync complete');
        } catch (buyError) {
          log.error({ error: buyError }, 'Failed to sync Bybit BUY orders');
        }
      }
    } catch (error) {
      log.error({ error }, 'Failed to sync Bybit orders');
    }
  }

  // ==================== POLLING ====================

  private async pollOrders(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const side = this.config.tradeType === 'sell' ? 1 : 0;

      // Get pending orders (most important — these are active)
      const { items: pendingOrders } = await this.client.listPendingOrders({ side, size: 30 });

      for (const bybitOrder of pendingOrders) {
        const order = toOrderData(bybitOrder);
        await this.processOrder(order);
      }

      // Get recent completed/cancelled to detect status changes
      const { items: recentOrders } = await this.client.listOrders({
        page: 1,
        size: 20,
        side,
      });

      for (const bybitOrder of recentOrders) {
        const order = toOrderData(bybitOrder);
        const tracked = this.activeOrders.get(order.orderNumber);
        if (tracked && tracked.orderStatus !== order.orderStatus) {
          await this.processOrder(order);
        }
      }

      // Also sync BUY orders to database (side: 0) — save only, don't track in activeOrders
      if (side !== 0) {
        try {
          const buySide = 0;
          const { items: buyPending } = await this.client.listPendingOrders({ side: buySide, size: 30 });
          const { items: buyRecent } = await this.client.listOrders({ page: 1, size: 20, side: buySide });

          for (const bybitOrder of [...buyPending, ...buyRecent]) {
            const order = toOrderData(bybitOrder);
            try { await saveOrder(order); } catch { /* skip duplicates */ }
          }
        } catch (buyError) {
          log.error({ error: buyError }, 'Error polling Bybit BUY orders');
        }
      }
    } catch (error) {
      log.error({ error }, 'Error polling Bybit orders');
    } finally {
      this.isPolling = false;
    }
  }

  // ==================== ORDER PROCESSING ====================

  private async processOrder(order: OrderData): Promise<void> {
    const existing = this.activeOrders.get(order.orderNumber);

    if (!existing) {
      if (!['COMPLETED', 'CANCELLED', 'CANCELLED_BY_SYSTEM'].includes(order.orderStatus)) {
        await this.handleNewOrder(order);
        this.activeOrders.set(order.orderNumber, order);
      } else {
        try { await saveOrder(order); } catch { /* skip */ }
      }
    } else if (existing.orderStatus !== order.orderStatus) {
      await this.handleStatusChange(existing, order);
      if (['COMPLETED', 'CANCELLED', 'CANCELLED_BY_SYSTEM'].includes(order.orderStatus)) {
        // Cleaned up in handleStatusChange
      } else {
        this.activeOrders.set(order.orderNumber, order);
      }
    } else {
      this.activeOrders.set(order.orderNumber, order);
    }
  }

  private async handleNewOrder(order: OrderData): Promise<void> {
    log.info({
      orderId: order.orderNumber,
      amount: order.totalPrice,
      asset: order.asset,
      status: order.orderStatus,
      buyer: order.counterPartNickName,
    }, 'New Bybit order detected');

    // Enrich buyer info from order detail
    await this.enrichBuyerInfo(order);

    try {
      await saveOrder(order);
    } catch (dbError) {
      log.error({ orderId: order.orderNumber, error: dbError }, 'Failed to save Bybit order');
    }

    // Track order
    this.pendingMatches.set(order.orderNumber, {
      orderNumber: order.orderNumber,
      expectedAmount: parseFloat(order.totalPrice),
      verified: false,
    });

    // Emit new order event
    this.emit('order', { type: 'new', order } as BybitOrderEvent);

    // If already paid, also emit paid event
    if (order.orderStatus === 'BUYER_PAYED') {
      log.info({ orderId: order.orderNumber }, 'New Bybit order already BUYER_PAYED - triggering verification');
      this.emit('order', { type: 'paid', order } as BybitOrderEvent);
    }
  }

  private async handleStatusChange(oldOrder: OrderData, newOrder: OrderData): Promise<void> {
    log.info({
      orderId: newOrder.orderNumber,
      oldStatus: oldOrder.orderStatus,
      newStatus: newOrder.orderStatus,
    }, 'Bybit order status changed');

    try { await saveOrder(newOrder); } catch { /* continue */ }

    switch (newOrder.orderStatus) {
      case 'BUYER_PAYED':
        // Enrich buyer info when payment is detected
        await this.enrichBuyerInfo(newOrder);
        try { await saveOrder(newOrder); } catch { /* already saved above */ }
        this.emit('order', { type: 'paid', order: newOrder } as BybitOrderEvent);
        break;

      case 'COMPLETED':
        this.activeOrders.delete(newOrder.orderNumber);
        this.pendingMatches.delete(newOrder.orderNumber);
        this.emit('order', { type: 'released', order: newOrder } as BybitOrderEvent);
        log.info({ orderId: newOrder.orderNumber, amount: newOrder.totalPrice }, 'Bybit order completed');
        break;

      case 'CANCELLED':
      case 'CANCELLED_BY_SYSTEM': {
        // Check if this order was already released — Bybit race condition:
        // buyer can cancel almost simultaneously with release, resulting in
        // status=CANCELLED even though crypto was already released successfully.
        // In that case, treat as COMPLETED instead of CANCELLED.
        let wasReleased = false;
        try {
          const timeline = await getVerificationTimeline(newOrder.orderNumber);
          wasReleased = timeline.some(step => step.status === 'RELEASED');
        } catch { /* DB error — proceed with cancel */ }

        if (wasReleased) {
          log.warn({ orderId: newOrder.orderNumber }, 'Bybit: CANCELLED after RELEASED — ignoring cancel, treating as COMPLETED (Bybit race condition)');
          this.activeOrders.delete(newOrder.orderNumber);
          this.pendingMatches.delete(newOrder.orderNumber);
          newOrder.orderStatus = 'COMPLETED';
          try { await saveOrder(newOrder); } catch { /* continue */ }
          this.emit('order', { type: 'released', order: newOrder } as BybitOrderEvent);
        } else {
          this.activeOrders.delete(newOrder.orderNumber);
          this.pendingMatches.delete(newOrder.orderNumber);
          this.emit('order', { type: 'cancelled', order: newOrder } as BybitOrderEvent);
          log.info({ orderId: newOrder.orderNumber }, 'Bybit order cancelled');
        }
        break;
      }
    }
  }

  // ==================== BUYER INFO ENRICHMENT ====================

  private async enrichBuyerInfo(order: OrderData): Promise<void> {
    try {
      const detail = await this.client.getOrderDetail(order.orderNumber);
      if (!detail) return;

      const isSell = detail.side === 1;

      if (order.buyer) {
        if (detail.buyerRealName) {
          order.buyer.realName = detail.buyerRealName;
        }
        // Enrich buyerUserNo from counterparty
        if (isSell && detail.targetUserId) {
          order.buyer.userNo = detail.targetUserId;
        } else if (!isSell && detail.userId) {
          order.buyer.userNo = detail.userId;
        }
        // Enrich buyer nickName
        if (isSell && detail.targetNickName) {
          order.buyer.nickName = detail.targetNickName;
        }
      }

      if (order.seller && detail.sellerRealName) {
        order.seller.realName = detail.sellerRealName;
      }

      // Update counterPartNickName if missing
      if ((!order.counterPartNickName || order.counterPartNickName === 'unknown') && detail.targetNickName) {
        order.counterPartNickName = detail.targetNickName;
      }

      log.info({
        orderId: order.orderNumber,
        buyerRealName: detail.buyerRealName,
        buyerUserNo: order.buyer?.userNo,
        buyerNickName: order.buyer?.nickName,
      }, 'Enriched buyer info from order detail');
    } catch (error) {
      log.warn({ orderId: order.orderNumber, error }, 'Failed to enrich buyer info');
    }
  }

  // ==================== STALE ORDER RECOVERY ====================

  private async checkStaleOrders(): Promise<void> {
    if (this.isCheckingStale) return;
    this.isCheckingStale = true;

    try {
      const staleOrders = await getStaleOrders(30, 10);
      if (staleOrders.length === 0) return;

      log.info({ count: staleOrders.length }, 'Checking stale orders for recovery');

      for (const stale of staleOrders) {
        try {
          // Fetch current status from Bybit via order detail
          const detail = await this.client.getOrderDetail(stale.orderNumber);
          if (!detail) continue;

          const currentStatus = mapBybitOrderStatus(detail.status);

          if (currentStatus !== stale.status) {
            log.info({
              orderId: stale.orderNumber,
              oldStatus: stale.status,
              newStatus: currentStatus,
            }, 'Stale order status changed — recovering');

            // Build OrderData from detail
            const isSell = detail.side === 1;
            const recoveredOrder: OrderData = {
              orderNumber: detail.id,
              orderStatus: currentStatus,
              tradeType: isSell ? 'SELL' : 'BUY',
              asset: detail.tokenId,
              fiat: detail.currencyId,
              fiatUnit: detail.currencyId,
              fiatSymbol: detail.currencyId === 'MXN' ? 'Mex$' : '$',
              amount: detail.quantity,
              totalPrice: detail.amount,
              unitPrice: detail.price,
              commission: detail.fee || '0',
              createTime: parseInt(detail.createDate) || Date.now(),
              counterPartNickName: detail.targetNickName || 'unknown',
              payMethodName: detail.paymentType || 'BANK',
              advNo: detail.itemId || '',
              buyer: {
                userNo: isSell ? detail.targetUserId : detail.userId,
                nickName: isSell ? detail.targetNickName : detail.nickName,
                realName: detail.buyerRealName,
                userType: 'USER',
                userGrade: 0,
                monthFinishRate: 0,
                monthOrderCount: 0,
              },
              seller: {
                userNo: isSell ? detail.userId : detail.targetUserId,
                nickName: isSell ? detail.nickName : detail.targetNickName,
                realName: detail.sellerRealName,
                userType: 'USER',
                userGrade: 0,
                monthFinishRate: 0,
                monthOrderCount: 0,
              },
            } as OrderData;

            try { await saveOrder(recoveredOrder); } catch { /* continue */ }

            if (currentStatus === 'COMPLETED') {
              this.activeOrders.delete(recoveredOrder.orderNumber);
              this.pendingMatches.delete(recoveredOrder.orderNumber);
              this.emit('order', { type: 'released', order: recoveredOrder } as BybitOrderEvent);
            } else if (currentStatus === 'CANCELLED' || currentStatus === 'CANCELLED_BY_SYSTEM') {
              this.activeOrders.delete(recoveredOrder.orderNumber);
              this.pendingMatches.delete(recoveredOrder.orderNumber);
              this.emit('order', { type: 'cancelled', order: recoveredOrder } as BybitOrderEvent);
            }
          }

          // 500ms delay between checks
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          log.error({ orderId: stale.orderNumber, error }, 'Error recovering stale order');
        }
      }
    } catch (error) {
      log.error({ error }, 'Error checking stale orders');
    } finally {
      this.isCheckingStale = false;
    }
  }

  // ==================== RELEASE & VERIFICATION ====================

  async releaseCrypto(orderNumber: string): Promise<boolean> {
    const order = this.activeOrders.get(orderNumber);
    if (!order) throw new Error('Order not found');

    const match = this.pendingMatches.get(orderNumber);
    if (!match?.verified && !match?.bankTransactionId) {
      throw new Error('Payment not verified');
    }

    await this.client.releaseCrypto(orderNumber);
    return true;
  }

  verifyPayment(orderNumber: string, bankTransactionId?: string): boolean {
    const match = this.pendingMatches.get(orderNumber);
    if (!match) return false;
    match.verified = true;
    if (bankTransactionId) match.bankTransactionId = bankTransactionId;
    return true;
  }

  // ==================== PAYMENT MATCHING ====================

  matchBankPayment(payment: BankWebhookPayload): OrderMatch | null {
    log.info({
      transactionId: payment.transactionId,
      amount: payment.amount,
      sender: payment.senderName,
    }, 'Attempting to match bank payment to Bybit order');

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
        }, 'Payment matched to Bybit order');

        this.emit('order', { type: 'matched', order, match } as BybitOrderEvent);
        return match;
      }
    }

    log.warn({ amount: payment.amount, sender: payment.senderName }, 'No matching Bybit order for payment');
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

  registerOrderForRelease(order: OrderData, bankTransactionId?: string): void {
    log.info({ orderId: order.orderNumber, bankTx: bankTransactionId }, 'Registering Bybit order for release');
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

export function createBybitOrderManager(config?: Partial<BybitOrderManagerConfig>): BybitOrderManager {
  const defaultConfig: BybitOrderManagerConfig = {
    pollIntervalMs: parseInt(process.env.BYBIT_ORDER_POLL_INTERVAL_MS || '5000'),
    tradeType: (process.env.BYBIT_TRADE_TYPE?.toLowerCase() || 'sell') as 'buy' | 'sell',
  };

  return new BybitOrderManager({ ...defaultConfig, ...config });
}
