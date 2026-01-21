import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// GET - Fetch ads from all merchants' bots
export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized - Admin only' }, { status: 403 });
    }

    // Get all active merchants with their bot URLs
    const merchantsResult = await pool.query(`
      SELECT id, name, "binanceNickname", "botApiUrl"
      FROM "Merchant"
      WHERE "isActive" = true AND "isAdmin" = false AND "botApiUrl" IS NOT NULL
    `);

    // Fetch ads from each merchant's bot in parallel
    const adsPromises = merchantsResult.rows.map(async (merchant) => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(`${merchant.botApiUrl}/api/ads`, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          return {
            merchantId: merchant.id,
            merchantName: merchant.name,
            binanceNickname: merchant.binanceNickname,
            error: `HTTP ${response.status}`,
            sellAds: [],
            buyAds: [],
          };
        }

        const data = await response.json();

        return {
          merchantId: merchant.id,
          merchantName: merchant.name,
          binanceNickname: merchant.binanceNickname,
          sellAds: (data.sellAds || []).map((ad: any) => ({
            ...ad,
            merchantId: merchant.id,
            merchantName: merchant.name,
          })),
          buyAds: (data.buyAds || []).map((ad: any) => ({
            ...ad,
            merchantId: merchant.id,
            merchantName: merchant.name,
          })),
        };
      } catch (error: any) {
        return {
          merchantId: merchant.id,
          merchantName: merchant.name,
          binanceNickname: merchant.binanceNickname,
          error: error.message || 'Failed to fetch',
          sellAds: [],
          buyAds: [],
        };
      }
    });

    const merchantAds = await Promise.all(adsPromises);

    // Aggregate all ads
    const allSellAds = merchantAds.flatMap(m => m.sellAds);
    const allBuyAds = merchantAds.flatMap(m => m.buyAds);

    return NextResponse.json({
      success: true,
      merchants: merchantAds,
      aggregated: {
        sellAds: allSellAds,
        buyAds: allBuyAds,
        totalSell: allSellAds.length,
        totalBuy: allBuyAds.length,
      },
    });
  } catch (error) {
    console.error('Admin ads error:', error);
    return NextResponse.json({ error: 'Failed to load ads' }, { status: 500 });
  }
}

// POST - Update an ad for a specific merchant (proxy to their bot)
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized - Admin only' }, { status: 403 });
    }

    const body = await request.json();
    const { merchantId, advNo, price } = body;

    if (!merchantId || !advNo || price === undefined) {
      return NextResponse.json(
        { error: 'merchantId, advNo, and price are required' },
        { status: 400 }
      );
    }

    // Get merchant's bot URL
    const merchantResult = await pool.query(
      `SELECT "botApiUrl" FROM "Merchant" WHERE id = $1`,
      [merchantId]
    );

    if (!merchantResult.rows[0]?.botApiUrl) {
      return NextResponse.json(
        { error: 'Merchant bot URL not configured' },
        { status: 400 }
      );
    }

    const botUrl = merchantResult.rows[0].botApiUrl;

    // Proxy the update request to the merchant's bot
    const response = await fetch(`${botUrl}/api/ads/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ advNo, price }),
    });

    const data = await response.json();

    return NextResponse.json(data);
  } catch (error) {
    console.error('Admin ads update error:', error);
    return NextResponse.json({ error: 'Failed to update ad' }, { status: 500 });
  }
}
