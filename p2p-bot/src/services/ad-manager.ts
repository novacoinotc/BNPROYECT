// =====================================================
// AD MANAGER - Automatically finds and manages active ads
// Uses shared binance-api helper with proxy support
// =====================================================

import { logger } from '../utils/logger.js';
import {
  fetchMerchantAds,
  updateAdPrice as updateAdPriceApi,
  AdInfo as ApiAdInfo,
} from './binance-api.js';

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
  const ads = await fetchMerchantAds();

  // Map from ApiAdInfo to AdInfo
  return ads.map(ad => ({
    advNo: ad.advNo,
    tradeType: ad.tradeType,
    asset: ad.asset,
    fiatUnit: ad.fiat,
    price: ad.currentPrice.toString(),
    advStatus: ad.isOnline ? 1 : 4,
    surplusAmount: '0',
    minSingleTransAmount: '0',
    maxSingleTransAmount: '0',
  }));
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
 * Note: This function is deprecated - use getMyAds and filter instead
 */
export async function getAdDetail(advNo: string): Promise<AdInfo | null> {
  const ads = await getMyAds();
  return ads.find(ad => ad.advNo === advNo) || null;
}

/**
 * Update ad price
 */
export async function updateAdPrice(advNo: string, price: number): Promise<boolean> {
  const result = await updateAdPriceApi(advNo, price);

  if (result.success) {
    logger.info(`✅ Price updated: ${advNo} -> ${Math.round(price * 100) / 100}`);
  } else {
    logger.error(`❌ Failed to update price: ${result.message || 'Unknown error'}`);
  }

  return result.success;
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
