// =====================================================
// DATABASE SERVICE (PostgreSQL native)
// Using pg package instead of Prisma for Railway compatibility
// =====================================================

import pg from 'pg';
import { logger } from '../utils/logger.js';
import {
  OrderData,
  OrderStatus as BinanceOrderStatus,
  BankWebhookPayload,
  ChatMessage,
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

const statusMap: Record<number, string> = {
  1: 'PENDING',
  2: 'PAID',
  3: 'APPEALING',
  4: 'COMPLETED',
  5: 'CANCELLED',
  6: 'CANCELLED_SYSTEM',
  7: 'CANCELLED_TIMEOUT',
};

export async function saveOrder(order: OrderData): Promise<void> {
  const db = getPool();
  const status = statusMap[order.orderStatus] || 'PENDING';

  try {
    // Try to update first
    const updateResult = await db.query(
      `UPDATE "Order" SET
        status = $1,
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
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW(), NOW())`,
        [
          generateId(),
          order.orderNumber,
          order.advNo,
          order.tradeType,
          order.asset,
          order.fiatUnit,
          order.amount,
          order.totalPrice,
          order.unitPrice,
          order.commission,
          status,
          order.buyer.userNo,
          order.buyer.nickName,
          order.buyer.realName || null,
          order.seller.userNo,
          order.seller.nickName,
          new Date(order.createTime),
          order.confirmPayEndTime ? new Date(order.confirmPayEndTime) : null,
        ]
      );
    }

    logger.debug({ orderNumber: order.orderNumber }, 'Order saved to database');
  } catch (error) {
    const err = error as Error;
    // Ignore duplicate key errors
    if (!err.message.includes('duplicate key')) {
      logger.error({
        errorMessage: err.message,
        errorName: err.name,
        orderNumber: order.orderNumber,
      }, 'Failed to save order');
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

// ==================== CLEANUP ====================

export async function disconnect(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database disconnected');
  }
}
