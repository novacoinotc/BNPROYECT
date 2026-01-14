// =====================================================
// DATABASE SERVICE (PostgreSQL native)
// Using pg package instead of Prisma for Railway compatibility
// =====================================================

import pg from 'pg';
import { logger } from '../utils/logger.js';
import {
  OrderData,
  OrderStatusString,
  mapOrderStatus,
  BankWebhookPayload,
  ChatMessage,
  VerificationStatus,
  VerificationStep,
  VerificationResult,
} from '../types/binance.js';

const { Pool } = pg;

// Connection pool singleton
let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false, // Required for Neon
      },
    });
  }
  return pool;
}

// Generate CUID-like ID
function generateId(): string {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 15);
  return `c${timestamp}${randomPart}`;
}

// ==================== CONNECTION ====================

export async function testConnection(): Promise<boolean> {
  try {
    const db = getPool();
    const result = await db.query('SELECT 1 as test');
    logger.info('Database connection successful');
    return true;
  } catch (error) {
    const err = error as Error;
    logger.error({
      errorMessage: err.message,
      errorName: err.name,
    }, 'Database connection failed');
    return false;
  }
}

// ==================== ORDER OPERATIONS ====================

export async function saveOrder(order: OrderData): Promise<void> {
  const db = getPool();

  // Handle string status from API (e.g., "TRADING", "BUYER_PAYED")
  const status = mapOrderStatus(order.orderStatus);

  // API returns counterPartNickName instead of buyer/seller objects
  // For SELL orders: counterPart is the buyer
  // For BUY orders: counterPart is the seller
  const isSellOrder = order.tradeType === 'SELL';
  const counterPartNick = order.counterPartNickName || (order as any).counterPartNickName || 'unknown';

  // Map to buyer/seller based on trade type
  const buyerUserNo = isSellOrder ? 'counterpart' : 'self';
  const buyerNickName = isSellOrder ? counterPartNick : 'self';
  const buyerRealName = null; // Not available in API response
  const sellerUserNo = isSellOrder ? 'self' : 'counterpart';
  const sellerNickName = isSellOrder ? 'self' : counterPartNick;

  try {
    // Try to update first
    const updateResult = await db.query(
      `UPDATE "Order" SET
        status = $1::"OrderStatus",
        "paidAt" = CASE WHEN $2 = 'PAID' AND "paidAt" IS NULL THEN NOW() ELSE "paidAt" END,
        "releasedAt" = CASE WHEN $2 = 'COMPLETED' AND "releasedAt" IS NULL THEN NOW() ELSE "releasedAt" END,
        "cancelledAt" = CASE WHEN $2 IN ('CANCELLED', 'CANCELLED_SYSTEM', 'CANCELLED_TIMEOUT') AND "cancelledAt" IS NULL THEN NOW() ELSE "cancelledAt" END,
        "updatedAt" = NOW()
      WHERE "orderNumber" = $3`,
      [status, status, order.orderNumber]
    );

    // If no rows updated, insert new order
    if (updateResult.rowCount === 0) {
      await db.query(
        `INSERT INTO "Order" (
          id, "orderNumber", "advNo", "tradeType", asset, "fiatUnit",
          amount, "totalPrice", "unitPrice", commission, status,
          "buyerUserNo", "buyerNickName", "buyerRealName",
          "sellerUserNo", "sellerNickName",
          "binanceCreateTime", "confirmPayEndTime",
          "createdAt", "updatedAt"
        ) VALUES ($1, $2, $3, $4::"TradeType", $5, $6, $7, $8, $9, $10, $11::"OrderStatus", $12, $13, $14, $15, $16, $17, $18, NOW(), NOW())`,
        [
          generateId(),
          order.orderNumber,
          order.advNo,
          order.tradeType,
          order.asset,
          order.fiat || order.fiatUnit || 'MXN',  // API returns 'fiat', fallback to fiatUnit
          order.amount,
          order.totalPrice,
          order.unitPrice,
          order.commission,
          status,
          buyerUserNo,
          buyerNickName,
          buyerRealName,
          sellerUserNo,
          sellerNickName,
          new Date(order.createTime),
          order.confirmPayEndTime ? new Date(order.confirmPayEndTime) : null,
        ]
      );
    }

    logger.info({ orderNumber: order.orderNumber }, 'Order saved to database');
  } catch (error) {
    const err = error as Error;
    // Ignore duplicate key errors
    if (!err.message.includes('duplicate key')) {
      logger.error(`Failed to save order ${order.orderNumber}: ${err.message}`);
      throw error;
    }
  }
}

