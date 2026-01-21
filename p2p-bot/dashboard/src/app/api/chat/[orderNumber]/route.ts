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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderNumber: string }> }
) {
  try {
    // SECURITY: Require authentication
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { orderNumber } = await params;

    if (!orderNumber) {
      return NextResponse.json(
        { error: 'Order number is required' },
        { status: 400 }
      );
    }

    // SECURITY: Verify merchant owns this order before fetching chat
    const merchantFilter = getMerchantFilter(context);
    const order = await prisma.order.findFirst({
      where: { orderNumber, ...merchantFilter },
      select: { id: true, orderNumber: true },
    });

    if (!order) {
      return NextResponse.json(
        { error: 'Order not found or access denied' },
        { status: 404 }
      );
    }

    // Get the logged-in merchant's bot URL
    const botUrl = await getMerchantBotUrl(context.merchantId);

    // Use merchant's bot URL or fallback to global RAILWAY_API_URL
    const apiUrl = botUrl || RAILWAY_API_URL;

    if (!apiUrl) {
      return NextResponse.json(
        { error: 'Bot API URL not configured' },
        { status: 500 }
      );
    }

    const response = await fetch(`${apiUrl}/api/chat/${orderNumber}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Chat fetch error: ${response.status} - ${errorText}`);
      return NextResponse.json(
        { error: `Failed to fetch chat: ${response.status}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error: any) {
    console.error('Chat API error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch chat messages' },
      { status: 500 }
    );
  }
}
