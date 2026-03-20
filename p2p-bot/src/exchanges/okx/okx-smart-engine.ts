// =====================================================
// OKX SMART ENGINE
// Competitor search and undercut algorithm
// Uses OKX marketplace-list API
// =====================================================

import { getOkxClient, OkxClient } from './okx-client.js';
import { OkxAdData, toAdData, mapCreatorTypeToGrade } from './okx-types.js';
import { logger } from '../../utils/logger.js';

const log = logger.child({ module: 'okx-smart' });

// ==================== CONFIG ====================

export interface OkxSmartConfig {
  minMonthOrderCount: number;
  minSurplusAmount: number;     // In FIAT value (price × available amount)
  undercutCents: number;
  matchPrice: boolean;
  minPrice?: number | null;      // Price floor for SELL ads
  maxPrice?: number | null;      // Price ceiling for BUY ads
  myNickName?: string;
  ignoredAdvertisers?: string[];
  minMaxOrderLimit?: number;   // Min maxOrderLimit to filter trap ads
}

export interface OkxSmartResult {
  success: boolean;
  targetPrice: number;
  bestCompetitorPrice: number;
  bestCompetitorNick: string;
  qualifiedCount: number;
}

const DEFAULT_CONFIG: OkxSmartConfig = {
  minMonthOrderCount: 10,
  minSurplusAmount: 100,
  undercutCents: 1,
  matchPrice: false,
};

// ==================== SMART ENGINE ====================

export class OkxSmartEngine {
  private client: OkxClient;
  private config: OkxSmartConfig;
  private adType: 'buy' | 'sell';

