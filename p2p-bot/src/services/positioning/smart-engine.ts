// =====================================================
// SMART ENGINE - Independent module for smart positioning
// =====================================================

import { getBinanceClient, BinanceC2CClient } from '../binance-client.js';
import { AdData, TradeType } from '../../types/binance.js';

export interface SmartConfig {
  minUserGrade: number;
  minMonthFinishRate: number;
  minMonthOrderCount: number;
  minPositiveRate: number;
  requireOnline: boolean;
  minSurplusAmount: number;
  undercutCents: number;
  matchPrice: boolean; // true = exact match, false = undercut
}

export interface SmartResult {
  success: boolean;
  targetPrice: number;
  bestCompetitorPrice: number;
  qualifiedCount: number;
}

const DEFAULT_CONFIG: SmartConfig = {
  minUserGrade: 2,
  minMonthFinishRate: 0.90,
  minMonthOrderCount: 10,
  minPositiveRate: 0.95,
  requireOnline: true,
  minSurplusAmount: 100,
  undercutCents: 1,
  matchPrice: false,
};

export class SmartEngine {
  private client: BinanceC2CClient;
  private config: SmartConfig;
  private adType: 'BUY' | 'SELL';

  constructor(adType: 'BUY' | 'SELL', config: Partial<SmartConfig> = {}) {
    this.client = getBinanceClient();
    this.adType = adType;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  updateConfig(config: Partial<SmartConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Check if an ad passes all quality filters
   */
  private passesFilters(ad: AdData): boolean {
    const adv = ad.advertiser;

    if (adv.userGrade < this.config.minUserGrade) return false;
    if (adv.monthFinishRate < this.config.minMonthFinishRate) return false;
    if (adv.monthOrderCount < this.config.minMonthOrderCount) return false;
    if (adv.positiveRate < this.config.minPositiveRate) return false;
    if (this.config.requireOnline && !adv.isOnline) return false;
    if (parseFloat(ad.surplusAmount) < this.config.minSurplusAmount) return false;

    return true;
  }

  /**
   * Get recommended price using smart algorithm
   */
  async getPrice(asset: string, fiat: string): Promise<SmartResult | null> {
    // Search type is from CLIENT perspective:
    // - Our SELL ad → search with BUY → finds other sellers
    // - Our BUY ad → search with SELL → finds other buyers
    const searchType = this.adType === 'SELL' ? TradeType.BUY : TradeType.SELL;

    const ads = await this.client.searchAds({
      asset,
      fiat,
      tradeType: searchType,
      page: 1,
      rows: 20,
    });

    if (ads.length === 0) {
      return null;
    }

    // Filter and sort by price
    const qualifiedAds = ads.filter(ad => this.passesFilters(ad));

    if (qualifiedAds.length === 0) {
      // No qualified competitors - use best available
      const bestPrice = parseFloat(ads[0].price);
      return {
        success: true,
        targetPrice: bestPrice,
        bestCompetitorPrice: bestPrice,
        qualifiedCount: 0,
      };
    }

    // Sort by price (SELL ads sorted ascending, BUY ads sorted descending)
    qualifiedAds.sort((a, b) => {
      const priceA = parseFloat(a.price);
      const priceB = parseFloat(b.price);
      return this.adType === 'SELL' ? priceA - priceB : priceB - priceA;
    });

    const bestPrice = parseFloat(qualifiedAds[0].price);

    // If matchPrice is true, use exact same price
    // Otherwise, undercut by the configured cents
    let ourPrice: number;
    if (this.config.matchPrice) {
      ourPrice = bestPrice;
    } else {
      const undercutValue = this.config.undercutCents / 100;
      // SELL ad → go LOWER to attract buyers
      // BUY ad → go HIGHER to attract sellers
      ourPrice = this.adType === 'SELL'
        ? bestPrice - undercutValue
        : bestPrice + undercutValue;
    }

    return {
      success: true,
      targetPrice: Math.round(ourPrice * 100) / 100,
      bestCompetitorPrice: bestPrice,
      qualifiedCount: qualifiedAds.length,
    };
  }
}
