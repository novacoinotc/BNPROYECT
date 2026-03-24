import { NextRequest, NextResponse } from 'next/server';
import { getMerchantContext, getMerchantFilter } from '@/lib/merchant-context';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function GET(request: NextRequest) {
  try {
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const orderNumber = searchParams.get('orderNumber');
    const buyerName = searchParams.get('buyerName');
    const documentType = searchParams.get('type');
    const dateFrom = searchParams.get('dateFrom');
    const dateTo = searchParams.get('dateTo');
    const minAmount = searchParams.get('minAmount');
    const maxAmount = searchParams.get('maxAmount');
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    const offset = (page - 1) * limit;

    const filter = getMerchantFilter(context);
    let where = '1=1';
    const params: any[] = [];
    let paramIdx = 1;

    if (filter.merchantId) {
      where += ` AND "merchantId" = $${paramIdx++}`;
      params.push(filter.merchantId);
    }

    if (orderNumber) {
      where += ` AND "orderNumber" LIKE $${paramIdx++}`;
      params.push(`%${orderNumber}%`);
    }

    if (buyerName) {
      where += ` AND "buyerName" ILIKE $${paramIdx++}`;
      params.push(`%${buyerName}%`);
    }

    if (documentType) {
      where += ` AND "documentType" = $${paramIdx++}`;
      params.push(documentType);
    }

    if (dateFrom) {
      where += ` AND "createdAt" >= $${paramIdx++}`;
      params.push(dateFrom);
    }

    if (dateTo) {
      where += ` AND "createdAt" < ($${paramIdx++})::date + interval '1 day'`;
      params.push(dateTo);
    }

    if (minAmount) {
      where += ` AND "amount"::numeric >= $${paramIdx++}`;
      params.push(parseFloat(minAmount));
    }

    if (maxAmount) {
      where += ` AND "amount"::numeric <= $${paramIdx++}`;
      params.push(parseFloat(maxAmount));
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM "OrderImage" WHERE ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    const result = await pool.query(
      `SELECT id, "orderNumber", "documentType", "compressedSize", "amount",
              "buyerName", "merchantId", "createdAt"
       FROM "OrderImage"
       WHERE ${where}
       ORDER BY "createdAt" DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset]
    );

    return NextResponse.json({
      success: true,
      images: result.rows,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
