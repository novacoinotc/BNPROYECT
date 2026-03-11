import { NextRequest, NextResponse } from 'next/server';
import { getMerchantContext } from '@/lib/merchant-context';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

interface SellerData {
  userNo: string;
  nickName: string;
  price: string;
  surplusAmount: string;
  minAmount: string;
  maxAmount: string;
  isOnline: boolean;
  userGrade: number;
  monthFinishRate: number;
  monthOrderCount: number;
  positiveRate: number;
  proMerchant: boolean;
}

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

// Try fetching sellers through the merchant's bot proxy
async function tryBotProxy(
  botUrl: string,
  asset: string,
  fiat: string,
  tradeType: string,
  rows: number
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const params = new URLSearchParams({ asset, fiat, tradeType, rows: String(rows) });
    const response = await fetch(`${botUrl}/api/sellers?${params}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return { success: false, error: `Bot proxy HTTP ${response.status}` };
    }

    const data = await response.json();
    if (!data.success) {
      return { success: false, error: data.error || 'Bot proxy returned error' };
    }

    return { success: true, data };
  } catch (error: any) {
    console.log('Bot proxy sellers error:', error.message);
    return { success: false, error: error.message };
  }
}

// Fetch sellers directly from Binance P2P market (original behavior)
async function fetchFromBinance(
  asset: string,
  fiat: string,
  tradeType: string,
  rows: number
): Promise<{ success: boolean; sellers?: SellerData[]; error?: string }> {
  const perPage = 20;
  const pages = Math.ceil(rows / perPage);
  let allItems: Array<{
    adv: {
      advNo: string;
      tradeType: string;
      asset: string;
      fiatUnit: string;
      price: string;
      surplusAmount: string;
      minSingleTransAmount: string;
      maxSingleTransAmount: string;
    };
    advertiser: {
      userNo: string;
      nickName: string;
      userGrade?: number;
      monthFinishRate?: number;
      monthOrderCount?: number;
      positiveRate?: number;
      isOnline?: boolean;
      proMerchant?: boolean;
    };
  }> = [];

  for (let page = 1; page <= pages; page++) {
    const response = await fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset,
        fiat,
        tradeType,
        page,
        rows: perPage,
        payTypes: [],
        publisherType: 'merchant',
        transAmount: null,
      }),
    });

    const rawData = await response.json() as { code?: string; data?: typeof allItems };

    if (rawData.code !== '000000' || !rawData.data) {
      if (page === 1) {
        return { success: false, error: 'Failed to fetch sellers from Binance' };
      }
      break;
    }

    allItems.push(...rawData.data);
    if (rawData.data.length < perPage) break;
  }

  const sellers: SellerData[] = allItems.slice(0, rows).map((item, index) => ({
    position: index + 1,
    userNo: item.advertiser.userNo,
    nickName: item.advertiser.nickName,
    price: item.adv.price,
    surplusAmount: item.adv.surplusAmount,
    minAmount: item.adv.minSingleTransAmount,
    maxAmount: item.adv.maxSingleTransAmount,
    isOnline: item.advertiser.isOnline ?? false,
    userGrade: item.advertiser.userGrade ?? 0,
    monthFinishRate: item.advertiser.monthFinishRate ?? 0,
    monthOrderCount: item.advertiser.monthOrderCount ?? 0,
    positiveRate: item.advertiser.positiveRate ?? 0,
    proMerchant: item.advertiser.proMerchant ?? false,
  }));

  return { success: true, sellers };
}

// GET - Fetch current sellers from the appropriate P2P market
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const asset = searchParams.get('asset') || 'USDT';
  const fiat = searchParams.get('fiat') || 'MXN';
  const tradeType = searchParams.get('tradeType') || 'SELL';
  const rows = parseInt(searchParams.get('rows') || '20');

  try {
    // Check if merchant has a dedicated bot URL (Bybit, OKX, etc.)
    const context = await getMerchantContext();
    if (context) {
      const botUrl = await getMerchantBotUrl(context.merchantId);
      if (botUrl) {
        // Route through the merchant's bot — it knows its own exchange
        const proxyResult = await tryBotProxy(botUrl, asset, fiat, tradeType, rows);
        if (proxyResult.success && proxyResult.data) {
          return NextResponse.json(proxyResult.data);
        }
        console.log(`Bot proxy failed for merchant ${context.merchantId}, falling back...`);
      }
    }

    // Default: Binance P2P market (original behavior)
    const result = await fetchFromBinance(asset, fiat, tradeType, rows);
    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      sellers: result.sellers,
      asset,
      fiat,
      tradeType,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error fetching sellers:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch sellers' },
      { status: 500 }
    );
  }
}
