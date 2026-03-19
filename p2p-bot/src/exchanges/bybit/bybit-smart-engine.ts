// =====================================================
// BYBIT SMART ENGINE
// Competitor search and undercut algorithm
// Uses Bybit marketplace /v5/p2p/item/online API
// =====================================================

import { BybitClient, getBybitClient } from './bybit-client.js';
import { BybitMarketplaceAd, mapAuthTagToGrade } from './bybit-types.js';
import { logger } from '../../utils/logger.js';

const log = logger.child({ module: 'bybit-smart' });

// ==================== CONFIG ====================

export interface BybitSmartConfig {
  minMonthOrderCount: number;
  minSurplusAmount: number;     // In FIAT value (price × available amount)
  minFinishRate: number;         // Min completion rate (0-1), e.g. 0.90 = 90%
  undercutCents: number;
  matchPrice: boolean;
  minPrice?: number | null;      // Price floor for SELL ads
  maxPrice?: number | null;      // Price ceiling for BUY ads
  myNickName?: string;
  minUserGrade: number;          // 1=GA, 2=VA, 3=BA
  ignoredAdvertisers?: string[];
  minMaxOrderLimit?: number;     // Min maxOrderLimit to filter trap ads
}

export interface BybitSmartResult {
  success: boolean;
  targetPrice: number;
  bestCompetitorPrice: number;
  bestCompetitorNick: string;
  qualifiedCount: number;
}

const DEFAULT_CONFIG: BybitSmartConfig = {
  minMonthOrderCount: 10,
  minSurplusAmount: 100,
  minFinishRate: 0,
  undercutCents: 1,
  matchPrice: false,
  minUserGrade: 2,
};

// ==================== SMART ENGINE ====================

export class BybitSmartEngine {
  private client: BybitClient;
  private config: BybitSmartConfig;
  private adSide: 'buy' | 'sell';  // Our ad side

