import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// GET - Get orders that could match a payment amount (for manual linking)
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const amount = parseFloat(searchParams.get('amount') || '0');
    const tolerance = parseFloat(searchParams.get('tolerance') || '5'); // 5% default

    if (amount <= 0) {
      return NextResponse.json(
        { success: false, error: 'Valid amount is required' },
        { status: 400 }
      );
    }

    const minAmount = amount * (1 - tolerance / 100);
    const maxAmount = amount * (1 + tolerance / 100);

    const result = await pool.query(
      `SELECT "orderNumber", "totalPrice", "buyerNickName", "buyerRealName",
              status, "binanceCreateTime" as "createdAt"
       FROM "Order"
       WHERE "totalPrice"::numeric BETWEEN $1 AND $2
         AND status IN ('PAID', 'COMPLETED')
         AND "binanceCreateTime" > NOW() - INTERVAL '7 days'
       ORDER BY "binanceCreateTime" DESC
       LIMIT 20`,
      [minAmount, maxAmount]
    );

    return NextResponse.json({
      success: true,
      orders: result.rows,
      searchCriteria: { amount, tolerance, minAmount, maxAmount },
    });
  } catch (error) {
    console.error('Error fetching orders for manual match:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch orders' },
      { status: 500 }
    );
  }
}
