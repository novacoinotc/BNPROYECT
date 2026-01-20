import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';
import { getMerchantContext, getMerchantFilter } from '@/lib/merchant-context';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// GET - Get orders that could match a payment amount (for manual linking)
export async function GET(request: NextRequest) {
  try {
    // Get merchant context
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

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

    // Build query with merchant filter
    // Admin sees all, merchant sees only their own
    const merchantFilter = getMerchantFilter(context);
    const merchantCondition = merchantFilter.merchantId
      ? 'AND "merchantId" = $3'
      : '';

    const queryParams: any[] = [minAmount, maxAmount];
    if (merchantFilter.merchantId) {
      queryParams.push(merchantFilter.merchantId);
    }

    const result = await pool.query(
      `SELECT "orderNumber", "totalPrice", "buyerNickName", "buyerRealName",
              status, "binanceCreateTime" as "createdAt"
       FROM "Order"
       WHERE "totalPrice"::numeric BETWEEN $1 AND $2
         AND status IN ('PAID', 'COMPLETED')
         AND "binanceCreateTime" > NOW() - INTERVAL '7 days'
         ${merchantCondition}
       ORDER BY "binanceCreateTime" DESC
       LIMIT 20`,
      queryParams
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
