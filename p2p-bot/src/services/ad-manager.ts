// =====================================================
// AD MANAGER - Automatically finds and manages active ads
// =====================================================

import crypto from 'crypto';
import { logger } from '../utils/logger.js';

const API_KEY = process.env.BINANCE_API_KEY!;
const API_SECRET = process.env.BINANCE_API_SECRET!;

function sign(query: string): string {
  return crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

export interface AdInfo {
  advNo: string;
  tradeType: 'BUY' | 'SELL';
  asset: string;
  fiatUnit: string;
  price: string;
  advStatus: number; // 1=online, 4=offline
  surplusAmount: string;
  minSingleTransAmount: string;
  maxSingleTransAmount: string;
}

/**
 * Get all user's ads
 */
export async function getMyAds(): Promise<AdInfo[]> {
  const ts = Date.now();
  const query = `timestamp=${ts}`;

  const res = await fetch(
    `https://api.binance.com/sapi/v1/c2c/ads/list?${query}&signature=${sign(query)}`,
    {
      method: 'GET',
      headers: { 'X-MBX-APIKEY': API_KEY },
    }
  );

  const data = await res.json() as any;

  if (!data.data) {
    logger.warn('No ads data returned');
    return [];
  }

  // Combine sellList and buyList
  const allAds: AdInfo[] = [];

  if (data.data.sellList) {
    allAds.push(...data.data.sellList);
  }
  if (data.data.buyList) {
    allAds.push(...data.data.buyList);
  }

  return allAds;
}

/**
 * Find the active (online) ad for a given trade type
 * Returns the first online ad found, or null if none
 */
export async function findActiveAd(
  tradeType: 'BUY' | 'SELL',
  asset: string = 'USDT',
  fiat: string = 'MXN'
): Promise<AdInfo | null> {
  const ads = await getMyAds();

  const activeAd = ads.find(ad =>
    ad.tradeType === tradeType &&
    ad.asset === asset &&
    ad.fiatUnit === fiat &&
    ad.advStatus === 1 // 1 = online
  );

  if (activeAd) {
    logger.info(
      `✅ Found active ${tradeType} ad: ${activeAd.advNo} @ ${activeAd.price} ${fiat}`
    );
  } else {
    logger.warn(`⚠️ No active ${tradeType} ad found for ${asset}/${fiat}`);
  }

  return activeAd || null;
}

/**
 * Get ad detail by advNo
 */
export async function getAdDetail(advNo: string): Promise<AdInfo | null> {
  const ts = Date.now();
  const query = `adsNo=${advNo}&timestamp=${ts}`;

  const res = await fetch(
    `https://api.binance.com/sapi/v1/c2c/ads/getDetailByNo?${query}&signature=${sign(query)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MBX-APIKEY': API_KEY },
    }
  );

  const data = await res.json() as any;
  return data.data || null;
}

/**
 * Update ad price
 */
export async function updateAdPrice(advNo: string, price: number): Promise<boolean> {
  const roundedPrice = Math.round(price * 100) / 100;

  const ts = Date.now();
  const query = `timestamp=${ts}`;

  const res = await fetch(
    `https://api.binance.com/sapi/v1/c2c/ads/update?${query}&signature=${sign(query)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MBX-APIKEY': API_KEY },
      body: JSON.stringify({ advNo, price: roundedPrice }),
    }
  );

  const data = await res.json() as any;
  const success = data.success === true || data.code === '000000';

  if (success) {
    logger.info(`✅ Price updated: ${advNo} -> ${roundedPrice}`);
  } else {
    logger.error(`❌ Failed to update price: ${JSON.stringify(data)}`);
  }

  return success;
}

/**
 * Smart update - finds the active ad and updates it
 * No need to specify advNo!
 */
export async function smartUpdatePrice(
  tradeType: 'BUY' | 'SELL',
  newPrice: number,
  asset: string = 'USDT',
  fiat: string = 'MXN'
): Promise<boolean> {
  const activeAd = await findActiveAd(tradeType, asset, fiat);

  if (!activeAd) {
    logger.error(`No active ${tradeType} ad to update`);
    return false;
  }

  return updateAdPrice(activeAd.advNo, newPrice);
}
