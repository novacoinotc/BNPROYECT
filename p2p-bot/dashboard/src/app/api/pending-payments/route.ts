import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';
import { getMerchantContext, getMerchantFilter } from '@/lib/merchant-context';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// GET - List pending or third-party payments
export async function GET(request: NextRequest) {
  try {
    // Get merchant context
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const limit = parseInt(searchParams.get('limit') || '50');
    const status = searchParams.get('status') || 'PENDING'; // 'PENDING' or 'THIRD_PARTY'

    // Validate status parameter
    const validStatuses = ['PENDING', 'THIRD_PARTY'];
    const filterStatus = validStatuses.includes(status) ? status : 'PENDING';

    // Build query with merchant filter
    // Admin sees all, merchant sees only their own
    const merchantFilter = getMerchantFilter(context);
    const merchantCondition = merchantFilter.merchantId
      ? 'AND "merchantId" = $3'
      : '';

    const queryParams: any[] = [filterStatus, limit];
    if (merchantFilter.merchantId) {
      queryParams.push(merchantFilter.merchantId);
    }

    const result = await pool.query(
      `SELECT id, "transactionId", amount, currency, "senderName", "senderAccount",
              "bankReference", "bankTimestamp", "createdAt", status
       FROM "Payment"
       WHERE status = $1 ${merchantCondition}
       ORDER BY "createdAt" DESC
       LIMIT $2`,
      queryParams
    );

    const payments = result.rows.map(row => ({
      ...row,
      amount: typeof row.amount === 'string' ? parseFloat(row.amount) : Number(row.amount),
    }));

    return NextResponse.json({
      success: true,
      payments,
      count: payments.length,
      status: filterStatus,
    });
  } catch (error) {
    console.error('Error fetching pending payments:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch pending payments' },
      { status: 500 }
    );
  }
}

// POST - Manually match payment to order
export async function POST(request: NextRequest) {
  try {
    // Get merchant context
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { transactionId, orderNumber, resolvedBy } = body;

    if (!transactionId || !orderNumber) {
      return NextResponse.json(
        { success: false, error: 'transactionId and orderNumber are required' },
        { status: 400 }
      );
    }

    // Build merchant filter for queries
    const merchantFilter = getMerchantFilter(context);
    const merchantCondition = merchantFilter.merchantId
      ? 'AND "merchantId" = $2'
      : '';

    // Check payment exists and is pending (with merchant filter)
    const paymentParams: any[] = [transactionId];
    if (merchantFilter.merchantId) {
      paymentParams.push(merchantFilter.merchantId);
    }

    const paymentCheck = await pool.query(
      `SELECT status FROM "Payment" WHERE "transactionId" = $1 ${merchantCondition}`,
      paymentParams
    );

    if (paymentCheck.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Payment not found' },
        { status: 404 }
      );
    }

    if (paymentCheck.rows[0].status === 'RELEASED') {
      return NextResponse.json(
        { success: false, error: 'Payment already released' },
        { status: 400 }
      );
    }

    // Check order exists (with merchant filter)
    const orderParams: any[] = [orderNumber];
    if (merchantFilter.merchantId) {
      orderParams.push(merchantFilter.merchantId);
    }

    const orderCheck = await pool.query(
      `SELECT id, status FROM "Order" WHERE "orderNumber" = $1 ${merchantCondition}`,
      orderParams
    );

    if (orderCheck.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Order not found' },
        { status: 404 }
      );
    }

    // Match payment to order
    await pool.query(
      `UPDATE "Payment" SET
        status = 'MATCHED',
        "matchedOrderId" = $1,
        "matchedAt" = NOW(),
        "verificationMethod" = 'MANUAL',
        "updatedAt" = NOW()
      WHERE "transactionId" = $2`,
      [orderCheck.rows[0].id, transactionId]
    );

    // Add verification step to order
    const step = {
      timestamp: new Date(),
      status: 'PAYMENT_MATCHED',
      message: `Pago vinculado manualmente por ${resolvedBy || 'Dashboard'} (pago de tercero)`,
      details: { transactionId, resolvedBy, matchType: 'manual_third_party' },
    };

    await pool.query(
      `UPDATE "Order" SET
        "verificationStatus" = 'PAYMENT_MATCHED',
        "verificationTimeline" = COALESCE("verificationTimeline", '[]'::jsonb) || $1::jsonb,
        "updatedAt" = NOW()
      WHERE "orderNumber" = $2`,
      [JSON.stringify([step]), orderNumber]
    );

    return NextResponse.json({
      success: true,
      message: `Payment ${transactionId} linked to order ${orderNumber}`,
    });
  } catch (error) {
    console.error('Error matching payment:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to match payment' },
      { status: 500 }
    );
  }
}

// PATCH - Mark payment as resolved/ignored
export async function PATCH(request: NextRequest) {
  try {
    // Get merchant context
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { transactionId, resolvedBy, reason } = body;

    if (!transactionId) {
      return NextResponse.json(
        { success: false, error: 'transactionId is required' },
        { status: 400 }
      );
    }

    // Build merchant filter for query
    const merchantFilter = getMerchantFilter(context);
    const merchantCondition = merchantFilter.merchantId
      ? 'AND "merchantId" = $2'
      : '';

    const paymentParams: any[] = [transactionId];
    if (merchantFilter.merchantId) {
      paymentParams.push(merchantFilter.merchantId);
    }

    // Check payment exists (with merchant filter)
    const paymentCheck = await pool.query(
      `SELECT status FROM "Payment" WHERE "transactionId" = $1 ${merchantCondition}`,
      paymentParams
    );

    if (paymentCheck.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Payment not found' },
        { status: 404 }
      );
    }

    if (paymentCheck.rows[0].status === 'RELEASED') {
      return NextResponse.json(
        { success: false, error: 'Payment already released' },
        { status: 400 }
      );
    }

    // Mark as FAILED (resolved/ignored)
    await pool.query(
      `UPDATE "Payment" SET
        status = 'FAILED',
        "updatedAt" = NOW()
      WHERE "transactionId" = $1`,
      [transactionId]
    );

    // Create audit log with merchantId
    const id = `c${Date.now().toString(36)}${Math.random().toString(36).substring(2, 9)}`;
    await pool.query(
      `INSERT INTO "AuditLog" (id, action, details, success, "merchantId", "createdAt")
       VALUES ($1, 'payment_resolved', $2, true, $3, NOW())`,
      [id, JSON.stringify({ transactionId, resolvedBy, reason }), context.merchantId]
    );

    return NextResponse.json({
      success: true,
      message: `Payment ${transactionId} marked as resolved`,
    });
  } catch (error) {
    console.error('Error resolving payment:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to resolve payment' },
      { status: 500 }
    );
  }
}
