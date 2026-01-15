import { NextRequest, NextResponse } from 'next/server';

// Binance API configuration - support both env var names
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET_KEY = process.env.BINANCE_SECRET_KEY || process.env.BINANCE_API_SECRET;
const BINANCE_BASE_URL = 'https://api.binance.com';

// Generate signature for Binance API
function generateSignature(queryString: string): string {
  const crypto = require('crypto');
  return crypto
    .createHmac('sha256', BINANCE_SECRET_KEY || '')
    .update(queryString)
    .digest('hex');
}

// Build signed query string
function buildSignedQuery(params: Record<string, any> = {}): string {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };

  const queryString = Object.entries(allParams)
    .filter(([_, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');

  const signature = generateSignature(queryString);
  return `${queryString}&signature=${signature}`;
}

// Get my ads from Binance
// Tries GET first, then POST as fallback
async function getMyAds(): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    if (!BINANCE_API_KEY || !BINANCE_SECRET_KEY) {
      return { success: false, error: 'Missing BINANCE_API_KEY or BINANCE_SECRET_KEY/BINANCE_API_SECRET' };
    }

    // Try GET method first (works on some API versions)
    const getResult = await tryGetAds();
    if (getResult.success && getResult.data) {
      console.log('Ads fetched via GET method');
      return getResult;
    }

    // Try POST method as fallback
    const postResult = await tryPostAds();
    if (postResult.success && postResult.data) {
      console.log('Ads fetched via POST method');
      return postResult;
    }

    // Both failed
    console.error('Both GET and POST failed for ads endpoint');
    return { success: false, error: postResult.error || getResult.error || 'Failed to fetch ads' };
  } catch (error) {
    console.error('Error fetching ads:', error);
    return { success: false, error: String(error) };
  }
}

// Try GET method
async function tryGetAds(): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const signedQuery = buildSignedQuery({ page: 1, rows: 20 });

    const response = await fetch(
      `${BINANCE_BASE_URL}/sapi/v1/c2c/ads/listWithPagination?${signedQuery}`,
      {
        method: 'GET',
        headers: {
          'X-MBX-APIKEY': BINANCE_API_KEY || '',
          'clientType': 'web',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.log('GET ads failed:', response.status, errorText);
      return { success: false, error: `GET HTTP ${response.status}` };
    }

    const data = await response.json();

    if (data.code && data.code !== '000000' && data.code !== 0) {
      console.log('GET ads API error:', data.code, data.message || data.msg);
      return { success: false, error: `GET Binance error ${data.code}` };
    }

    return { success: true, data: data.data || data };
  } catch (error) {
    console.log('GET ads exception:', error);
    return { success: false, error: 'GET failed' };
  }
}

// Try POST method
async function tryPostAds(): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const signedQuery = buildSignedQuery({});
    const body = { page: 1, rows: 20 };

    const response = await fetch(
      `${BINANCE_BASE_URL}/sapi/v1/c2c/ads/listWithPagination?${signedQuery}`,
      {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': BINANCE_API_KEY || '',
          'Content-Type': 'application/json',
          'clientType': 'web',
        },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.log('POST ads failed:', response.status, errorText);
      return { success: false, error: `POST HTTP ${response.status}` };
    }

    const data = await response.json();

    if (data.code && data.code !== '000000' && data.code !== 0) {
      console.log('POST ads API error:', data.code, data.message || data.msg);
      return { success: false, error: `POST Binance error ${data.code}` };
    }

    return { success: true, data: data.data || data };
  } catch (error) {
    console.log('POST ads exception:', error);
    return { success: false, error: 'POST failed' };
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
