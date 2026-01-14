// =====================================================
// DATABASE SERVICE
// Prisma client wrapper for PostgreSQL operations
// =====================================================

import { PrismaClient, Prisma } from '@prisma/client';
import { logger } from '../utils/logger.js';
import {
  OrderData,
  OrderStatus as BinanceOrderStatus,
  TradeType as BinanceTradeType,
  BankWebhookPayload,
  ChatMessage,
} from '../types/binance.js';

// Prisma client singleton
let prisma: PrismaClient;

export function getPrismaClient(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
    });
  }
  return prisma;
}

// ==================== ORDER OPERATIONS ====================

/**
 * Save or update order
 */
export async function saveOrder(order: OrderData): Promise<void> {
  const db = getPrismaClient();

  const statusMap: Record<number, string> = {
    1: 'PENDING',
    2: 'PAID',
    3: 'APPEALING',
    4: 'COMPLETED',
    5: 'CANCELLED',
    6: 'CANCELLED_SYSTEM',
    7: 'CANCELLED_TIMEOUT',
  };

  try {
    await db.order.upsert({
      where: { orderNumber: order.orderNumber },
      update: {
        status: statusMap[order.orderStatus] as any,
        paidAt: order.orderStatus === BinanceOrderStatus.PAID ? new Date() : undefined,
        releasedAt: order.orderStatus === BinanceOrderStatus.COMPLETED ? new Date() : undefined,
        cancelledAt: [5, 6, 7].includes(order.orderStatus) ? new Date() : undefined,
        updatedAt: new Date(),
      },
      create: {
        orderNumber: order.orderNumber,
        advNo: order.advNo,
        tradeType: order.tradeType as any,
        asset: order.asset,
        fiatUnit: order.fiatUnit,
        amount: new Prisma.Decimal(order.amount),
        totalPrice: new Prisma.Decimal(order.totalPrice),
        unitPrice: new Prisma.Decimal(order.unitPrice),
        commission: new Prisma.Decimal(order.commission),
        status: statusMap[order.orderStatus] as any,
        buyerUserNo: order.buyer.userNo,
        buyerNickName: order.buyer.nickName,
        buyerRealName: order.buyer.realName,
        sellerUserNo: order.seller.userNo,
        sellerNickName: order.seller.nickName,
        binanceCreateTime: new Date(order.createTime),
        confirmPayEndTime: order.confirmPayEndTime
          ? new Date(order.confirmPayEndTime)
          : null,
      },
    });

    logger.debug({ orderNumber: order.orderNumber }, 'Order saved to database');
  } catch (error) {
    logger.error({ error, orderNumber: order.orderNumber }, 'Failed to save order');
  }
}

/**
 * Get order by number
 */
export async function getOrder(orderNumber: string) {
  const db = getPrismaClient();
  return db.order.findUnique({ where: { orderNumber } });
}

/**
 * Get recent orders
 */
export async function getRecentOrders(limit: number = 50) {
  const db = getPrismaClient();
  return db.order.findMany({
    orderBy: { binanceCreateTime: 'desc' },
    take: limit,
    include: { payments: true },
  });
}

// ==================== PAYMENT OPERATIONS ====================

/**
 * Save bank payment
 */
export async function savePayment(payment: BankWebhookPayload): Promise<string> {
  const db = getPrismaClient();

  const result = await db.payment.create({
    data: {
      transactionId: payment.transactionId,
      amount: new Prisma.Decimal(payment.amount),
      currency: payment.currency,
      senderName: payment.senderName,
      senderAccount: payment.senderAccount,
      receiverAccount: payment.receiverAccount,
      concept: payment.concept,
      bankReference: payment.bankReference,
      bankTimestamp: new Date(payment.timestamp),
      status: 'PENDING',
    },
  });

  logger.debug({ transactionId: payment.transactionId }, 'Payment saved');
  return result.id;
}

/**
 * Match payment to order
 */
