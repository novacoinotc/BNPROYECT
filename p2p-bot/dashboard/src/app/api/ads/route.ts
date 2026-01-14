import { NextRequest, NextResponse } from 'next/server';

// Binance API configuration - support both env var names
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET_KEY = process.env.BINANCE_SECRET_KEY || process.env.BINANCE_API_SECRET;
const BINANCE_BASE_URL = 'https://api.binance.com';

// Sign request for Binance API
async function signRequest(params: Record<string, string>): Promise<string> {
  const crypto = await import('crypto');
  const queryString = new URLSearchParams(params).toString();
  const signature = crypto
    .createHmac('sha256', BINANCE_SECRET_KEY || '')
    .update(queryString)
    .digest('hex');
  return `${queryString}&signature=${signature}`;
}

// Get my ads from Binance
async function getMyAds(): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    if (!BINANCE_API_KEY || !BINANCE_SECRET_KEY) {
      return { success: false, error: 'Missing BINANCE_API_KEY or BINANCE_SECRET_KEY/BINANCE_API_SECRET' };
    }

    const timestamp = Date.now().toString();
    const params = { timestamp, page: '1', rows: '20' };
    const signedQuery = await signRequest(params);

    const response = await fetch(
      `${BINANCE_BASE_URL}/sapi/v1/c2c/ads/list?${signedQuery}`,
      {
        method: 'GET',
        headers: {
          'X-MBX-APIKEY': BINANCE_API_KEY || '',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Error fetching ads:', response.status, errorText);
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }

    const data = await response.json();

    if (data.code && data.code !== 0) {
      console.error('Binance API error:', data.code, data.msg);
      return { success: false, error: `Binance error ${data.code}: ${data.msg}` };
    }

    return { success: true, data: data.data || data };
  } catch (error) {
    console.error('Error fetching ads:', error);
    return { success: false, error: String(error) };
  }
}

export async function GET(request: NextRequest) {
  try {
    const result = await getMyAds();

    if (!result.success || !result.data) {
      return NextResponse.json(
        { success: false, error: result.error || 'Failed to fetch ads from Binance' },
        { status: 500 }
      );
    }

    const adsData = result.data;

    // Extract sell ads (the ones we care about)
    const sellAds = adsData.sellList || [];
    const buyAds = adsData.buyList || [];
    const merchant = adsData.merchant || {};

    // Format response
    return NextResponse.json({
      success: true,
      sellAds: sellAds.map((ad: any) => ({
        advNo: ad.advNo,
        asset: ad.asset,
        fiatUnit: ad.fiatUnit,
        price: ad.price,
        priceType: ad.priceType,
        priceFloatingRatio: ad.priceFloatingRatio,
        minAmount: ad.minSingleTransAmount,
        maxAmount: ad.maxSingleTransAmount,
        surplusAmount: ad.surplusAmount,
        tradeMethods: ad.tradeMethods?.map((m: any) => ({
          payType: m.payType,
          payBank: m.payBank,
        })) || [],
        status: ad.advStatus === 1 ? 'ONLINE' : 'OFFLINE',
        autoReplyMsg: ad.autoReplyMsg,
        remarks: ad.remarks,
        buyerRegDaysLimit: ad.buyerRegDaysLimit,
        buyerBtcPositionLimit: ad.buyerBtcPositionLimit,
        dynamicMaxSingleTransAmount: ad.dynamicMaxSingleTransAmount,
        dynamicMaxSingleTransQuantity: ad.dynamicMaxSingleTransQuantity,
      })),
      buyAds: buyAds.length,
      merchant: {
        monthFinishRate: merchant.monthFinishRate,
        monthOrderCount: merchant.monthOrderCount,
        onlineStatus: merchant.onlineStatus,
      },
    });
  } catch (error) {
    console.error('Error fetching ads:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch ads' },
      { status: 500 }
    );
  }
}
