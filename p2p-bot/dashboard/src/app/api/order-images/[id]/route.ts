import { NextRequest, NextResponse } from 'next/server';
import { getMerchantContext } from '@/lib/merchant-context';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const context = await getMerchantContext();
    if (!context) {
      return new NextResponse('Unauthorized', { status: 401 });
    }

    const { id } = await params;

    const result = await pool.query(
      `SELECT "imageData", "mimeType" FROM "OrderImage" WHERE id = $1 AND "merchantId" = $2`,
      [id, context.merchantId]
    );

    if (!result.rows[0]) {
      return new NextResponse('Not found', { status: 404 });
    }

    const { imageData, mimeType } = result.rows[0];

    return new NextResponse(imageData, {
      headers: {
        'Content-Type': mimeType || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (error: any) {
    return new NextResponse('Error', { status: 500 });
  }
}
