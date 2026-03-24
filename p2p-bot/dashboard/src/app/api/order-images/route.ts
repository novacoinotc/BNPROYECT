import { NextRequest, NextResponse } from 'next/server';
import { getMerchantContext } from '@/lib/merchant-context';
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
    const documentType = searchParams.get('type');
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    const offset = (page - 1) * limit;

    let where = `"merchantId" = $1`;
    const params: any[] = [context.merchantId];
    let paramIdx = 2;

    if (orderNumber) {
      where += ` AND "orderNumber" = $${paramIdx++}`;
      params.push(orderNumber);
    }

    if (documentType) {
      where += ` AND "documentType" = $${paramIdx++}`;
      params.push(documentType);
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM "OrderImage" WHERE ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    const result = await pool.query(
      `SELECT id, "orderNumber", "documentType", "compressedSize", "amount",
              "buyerName", "createdAt"
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