  constructor(adType: 'buy' | 'sell', config: Partial<OkxSmartConfig> = {}) {
    this.client = getOkxClient();
    this.adType = adType;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  updateConfig(config: Partial<OkxSmartConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Check if an ad passes quality filters
   */
  private passesFilters(ad: OkxAdData): boolean {
    const creator = ad.creator;
    if (!creator) return false;

    // Filter 1: Minimum completed orders
    if (creator.completedOrders < this.config.minMonthOrderCount) return false;

    // Filter 3: Minimum fiat value available
    const price = parseFloat(ad.unitPrice);
    const available = parseFloat(ad.availableAmount);
    const fiatValue = price * available;
    if (fiatValue < this.config.minSurplusAmount) return false;

    // Filter 4: Skip trap ads with very low max order limit
    if (this.config.minMaxOrderLimit) {
      const maxOrder = parseFloat(ad.maxAmount || '0');
      if (maxOrder > 0 && maxOrder < this.config.minMaxOrderLimit) return false;
    }

    return true;
  }

  /**
   * Get recommended price using smart algorithm
   */
  async getPrice(crypto: string, fiat: string): Promise<OkxSmartResult | null> {
    // Our SELL ad → search for other SELLERS → OKX 'sell' side
    // Our BUY ad → search for other BUYERS → OKX 'buy' side
    const searchSide = this.adType;

    log.debug({ adType: this.adType, searchSide, crypto, fiat }, 'OKX Smart: Searching marketplace');

    const ads = await this.client.searchAds(searchSide, crypto, fiat, 1, 20);

    if (ads.length > 0) {
      log.debug({ count: ads.length }, `OKX Smart: Found ${ads.length} ads`);
    }

    if (ads.length === 0) return null;

    // Filter out own ads, ignored, and apply quality filters
    const ignoredNames: string[] = [];
    const qualified = ads.filter(ad => {
      if (!ad.creator) return false;
      const nick = ad.creator.nickName;

      // Exclude own ads (case-insensitive — OKX API may return different casing)
      if (this.config.myNickName && nick.toLowerCase() === this.config.myNickName.toLowerCase()) return false;

      // Exclude ignored advertisers
      if (this.config.ignoredAdvertisers?.length) {
        const isIgnored = this.config.ignoredAdvertisers.some(
          ignored => ignored.toLowerCase() === nick.toLowerCase()
        );
        if (isIgnored) {
          ignoredNames.push(`${nick}@${parseFloat(ad.unitPrice).toFixed(2)}`);
          return false;
        }
      }

      return this.passesFilters(ad);
    });

    if (ignoredNames.length > 0) {
      log.info({ ignored: ignoredNames }, 'OKX Smart: Filtered out ignored advertisers');
    }

    // Log ALL ads with filter results for debugging
    const adSummary = ads.map((ad, i) => {
      const nick = ad.creator?.nickName || '?';
      const price = parseFloat(ad.unitPrice);
      const grade = ad.creator ? (ad.creator.userGrade || mapCreatorTypeToGrade(ad.creator.type)) : 0;
      const orders = ad.creator?.completedOrders ?? 0;
      const avail = parseFloat(ad.availableAmount || '0');
      const fiat = price * avail;
      const isSelf = this.config.myNickName && nick.toLowerCase() === this.config.myNickName.toLowerCase();
      const isQualified = qualified.some(q => q.creator?.nickName === nick && q.unitPrice === ad.unitPrice);
      return `${nick}@${price.toFixed(2)}(g=${grade},o=${orders},f=${Math.round(fiat)})${isSelf ? '[SELF]' : isQualified ? '[OK]' : '[X]'}`;
    });
    log.info({ total: ads.length, qualified: qualified.length, ads: adSummary.slice(0, 20).join(' | ') }, 'OKX Smart: All ads');

    if (qualified.length === 0) {
      log.debug('OKX Smart: 0 qualified competitors — keeping current price');
      return null;
    }

    // Sort: SELL ads ascending (lowest first), BUY ads descending (highest first)
    qualified.sort((a, b) => {
      const priceA = parseFloat(a.unitPrice);
      const priceB = parseFloat(b.unitPrice);
      return this.adType === 'sell' ? priceA - priceB : priceB - priceA;
    });

    const bestPrice = parseFloat(qualified[0].unitPrice);
    const bestNick = qualified[0].creator?.nickName || '?';

    // Log top 5 qualified competitors
    const top5 = qualified.slice(0, 5).map(q => `${q.creator?.nickName}@${parseFloat(q.unitPrice).toFixed(2)}`);
    log.info({ bestNick, bestPrice: bestPrice.toFixed(2), top5 }, 'OKX Smart: Top qualified competitors');

    let ourPrice: number;
    if (this.config.matchPrice) {
      ourPrice = bestPrice;
      log.info(`OKX Smart: matchPrice=true → matching ${bestNick}@${bestPrice.toFixed(2)}`);
    } else {
      const undercutValue = this.config.undercutCents / 100;
      // SELL → go LOWER to attract buyers
      // BUY → go HIGHER to attract sellers
      ourPrice = this.adType === 'sell'
        ? bestPrice - undercutValue
        : bestPrice + undercutValue;
      log.info(`OKX Smart: undercut ${bestNick}@${bestPrice.toFixed(2)} by ${this.config.undercutCents}¢ → ${ourPrice.toFixed(2)}`);
    }

    // Apply price floor for SELL ads
    if (this.adType === 'sell' && this.config.minPrice && ourPrice < this.config.minPrice) {
      log.info({ ourPrice: ourPrice.toFixed(2), floor: this.config.minPrice.toFixed(2) }, 'OKX Smart: Price below floor');

      const aboveFloor = qualified.filter(ad => parseFloat(ad.unitPrice) >= this.config.minPrice!);
      if (aboveFloor.length > 0) {
        const nextPrice = parseFloat(aboveFloor[0].unitPrice);
        const undercutAttempt = this.config.matchPrice ? nextPrice : nextPrice - (this.config.undercutCents / 100);
        ourPrice = Math.max(undercutAttempt, this.config.minPrice!);
        log.info({ price: ourPrice.toFixed(2), competitor: nextPrice.toFixed(2) }, 'OKX Smart: Undercutting competitor above floor');
        return {
          success: true,
          targetPrice: Math.round(ourPrice * 100) / 100,
          bestCompetitorPrice: parseFloat(aboveFloor[0].unitPrice),
          bestCompetitorNick: aboveFloor[0].creator?.nickName || '?',
          qualifiedCount: aboveFloor.length,
        };
      } else {
        ourPrice = this.config.minPrice;
        log.info({ price: ourPrice.toFixed(2) }, 'OKX Smart: Staying at floor');
      }
    }

    // Apply price ceiling for BUY ads
    if (this.adType === 'buy' && this.config.maxPrice && ourPrice > this.config.maxPrice) {
      ourPrice = this.config.maxPrice;
      log.info({ price: ourPrice.toFixed(2) }, 'OKX Smart: Capped at ceiling');
    }

    return {
      success: true,
      targetPrice: Math.round(ourPrice * 100) / 100,
      bestCompetitorPrice: bestPrice,
      bestCompetitorNick: bestNick,
      qualifiedCount: qualified.length,
    };
  }
}
