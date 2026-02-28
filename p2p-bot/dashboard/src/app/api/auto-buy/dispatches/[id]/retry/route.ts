import { NextResponse } from 'next/server';
import { getMerchantContext } from '@/lib/merchant-context';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function getMerchantBotUrl(merchantId: string): Promise<string | null> {
  try {
    const result = await pool.query(
      'SELECT "botApiUrl" FROM "Merchant" WHERE id = $1',
      [merchantId]
    );
    return result.rows[0]?.botApiUrl || null;
  } catch {
    return null;
  }
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const botUrl = await getMerchantBotUrl(context.merchantId);
    if (!botUrl) {
      return NextResponse.json({ error: 'Bot URL not configured' }, { status: 500 });
    }

    const { id } = await params;
    const response = await fetch(`${botUrl}/api/auto-buy/dispatches/${id}/retry`, {
      method: 'POST',
      signal: AbortSignal.timeout(60000),
    });

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
