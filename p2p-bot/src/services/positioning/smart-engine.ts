// =====================================================
// SMART ENGINE - Independent module for smart positioning
// Simplified to only use: minOrderCount and minSurplus
// =====================================================

import { getBinanceClient, BinanceC2CClient } from '../binance-client.js';
import { AdData, TradeType } from '../../types/binance.js';
import { logger } from '../../utils/logger.js';

export interface SmartConfig {
  minMonthOrderCount: number;  // Minimum completed orders
  minSurplusAmount: number;    // Minimum available volume
  undercutCents: number;
  matchPrice: boolean;         // true = exact match, false = undercut
  myNickName?: string;         // Our nickname to exclude from results
}

export interface SmartResult {
  success: boolean;
  targetPrice: number;
  bestCompetitorPrice: number;
  qualifiedCount: number;
}

const DEFAULT_CONFIG: SmartConfig = {
  minMonthOrderCount: 10,
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
   * Check if an ad passes filters (simplified to only 2 criteria)
   */
  private passesFilters(ad: AdData): boolean {
    const adv = ad.advertiser;

    // Filter 1: Minimum orders completed this month
    if (adv.monthOrderCount < this.config.minMonthOrderCount) return false;

    // Filter 2: Minimum available volume IN FIAT VALUE (price × crypto amount)
    // This ensures the filter works correctly for all assets (BNB, BTC, etc.)
    // where crypto units are much smaller than fiat values
    const price = parseFloat(ad.price);
    const surplusAmount = parseFloat(ad.surplusAmount);
    const fiatValue = price * surplusAmount;
    if (fiatValue < this.config.minSurplusAmount) return false;

    return true;
  }

  /**
   * Get recommended price using smart algorithm
   */
  async getPrice(asset: string, fiat: string): Promise<SmartResult | null> {
    // API tradeType from USER perspective:
    // - tradeType='BUY' returns ads from "Buy" tab (where users BUY from SELLERS)
    // - tradeType='SELL' returns ads from "Sell" tab (where users SELL to BUYERS)
    //
    // Our positioning logic:
    // - Our SELL ad → we compete with other SELLERS → search 'BUY' tab
    // - Our BUY ad → we compete with other BUYERS → search 'SELL' tab
    const searchType = this.adType === 'SELL' ? TradeType.BUY : TradeType.SELL;

    logger.info(`🔍 [SMART] Our ${this.adType} ad → searching '${searchType}' tab for ${asset}/${fiat}`);

    const ads = await this.client.searchAds({
      asset,
      fiat,
      tradeType: searchType,
      page: 1,
      rows: 20,
    });

    if (ads.length > 0) {
      logger.info(`🔍 [SMART] Found ${ads.length} ads. Top 3: ${ads.slice(0, 3).map(a => `${a.advertiser.nickName}@${a.price}`).join(', ')}`);
    }

    if (ads.length === 0) {
      return null;
    }

    // Filter out our own ads and apply quality filters
    const qualifiedAds = ads.filter(ad => {
      // Exclude our own ads by nickname
      if (this.config.myNickName && ad.advertiser.nickName === this.config.myNickName) {
        return false;
      }
      return this.passesFilters(ad);
    });

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
