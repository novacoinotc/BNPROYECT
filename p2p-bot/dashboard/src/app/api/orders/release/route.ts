import { NextRequest, NextResponse } from 'next/server';
import { getMerchantContext, getMerchantFilter } from '@/lib/merchant-context';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

const prisma = new PrismaClient();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const RAILWAY_API_URL = process.env.RAILWAY_API_URL;

// Get bot URL for the logged-in merchant
async function getMerchantBotUrl(merchantId: string): Promise<string | null> {
  try {
    const result = await pool.query(
      'SELECT "botApiUrl" FROM "Merchant" WHERE id = $1',
      [merchantId]
    );
    return result.rows[0]?.botApiUrl || null;
  } catch (error) {
    console.error('Error getting merchant bot URL:', error);
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    // SECURITY: Require authentication
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { orderNumber, authType, code } = body;

    if (!orderNumber || !authType || !code) {
      return NextResponse.json(
        { success: false, error: 'orderNumber, authType, and code are required' },
        { status: 400 }
      );
    }

    // SECURITY: Verify merchant owns this order before proxying release
    const merchantFilter = getMerchantFilter(context);
    const order = await prisma.order.findFirst({
      where: { orderNumber, ...merchantFilter },
      select: { id: true, orderNumber: true },
    });

    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found or access denied' },
        { status: 404 }
      );
    }

    // Get the logged-in merchant's bot URL
    const botUrl = await getMerchantBotUrl(context.merchantId);

    // Use merchant's bot URL or fallback to global RAILWAY_API_URL
    const apiUrl = botUrl || RAILWAY_API_URL;

    if (!apiUrl) {
      return NextResponse.json(
        { success: false, error: 'Bot API URL not configured' },
        { status: 500 }
      );
    }

    const response = await fetch(`${apiUrl}/api/orders/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderNumber, authType, code }),
      signal: AbortSignal.timeout(30000), // 30 second timeout for release
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: data.error || 'Failed to release order' },
        { status: response.status }
      );
    }

    return NextResponse.json(data);
  } catch (error: any) {
    console.error('Release API error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to release order' },
      { status: 500 }
    );
  }
}
