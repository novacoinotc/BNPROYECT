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

  // Try multiple sources for the buyer nickname:
  // 1. counterPartNickName (from list endpoints)
  // 2. buyer.nickName (from order detail endpoint)
  const counterPartNick = order.counterPartNickName
    || (order as any).counterPartNickName
    || order.buyer?.nickName
    || 'unknown';

  // Map to buyer/seller based on trade type
  const buyerUserNo = isSellOrder ? 'counterpart' : 'self';
  const buyerNickName = isSellOrder ? counterPartNick : 'self';
  // Get real name from order detail if available (multiple sources)
  const buyerRealName = (order as any).buyerRealName || order.buyer?.realName || null;
  const sellerUserNo = isSellOrder ? 'self' : 'counterpart';
  const sellerNickName = isSellOrder ? 'self' : counterPartNick;

  // Calculate unitPrice if not provided (totalPrice / amount)
  // API may return unitPrice or price field
  let unitPrice = order.unitPrice || (order as any).price;
  if (!unitPrice && order.totalPrice && order.amount) {
    const total = parseFloat(order.totalPrice);
    const amount = parseFloat(order.amount);
    if (amount > 0) {
      unitPrice = (total / amount).toFixed(2);
    }
  }
  // Fallback to '0' to avoid null constraint violation
  unitPrice = unitPrice || '0';

  try {
    // Try to update first - also update buyerRealName and buyerNickName if we now have better values
    const updateResult = await db.query(
      `UPDATE "Order" SET
        status = $1::"OrderStatus",
        "buyerRealName" = COALESCE($4, "buyerRealName"),
        "buyerNickName" = CASE WHEN $5 <> 'unknown' AND ("buyerNickName" = 'unknown' OR "buyerNickName" IS NULL) THEN $5 ELSE "buyerNickName" END,
        "paidAt" = CASE WHEN $2 = 'PAID' AND "paidAt" IS NULL THEN NOW() ELSE "paidAt" END,
        "releasedAt" = CASE WHEN $2 = 'COMPLETED' AND "releasedAt" IS NULL THEN NOW() ELSE "releasedAt" END,
        "cancelledAt" = CASE WHEN $2 IN ('CANCELLED', 'CANCELLED_SYSTEM', 'CANCELLED_TIMEOUT') AND "cancelledAt" IS NULL THEN NOW() ELSE "cancelledAt" END,
        "updatedAt" = NOW()
      WHERE "orderNumber" = $3`,
      [status, status, order.orderNumber, buyerRealName, buyerNickName]
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
          order.amount || '0',
          order.totalPrice || '0',
          unitPrice,  // Use calculated unitPrice
          order.commission || '0',
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

    logger.debug({ orderNumber: order.orderNumber }, 'Order saved to database');
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
): Promise<boolean> {
  const db = getPool();

  const orderResult = await db.query(
    'SELECT id FROM "Order" WHERE "orderNumber" = $1',
    [orderNumber]
  );

  if (orderResult.rows.length === 0) {
    throw new Error(`Order ${orderNumber} not found`);
  }

  // CRITICAL: Check if payment was already released (prevent double-spend)
  const paymentCheck = await db.query(
    'SELECT status, "matchedOrderId" FROM "Payment" WHERE "transactionId" = $1',
    [transactionId]
  );

  if (paymentCheck.rows.length > 0) {
    const payment = paymentCheck.rows[0];
    if (payment.status === 'RELEASED') {
      logger.warn({
        transactionId,
        orderNumber,
        previousOrderId: payment.matchedOrderId,
      }, '🚫 [DOUBLE-SPEND BLOCKED] Payment was already used for a released order!');
      return false; // Payment already used - don't allow re-matching
    }
  }

  // Only match if payment is PENDING (not already matched or released)
  const result = await db.query(
    `UPDATE "Payment" SET
      status = 'MATCHED',
      "matchedOrderId" = $1,
      "matchedAt" = NOW(),
      "verificationMethod" = $2,
      "ocrConfidence" = $3,
      "receiptUrl" = $4,
      "updatedAt" = NOW()
    WHERE "transactionId" = $5
      AND status IN ('PENDING', 'MATCHED')`,
    [orderResult.rows[0].id, method, ocrConfidence || null, receiptUrl || null, transactionId]
  );

  if (result.rowCount === 0) {
    logger.warn({ transactionId, orderNumber }, '⚠️ Payment not matched - may already be released or not found');
    return false;
  }

  logger.info({ transactionId, orderNumber }, 'Payment matched to order');
  return true;
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

  // PostgreSQL returns Decimal as string - convert to number
  return result.rows.map(row => ({
    ...row,
    amount: typeof row.amount === 'string' ? parseFloat(row.amount) : Number(row.amount),
  }));
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
  buyerRealName: string | null;
  createdAt: Date;
}>> {
  const db = getPool();
  const tolerance = amount * (tolerancePercent / 100);
  const minAmount = amount - tolerance;
  const maxAmount = amount + tolerance;

  logger.info({
    amount,
    tolerancePercent,
    minAmount,
    maxAmount,
  }, 'Searching for orders awaiting payment');

  const result = await db.query(
    `SELECT "orderNumber", "totalPrice", "buyerNickName", "buyerRealName", "createdAt"
     FROM "Order"
     WHERE status = 'PAID'::"OrderStatus"
       AND "totalPrice"::numeric BETWEEN $1 AND $2
       AND "releasedAt" IS NULL
     ORDER BY "binanceCreateTime" DESC
     LIMIT 10`,
    [minAmount, maxAmount]
  );

  logger.info({
    foundOrders: result.rows.length,
    orders: result.rows.map(o => ({ orderNumber: o.orderNumber, totalPrice: o.totalPrice })),
  }, 'Orders awaiting payment search result');

  return result.rows;
}

/**
 * Find order by amount AND buyer name (smart matching)
 * Prioritizes orders where the buyer's real name matches the payment sender
 * Returns null if no confident match found
 */
export async function findOrderByAmountAndName(
  amount: number,
  senderName: string,
  tolerancePercent: number = 1
): Promise<{
  orderNumber: string;
  totalPrice: string;
  buyerNickName: string;
  buyerRealName: string | null;
  createdAt: Date;
  nameMatchScore: number;
} | null> {
  const db = getPool();
  const tolerance = amount * (tolerancePercent / 100);
  const minAmount = amount - tolerance;
  const maxAmount = amount + tolerance;

  // Normalize sender name for comparison
  const normalizedSender = senderName
    .toLowerCase()
    .trim()
    .replace(/[,\/\.\-\_\|]/g, ' ')
    .replace(/[^a-z0-9\sáéíóúüñ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const senderWords = new Set(normalizedSender.split(/\s+/).filter(w => w.length > 2));

  logger.info({
    amount,
    senderName,
    normalizedSender,
    senderWords: Array.from(senderWords),
  }, '🔍 [SMART MATCH] Searching for order by amount AND name');

  // Get all orders with matching amount
  const result = await db.query(
    `SELECT "orderNumber", "totalPrice", "buyerNickName", "buyerRealName", "createdAt"
     FROM "Order"
     WHERE status = 'PAID'::"OrderStatus"
       AND "totalPrice"::numeric BETWEEN $1 AND $2
       AND "releasedAt" IS NULL
     ORDER BY "binanceCreateTime" DESC
     LIMIT 20`,
    [minAmount, maxAmount]
  );

  if (result.rows.length === 0) {
    logger.info({ amount }, '🔍 [SMART MATCH] No orders found with matching amount');
    return null;
  }

  // Score each order by name similarity
  let bestMatch: typeof result.rows[0] | null = null;
  let bestScore = 0;

  for (const order of result.rows) {
    const buyerName = order.buyerRealName || order.buyerNickName || '';

    // Normalize buyer name
    const normalizedBuyer = buyerName
      .toLowerCase()
      .trim()
      .replace(/[,\/\.\-\_\|]/g, ' ')
      .replace(/[^a-z0-9\sáéíóúüñ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const buyerWords = new Set(normalizedBuyer.split(/\s+/).filter((w: string) => w.length > 2));

    // Calculate word overlap score
    let matches = 0;
    for (const word of senderWords) {
      if (buyerWords.has(word)) matches++;
    }
    const totalWords = Math.max(senderWords.size, buyerWords.size);
    const score = totalWords > 0 ? matches / totalWords : 0;

    logger.debug({
      orderNumber: order.orderNumber,
      buyerName,
      normalizedBuyer,
      score: score.toFixed(2),
    }, '🔍 [SMART MATCH] Comparing with order');

    if (score > bestScore) {
      bestScore = score;
      bestMatch = order;
    }
  }

  // Only return if we have a confident match (>30% name similarity)
  if (bestMatch && bestScore > 0.3) {
    logger.info({
      orderNumber: bestMatch.orderNumber,
      buyerRealName: bestMatch.buyerRealName,
      buyerNickName: bestMatch.buyerNickName,
      senderName,
      matchScore: bestScore.toFixed(2),
    }, '✅ [SMART MATCH] Found order with matching amount AND name');

    return {
      ...bestMatch,
      nameMatchScore: bestScore,
    };
  }

  logger.info({
    amount,
    senderName,
    ordersChecked: result.rows.length,
    bestScore: bestScore.toFixed(2),
  }, '⚠️ [SMART MATCH] No order found with confident name match - payment will wait');

  return null;
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

/**
 * Get payments matched to a specific order
 */
export async function getPaymentsForOrder(orderNumber: string): Promise<Array<{
  transactionId: string;
  amount: number;
  senderName: string;
  status: string;
}>> {
  const db = getPool();
  const result = await db.query(
    `SELECT p."transactionId", p.amount, p."senderName", p.status
     FROM "Payment" p
     JOIN "Order" o ON p."matchedOrderId" = o.id
     WHERE o."orderNumber" = $1
     AND p.status IN ('MATCHED', 'VERIFIED')`,
    [orderNumber]
  );
  // PostgreSQL returns Decimal as string - convert to number
  return result.rows.map(row => ({
    ...row,
    amount: typeof row.amount === 'string' ? parseFloat(row.amount) : Number(row.amount),
  }));
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

/**
 * Check if a transactionId was already used to release crypto (double-spend protection)
 * Call this BEFORE releasing crypto as a final safety check
 */
export async function isPaymentAlreadyReleased(transactionId: string): Promise<{
  released: boolean;
  orderNumber?: string;
  releasedAt?: Date;
}> {
  const db = getPool();

  const result = await db.query(
    `SELECT p.status, p."matchedAt", o."orderNumber", o."releasedAt"
     FROM "Payment" p
     LEFT JOIN "Order" o ON p."matchedOrderId" = o.id
     WHERE p."transactionId" = $1`,
    [transactionId]
  );

  if (result.rows.length === 0) {
    return { released: false };
  }

  const payment = result.rows[0];
  if (payment.status === 'RELEASED') {
    logger.warn({
      transactionId,
      orderNumber: payment.orderNumber,
      releasedAt: payment.releasedAt,
    }, '🚫 [DOUBLE-SPEND CHECK] This payment was already used for a released order!');

    return {
      released: true,
      orderNumber: payment.orderNumber,
      releasedAt: payment.releasedAt,
    };
  }

  return { released: false };
}

/**
 * Unmatch a payment from its order (reset to PENDING)
 * Used when name verification fails - allows payment to match other orders
 */
export async function unmatchPayment(transactionId: string): Promise<void> {
  const db = getPool();

  await db.query(
    `UPDATE "Payment" SET
      status = 'PENDING',
      "matchedOrderId" = NULL,
      "matchedAt" = NULL,
      "updatedAt" = NOW()
    WHERE "transactionId" = $1`,
    [transactionId]
  );

  logger.info({ transactionId }, '🔄 Payment unmatched - available for re-matching');
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

// ==================== PRICE HISTORY ====================

// Generate a CUID-like ID (compatible with Prisma's cuid())
function generateCuid(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 9);
  return `c${timestamp}${random}`;
}

/**
 * Save price snapshot for dashboard
 */
export async function savePriceHistory(data: {
  asset: string;
  fiat: string;
  tradeType: string;
  referencePrice: number;
  bestCompetitor: number;
  averagePrice: number;
  ourPrice: number;
  margin: number;
  pricePosition?: string;
}): Promise<void> {
  const db = getPool();

  // Determine price position if not provided
  const pricePosition = data.pricePosition || (
    data.ourPrice <= data.bestCompetitor ? 'best' :
    data.ourPrice <= data.averagePrice ? 'competitive' :
    'above_average'
  );

  try {
    await db.query(
      `INSERT INTO "PriceHistory"
       (id, asset, fiat, "tradeType", "referencePrice", "bestCompetitor",
        "averagePrice", "ourPrice", margin, "pricePosition", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
      [
        generateCuid(),
        data.asset,
        data.fiat,
        data.tradeType,
        data.referencePrice,
        data.bestCompetitor,
        data.averagePrice,
        data.ourPrice,
        data.margin,
        pricePosition,
      ]
    );
    logger.debug({ asset: data.asset, ourPrice: data.ourPrice }, 'Price history saved');
  } catch (error) {
    // Table might not exist yet, log but don't fail
    logger.warn({ error }, 'Failed to save price history (table may not exist)');
  }
}

// ==================== TRUSTED BUYERS ====================

export interface TrustedBuyerData {
  id: string;
  counterPartNickName: string;
  realName: string | null;
  verifiedAt: Date;
  verifiedBy: string | null;
  notes: string | null;
  ordersAutoReleased: number;
  totalAmountReleased: number;
  lastAutoReleaseAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Check if a buyer is trusted (by nickname OR realName)
 * This allows matching even if nicknames are censored (e.g., "lui***")
 */
export async function isTrustedBuyer(counterPartNickName: string, buyerRealName?: string | null): Promise<boolean> {
  const db = getPool();

  // Normalize names for comparison (uppercase, trim whitespace)
  const normalizedNickName = counterPartNickName?.trim() || '';
  const normalizedRealName = buyerRealName?.trim().toUpperCase() || '';

  // Search by nickname OR realName (if provided)
  let query: string;
  let params: string[];

  if (normalizedRealName) {
    // Search by either nickname or realName (case-insensitive for realName)
    query = `SELECT id, "counterPartNickName", "realName" FROM "TrustedBuyer"
             WHERE "isActive" = true
             AND ("counterPartNickName" = $1 OR UPPER(TRIM("realName")) = $2)`;
    params = [normalizedNickName, normalizedRealName];
  } else {
    // Only search by nickname
    query = `SELECT id, "counterPartNickName", "realName" FROM "TrustedBuyer"
             WHERE "counterPartNickName" = $1 AND "isActive" = true`;
    params = [normalizedNickName];
  }

  const result = await db.query(query, params);

  if (result.rows.length > 0) {
    const matched = result.rows[0];
    logger.info({
      searchedNickName: normalizedNickName,
      searchedRealName: normalizedRealName || '(not provided)',
      matchedBy: matched.counterPartNickName === normalizedNickName ? 'nickname' : 'realName',
      trustedBuyerNickName: matched.counterPartNickName,
      trustedBuyerRealName: matched.realName,
    }, '⭐ [TRUSTED BUYER] Match found in trusted buyers list');
  }

  return result.rows.length > 0;
}

/**
 * Get trusted buyer info by nickname
 */
export async function getTrustedBuyer(counterPartNickName: string): Promise<TrustedBuyerData | null> {
  const db = getPool();
  const result = await db.query(
    `SELECT * FROM "TrustedBuyer" WHERE "counterPartNickName" = $1`,
    [counterPartNickName]
  );
  return result.rows[0] || null;
}

/**
 * Add a buyer to trusted list
 */
export async function addTrustedBuyer(
  counterPartNickName: string,
  realName?: string,
  verifiedBy?: string,
  notes?: string
): Promise<TrustedBuyerData> {
  const db = getPool();

  // Try to update if exists (reactivate)
  const updateResult = await db.query(
    `UPDATE "TrustedBuyer" SET
      "isActive" = true,
      "realName" = COALESCE($2, "realName"),
      "verifiedBy" = COALESCE($3, "verifiedBy"),
      "notes" = COALESCE($4, "notes"),
      "verifiedAt" = NOW(),
      "updatedAt" = NOW()
    WHERE "counterPartNickName" = $1
    RETURNING *`,
    [counterPartNickName, realName || null, verifiedBy || null, notes || null]
  );

  if (updateResult.rows.length > 0) {
    logger.info({ counterPartNickName }, '⭐ Trusted buyer reactivated');
    return updateResult.rows[0];
  }

  // Insert new trusted buyer
  const insertResult = await db.query(
    `INSERT INTO "TrustedBuyer" (
      id, "counterPartNickName", "realName", "verifiedBy", "notes",
      "verifiedAt", "isActive", "createdAt", "updatedAt"
    ) VALUES ($1, $2, $3, $4, $5, NOW(), true, NOW(), NOW())
    RETURNING *`,
    [generateId(), counterPartNickName, realName || null, verifiedBy || null, notes || null]
  );

  logger.info({ counterPartNickName, realName }, '⭐ New trusted buyer added');
  return insertResult.rows[0];
}

/**
 * Remove buyer from trusted list (deactivate)
 */
export async function removeTrustedBuyer(counterPartNickName: string): Promise<boolean> {
  const db = getPool();

  const result = await db.query(
    `UPDATE "TrustedBuyer" SET
      "isActive" = false,
      "updatedAt" = NOW()
    WHERE "counterPartNickName" = $1`,
    [counterPartNickName]
  );

  if (result.rowCount && result.rowCount > 0) {
    logger.info({ counterPartNickName }, '❌ Trusted buyer removed');
    return true;
  }
  return false;
}

/**
 * List all trusted buyers
 */
export async function listTrustedBuyers(includeInactive: boolean = false): Promise<TrustedBuyerData[]> {
  const db = getPool();

  const query = includeInactive
    ? `SELECT * FROM "TrustedBuyer" ORDER BY "verifiedAt" DESC`
    : `SELECT * FROM "TrustedBuyer" WHERE "isActive" = true ORDER BY "verifiedAt" DESC`;

  const result = await db.query(query);
  return result.rows;
}

/**
 * Update trusted buyer stats after auto-release
 */
export async function incrementTrustedBuyerStats(
  counterPartNickName: string,
  amountReleased: number
): Promise<void> {
  const db = getPool();

  await db.query(
    `UPDATE "TrustedBuyer" SET
      "ordersAutoReleased" = "ordersAutoReleased" + 1,
      "totalAmountReleased" = "totalAmountReleased" + $1,
      "lastAutoReleaseAt" = NOW(),
      "updatedAt" = NOW()
    WHERE "counterPartNickName" = $2`,
    [amountReleased, counterPartNickName]
  );

  logger.debug({ counterPartNickName, amountReleased }, 'Trusted buyer stats updated');
}

// ==================== CLEANUP ====================

export async function disconnect(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database disconnected');
  }
}