export async function matchPaymentToOrder(
  transactionId: string,
  orderNumber: string,
  method: 'BANK_WEBHOOK' | 'OCR_RECEIPT' | 'MANUAL',
  ocrConfidence?: number,
  receiptUrl?: string
): Promise<void> {
  const db = getPrismaClient();

  const order = await db.order.findUnique({ where: { orderNumber } });

  if (!order) {
    throw new Error(`Order ${orderNumber} not found`);
  }

  await db.payment.update({
    where: { transactionId },
    data: {
      status: 'MATCHED',
      matchedOrderId: order.id,
      matchedAt: new Date(),
      verificationMethod: method,
      ocrConfidence,
      receiptUrl,
    },
  });

  logger.info({ transactionId, orderNumber }, 'Payment matched to order');
}

/**
 * Mark payment as released
 */
export async function markPaymentReleased(orderNumber: string): Promise<void> {
  const db = getPrismaClient();

  await db.payment.updateMany({
    where: {
      order: { orderNumber },
      status: 'MATCHED',
    },
    data: {
      status: 'RELEASED',
    },
  });
}

/**
 * Mark payment as reversed (chargeback)
 */
export async function markPaymentReversed(transactionId: string): Promise<void> {
  const db = getPrismaClient();

  await db.payment.update({
    where: { transactionId },
    data: { status: 'REVERSED' },
  });

  // Create alert
  await createAlert({
    type: 'reversal',
    severity: 'critical',
    title: 'Payment Reversal Detected',
    message: `Bank transaction ${transactionId} was reversed`,
    metadata: { transactionId },
  });
}

// ==================== CHAT MESSAGE OPERATIONS ====================

/**
 * Save chat message
 */
export async function saveChatMessage(message: ChatMessage): Promise<void> {
  const db = getPrismaClient();

  try {
    await db.chatMessage.create({
      data: {
        messageId: message.id.toString(),
        orderNumber: message.orderNo,
        content: message.content,
        imageUrl: message.imageUrl,
        thumbnailUrl: message.thumbnailUrl,
        messageType: message.type,
        fromNickName: message.fromNickName,
        isSelf: message.self,
        binanceTime: new Date(message.createTime),
      },
    });
  } catch (err: unknown) {
    // Ignore duplicate key errors
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
      logger.error({ error: err }, 'Failed to save chat message');
    }
  }
}

// ==================== PRICE HISTORY ====================

/**
 * Save price snapshot
 */
export async function savePriceHistory(data: {
  asset: string;
  fiat: string;
  tradeType: BinanceTradeType;
  referencePrice: number;
  bestCompetitor: number;
  averagePrice: number;
  ourPrice: number;
  margin: number;
  pricePosition: string;
}): Promise<void> {
  const db = getPrismaClient();

  await db.priceHistory.create({
    data: {
      asset: data.asset,
      fiat: data.fiat,
      tradeType: data.tradeType as any,
      referencePrice: new Prisma.Decimal(data.referencePrice),
      bestCompetitor: new Prisma.Decimal(data.bestCompetitor),
      averagePrice: new Prisma.Decimal(data.averagePrice),
      ourPrice: new Prisma.Decimal(data.ourPrice),
      margin: data.margin,
      pricePosition: data.pricePosition,
    },
  });
}

// ==================== DAILY STATS ====================

/**
 * Update daily statistics
 */
export async function updateDailyStats(
  date: Date,
  update: Partial<{
    totalOrders: number;
    completedOrders: number;
    cancelledOrders: number;
    totalVolumeFiat: number;
    totalVolumeAsset: number;
    totalCommission: number;
    avgMargin: number;
    avgPrice: number;
  }>
): Promise<void> {
  const db = getPrismaClient();

  const dateOnly = new Date(date.toISOString().split('T')[0]);

  await db.dailyStats.upsert({
    where: { date: dateOnly },
    update: {
      totalOrders: update.totalOrders !== undefined
        ? { increment: update.totalOrders }
        : undefined,
      completedOrders: update.completedOrders !== undefined
        ? { increment: update.completedOrders }
        : undefined,
      cancelledOrders: update.cancelledOrders !== undefined
        ? { increment: update.cancelledOrders }
        : undefined,
      totalVolumeFiat: update.totalVolumeFiat !== undefined
        ? { increment: update.totalVolumeFiat }
        : undefined,
      totalVolumeAsset: update.totalVolumeAsset !== undefined
        ? { increment: update.totalVolumeAsset }
        : undefined,
      totalCommission: update.totalCommission !== undefined
        ? { increment: update.totalCommission }
        : undefined,
    },
    create: {
      date: dateOnly,
      totalOrders: update.totalOrders || 0,
      completedOrders: update.completedOrders || 0,
      cancelledOrders: update.cancelledOrders || 0,
      totalVolumeFiat: new Prisma.Decimal(update.totalVolumeFiat || 0),
      totalVolumeAsset: new Prisma.Decimal(update.totalVolumeAsset || 0),
      totalCommission: new Prisma.Decimal(update.totalCommission || 0),
      avgMargin: update.avgMargin || 0,
      avgPrice: new Prisma.Decimal(update.avgPrice || 0),
    },
  });
}

