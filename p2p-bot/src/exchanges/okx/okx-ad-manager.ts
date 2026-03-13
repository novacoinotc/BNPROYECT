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
          const rawAd = ad as any;
          const status = (ad.status || rawAd.adStatus || rawAd.state || '').toLowerCase();

          // Log every ad during filtering for debugging
          log.info({
            adId: ad.adId,
            status,
            side: ad.side,
            crypto: ad.cryptoCurrency,
            price: ad.unitPrice,
            rawStatus: ad.status,
            rawAdStatus: rawAd.adStatus,
            rawState: rawAd.state,
            isListedOnMarketplace: rawAd.isListedOnMarketplace,
            isHidden: rawAd.isHidden,
          }, `OKX ad filter check: ${ad.adId}`);

          // Only exclude truly dead ads
          const excludedStatuses = ['cancelled', 'expired', 'deleted'];
          if (excludedStatuses.includes(status)) return false;

          // Skip hidden ads — only manage visible/marketplace-listed ads
          // This prevents OKX error 55147 ("duplicate price") when multiple ads
          // exist for the same pair and the bot tries to set them all to the same price
          if (rawAd.isHidden === true || rawAd.isHidden === 'true') {
            log.info({ adId: ad.adId, price: ad.unitPrice, crypto: ad.cryptoCurrency }, 'OKX: Skipping hidden ad');
            return false;
          }

          return true;
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
   * Handles error 55147 (duplicate price) by canceling conflicting hidden ads
   */
  async updateAdPrice(adId: string, newPrice: number, adType?: string, availableAmount?: string): Promise<OkxAdUpdateResult | null> {
    const priceStr = newPrice.toFixed(2);

    log.info(`OKX: Updating ad ${adId} to ${priceStr} (type=${adType || 'unknown'})`);

    const updateParams: Record<string, any> = { unitPrice: priceStr };

    // Always send maxOrderLimit to prevent "maximum order limit" errors when price decreases
    // OKX requires minimum 1000 MXN for maxOrderLimit
    if (availableAmount) {
      const maxFiat = Math.max(1000, Math.floor(parseFloat(availableAmount) * newPrice));
      updateParams.maxOrderLimit = maxFiat.toFixed(2);
    }

    try {
      const result = await this.client.updateAd(adId, updateParams);
      log.info(`OKX: Ad updated ${result.oldAdId} -> ${result.newAdId} at ${priceStr}`);
      return result;
    } catch (error: any) {
      const errMsg = error.message || '';

      // Error 55147: "You already have a sell ad with the same price on the marketplace"
      // This happens when a hidden ad already exists at the target price.
      // Fix: find and cancel the conflicting hidden ad, then retry.
      if (errMsg.includes('55147')) {
        log.warn(`OKX: Duplicate price conflict at ${priceStr} — looking for hidden ad to cancel`);
        const resolved = await this.resolveHiddenPriceConflict(adId, newPrice);
        if (resolved) {
          try {
            const result = await this.client.updateAd(adId, updateParams);
            log.info(`OKX: Ad updated after conflict resolution ${result.oldAdId} -> ${result.newAdId} at ${priceStr}`);
            return result;
          } catch (retryError: any) {
            log.error(`OKX: Retry failed after conflict resolution: ${retryError.message}`);
            return null;
          }
        }
      }

      // Error 55723: "Insufficient balance in your funding account"
      // The ad's availableAmount exceeds the funding balance.
      // Fix: extract balance from error and retry with reduced totalAmount.
      if (errMsg.includes('55723')) {
        const balanceMatch = errMsg.match(/balance is ([\d,]+\.?\d*)/i);
        if (balanceMatch) {
          const availableBalance = parseFloat(balanceMatch[1].replace(/,/g, ''));
          // Use 85% of available balance to leave room for locked orders + fees
          const reducedAmount = Math.floor(availableBalance * 0.85 * 100) / 100;
          const maxFiat = Math.max(1000, Math.floor(reducedAmount * newPrice));
          log.warn(`OKX: Insufficient balance (${availableBalance} USDT) — retrying with cryptoAmount=${reducedAmount}, maxOrderLimit=${maxFiat}`);

          // OKX Update Ad API uses `cryptoAmount` for the cryptocurrency quantity
          const retryParams: Record<string, any> = {
            unitPrice: priceStr,
            cryptoAmount: reducedAmount.toFixed(2),
            maxOrderLimit: maxFiat.toFixed(2),
          };

          try {
            const result = await this.client.updateAd(adId, retryParams);
            log.info(`OKX: Ad updated with reduced amount ${result.oldAdId} -> ${result.newAdId} at ${priceStr} (${reducedAmount} USDT)`);
            return result;
          } catch (retryError: any) {
            log.error(`OKX: Retry with reduced amount failed: ${retryError.message}`);
            return null;
          }
        }
      }

      log.error(`OKX: Failed to update ad ${adId} to ${priceStr}: ${errMsg}`);
      return null;
    }
  }

  /**
   * Find and cancel a hidden ad that conflicts with the target price.
   * Called when error 55147 occurs — a hidden ad at the same price blocks the update.
   */
  private async resolveHiddenPriceConflict(currentAdId: string, targetPrice: number): Promise<boolean> {
    try {
      const allAds = await this.client.getActiveAds();
      const priceStr = targetPrice.toFixed(2);

      const conflicting = allAds.find(ad => {
        const rawAd = ad as any;
        const isHidden = rawAd.isHidden === true || rawAd.isHidden === 'true';
        const samePrice = parseFloat(ad.unitPrice).toFixed(2) === priceStr;
        const notSelf = ad.adId !== currentAdId;
        return isHidden && samePrice && notSelf;
      });

      if (!conflicting) {
        log.warn(`OKX: No hidden ad found at ${priceStr} to cancel`);
        return false;
      }

      log.info({ conflictAdId: conflicting.adId, price: priceStr }, 'OKX: Canceling conflicting hidden ad');
      await this.client.cancelAd(conflicting.adId);
      log.info({ conflictAdId: conflicting.adId }, 'OKX: Conflicting hidden ad cancelled successfully');

      // Small delay to let OKX process the cancellation
      await new Promise(r => setTimeout(r, 1000));
      return true;
    } catch (error: any) {
      log.error({ error: error.message }, 'OKX: Failed to resolve hidden price conflict');
      return false;
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