export async function getOrder(orderNumber: string) {
  const db = getPool();
  const result = await db.query(
    'SELECT * FROM "Order" WHERE "orderNumber" = $1',
    [orderNumber]
  );
  return result.rows[0] || null;
}

export async function getRecentOrders(limit: number = 50) {
  const db = getPool();
  const result = await db.query(
    'SELECT * FROM "Order" ORDER BY "binanceCreateTime" DESC LIMIT $1',
    [limit]
  );
  return result.rows;
}

// ==================== PAYMENT OPERATIONS ====================

export async function savePayment(payment: BankWebhookPayload): Promise<string> {
  const db = getPool();
  const id = generateId();

  await db.query(
    `INSERT INTO "Payment" (
      id, "transactionId", amount, currency, "senderName",
      "senderAccount", "receiverAccount", concept, "bankReference",
      "bankTimestamp", status, "createdAt", "updatedAt"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING', NOW(), NOW())`,
    [
      id,
      payment.transactionId,
      payment.amount,
      payment.currency,
      payment.senderName,
      payment.senderAccount || null,
      payment.receiverAccount || null,
      payment.concept || null,
      payment.bankReference || null,
      new Date(payment.timestamp),
    ]
  );

  logger.debug({ transactionId: payment.transactionId }, 'Payment saved');
  return id;
}

export async function matchPaymentToOrder(
  transactionId: string,
  orderNumber: string,
  method: 'BANK_WEBHOOK' | 'OCR_RECEIPT' | 'MANUAL',
  ocrConfidence?: number,
  receiptUrl?: string
): Promise<void> {
  const db = getPool();

  const orderResult = await db.query(
    'SELECT id FROM "Order" WHERE "orderNumber" = $1',
    [orderNumber]
  );

  if (orderResult.rows.length === 0) {
    throw new Error(`Order ${orderNumber} not found`);
  }

  await db.query(
    `UPDATE "Payment" SET
      status = 'MATCHED',
      "matchedOrderId" = $1,
      "matchedAt" = NOW(),
      "verificationMethod" = $2,
      "ocrConfidence" = $3,
      "receiptUrl" = $4,
      "updatedAt" = NOW()
    WHERE "transactionId" = $5`,
    [orderResult.rows[0].id, method, ocrConfidence || null, receiptUrl || null, transactionId]
  );

  logger.info({ transactionId, orderNumber }, 'Payment matched to order');
}

/**
 * Find unmatched payments within amount tolerance (for bidirectional matching)
 * Used when: order becomes BUYER_PAYED -> search for existing bank payments
 */
export async function findUnmatchedPaymentsByAmount(
  expectedAmount: number,
  tolerancePercent: number = 1,
  maxAgeMinutes: number = 60
): Promise<Array<{
  id: string;
  transactionId: string;
  amount: number;
  senderName: string;
  senderAccount: string;
  createdAt: Date;
}>> {
  const db = getPool();
  const tolerance = expectedAmount * (tolerancePercent / 100);
  const minAmount = expectedAmount - tolerance;
  const maxAmount = expectedAmount + tolerance;
  const minTime = new Date(Date.now() - maxAgeMinutes * 60 * 1000);

  const result = await db.query(
    `SELECT id, "transactionId", amount, "senderName", "senderAccount", "createdAt"
     FROM "Payment"
     WHERE status = 'PENDING'
       AND amount BETWEEN $1 AND $2
       AND "createdAt" >= $3
     ORDER BY "createdAt" DESC
     LIMIT 10`,
    [minAmount, maxAmount, minTime]
  );

  return result.rows;
}

