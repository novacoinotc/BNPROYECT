// =====================================================
// BINANCE API HELPER - Shared HTTP client with proxy support
// Used by positioning managers for authenticated API calls
// =====================================================

import crypto from 'crypto';
import axios, { AxiosInstance } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { logger } from '../utils/logger.js';

// Create proxy agent if PROXY_URL is configured
function createProxyAgent(): HttpsProxyAgent<string> | undefined {
  const proxyUrl = process.env.PROXY_URL;
  if (proxyUrl) {
    return new HttpsProxyAgent(proxyUrl);
  }
  return undefined;
}

// Singleton axios instance with proxy support
let axiosInstance: AxiosInstance | null = null;

function getAxiosInstance(): AxiosInstance {
  if (!axiosInstance) {
    const proxyAgent = createProxyAgent();

    axiosInstance = axios.create({
      baseURL: 'https://api.binance.com',
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'X-MBX-APIKEY': process.env.BINANCE_API_KEY || '',
      },
      ...(proxyAgent && { httpsAgent: proxyAgent, proxy: false }),
    });

    if (proxyAgent) {
      logger.info('🌐 [BINANCE-API] Using HTTP proxy for Binance API calls');
    }
  }
  return axiosInstance;
}

// Sign query string with HMAC-SHA256
function signQuery(query: string): string {
  const secret = process.env.BINANCE_API_SECRET || '';
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

// ==================== AD LISTING ====================

interface RawAd {
  advNo: string;
  tradeType: string;
  asset: string;
  fiatUnit: string;
  price: string;
  advStatus: number;
}

export interface AdInfo {
  advNo: string;
  asset: string;
  fiat: string;
  tradeType: 'BUY' | 'SELL';
  currentPrice: number;
  isOnline: boolean;
}

/**
 * Fetch all merchant's ads (both BUY and SELL)
 * Returns active ads filtered by optional tradeType
 */
export async function fetchMerchantAds(tradeType?: 'BUY' | 'SELL'): Promise<AdInfo[]> {
  const ts = Date.now();
  const query = `timestamp=${ts}`;
  const signature = signQuery(query);

  try {
    const response = await getAxiosInstance().post(
      `/sapi/v1/c2c/ads/listWithPagination?${query}&signature=${signature}`,
      { page: 1, rows: 50 }
    );

    const data = response.data;
    const allAds: RawAd[] = [];

    // Handle different API response formats
    if (Array.isArray(data.data)) {
      allAds.push(...data.data);
    } else if (data.data) {
      if (data.data.buyList) allAds.push(...data.data.buyList);
      if (data.data.sellList) allAds.push(...data.data.sellList);
    }

    // Map to AdInfo and filter by tradeType if specified
    const ads: AdInfo[] = allAds
      .filter(ad => ad.advStatus === 1) // Only online ads
      .filter(ad => !tradeType || ad.tradeType === tradeType)
      .map(ad => ({
        advNo: ad.advNo,
        asset: ad.asset,
        fiat: ad.fiatUnit,
        tradeType: ad.tradeType as 'BUY' | 'SELL',
        currentPrice: parseFloat(ad.price),
        isOnline: ad.advStatus === 1,
      }));

    return ads;
  } catch (error: any) {
    // Log detailed error info for debugging
    const errorDetails = {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data,
    };
    logger.error(errorDetails, '❌ [BINANCE-API] Error fetching merchant ads');
    return [];
  }
}

/**
 * Fetch only SELL ads
 */
export async function fetchSellAds(): Promise<AdInfo[]> {
  return fetchMerchantAds('SELL');
}

/**
 * Fetch only BUY ads
 */
export async function fetchBuyAds(): Promise<AdInfo[]> {
  return fetchMerchantAds('BUY');
}

// ==================== AD UPDATE ====================

export interface UpdateAdResult {
  success: boolean;
  code?: string;
  message?: string;
}

/**
 * Update ad price via Binance API
 */
export async function updateAdPrice(advNo: string, price: number): Promise<UpdateAdResult> {
  const roundedPrice = Math.round(price * 100) / 100;
  const ts = Date.now();
  const query = `timestamp=${ts}`;
  const signature = signQuery(query);

  try {
    const response = await getAxiosInstance().post(
      `/sapi/v1/c2c/ads/update?${query}&signature=${signature}`,
      { advNo, price: roundedPrice }
    );

    const data = response.data;
    const success = data.success === true || data.code === '000000';

    if (!success) {
      logger.warn({
        advNo,
        code: data.code,
        message: data.msg || data.message,
      }, '⚠️ [BINANCE-API] Ad update failed');
    }

    return {
      success,
      code: data.code,
      message: data.msg || data.message,
    };
  } catch (error: any) {
    // Extract Binance error details from response
    const responseData = error.response?.data;
    const binanceCode = responseData?.code;
    const binanceMsg = responseData?.msg || responseData?.message;
    const httpStatus = error.response?.status;

    // Log with clear visibility of Binance error
    logger.error({
      advNo,
      httpStatus,
      binanceCode,
      binanceMsg,
      axiosMessage: error.message,
      fullResponse: JSON.stringify(responseData),
    }, `❌ [BINANCE-API] Error updating ad price: ${binanceMsg || error.message}`);

    return {
      success: false,
      code: binanceCode,
      message: binanceMsg || error.message,
    };
  }
}

// ==================== LEGACY SINGLE-AD DETECTION ====================

/**
 * Find active ad matching criteria (for legacy single-ad mode)
 * Note: tradeType here is the SEARCH type, we invert to find our ad
 */
export async function findActiveAdNo(
  searchTradeType: 'BUY' | 'SELL',
  asset: string = 'USDT',
  fiat: string = 'MXN'
): Promise<string | null> {
  // When searching BUY (other sellers), our ad is SELL
  // When searching SELL (other buyers), our ad is BUY
  const ourAdType = searchTradeType === 'BUY' ? 'SELL' : 'BUY';

  const ads = await fetchMerchantAds(ourAdType);
  const matchingAd = ads.find(ad => ad.asset === asset && ad.fiat === fiat);

  if (matchingAd) {
    logger.info({
      advNo: matchingAd.advNo,
      tradeType: matchingAd.tradeType,
      asset: matchingAd.asset,
      fiat: matchingAd.fiat,
      price: matchingAd.currentPrice,
    }, '🎯 [BINANCE-API] Found active ad');
    return matchingAd.advNo;
  }

  logger.warn({
    searchType: ourAdType,
    asset,
    fiat,
  }, '⚠️ [BINANCE-API] No active ad found matching criteria');
  return null;
}
