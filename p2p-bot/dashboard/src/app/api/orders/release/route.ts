import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Pool } from 'pg';

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
    const body = await request.json();
    const { orderNumber, authType, code } = body;

    if (!orderNumber || !authType || !code) {
      return NextResponse.json(
        { success: false, error: 'orderNumber, authType, and code are required' },
        { status: 400 }
      );
    }

    // Get the logged-in merchant's bot URL
    const session = await getServerSession(authOptions);
    let botUrl: string | null = null;

    if (session?.user?.id) {
      botUrl = await getMerchantBotUrl(session.user.id);
    }

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
