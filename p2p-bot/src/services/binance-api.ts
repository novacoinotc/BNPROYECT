// =====================================================
// BINANCE API HELPER - Shared HTTP client with proxy support
// Used by positioning managers for authenticated API calls
// =====================================================

import crypto from 'crypto';
import axios, { AxiosInstance } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import JSONBigInt from 'json-bigint';
import { logger } from '../utils/logger.js';

// Configure json-bigint to convert big integers to strings
// This prevents precision loss for advNo values like 13844165819849826304
const JSONBig = JSONBigInt({ storeAsString: true });

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
        'clientType': 'web',  // Required by Binance C2C API - fixes error -9000/187049
      },
      // Use json-bigint for parsing to preserve large advNo values
      // Without this, advNo like 13844165819849826304 gets corrupted due to JS precision limits
      transformResponse: [(data) => {
        if (typeof data === 'string') {
          try {
            return JSONBig.parse(data);
          } catch {
            return data;
          }
        }
        return data;
      }],
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
 * Includes retry logic for -9000/187049 error (race condition when orders arrive)
 */
export async function updateAdPrice(advNo: string, price: number, retryCount: number = 0): Promise<UpdateAdResult> {
  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 3000; // 3 seconds between retries

  const roundedPrice = Math.round(price * 100) / 100;
  const ts = Date.now();
  const query = `timestamp=${ts}`;
  const signature = signQuery(query);
  const body = { advNo, price: roundedPrice };

  try {
    const response = await getAxiosInstance().post(
      `/sapi/v1/c2c/ads/update?${query}&signature=${signature}`,
      body
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

    // Retry on -9000/187049 error (race condition with order arrival)
    // This error occurs when orders arrive simultaneously with ad updates
    if (binanceCode === -9000 && (binanceMsg === '187049' || binanceMsg === 187049) && retryCount < MAX_RETRIES) {
      logger.warn({
        advNo,
        retryCount: retryCount + 1,
        maxRetries: MAX_RETRIES,
      }, `⏳ [BINANCE-API] Error -9000/187049 (race condition), retrying in ${RETRY_DELAY_MS/1000}s...`);

      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      return updateAdPrice(advNo, price, retryCount + 1);
    }

    logger.error({
      advNo,
      price: roundedPrice,
      httpStatus,
      binanceCode,
      binanceMsg,
    }, `❌ [BINANCE-API] Error updating ad: [${binanceCode}] ${binanceMsg || error.message}`);

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