/**
 * Find orders awaiting payment verification (BUYER_PAYED status)
 * Used when: bank webhook arrives -> search for orders waiting for this payment
 */
export async function findOrdersAwaitingPayment(
  amount: number,
  tolerancePercent: number = 1
): Promise<Array<{
  orderNumber: string;
  totalPrice: string;
  buyerNickName: string;
  createdAt: Date;
}>> {
  const db = getPool();
  const tolerance = amount * (tolerancePercent / 100);
  const minAmount = amount - tolerance;
  const maxAmount = amount + tolerance;

  const result = await db.query(
    `SELECT "orderNumber", "totalPrice", "buyerNickName", "createdAt"
     FROM "Order"
     WHERE status = 'PAID'
       AND "totalPrice"::numeric BETWEEN $1 AND $2
       AND "releasedAt" IS NULL
     ORDER BY "createdAt" DESC
     LIMIT 10`,
    [minAmount, maxAmount]
  );

  return result.rows;
}

/**
 * Get payment by transaction ID
 */
export async function getPaymentByTransactionId(transactionId: string) {
  const db = getPool();
  const result = await db.query(
    'SELECT * FROM "Payment" WHERE "transactionId" = $1',
    [transactionId]
  );
  return result.rows[0] || null;
}

export async function markPaymentReleased(orderNumber: string): Promise<void> {
  const db = getPool();

  await db.query(
    `UPDATE "Payment" SET status = 'RELEASED', "updatedAt" = NOW()
    WHERE "matchedOrderId" IN (SELECT id FROM "Order" WHERE "orderNumber" = $1)
    AND status = 'MATCHED'`,
    [orderNumber]
  );
}

export async function markPaymentReversed(transactionId: string): Promise<void> {
  const db = getPool();

  await db.query(
    `UPDATE "Payment" SET status = 'REVERSED', "updatedAt" = NOW()
    WHERE "transactionId" = $1`,
    [transactionId]
  );

  await createAlert({
    type: 'reversal',
    severity: 'critical',
    title: 'Payment Reversal Detected',
    message: `Bank transaction ${transactionId} was reversed`,
    metadata: { transactionId },
  });
}

// ==================== CHAT MESSAGE OPERATIONS ====================

