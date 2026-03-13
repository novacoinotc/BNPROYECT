// =====================================================
// OKX AD MANAGER
// Ad CRUD with OKX's cancel+create update pattern
// CRITICAL: OKX ad update creates new ad ID!
// =====================================================

import { getOkxClient, OkxClient } from './okx-client.js';
import { OkxAdData, OkxAdUpdateResult } from './okx-types.js';
import { logger } from '../../utils/logger.js';

const log = logger.child({ module: 'okx-ads' });

// ==================== TYPES ====================

export interface OkxManagedAd {
  adId: string;
  side: 'buy' | 'sell';
  crypto: string;
  fiat: string;
  currentPrice: number;
  status: string;   // 'new', 'online', 'offline'
  availableAmount: string;
  type: string;     // 'limit' or 'floating_market'
  priceMargin?: string; // For floating_market ads
}

// ==================== AD MANAGER ====================

export class OkxAdManager {
  private client: OkxClient;

  constructor() {
    this.client = getOkxClient();
  }

  /**
   * Get all active (online) ads
   * Fetches from OKX and returns parsed ad info
   */
  async getActiveAds(side?: 'buy' | 'sell'): Promise<OkxManagedAd[]> {
    try {
      const ads = await this.client.getActiveAds(side);

      if (ads.length === 0) {
        log.warn({ side }, 'OKX getActiveAds returned 0 ads from API');
      }

      const activeAds = ads
        .filter(ad => {
          // Only include ads that are listed on the marketplace (actually visible to buyers)
          const rawAd = ad as any;
          if (rawAd.isListedOnMarketplace === false || rawAd.isListedOnMarketplace === 'false') return false;
          if (rawAd.isHidden === true || rawAd.isHidden === 'true') return false;

          const status = (ad.status || '').toLowerCase();
          const excludedStatuses = ['hidden', 'offline', 'cancelled', 'expired', 'deleted'];
          return !excludedStatuses.includes(status);
        })
        .map(ad => {
          const rawAd = ad as any;
          return {
            adId: ad.adId,
            side: ad.side,
            crypto: ad.cryptoCurrency,
            fiat: ad.fiatCurrency,
            currentPrice: parseFloat(ad.unitPrice),
            status: ad.status || 'new',
            availableAmount: ad.availableAmount,
            type: rawAd.type || 'limit',
            priceMargin: rawAd.priceMargin,
          };
        });

      if (ads.length > 0) {
        const summary = activeAds.map(a => {
          return `${a.adId}(${a.side},${a.crypto},type=${a.type},price=${a.currentPrice})`;
        }).join(' | ');
        log.info(`OKX ads: ${ads.length} total, ${activeAds.length} active. Active: ${summary || 'none'}`);
      }

      log.debug({ count: activeAds.length, side }, 'OKX active ads fetched');
      return activeAds;
    } catch (error: any) {
      log.error(`Failed to fetch OKX active ads: ${error.message}`);
      return [];
    }
  }

  /**
   * Update ad price
   * IMPORTANT: OKX cancels old ad and creates new one!
   * Returns the new ad ID that must be tracked
   */
  async updateAdPrice(adId: string, newPrice: number, adType?: string, availableAmount?: string): Promise<OkxAdUpdateResult | null> {
    const priceStr = newPrice.toFixed(2);

    log.info(`OKX: Updating ad ${adId} to ${priceStr} (type=${adType || 'unknown'})`);

    try {
      const updateParams: Record<string, any> = { unitPrice: priceStr };

      // Always send maxOrderLimit to prevent "maximum order limit" errors when price decreases
      if (availableAmount) {
        const maxFiat = Math.floor(parseFloat(availableAmount) * newPrice);
        updateParams.maxOrderLimit = maxFiat.toFixed(2);
      }

      const result = await this.client.updateAd(adId, updateParams);

      log.info(`OKX: Ad updated ${result.oldAdId} -> ${result.newAdId} at ${priceStr}`);
      return result;
    } catch (error: any) {
      const errMsg = error.message || '';
      log.error(`OKX: Failed to update ad ${adId} to ${priceStr}: ${errMsg}`);
      return null;
    }
  }

  /**
   * Show/hide an ad
   */
  async setAdStatus(adId: string, status: 'hidden' | 'show'): Promise<boolean> {
    try {
      await this.client.updateAdStatus(adId, status);
      return true;
    } catch (error: any) {
      log.error({ adId, status, error: error.message }, 'OKX: Failed to update ad status');
      return false;
    }
  }

  /**
   * Cancel an ad
   */
  async cancelAd(adId: string): Promise<boolean> {
    try {
      await this.client.cancelAd(adId);
      return true;
    } catch (error: any) {
      log.error({ adId, error: error.message }, 'OKX: Failed to cancel ad');
      return false;
    }
  }
}

// ==================== FACTORY ====================

export function createOkxAdManager(): OkxAdManager {
  return new OkxAdManager();
}