/**
 * Get daily stats for date range
 */
export async function getDailyStats(startDate: Date, endDate: Date) {
  const db = getPrismaClient();

  return db.dailyStats.findMany({
    where: {
      date: {
        gte: startDate,
        lte: endDate,
      },
    },
    orderBy: { date: 'desc' },
  });
}

// ==================== BUYER CACHE ====================

/**
 * Get or create buyer cache
 */
export async function getOrCreateBuyer(userNo: string, nickName: string) {
  const db = getPrismaClient();

  return db.buyerCache.upsert({
    where: { userNo },
    update: {
      nickName,
      ordersWithUs: { increment: 1 },
      lastOrderAt: new Date(),
    },
    create: {
      userNo,
      nickName,
      ordersWithUs: 1,
      lastOrderAt: new Date(),
    },
  });
}

/**
 * Update buyer stats
 */
export async function updateBuyerStats(
  userNo: string,
  stats: {
    completedOrders?: number;
    completedOrders30d?: number;
    finishRate?: number;
    finishRate30d?: number;
    avgPayTime?: number;
    creditScore?: number;
    registerDays?: number;
  }
): Promise<void> {
  const db = getPrismaClient();

  await db.buyerCache.update({
    where: { userNo },
    data: stats,
  });
}

/**
 * Block buyer
 */
export async function blockBuyer(userNo: string, reason: string): Promise<void> {
  const db = getPrismaClient();

  await db.buyerCache.update({
    where: { userNo },
    data: {
      isBlocked: true,
      blockReason: reason,
    },
  });

  logger.warn({ userNo, reason }, 'Buyer blocked');
}

/**
 * Check if buyer is blocked
 */
export async function isBuyerBlocked(userNo: string): Promise<boolean> {
  const db = getPrismaClient();

  const buyer = await db.buyerCache.findUnique({
    where: { userNo },
    select: { isBlocked: true },
  });

  return buyer?.isBlocked ?? false;
}

// ==================== ALERTS ====================

/**
 * Create alert
 */
export async function createAlert(data: {
  type: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  title: string;
  message: string;
  orderNumber?: string;
  metadata?: any;
}): Promise<void> {
  const db = getPrismaClient();

  await db.alert.create({
    data: {
      type: data.type,
      severity: data.severity,
      title: data.title,
      message: data.message,
      orderNumber: data.orderNumber,
      metadata: data.metadata,
    },
  });

  logger.info({ type: data.type, severity: data.severity }, 'Alert created');
}

/**
 * Get unacknowledged alerts
 */
export async function getUnacknowledgedAlerts() {
  const db = getPrismaClient();

  return db.alert.findMany({
    where: { acknowledged: false },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Acknowledge alert
 */
export async function acknowledgeAlert(id: string, by: string): Promise<void> {
  const db = getPrismaClient();

  await db.alert.update({
    where: { id },
    data: {
      acknowledged: true,
      acknowledgedAt: new Date(),
      acknowledgedBy: by,
    },
  });
}

// ==================== AUDIT LOG ====================

/**
 * Log action
 */
export async function logAction(
  action: string,
  orderNumber?: string,
  details?: any,
  success: boolean = true,
  error?: string
): Promise<void> {
  const db = getPrismaClient();

  await db.auditLog.create({
    data: {
      action,
      orderNumber,
      details,
      success,
      error,
    },
  });
}

// ==================== CLEANUP ====================

/**
 * Disconnect from database
 */
export async function disconnect(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    logger.info('Database disconnected');
  }
}
