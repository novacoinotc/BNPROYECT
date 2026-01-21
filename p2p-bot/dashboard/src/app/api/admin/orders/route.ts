import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized - Admin only' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const merchantId = searchParams.get('merchantId');
    const limit = parseInt(searchParams.get('limit') || '100');
    const offset = parseInt(searchParams.get('offset') || '0');

    // Build query dynamically
    let whereConditions: string[] = [];
    let params: any[] = [];
    let paramIndex = 1;

    if (status && status !== 'all') {
      whereConditions.push(`o.status = $${paramIndex++}`);
      params.push(status);
    }

    if (merchantId && merchantId !== 'all') {
      whereConditions.push(`o."merchantId" = $${paramIndex++}`);
      params.push(merchantId);
    }

    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    // Get orders with merchant info
    const ordersResult = await pool.query(`
      SELECT
        o.id,
        o."orderNumber",
        o."tradeType",
        o.asset,
        o.amount,
        o."totalPrice",
        o."unitPrice",
        o.status,
        o."buyerNickName",
        o."buyerRealName",
        o."verificationStatus",
        o."binanceCreateTime",
        o."paidAt",
        o."releasedAt",
        o."cancelledAt",
        o.dismissed,
        m.id as "merchantId",
        m.name as "merchantName",
        m."binanceNickname" as "merchantNickname"
      FROM "Order" o
      LEFT JOIN "Merchant" m ON o."merchantId" = m.id
      ${whereClause}
      ORDER BY o."binanceCreateTime" DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `, [...params, limit, offset]);

    // Get total count
    const countResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM "Order" o
      ${whereClause}
    `, params);

    // Get counts by status for filters
    const statusCountsResult = await pool.query(`
      SELECT status, COUNT(*) as count
      FROM "Order"
      GROUP BY status
    `);

    // Get payment info for each order
    const orderNumbers = ordersResult.rows.map(o => o.orderNumber);
    let paymentsMap: Record<string, any[]> = {};

    if (orderNumbers.length > 0) {
      const paymentsResult = await pool.query(`
        SELECT
          p.id,
          p.amount,
          p."senderName",
          p.status,
          p."matchedOrderId",
          o."orderNumber"
        FROM "Payment" p
        JOIN "Order" o ON p."matchedOrderId" = o.id
        WHERE o."orderNumber" = ANY($1)
      `, [orderNumbers]);

      paymentsResult.rows.forEach(payment => {
        if (!paymentsMap[payment.orderNumber]) {
          paymentsMap[payment.orderNumber] = [];
        }
        paymentsMap[payment.orderNumber].push(payment);
      });
    }

    // Attach payments to orders
    const ordersWithPayments = ordersResult.rows.map(order => ({
      ...order,
      payments: paymentsMap[order.orderNumber] || [],
    }));

    return NextResponse.json({
      success: true,
      orders: ordersWithPayments,
      total: parseInt(countResult.rows[0].total),
      statusCounts: statusCountsResult.rows.reduce((acc, row) => {
        acc[row.status] = parseInt(row.count);
        return acc;
      }, {} as Record<string, number>),
    });
  } catch (error) {
    console.error('Admin orders error:', error);
    return NextResponse.json({ error: 'Failed to load orders' }, { status: 500 });
  }
}