  constructor(adSide: 'buy' | 'sell', config: Partial<BybitSmartConfig> = {}) {
    this.client = getBybitClient();
    this.adSide = adSide;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  updateConfig(config: Partial<BybitSmartConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Check if a marketplace ad passes quality filters
   */
  private passesFilters(ad: BybitMarketplaceAd): boolean {
    // Filter 1: Minimum user grade (GA=1, VA=2, BA=3)
    const grade = mapAuthTagToGrade(ad.authTag || []);
    if (grade < this.config.minUserGrade) return false;

    // Filter 2: Minimum recent orders
    const recentOrders = parseInt(ad.recentOrderNum) || 0;
    if (recentOrders < this.config.minMonthOrderCount) return false;

    // Filter 3: Minimum completion rate
    if (this.config.minFinishRate > 0) {
      const finishRate = parseFloat(ad.recentExecuteRate) || 0;
      if (finishRate < this.config.minFinishRate) return false;
    }

    // Filter 4: Minimum fiat value available
    const price = parseFloat(ad.price);
    const available = parseFloat(ad.lastQuantity);
    const fiatValue = price * available;
    if (fiatValue < this.config.minSurplusAmount) return false;

    // Filter 5: Skip trap ads with very low max order limit
    if (this.config.minMaxOrderLimit) {
      const maxOrder = parseFloat(ad.maxAmount || '0');
      if (maxOrder > 0 && maxOrder < this.config.minMaxOrderLimit) return false;
    }

    return true;
  }

  /**
   * Get recommended price using smart algorithm
   */
  async getPrice(tokenId: string, currencyId: string): Promise<BybitSmartResult | null> {
    // Bybit side: '0'=buy, '1'=sell
    // Our SELL ad → search for other SELLERS → side '1'
    // Our BUY ad → search for other BUYERS → side '0'
    const searchSide = this.adSide === 'sell' ? '1' : '0';

    log.debug({ adSide: this.adSide, searchSide, tokenId, currencyId }, 'Bybit Smart: Searching marketplace');

    const { items: ads } = await this.client.searchAds(tokenId, currencyId, searchSide as '0' | '1', 1, 20);

    if (ads.length > 0) {
      log.debug({ count: ads.length }, `Bybit Smart: Found ${ads.length} ads`);
    }

    if (ads.length === 0) return null;

    // Filter out own ads, ignored, and apply quality filters
    const qualified = ads.filter(ad => {
      const nick = ad.nickName;

      // Exclude own ads
      if (this.config.myNickName && nick === this.config.myNickName) return false;

      // Exclude ignored advertisers
      if (this.config.ignoredAdvertisers?.length) {
        const isIgnored = this.config.ignoredAdvertisers.some(
          ignored => ignored.toLowerCase() === nick.toLowerCase()
        );
        if (isIgnored) return false;
      }

      return this.passesFilters(ad);
    });

    // Log ALL ads with filter results for debugging
    const adSummary = ads.map((ad) => {
      const nick = ad.nickName;
      const price = parseFloat(ad.price);
      const grade = mapAuthTagToGrade(ad.authTag || []);
      const orders = parseInt(ad.recentOrderNum) || 0;
      const avail = parseFloat(ad.lastQuantity);
      const fiatVal = price * avail;
      const isSelf = this.config.myNickName && nick === this.config.myNickName;
      const isQualified = qualified.some(q => q.nickName === nick && q.price === ad.price);
      return `${nick}@${price.toFixed(2)}(g=${grade},o=${orders},f=${Math.round(fiatVal)})${isSelf ? '[SELF]' : isQualified ? '[OK]' : '[X]'}`;
    });
    log.info({ total: ads.length, qualified: qualified.length, ads: adSummary.slice(0, 20).join(' | ') }, 'Bybit Smart: All ads');

    if (qualified.length === 0) {
      log.info('Bybit Smart: 0 qualified competitors — keeping current price');
      return null;
    }

    // Sort: SELL ads ascending (lowest first), BUY ads descending (highest first)
    qualified.sort((a, b) => {
      const priceA = parseFloat(a.price);
      const priceB = parseFloat(b.price);
      return this.adSide === 'sell' ? priceA - priceB : priceB - priceA;
    });

    const bestPrice = parseFloat(qualified[0].price);
    const bestNick = qualified[0].nickName || '?';

    // Log top 5 qualified competitors
    const top5 = qualified.slice(0, 5).map(q => `${q.nickName}@${parseFloat(q.price).toFixed(2)}`);
    log.info({ bestNick, bestPrice: bestPrice.toFixed(2), top5 }, 'Bybit Smart: Top qualified competitors');

    let ourPrice: number;
    if (this.config.matchPrice) {
      ourPrice = bestPrice;
      log.info(`Bybit Smart: matchPrice=true → matching ${bestNick}@${bestPrice.toFixed(2)}`);
    } else {
      const undercutValue = this.config.undercutCents / 100;
      // SELL → go LOWER to attract buyers
      // BUY → go HIGHER to attract sellers
      ourPrice = this.adSide === 'sell'
        ? bestPrice - undercutValue
        : bestPrice + undercutValue;
      log.info(`Bybit Smart: undercut ${bestNick}@${bestPrice.toFixed(2)} by ${this.config.undercutCents}¢ → ${ourPrice.toFixed(2)}`);
    }

    // Apply price floor for SELL ads
    if (this.adSide === 'sell' && this.config.minPrice && ourPrice < this.config.minPrice) {
      log.info({ ourPrice: ourPrice.toFixed(2), floor: this.config.minPrice.toFixed(2) }, 'Bybit Smart: Price below floor');

      const aboveFloor = qualified.filter(ad => parseFloat(ad.price) >= this.config.minPrice!);
      if (aboveFloor.length > 0) {
        ourPrice = parseFloat(aboveFloor[0].price);
        log.info({ price: ourPrice.toFixed(2), nick: aboveFloor[0].nickName }, 'Bybit Smart: Matching competitor above floor');
        return {
          success: true,
          targetPrice: Math.round(ourPrice * 100) / 100,
          bestCompetitorPrice: parseFloat(aboveFloor[0].price),
          bestCompetitorNick: aboveFloor[0].nickName || '?',
          qualifiedCount: aboveFloor.length,
        };
      } else {
        ourPrice = this.config.minPrice;
        log.info({ price: ourPrice.toFixed(2) }, 'Bybit Smart: Staying at floor');
      }
    }

    // Apply price ceiling for BUY ads
    if (this.adSide === 'buy' && this.config.maxPrice && ourPrice > this.config.maxPrice) {
      ourPrice = this.config.maxPrice;
      log.info({ price: ourPrice.toFixed(2) }, 'Bybit Smart: Capped at ceiling');
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