export async function saveChatMessage(message: ChatMessage): Promise<void> {
  const db = getPool();

  try {
    await db.query(
      `INSERT INTO "ChatMessage" (
        id, "messageId", "orderNumber", content, "imageUrl", "thumbnailUrl",
        "messageType", "fromNickName", "isSelf", "binanceTime", "createdAt"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
      [
        generateId(),
        message.id.toString(),
        message.orderNo,
        message.content || null,
        message.imageUrl || null,
        message.thumbnailUrl || null,
        message.type,
        message.fromNickName,
        message.self,
        new Date(message.createTime),
      ]
    );
  } catch (err) {
    const error = err as Error;
    if (!error.message.includes('duplicate key')) {
      logger.error({ error: error.message }, 'Failed to save chat message');
    }
  }
}

// ==================== ALERTS ====================

export async function createAlert(data: {
  type: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  title: string;
  message: string;
  orderNumber?: string;
  metadata?: any;
}): Promise<void> {
  const db = getPool();

  await db.query(
    `INSERT INTO "Alert" (
      id, type, severity, title, message, "orderNumber", metadata, acknowledged, "createdAt"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, NOW())`,
    [
      generateId(),
      data.type,
      data.severity,
      data.title,
      data.message,
      data.orderNumber || null,
      data.metadata ? JSON.stringify(data.metadata) : null,
    ]
  );

  logger.info({ type: data.type, severity: data.severity }, 'Alert created');
}

export async function getUnacknowledgedAlerts() {
  const db = getPool();
  const result = await db.query(
    'SELECT * FROM "Alert" WHERE acknowledged = false ORDER BY "createdAt" DESC'
  );
  return result.rows;
}

export async function acknowledgeAlert(id: string, by: string): Promise<void> {
  const db = getPool();

  await db.query(
    `UPDATE "Alert" SET
      acknowledged = true,
      "acknowledgedAt" = NOW(),
      "acknowledgedBy" = $1
    WHERE id = $2`,
    [by, id]
  );
}

// ==================== AUDIT LOG ====================

export async function logAction(
  action: string,
  orderNumber?: string,
  details?: any,
  success: boolean = true,
  error?: string
): Promise<void> {
  const db = getPool();

  await db.query(
    `INSERT INTO "AuditLog" (id, action, "orderNumber", details, success, error, "createdAt")
    VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [
      generateId(),
      action,
      orderNumber || null,
      details ? JSON.stringify(details) : null,
      success,
      error || null,
    ]
  );
}

// ==================== BUYER CACHE ====================

export async function getOrCreateBuyer(userNo: string, nickName: string) {
  const db = getPool();

  // Try to update first
  const updateResult = await db.query(
    `UPDATE "BuyerCache" SET
      "nickName" = $1,
      "ordersWithUs" = "ordersWithUs" + 1,
      "lastOrderAt" = NOW(),
      "updatedAt" = NOW()
    WHERE "userNo" = $2
    RETURNING *`,
    [nickName, userNo]
  );

  if (updateResult.rows.length > 0) {
    return updateResult.rows[0];
  }

  // Insert new buyer
  const insertResult = await db.query(
    `INSERT INTO "BuyerCache" (
      id, "userNo", "nickName", "ordersWithUs", "lastOrderAt", "createdAt", "updatedAt"
    ) VALUES ($1, $2, $3, 1, NOW(), NOW(), NOW())
    RETURNING *`,
    [generateId(), userNo, nickName]
  );

  return insertResult.rows[0];
}

export async function isBuyerBlocked(userNo: string): Promise<boolean> {
  const db = getPool();

  const result = await db.query(
    'SELECT "isBlocked" FROM "BuyerCache" WHERE "userNo" = $1',
    [userNo]
  );

  return result.rows[0]?.isBlocked ?? false;
}

export async function blockBuyer(userNo: string, reason: string): Promise<void> {
  const db = getPool();

  await db.query(
    `UPDATE "BuyerCache" SET
      "isBlocked" = true,
      "blockReason" = $1,
      "updatedAt" = NOW()
    WHERE "userNo" = $2`,
    [reason, userNo]
  );

  logger.warn({ userNo, reason }, 'Buyer blocked');
}

// ==================== VERIFICATION TRACKING ====================

/**
 * Add a verification step to an order's timeline
 */
export async function addVerificationStep(
  orderNumber: string,
  status: VerificationStatus,
  message: string,
  details?: Record<string, any>
): Promise<void> {
  const db = getPool();

  const step: VerificationStep = {
    timestamp: new Date(),
    status,
    message,
    details,
  };

  // Update order with new verification status and append to timeline
  await db.query(
    `UPDATE "Order" SET
      "verificationStatus" = $1,
      "verificationTimeline" = COALESCE("verificationTimeline", '[]'::jsonb) || $2::jsonb,
      "updatedAt" = NOW()
    WHERE "orderNumber" = $3`,
    [status, JSON.stringify([step]), orderNumber]
  );

  // Log with emoji for visibility
  const emoji = getStatusEmoji(status);
  logger.info({ orderNumber, status, message }, `${emoji} ${message}`);
}

/**
 * Get verification timeline for an order
 */
export async function getVerificationTimeline(orderNumber: string): Promise<VerificationStep[]> {
  const db = getPool();

  const result = await db.query(
    `SELECT "verificationTimeline" FROM "Order" WHERE "orderNumber" = $1`,
    [orderNumber]
  );

  return result.rows[0]?.verificationTimeline || [];
}

/**
 * Get full verification result for an order
 */
export async function getVerificationResult(orderNumber: string): Promise<VerificationResult | null> {
  const db = getPool();

  // Get order info
  const orderResult = await db.query(
    `SELECT "orderNumber", "totalPrice", "buyerNickName", "buyerRealName",
            "verificationStatus", "verificationTimeline", "binanceCreateTime", status
     FROM "Order" WHERE "orderNumber" = $1`,
    [orderNumber]
  );

  if (orderResult.rows.length === 0) return null;
  const order = orderResult.rows[0];

  // Get matched payment if any
  const paymentResult = await db.query(
    `SELECT p."transactionId", p.amount, p."senderName", p."createdAt"
     FROM "Payment" p
     JOIN "Order" o ON p."matchedOrderId" = o.id
     WHERE o."orderNumber" = $1 AND p.status IN ('MATCHED', 'RELEASED')`,
    [orderNumber]
  );

  const timeline = order.verificationTimeline || [];
  const currentStatus = order.verificationStatus || VerificationStatus.AWAITING_PAYMENT;
  const payment = paymentResult.rows[0];

  // Determine checks status
  const checks = {
    bankPaymentReceived: !!payment,
    buyerMarkedPaid: order.status === 'PAID' || order.status === 'COMPLETED',
    amountMatches: payment ? Math.abs(payment.amount - parseFloat(order.totalPrice)) < 1 : false,
    nameMatches: null as boolean | null,
  };

  // Determine recommendation
  let recommendation: 'RELEASE' | 'MANUAL_REVIEW' | 'WAIT' = 'WAIT';
  if (currentStatus === VerificationStatus.READY_TO_RELEASE) {
    recommendation = 'RELEASE';
  } else if (currentStatus === VerificationStatus.MANUAL_REVIEW ||
             currentStatus === VerificationStatus.NAME_MISMATCH ||
             currentStatus === VerificationStatus.AMOUNT_MISMATCH) {
    recommendation = 'MANUAL_REVIEW';
  }

  return {
    orderNumber,
    currentStatus,
    timeline,
    recommendation,
    checks,
    bankPayment: payment ? {
      transactionId: payment.transactionId,
      amount: payment.amount,
      senderName: payment.senderName,
      receivedAt: payment.createdAt,
    } : undefined,
    orderDetails: {
      expectedAmount: parseFloat(order.totalPrice),
      buyerName: order.buyerRealName || order.buyerNickName,
      createdAt: order.binanceCreateTime,
    },
  };
}

/**
 * Get orders pending verification (for dashboard)
 */
export async function getOrdersPendingVerification(): Promise<Array<{
  orderNumber: string;
  totalPrice: string;
  buyerNickName: string;
  verificationStatus: VerificationStatus;
  verificationTimeline: VerificationStep[];
  createdAt: Date;
}>> {
  const db = getPool();

  const result = await db.query(
    `SELECT "orderNumber", "totalPrice", "buyerNickName",
            "verificationStatus", "verificationTimeline", "binanceCreateTime" as "createdAt"
     FROM "Order"
     WHERE status = 'PAID' AND "releasedAt" IS NULL
     ORDER BY "binanceCreateTime" DESC
     LIMIT 50`
  );

  return result.rows;
}

function getStatusEmoji(status: VerificationStatus): string {
  const emojis: Record<VerificationStatus, string> = {
    [VerificationStatus.AWAITING_PAYMENT]: '⏳',
    [VerificationStatus.BUYER_MARKED_PAID]: '📝',
    [VerificationStatus.BANK_PAYMENT_RECEIVED]: '💰',
    [VerificationStatus.PAYMENT_MATCHED]: '🔗',
    [VerificationStatus.AMOUNT_VERIFIED]: '✅',
    [VerificationStatus.AMOUNT_MISMATCH]: '⚠️',
    [VerificationStatus.NAME_VERIFIED]: '✅',
    [VerificationStatus.NAME_MISMATCH]: '⚠️',
    [VerificationStatus.READY_TO_RELEASE]: '🚀',
    [VerificationStatus.RELEASED]: '✨',
    [VerificationStatus.MANUAL_REVIEW]: '👤',
  };
  return emojis[status] || '📋';
}

// ==================== CLEANUP ====================

export async function disconnect(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database disconnected');
  }
}
