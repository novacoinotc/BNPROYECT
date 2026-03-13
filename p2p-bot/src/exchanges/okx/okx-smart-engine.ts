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
  minUserGrade: number;          // 1=common, 2=certified, 3=diamond
  ignoredAdvertisers?: string[];
}

export interface OkxSmartResult {
  success: boolean;
  targetPrice: number;
  bestCompetitorPrice: number;
  qualifiedCount: number;
}

const DEFAULT_CONFIG: OkxSmartConfig = {
  minMonthOrderCount: 10,
  minSurplusAmount: 100,
  undercutCents: 1,
  matchPrice: false,
  minUserGrade: 2,
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

    // Filter 1: Minimum user grade
    const grade = creator.userGrade || mapCreatorTypeToGrade(creator.type);
    if (grade < this.config.minUserGrade) return false;

    // Filter 2: Minimum completed orders
    if (creator.completedOrders < this.config.minMonthOrderCount) return false;

    // Filter 3: Minimum fiat value available
    const price = parseFloat(ad.unitPrice);
    const available = parseFloat(ad.availableAmount);
    const fiatValue = price * available;
    if (fiatValue < this.config.minSurplusAmount) return false;

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

      // Exclude own ads
      if (this.config.myNickName && nick === this.config.myNickName) return false;

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
    log.debug({ total: ads.length, qualified: qualified.length }, 'OKX Smart: Filter results');

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

    let ourPrice: number;
    if (this.config.matchPrice) {
      ourPrice = bestPrice;
    } else {
      const undercutValue = this.config.undercutCents / 100;
      // SELL → go LOWER to attract buyers
      // BUY → go HIGHER to attract sellers
      ourPrice = this.adType === 'sell'
        ? bestPrice - undercutValue
        : bestPrice + undercutValue;
    }

    // Apply price floor for SELL ads
    if (this.adType === 'sell' && this.config.minPrice && ourPrice < this.config.minPrice) {
      log.info({ ourPrice: ourPrice.toFixed(2), floor: this.config.minPrice.toFixed(2) }, 'OKX Smart: Price below floor');

      const aboveFloor = qualified.filter(ad => parseFloat(ad.unitPrice) >= this.config.minPrice!);
      if (aboveFloor.length > 0) {
        ourPrice = parseFloat(aboveFloor[0].unitPrice);
        log.info({ price: ourPrice.toFixed(2) }, 'OKX Smart: Matching competitor above floor');
        return {
          success: true,
          targetPrice: Math.round(ourPrice * 100) / 100,
          bestCompetitorPrice: parseFloat(aboveFloor[0].unitPrice),
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
      qualifiedCount: qualified.length,
    };
  }
}
