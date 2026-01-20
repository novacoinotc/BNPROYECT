// =====================================================
// DATABASE SERVICE (PostgreSQL native)
// Using pg package instead of Prisma for Railway compatibility
// Multi-Tenant: Uses MERCHANT_ID from environment
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

// ==================== MULTI-TENANT SUPPORT ====================

/**
 * Get the current merchant ID from environment
 * Each bot instance runs with its own MERCHANT_ID
 */
function getMerchantId(): string | null {
  return process.env.MERCHANT_ID || null;
}

/**
 * Validate that MERCHANT_ID is set (required for multi-tenant operations)
 */
function requireMerchantId(): string {
  const merchantId = getMerchantId();
  if (!merchantId) {
    logger.warn('MERCHANT_ID not set - running in single-tenant mode');
  }
  return merchantId || '';
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
  // For SELL orders: counterpart is the buyer, we are the seller
  // For BUY orders: counterpart is the seller, we are the buyer
  // Get the actual userNo from order detail if available
  const counterPartUserNo = order.buyer?.userNo || (order as any).counterPartUserNo || (order as any).buyerUserNo || null;

  const buyerUserNo = isSellOrder ? counterPartUserNo : 'self';
  const buyerNickName = isSellOrder ? counterPartNick : 'self';
  // Get real name from order detail if available (multiple sources)
  const buyerRealName = (order as any).buyerRealName || order.buyer?.realName || null;
  const sellerUserNo = isSellOrder ? 'self' : counterPartUserNo;
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
    // Try to update first - also update buyerUserNo, buyerRealName and buyerNickName if we now have better values
    const updateResult = await db.query(
      `UPDATE "Order" SET
        status = $1::"OrderStatus",
        "buyerUserNo" = CASE WHEN $6 IS NOT NULL AND $6 <> 'counterpart' AND $6 <> 'self' THEN $6 ELSE "buyerUserNo" END,
        "buyerRealName" = COALESCE($4, "buyerRealName"),
        "buyerNickName" = CASE WHEN $5 <> 'unknown' AND ("buyerNickName" = 'unknown' OR "buyerNickName" IS NULL) THEN $5 ELSE "buyerNickName" END,
        "paidAt" = CASE WHEN $2 = 'PAID' AND "paidAt" IS NULL THEN NOW() ELSE "paidAt" END,
        "releasedAt" = CASE WHEN $2 = 'COMPLETED' AND "releasedAt" IS NULL THEN NOW() ELSE "releasedAt" END,
        "cancelledAt" = CASE WHEN $2 IN ('CANCELLED', 'CANCELLED_SYSTEM', 'CANCELLED_TIMEOUT') AND "cancelledAt" IS NULL THEN NOW() ELSE "cancelledAt" END,
        "updatedAt" = NOW()
      WHERE "orderNumber" = $3`,
      [status, status, order.orderNumber, buyerRealName, buyerNickName, buyerUserNo]
    );

    // If no rows updated, insert new order
    if (updateResult.rowCount === 0) {
      const merchantId = getMerchantId();
      await db.query(
        `INSERT INTO "Order" (
          id, "orderNumber", "advNo", "tradeType", asset, "fiatUnit",
          amount, "totalPrice", "unitPrice", commission, status,
          "buyerUserNo", "buyerNickName", "buyerRealName",
          "sellerUserNo", "sellerNickName",
          "binanceCreateTime", "confirmPayEndTime",
          "merchantId",
          "createdAt", "updatedAt"
        ) VALUES ($1, $2, $3, $4::"TradeType", $5, $6, $7, $8, $9, $10, $11::"OrderStatus", $12, $13, $14, $15, $16, $17, $18, $19, NOW(), NOW())`,
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
          merchantId,
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
  const merchantId = getMerchantId();

  await db.query(
    `INSERT INTO "Payment" (
      id, "transactionId", amount, currency, "senderName",
      "senderAccount", "receiverAccount", concept, "bankReference",
      "bankTimestamp", status, "merchantId", "createdAt", "updatedAt"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING', $11, NOW(), NOW())`,
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
      merchantId,
    ]
  );

  logger.debug({ transactionId: payment.transactionId, merchantId }, 'Payment saved');
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
  const merchantId = getMerchantId();
  const tolerance = expectedAmount * (tolerancePercent / 100);
  const minAmount = expectedAmount - tolerance;
  const maxAmount = expectedAmount + tolerance;
  const minTime = new Date(Date.now() - maxAgeMinutes * 60 * 1000);

  // Filter by merchantId if set (multi-tenant mode)
  const merchantFilter = merchantId ? 'AND "merchantId" = $4' : '';
  const params = merchantId
    ? [minAmount, maxAmount, minTime, merchantId]
    : [minAmount, maxAmount, minTime];

  const result = await db.query(
    `SELECT id, "transactionId", amount, "senderName", "senderAccount", "createdAt"
     FROM "Payment"
     WHERE status = 'PENDING'
       AND amount BETWEEN $1 AND $2
       AND "createdAt" >= $3
       ${merchantFilter}
     ORDER BY "createdAt" DESC
     LIMIT 10`,
    params
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
  const merchantId = getMerchantId();
  const tolerance = amount * (tolerancePercent / 100);
  const minAmount = amount - tolerance;
  const maxAmount = amount + tolerance;

  logger.info({
    amount,
    tolerancePercent,
    minAmount,
    maxAmount,
    merchantId,
  }, 'Searching for orders awaiting payment');

  // Filter by merchantId if set (multi-tenant mode)
  const merchantFilter = merchantId ? 'AND "merchantId" = $3' : '';
  const params = merchantId
    ? [minAmount, maxAmount, merchantId]
    : [minAmount, maxAmount];

  const result = await db.query(
    `SELECT "orderNumber", "totalPrice", "buyerNickName", "buyerRealName", "createdAt"
     FROM "Order"
     WHERE status = 'PAID'::"OrderStatus"
       AND "totalPrice"::numeric BETWEEN $1 AND $2
       AND "releasedAt" IS NULL
       ${merchantFilter}
     ORDER BY "binanceCreateTime" DESC
     LIMIT 10`,
    params
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
 * Get PAID orders that have NULL buyerRealName and match a given amount
 * Used to populate missing names before smart matching
 */
export async function getOrdersNeedingBuyerName(
  amount: number,
  tolerancePercent: number = 1
): Promise<Array<{ orderNumber: string }>> {
  const db = getPool();
  const tolerance = amount * (tolerancePercent / 100);
  const minAmount = amount - tolerance;
  const maxAmount = amount + tolerance;

  const result = await db.query(
    `SELECT "orderNumber"
     FROM "Order"
     WHERE status = 'PAID'::"OrderStatus"
       AND "totalPrice"::numeric BETWEEN $1 AND $2
       AND "releasedAt" IS NULL
       AND "buyerRealName" IS NULL
     ORDER BY "binanceCreateTime" DESC
     LIMIT 10`,
    [minAmount, maxAmount]
  );

  return result.rows;
}

/**
 * Update the buyerRealName for an order
 */
export async function updateOrderBuyerName(
  orderNumber: string,
  buyerRealName: string
): Promise<void> {
  const db = getPool();
  await db.query(
    `UPDATE "Order" SET "buyerRealName" = $1, "updatedAt" = NOW()
     WHERE "orderNumber" = $2`,
    [buyerRealName, orderNumber]
  );
  logger.info({ orderNumber, buyerRealName }, '📝 [DB] Updated buyer real name for order');
}

/**
 * Get ALL open orders (PENDING or PAID) that need buyerRealName populated
 * Used for third-party payment detection - we need to know ALL buyer names
 * before we can determine if a payment sender is a known buyer
 */
export async function getAllOpenOrdersNeedingBuyerName(): Promise<Array<{ orderNumber: string }>> {
  const db = getPool();

  const result = await db.query(
    `SELECT "orderNumber"
     FROM "Order"
     WHERE status IN ('PENDING', 'PAID')
       AND "releasedAt" IS NULL
       AND "buyerRealName" IS NULL
     ORDER BY "binanceCreateTime" DESC
     LIMIT 50`
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

/**
 * Mark a payment as THIRD_PARTY (sender doesn't match any known buyer)
 * These payments require manual review and won't auto-match
 */
export async function markPaymentAsThirdParty(
  transactionId: string,
  reason?: string
): Promise<void> {
  const db = getPool();

  await db.query(
    `UPDATE "Payment" SET status = 'THIRD_PARTY', "updatedAt" = NOW()
    WHERE "transactionId" = $1`,
    [transactionId]
  );

  logger.warn({ transactionId, reason }, '🚨 [THIRD_PARTY] Payment marked as third-party - requires manual review');
}

/**
 * Check if ANY open order (PENDING or PAID) has a buyer name that matches the sender
 * Used to detect third-party payments - if no match, payment is from unknown sender
 */
export async function hasOrderWithMatchingBuyerName(
  senderName: string,
  toleranceScore: number = 0.3
): Promise<{
  hasMatch: boolean;
  matchedOrders?: Array<{ orderNumber: string; buyerRealName: string | null; buyerNickName: string; matchScore: number }>;
}> {
  const db = getPool();

  // Normalize sender name for comparison
  const normalizedSender = senderName
    .toLowerCase()
    .trim()
    .replace(/[,\/\.\-\_\|]/g, ' ')
    .replace(/[^a-z0-9\sáéíóúüñ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const senderWords = new Set(normalizedSender.split(/\s+/).filter(w => w.length > 2));

  // Get ALL open orders (PENDING or PAID status, not released)
  const result = await db.query(
    `SELECT "orderNumber", "buyerRealName", "buyerNickName"
     FROM "Order"
     WHERE status IN ('PENDING', 'PAID')
       AND "releasedAt" IS NULL
     ORDER BY "binanceCreateTime" DESC
     LIMIT 100`
  );

  if (result.rows.length === 0) {
    logger.info({ senderName }, '🔍 [THIRD_PARTY CHECK] No open orders found to compare');
    return { hasMatch: false };
  }

  // Score each order by name similarity
  const matchedOrders: Array<{ orderNumber: string; buyerRealName: string | null; buyerNickName: string; matchScore: number }> = [];

  for (const order of result.rows) {
    const buyerName = order.buyerRealName || '';
    if (!buyerName) continue; // Skip orders without real name

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

    if (score >= toleranceScore) {
      matchedOrders.push({
        orderNumber: order.orderNumber,
        buyerRealName: order.buyerRealName,
        buyerNickName: order.buyerNickName,
        matchScore: score,
      });
    }
  }

  if (matchedOrders.length > 0) {
    logger.info({
      senderName,
      matchedCount: matchedOrders.length,
      matchedOrders: matchedOrders.map(o => ({
        orderNumber: o.orderNumber,
        buyerRealName: o.buyerRealName,
        matchScore: o.matchScore.toFixed(2),
      })),
    }, '✅ [THIRD_PARTY CHECK] Found orders with matching buyer name');
    return { hasMatch: true, matchedOrders };
  }

  logger.warn({
    senderName,
    normalizedSender,
    openOrdersChecked: result.rows.length,
  }, '🚨 [THIRD_PARTY CHECK] No orders found with matching buyer name - THIRD PARTY PAYMENT');
  return { hasMatch: false };
}

/**
 * Get all third-party payments (for dashboard)
 */
export async function getThirdPartyPayments(limit: number = 50): Promise<Array<{
  id: string;
  transactionId: string;
  amount: number;
  currency: string;
  senderName: string;
  senderAccount: string | null;
  bankReference: string | null;
  bankTimestamp: Date;
  createdAt: Date;
  status: string;
}>> {
  const db = getPool();

  const result = await db.query(
    `SELECT id, "transactionId", amount, currency, "senderName", "senderAccount",
            "bankReference", "bankTimestamp", "createdAt", status
     FROM "Payment"
     WHERE status = 'THIRD_PARTY'
     ORDER BY "createdAt" DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map(row => ({
    ...row,
    amount: typeof row.amount === 'string' ? parseFloat(row.amount) : Number(row.amount),
  }));
}

// ==================== PENDING PAYMENTS MANAGEMENT ====================

/**
 * Get all pending payments (for dashboard)
 */
export async function getPendingPayments(limit: number = 50): Promise<Array<{
  id: string;
  transactionId: string;
  amount: number;
  currency: string;
  senderName: string;
  senderAccount: string | null;
  bankReference: string | null;
  bankTimestamp: Date;
  createdAt: Date;
  status: string;
}>> {
  const db = getPool();

  const result = await db.query(
    `SELECT id, "transactionId", amount, currency, "senderName", "senderAccount",
            "bankReference", "bankTimestamp", "createdAt", status
     FROM "Payment"
     WHERE status = 'PENDING'
     ORDER BY "createdAt" DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map(row => ({
    ...row,
    amount: typeof row.amount === 'string' ? parseFloat(row.amount) : Number(row.amount),
  }));
}

/**
 * Manually match a pending payment to an order (for third-party resolution)
 */
export async function manuallyMatchPayment(
  transactionId: string,
  orderNumber: string,
  resolvedBy: string
): Promise<{ success: boolean; error?: string }> {
  const db = getPool();

  // Check payment exists and is pending
  const paymentCheck = await db.query(
    'SELECT status FROM "Payment" WHERE "transactionId" = $1',
    [transactionId]
  );

  if (paymentCheck.rows.length === 0) {
    return { success: false, error: 'Payment not found' };
  }

  if (paymentCheck.rows[0].status === 'RELEASED') {
    return { success: false, error: 'Payment already released' };
  }

  // Check order exists
  const orderCheck = await db.query(
    'SELECT id, status FROM "Order" WHERE "orderNumber" = $1',
    [orderNumber]
  );

  if (orderCheck.rows.length === 0) {
    return { success: false, error: 'Order not found' };
  }

  // Match payment to order
  await db.query(
    `UPDATE "Payment" SET
      status = 'MATCHED',
      "matchedOrderId" = $1,
      "matchedAt" = NOW(),
      "verificationMethod" = 'MANUAL',
      "updatedAt" = NOW()
    WHERE "transactionId" = $2`,
    [orderCheck.rows[0].id, transactionId]
  );

  // Add verification step
  await addVerificationStep(
    orderNumber,
    VerificationStatus.PAYMENT_MATCHED,
    `✅ Pago vinculado manualmente por ${resolvedBy} (pago de tercero)`,
    {
      transactionId,
      resolvedBy,
      matchType: 'manual_third_party',
    }
  );

  logger.info({ transactionId, orderNumber, resolvedBy }, '✅ Payment manually matched to order');

  return { success: true };
}

/**
 * Mark a pending payment as resolved/ignored (won't match any order)
 */
export async function markPaymentResolved(
  transactionId: string,
  resolvedBy: string,
  reason: string
): Promise<{ success: boolean; error?: string }> {
  const db = getPool();

  // Check payment exists
  const paymentCheck = await db.query(
    'SELECT status FROM "Payment" WHERE "transactionId" = $1',
    [transactionId]
  );

  if (paymentCheck.rows.length === 0) {
    return { success: false, error: 'Payment not found' };
  }

  if (paymentCheck.rows[0].status === 'RELEASED') {
    return { success: false, error: 'Payment already released' };
  }

  // Mark as FAILED (resolved/ignored)
  await db.query(
    `UPDATE "Payment" SET
      status = 'FAILED',
      "updatedAt" = NOW()
    WHERE "transactionId" = $1`,
    [transactionId]
  );

  // Create audit log
  await logAction('payment_resolved', undefined, {
    transactionId,
    resolvedBy,
    reason,
  }, true);

  logger.info({ transactionId, resolvedBy, reason }, '📝 Payment marked as resolved/ignored');

  return { success: true };
}

/**
 * Get orders that could potentially match a payment amount (for manual matching UI)
 */
export async function getOrdersForManualMatch(
  amount: number,
  tolerancePercent: number = 5
): Promise<Array<{
  orderNumber: string;
  totalPrice: string;
  buyerNickName: string;
  buyerRealName: string | null;
  status: string;
  createdAt: Date;
}>> {
  const db = getPool();
  const tolerance = amount * (tolerancePercent / 100);
  const minAmount = amount - tolerance;
  const maxAmount = amount + tolerance;

  const result = await db.query(
    `SELECT "orderNumber", "totalPrice", "buyerNickName", "buyerRealName", status, "createdAt"
     FROM "Order"
     WHERE "totalPrice"::numeric BETWEEN $1 AND $2
       AND status IN ('PAID', 'COMPLETED')
       AND "createdAt" > NOW() - INTERVAL '7 days'
     ORDER BY "createdAt" DESC
     LIMIT 20`,
    [minAmount, maxAmount]
  );

  return result.rows;
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

// Status progression order (higher number = more advanced)
const STATUS_PROGRESSION: Record<string, number> = {
  'AWAITING_PAYMENT': 0,
  'BUYER_MARKED_PAID': 1,
  'BANK_PAYMENT_RECEIVED': 2,
  'PAYMENT_MATCHED': 3,
  'AMOUNT_VERIFIED': 4,
  'AMOUNT_MISMATCH': 4,  // Same level as AMOUNT_VERIFIED (error state)
  'NAME_VERIFIED': 5,
  'NAME_MISMATCH': 5,    // Same level as NAME_VERIFIED (error state)
  'READY_TO_RELEASE': 6,
  'MANUAL_REVIEW': 6,    // Same level as READY_TO_RELEASE (can override when limit exceeded)
  'RELEASED': 7,
};

/**
 * Add a verification step to an order's timeline
 * Note: Status will only update if it's progressing forward (not regressing)
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

  // Get current status to check if we should update it
  const currentResult = await db.query(
    `SELECT "verificationStatus" FROM "Order" WHERE "orderNumber" = $1`,
    [orderNumber]
  );
  const currentStatus = currentResult.rows[0]?.verificationStatus;
  const currentLevel = STATUS_PROGRESSION[currentStatus] ?? -1;
  const newLevel = STATUS_PROGRESSION[status] ?? 0;

  // Only update verificationStatus if new status is more advanced (or same level for error states)
  // Always append to timeline for debugging/history
  if (newLevel >= currentLevel) {
    // Status is progressing forward - update both
    await db.query(
      `UPDATE "Order" SET
        "verificationStatus" = $1,
        "verificationTimeline" = COALESCE("verificationTimeline", '[]'::jsonb) || $2::jsonb,
        "updatedAt" = NOW()
      WHERE "orderNumber" = $3`,
      [status, JSON.stringify([step]), orderNumber]
    );
  } else {
    // Status would regress - only append to timeline, don't change status
    await db.query(
      `UPDATE "Order" SET
        "verificationTimeline" = COALESCE("verificationTimeline", '[]'::jsonb) || $2::jsonb,
        "updatedAt" = NOW()
      WHERE "orderNumber" = $1`,
      [orderNumber, JSON.stringify([step])]
    );
    logger.debug(
      { orderNumber, currentStatus, attemptedStatus: status },
      '⏭️ [VERIFICATION] Status not regressed (timeline updated only)'
    );
  }

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
  buyerUserNo: string | null;  // Binance unique user ID - PRIMARY identifier
  realName: string | null;      // For display only, NOT for matching
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
 * Check if a buyer is trusted by buyerUserNo (Binance unique ID)
 *
 * SECURITY FIX (2026-01-19):
 * - ONLY match by buyerUserNo - it's the ONLY unique identifier
 * - DO NOT match by nickname - many users have same censored nickname (e.g., "Use***")
 * - DO NOT match by realName - different people can have the same name
 *
 * If buyerUserNo is not provided, the buyer is NOT considered trusted.
 * This ensures we only trust buyers we have explicitly verified.
 */
export async function isTrustedBuyer(
  counterPartNickName: string,
  buyerRealName?: string | null,
  buyerUserNo?: string | null
): Promise<boolean> {
  const db = getPool();
  const merchantId = getMerchantId();

  // SECURITY: We REQUIRE buyerUserNo to check trusted status
  // Nickname and realName are NOT reliable identifiers
  if (!buyerUserNo) {
    logger.debug({
      counterPartNickName,
      buyerRealName,
    }, '🔍 [TRUSTED BUYER] No userNo provided - cannot verify trusted status');
    return false;
  }

  // Search ONLY by buyerUserNo - the only unique identifier
  // Also filter by merchantId if in multi-tenant mode
  const merchantFilter = merchantId ? ' AND "merchantId" = $2' : '';
  const query = `SELECT id, "counterPartNickName", "realName", "buyerUserNo" FROM "TrustedBuyer"
                 WHERE "isActive" = true AND "buyerUserNo" = $1${merchantFilter}`;

  const params = merchantId ? [buyerUserNo, merchantId] : [buyerUserNo];
  const result = await db.query(query, params);

  if (result.rows.length > 0) {
    const matched = result.rows[0];
    logger.info({
      searchedUserNo: buyerUserNo,
      trustedBuyerNickName: matched.counterPartNickName,
      trustedBuyerRealName: matched.realName,
      trustedBuyerUserNo: matched.buyerUserNo,
    }, '⭐ [TRUSTED BUYER] Match found by userNo - buyer is TRUSTED');
    return true;
  }

  logger.debug({
    searchedUserNo: buyerUserNo,
    counterPartNickName,
  }, '🔍 [TRUSTED BUYER] userNo not in trusted list');

  return false;
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
 * IMPORTANT: buyerUserNo is REQUIRED for proper identification
 */
export async function addTrustedBuyer(
  counterPartNickName: string,
  buyerUserNo: string,
  realName?: string,
  verifiedBy?: string,
  notes?: string
): Promise<TrustedBuyerData> {
  const db = getPool();

  if (!buyerUserNo) {
    throw new Error('buyerUserNo is required to add a trusted buyer');
  }

  // Try to update if exists by userNo (reactivate)
  const updateResult = await db.query(
    `UPDATE "TrustedBuyer" SET
      "isActive" = true,
      "counterPartNickName" = $2,
      "realName" = COALESCE($3, "realName"),
      "verifiedBy" = COALESCE($4, "verifiedBy"),
      "notes" = COALESCE($5, "notes"),
      "verifiedAt" = NOW(),
      "updatedAt" = NOW()
    WHERE "buyerUserNo" = $1
    RETURNING *`,
    [buyerUserNo, counterPartNickName, realName || null, verifiedBy || null, notes || null]
  );

  if (updateResult.rows.length > 0) {
    logger.info({ buyerUserNo, counterPartNickName }, '⭐ Trusted buyer reactivated');
    return updateResult.rows[0];
  }

  // Insert new trusted buyer
  const insertResult = await db.query(
    `INSERT INTO "TrustedBuyer" (
      id, "counterPartNickName", "buyerUserNo", "realName", "verifiedBy", "notes",
      "verifiedAt", "isActive", "createdAt", "updatedAt"
    ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), true, NOW(), NOW())
    RETURNING *`,
    [generateId(), counterPartNickName, buyerUserNo, realName || null, verifiedBy || null, notes || null]
  );

  logger.info({ buyerUserNo, counterPartNickName, realName }, '⭐ New trusted buyer added');
  return insertResult.rows[0];
}

/**
 * Remove buyer from trusted list (deactivate)
 * Can remove by buyerUserNo (preferred) or by id
 */
export async function removeTrustedBuyer(buyerUserNoOrId: string): Promise<boolean> {
  const db = getPool();

  // Try to remove by buyerUserNo first, then by id
  const result = await db.query(
    `UPDATE "TrustedBuyer" SET
      "isActive" = false,
      "updatedAt" = NOW()
    WHERE "buyerUserNo" = $1 OR "id" = $1`,
    [buyerUserNoOrId]
  );

  if (result.rowCount && result.rowCount > 0) {
    logger.info({ buyerUserNoOrId }, '❌ Trusted buyer removed');
    return true;
  }
  return false;
}

/**
 * List all trusted buyers (filtered by merchantId in multi-tenant mode)
 */
export async function listTrustedBuyers(includeInactive: boolean = false): Promise<TrustedBuyerData[]> {
  const db = getPool();
  const merchantId = getMerchantId();

  // Build query with optional merchantId filter
  const merchantFilter = merchantId
    ? (includeInactive ? `WHERE "merchantId" = $1` : `WHERE "isActive" = true AND "merchantId" = $1`)
    : (includeInactive ? '' : `WHERE "isActive" = true`);

  const query = `SELECT * FROM "TrustedBuyer" ${merchantFilter} ORDER BY "verifiedAt" DESC`;
  const params = merchantId ? [merchantId] : [];

  const result = await db.query(query, params);
  return result.rows;
}

/**
 * Update trusted buyer stats after auto-release
 * Uses buyerUserNo as the primary identifier (filtered by merchantId in multi-tenant mode)
 */
export async function incrementTrustedBuyerStats(
  buyerUserNo: string,
  amountReleased: number
): Promise<void> {
  const db = getPool();
  const merchantId = getMerchantId();

  if (!buyerUserNo) {
    logger.warn({ amountReleased }, 'Cannot update trusted buyer stats - no userNo provided');
    return;
  }

  // Filter by merchantId if in multi-tenant mode
  const merchantFilter = merchantId ? ' AND "merchantId" = $3' : '';
  const params = merchantId
    ? [amountReleased, buyerUserNo, merchantId]
    : [amountReleased, buyerUserNo];

  await db.query(
    `UPDATE "TrustedBuyer" SET
      "ordersAutoReleased" = "ordersAutoReleased" + 1,
      "totalAmountReleased" = "totalAmountReleased" + $1,
      "lastAutoReleaseAt" = NOW(),
      "updatedAt" = NOW()
    WHERE "buyerUserNo" = $2${merchantFilter}`,
    params
  );

  logger.debug({ buyerUserNo, amountReleased, merchantId }, 'Trusted buyer stats updated');
}

// ==================== BOT CONFIG ====================

// Per-asset positioning configuration
export interface AssetPositioningConfig {
  enabled: boolean;  // Enable/disable positioning for this asset
  mode: 'smart' | 'follow';
  followTarget: string | null;
  // Per-asset price strategy
  matchPrice: boolean;      // true = exact match, false = undercut by cents
  undercutCents: number;    // Cents to undercut competitor
  // Per-asset smart filters
  smartMinOrderCount: number;  // Min monthly orders for smart mode
  smartMinSurplus: number;     // Min volume in FIAT (e.g., MXN) for smart mode
}

// Map of "TRADE_TYPE:ASSET" -> config (e.g., "SELL:USDT", "BUY:BTC")
export type PositioningConfigsMap = Record<string, AssetPositioningConfig>;

export interface BotConfig {
  releaseEnabled: boolean;
  positioningEnabled: boolean;
  // Legacy fields (for backwards compatibility)
  positioningMode: string;
  followTargetNickName: string | null;
  followTargetUserNo: string | null;
  // SELL ad config - defaults (when I'm selling, I compete with other sellers)
  sellMode: string; // 'smart' | 'follow'
  sellFollowTarget: string | null;
  // BUY ad config - defaults (when I'm buying, I compete with other buyers)
  buyMode: string; // 'smart' | 'follow'
  buyFollowTarget: string | null;
  // Per-asset positioning configs (overrides sellMode/buyMode when set)
  // Key format: "SELL:USDT", "BUY:BTC", etc.
  positioningConfigs: PositioningConfigsMap;
  // Smart mode filters (shared)
  smartMinUserGrade: number;
  smartMinFinishRate: number;
  smartMinOrderCount: number;
  smartMinPositiveRate: number;
  smartRequireOnline: boolean;
  smartMinSurplus: number;
  // Strategy
  undercutCents: number;
  matchPrice: boolean; // true = exact match, false = undercut by cents
  // Auto-message
  autoMessageEnabled: boolean;
  autoMessageText: string | null;
  // Ignored advertisers (global list)
  ignoredAdvertisers: string[];
}

/**
 * Get bot configuration from database
 * Returns default config if not found
 */
export async function getBotConfig(): Promise<BotConfig> {
  const db = getPool();
  const merchantId = getMerchantId();

  try {
    // Try to get existing config for this merchant (or 'main' for backwards compatibility)
    let result;
    if (merchantId) {
      result = await db.query(
        `SELECT * FROM "BotConfig" WHERE "merchantId" = $1`,
        [merchantId]
      );
    } else {
      // Backwards compatibility: use id = 'main' if no merchantId
      result = await db.query(
        `SELECT * FROM "BotConfig" WHERE id = 'main'`
      );
    }

    // If no config exists, create default
    if (result.rows.length === 0) {
      const configId = generateId();
      if (merchantId) {
        await db.query(
          `INSERT INTO "BotConfig" (id, "merchantId", "releaseEnabled", "positioningEnabled", "positioningMode", "updatedAt")
           VALUES ($1, $2, true, false, 'off', NOW())
           ON CONFLICT ("merchantId") DO NOTHING`,
          [configId, merchantId]
        );
        result = await db.query(
          `SELECT * FROM "BotConfig" WHERE "merchantId" = $1`,
          [merchantId]
        );
      } else {
        await db.query(
          `INSERT INTO "BotConfig" (id, "releaseEnabled", "positioningEnabled", "positioningMode", "updatedAt")
           VALUES ('main', true, false, 'off', NOW())
           ON CONFLICT (id) DO NOTHING`
        );
        result = await db.query(
          `SELECT * FROM "BotConfig" WHERE id = 'main'`
        );
      }
    }

    const row = result.rows[0];

    // Parse positioningConfigs from JSON
    let positioningConfigs: PositioningConfigsMap = {};
    if (row?.positioningConfigs) {
      try {
        positioningConfigs = typeof row.positioningConfigs === 'string'
          ? JSON.parse(row.positioningConfigs)
          : row.positioningConfigs;
      } catch {
        positioningConfigs = {};
      }
    }

    // Parse ignoredAdvertisers from JSON
    let ignoredAdvertisers: string[] = [];
    if (row?.ignoredAdvertisers) {
      try {
        ignoredAdvertisers = typeof row.ignoredAdvertisers === 'string'
          ? JSON.parse(row.ignoredAdvertisers)
          : row.ignoredAdvertisers;
      } catch {
        ignoredAdvertisers = [];
      }
    }

    return {
      releaseEnabled: row?.releaseEnabled ?? true,
      positioningEnabled: row?.positioningEnabled ?? false,
      // Legacy fields
      positioningMode: row?.positioningMode ?? 'smart',
      followTargetNickName: row?.followTargetNickName ?? null,
      followTargetUserNo: row?.followTargetUserNo ?? null,
      // SELL config - defaults (fallback to legacy if not set)
      sellMode: row?.sellMode ?? row?.positioningMode ?? 'smart',
      sellFollowTarget: row?.sellFollowTarget ?? row?.followTargetNickName ?? null,
      // BUY config - defaults (fallback to legacy if not set)
      buyMode: row?.buyMode ?? row?.positioningMode ?? 'smart',
      buyFollowTarget: row?.buyFollowTarget ?? row?.followTargetNickName ?? null,
      // Per-asset configs
      positioningConfigs,
      // Smart mode filters
      smartMinUserGrade: row?.smartMinUserGrade ?? 2,
      smartMinFinishRate: row?.smartMinFinishRate ?? 0.90,
      smartMinOrderCount: row?.smartMinOrderCount ?? 10,
      smartMinPositiveRate: row?.smartMinPositiveRate ?? 0.95,
      smartRequireOnline: row?.smartRequireOnline ?? true,
      smartMinSurplus: row?.smartMinSurplus ?? 100,
      // Strategy
      undercutCents: row?.undercutCents ?? 1,
      matchPrice: row?.matchPrice ?? false,
      // Auto-message
      autoMessageEnabled: row?.autoMessageEnabled ?? false,
      autoMessageText: row?.autoMessageText ?? null,
      // Ignored advertisers
      ignoredAdvertisers,
    };
  } catch (error) {
    logger.warn({ error }, 'Failed to get bot config, using defaults');
    return {
      releaseEnabled: true,
      positioningEnabled: false,
      positioningMode: 'smart',
      followTargetNickName: null,
      followTargetUserNo: null,
      sellMode: 'smart',
      sellFollowTarget: null,
      buyMode: 'smart',
      buyFollowTarget: null,
      positioningConfigs: {},
      smartMinUserGrade: 2,
      smartMinFinishRate: 0.90,
      smartMinOrderCount: 10,
      smartMinPositiveRate: 0.95,
      smartRequireOnline: true,
      smartMinSurplus: 100,
      undercutCents: 1,
      matchPrice: false,
      autoMessageEnabled: false,
      autoMessageText: null,
      ignoredAdvertisers: [],
    };
  }
}

/**
 * Get positioning config for a specific trade type and asset
 * Checks per-asset config first, then falls back to trade type defaults
 */
export function getPositioningConfigForAd(
  config: BotConfig,
  tradeType: 'SELL' | 'BUY',
  asset: string
): AssetPositioningConfig {
  // Check per-asset config first (e.g., "SELL:USDT")
  const key = `${tradeType}:${asset}`;
  if (config.positioningConfigs[key]) {
    const assetConfig = config.positioningConfigs[key];
    return {
      enabled: assetConfig.enabled !== false, // Default to true
      mode: assetConfig.mode || 'smart',
      followTarget: assetConfig.followTarget || null,
      // Per-asset price strategy (fallback to global defaults)
      matchPrice: assetConfig.matchPrice ?? config.matchPrice ?? false,
      undercutCents: assetConfig.undercutCents ?? config.undercutCents ?? 1,
      // Per-asset smart filters (fallback to global defaults)
      smartMinOrderCount: assetConfig.smartMinOrderCount ?? config.smartMinOrderCount ?? 10,
      smartMinSurplus: assetConfig.smartMinSurplus ?? config.smartMinSurplus ?? 100,
    };
  }

  // Fallback to trade type defaults (enabled by default)
  if (tradeType === 'SELL') {
    return {
      enabled: true,
      mode: (config.sellMode as 'smart' | 'follow') || 'smart',
      followTarget: config.sellFollowTarget,
      matchPrice: config.matchPrice ?? false,
      undercutCents: config.undercutCents ?? 1,
      smartMinOrderCount: config.smartMinOrderCount ?? 10,
      smartMinSurplus: config.smartMinSurplus ?? 100,
    };
  } else {
    return {
      enabled: true,
      mode: (config.buyMode as 'smart' | 'follow') || 'smart',
      followTarget: config.buyFollowTarget,
      matchPrice: config.matchPrice ?? false,
      undercutCents: config.undercutCents ?? 1,
      smartMinOrderCount: config.smartMinOrderCount ?? 10,
      smartMinSurplus: config.smartMinSurplus ?? 100,
    };
  }
}

/**
 * Update bot last active timestamp
 */
export async function updateBotLastActive(botType: 'release' | 'positioning'): Promise<void> {
  const db = getPool();

  const column = botType === 'release' ? 'releaseLastActive' : 'positioningLastActive';

  try {
    await db.query(
      `UPDATE "BotConfig" SET "${column}" = NOW() WHERE id = 'main'`
    );
  } catch (error) {
    logger.debug({ error, botType }, 'Failed to update bot last active timestamp');
  }
}

/**
 * Check if release bot is enabled
 */
export async function isReleaseEnabled(): Promise<boolean> {
  const config = await getBotConfig();
  return config.releaseEnabled;
}

/**
 * Check if positioning bot is enabled
 */
export async function isPositioningEnabled(): Promise<boolean> {
  const config = await getBotConfig();
  return config.positioningEnabled;
}

// ==================== SUPPORT REQUESTS ====================

export interface SupportRequest {
  id: string;
  orderNumber: string;
  buyerNickName: string;
  buyerRealName: string | null;
  amount: number;
  message: string | null;
  status: 'PENDING' | 'ATTENDED' | 'CLOSED';
  createdAt: Date;
  attendedAt: Date | null;
  attendedBy: string | null;
  closedAt: Date | null;
  notes: string | null;
}

/**
 * Create a new support request
 */
export async function createSupportRequest(
  orderNumber: string,
  buyerNickName: string,
  buyerRealName: string | null,
  amount: number,
  message: string | null
): Promise<SupportRequest> {
  const db = getPool();
  const id = generateId();

  const result = await db.query(
    `INSERT INTO "SupportRequest" (id, "orderNumber", "buyerNickName", "buyerRealName", amount, message, status, "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', NOW())
     RETURNING *`,
    [id, orderNumber, buyerNickName, buyerRealName, amount, message]
  );

  logger.info({ orderNumber, buyerNickName }, '🆘 [SUPPORT] New support request created');
  return result.rows[0];
}

/**
 * Check if a support request already exists for this order (to avoid duplicates)
 */
export async function hasPendingSupportRequest(orderNumber: string): Promise<boolean> {
  const db = getPool();

  const result = await db.query(
    `SELECT id FROM "SupportRequest" WHERE "orderNumber" = $1 AND status = 'PENDING' LIMIT 1`,
    [orderNumber]
  );

  return result.rows.length > 0;
}

/**
 * Get all support requests with optional status filter
 */
export async function getSupportRequests(status?: string): Promise<SupportRequest[]> {
  const db = getPool();

  let query = `SELECT * FROM "SupportRequest"`;
  const params: any[] = [];

  if (status) {
    query += ` WHERE status = $1`;
    params.push(status);
  }

  query += ` ORDER BY "createdAt" DESC`;

  const result = await db.query(query, params);
  return result.rows;
}

/**
 * Update support request status
 */
export async function updateSupportRequestStatus(
  id: string,
  status: 'PENDING' | 'ATTENDED' | 'CLOSED',
  attendedBy?: string,
  notes?: string
): Promise<void> {
  const db = getPool();

  const updates: string[] = [`status = $1`];
  const values: any[] = [status];
  let paramIndex = 2;

  if (status === 'ATTENDED') {
    updates.push(`"attendedAt" = NOW()`);
    if (attendedBy) {
      updates.push(`"attendedBy" = $${paramIndex++}`);
      values.push(attendedBy);
    }
  }

  if (status === 'CLOSED') {
    updates.push(`"closedAt" = NOW()`);
  }

  if (notes !== undefined) {
    updates.push(`notes = $${paramIndex++}`);
    values.push(notes);
  }

  values.push(id);

  await db.query(
    `UPDATE "SupportRequest" SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
    values
  );

  logger.info({ id, status }, '📝 [SUPPORT] Request status updated');
}

/**
 * Get count of pending support requests
 */
export async function getPendingSupportRequestCount(): Promise<number> {
  const db = getPool();

  const result = await db.query(
    `SELECT COUNT(*) as count FROM "SupportRequest" WHERE status = 'PENDING'`
  );

  return parseInt(result.rows[0].count);
}

// ==================== CLEANUP ====================

export async function disconnect(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database disconnected');
  }
}
