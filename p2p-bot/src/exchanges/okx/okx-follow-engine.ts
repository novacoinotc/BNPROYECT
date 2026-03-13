// =====================================================
// OKX FOLLOW ENGINE
// Tracks a target merchant and copies/undercuts price
// Uses OKX marketplace-list API
// =====================================================

import { getOkxClient, OkxClient } from './okx-client.js';
import { OkxAdData } from './okx-types.js';
import { logger } from '../../utils/logger.js';

const log = logger.child({ module: 'okx-follow' });

// ==================== CONFIG ====================

export interface OkxFollowConfig {
  targetNickName: string;
  undercutCents: number;
  matchPrice: boolean;
  minPrice?: number | null;
  maxPrice?: number | null;
  ignoredAdvertisers?: string[];
}

export interface OkxFollowResult {
  success: boolean;
  targetPrice: number;
  targetNickName: string | null;
  targetFoundPrice: number | null;
}

// ==================== FOLLOW ENGINE ====================

export class OkxFollowEngine {
  private client: OkxClient;
  private config: OkxFollowConfig;
  private adType: 'buy' | 'sell';

  constructor(adType: 'buy' | 'sell', config: OkxFollowConfig) {
    this.client = getOkxClient();
    this.adType = adType;
    this.config = config;
  }

  updateConfig(config: Partial<OkxFollowConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get recommended price by following target
   * Returns null if target not found
   */
  async getPrice(crypto: string, fiat: string): Promise<OkxFollowResult | null> {
    if (!this.config.targetNickName) return null;

    // Check if target is in ignored list
    if (this.config.ignoredAdvertisers?.length) {
      const isIgnored = this.config.ignoredAdvertisers.some(
        ignored => ignored.toLowerCase() === this.config.targetNickName.toLowerCase()
      );
      if (isIgnored) {
        log.warn({ target: this.config.targetNickName }, 'OKX Follow: Target is in ignored list');
        return null;
      }
    }

    const searchSide = this.adType;

    log.debug({ searchSide, target: this.config.targetNickName, crypto, fiat }, 'OKX Follow: Searching');

    // Search multiple pages to find target
    let allAds: OkxAdData[] = [];
    let targetAds: OkxAdData[] = [];

    for (let page = 1; page <= 3; page++) {
      const ads = await this.client.searchAds(searchSide, crypto, fiat, page, 20);
      if (ads.length === 0) break;
      allAds.push(...ads);

      const found = ads.filter(ad =>
        ad.creator?.nickName?.toLowerCase() === this.config.targetNickName.toLowerCase()
      );
      targetAds.push(...found);
    }

    if (targetAds.length === 0) {
      log.warn({ target: this.config.targetNickName, crypto, fiat }, 'OKX Follow: Target NOT FOUND');
      return null;
    }

    // Smart target selection: when multiple ads and price floor
    let targetAd: OkxAdData;

    if (targetAds.length === 1 || !this.config.minPrice || this.adType !== 'sell') {
      targetAd = targetAds[0];
    } else {
      const undercutValue = this.config.matchPrice ? 0 : this.config.undercutCents / 100;
      const validTargetAds = targetAds
        .map(ad => ({
          ad,
          price: parseFloat(ad.unitPrice),
          ourPrice: parseFloat(ad.unitPrice) - undercutValue,
        }))
        .filter(entry => entry.ourPrice >= this.config.minPrice!)
        .sort((a, b) => a.ourPrice - b.ourPrice);

      if (validTargetAds.length > 0) {
        targetAd = validTargetAds[0].ad;
        log.info({
          totalAds: targetAds.length,
          validAds: validTargetAds.length,
          price: validTargetAds[0].price.toFixed(2),
        }, 'OKX Follow: Selected best target ad above floor');
      } else {
        targetAd = targetAds[0];
      }
    }

    const targetPrice = parseFloat(targetAd.unitPrice);
    log.debug({ target: targetAd.creator.nickName, price: targetPrice.toFixed(2) }, 'OKX Follow: Found target');

    let ourPrice: number;
    if (this.config.matchPrice) {
      ourPrice = targetPrice;
    } else {
      const undercutValue = this.config.undercutCents / 100;
      ourPrice = this.adType === 'sell'
        ? targetPrice - undercutValue
        : targetPrice + undercutValue;
    }

    // Apply price floor for SELL ads
    if (this.adType === 'sell' && this.config.minPrice && ourPrice < this.config.minPrice) {
      log.info({ ourPrice: ourPrice.toFixed(2), floor: this.config.minPrice.toFixed(2) }, 'OKX Follow: Below floor');

      const myNickName = process.env.OKX_MY_NICKNAME?.toLowerCase() || '';
      const competitorsAboveFloor = allAds
        .filter(ad => {
          const price = parseFloat(ad.unitPrice);
          const nick = ad.creator?.nickName?.toLowerCase() || '';
          const isSelf = myNickName && nick === myNickName;
          const isTarget = nick === this.config.targetNickName.toLowerCase();
          const isIgnored = this.config.ignoredAdvertisers?.some(
            ignored => ignored.toLowerCase() === nick
          );
          return price >= this.config.minPrice! && !isSelf && !isTarget && !isIgnored;
        })
        .sort((a, b) => parseFloat(a.unitPrice) - parseFloat(b.unitPrice));

      if (competitorsAboveFloor.length > 0) {
        const next = competitorsAboveFloor[0];
        ourPrice = parseFloat(next.unitPrice);
        log.info({ price: ourPrice.toFixed(2), competitor: next.creator.nickName }, 'OKX Follow: Matching above floor');
        return {
          success: true,
          targetPrice: Math.round(ourPrice * 100) / 100,
          targetNickName: next.creator.nickName,
          targetFoundPrice: parseFloat(next.unitPrice),
        };
      } else {
        ourPrice = this.config.minPrice;
        log.info({ price: ourPrice.toFixed(2) }, 'OKX Follow: Staying at floor');
      }
    }

    // Apply price ceiling for BUY ads
    if (this.adType === 'buy' && this.config.maxPrice && ourPrice > this.config.maxPrice) {
      ourPrice = this.config.maxPrice;
    }

    return {
      success: true,
      targetPrice: Math.round(ourPrice * 100) / 100,
      targetNickName: targetAd.creator.nickName,
      targetFoundPrice: targetPrice,
    };
  }
}
