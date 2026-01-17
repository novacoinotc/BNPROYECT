// =====================================================
// SMART POSITIONING ENGINE
// Filters competitors by configurable criteria and positions price intelligently
// =====================================================

import { getBinanceClient, BinanceC2CClient } from './binance-client.js';
import { logger } from '../utils/logger.js';
import {
  AdData,
  TradeType,
  SmartPositioningConfig,
  PositioningAnalysis,
} from '../types/binance.js';

export interface FilteredCompetitor {
  ad: AdData;
  passedFilters: string[];
  failedFilters: string[];
}

export interface FilterResults {
  total: number;
  passedGrade: number;
  passedFinishRate: number;
  passedOrderCount: number;
  passedPositiveRate: number;
  passedOnline: number;
  passedProMerchant: number;
  passedSurplus: number;
  passedMaxTrans: number;
  qualified: number;
}

export class SmartPositioning {
  private client: BinanceC2CClient;
  private config: SmartPositioningConfig;

  constructor(config: Partial<SmartPositioningConfig> = {}) {
    this.client = getBinanceClient();
    this.config = this.buildConfig(config);

    logger.info({
      config: {
        minUserGrade: this.config.minUserGrade,
        minMonthFinishRate: `${(this.config.minMonthFinishRate * 100).toFixed(0)}%`,
        minMonthOrderCount: this.config.minMonthOrderCount,
        minPositiveRate: `${(this.config.minPositiveRate * 100).toFixed(0)}%`,
        requireOnline: this.config.requireOnline,
        requireProMerchant: this.config.requireProMerchant,
        minSurplusAmount: `${this.config.minSurplusAmount} USDT`,
        undercutAmount: `${this.config.undercutAmount} centavos`,
      },
    }, '📊 [SMART POSITIONING] Initialized with config');
  }

  private buildConfig(partial: Partial<SmartPositioningConfig>): SmartPositioningConfig {
    return {
      // Filtros de vendedor
      minUserGrade: partial.minUserGrade ?? parseFloat(process.env.POSITIONING_MIN_USER_GRADE || '2'),
      minMonthFinishRate: partial.minMonthFinishRate ?? parseFloat(process.env.POSITIONING_MIN_FINISH_RATE || '0.90'),
      minMonthOrderCount: partial.minMonthOrderCount ?? parseFloat(process.env.POSITIONING_MIN_ORDER_COUNT || '10'),
      minPositiveRate: partial.minPositiveRate ?? parseFloat(process.env.POSITIONING_MIN_POSITIVE_RATE || '0.95'),
      requireOnline: partial.requireOnline ?? process.env.POSITIONING_REQUIRE_ONLINE !== 'false',
      requireProMerchant: partial.requireProMerchant ?? process.env.POSITIONING_REQUIRE_PRO_MERCHANT === 'true',

      // Filtros de anuncio
      minSurplusAmount: partial.minSurplusAmount ?? parseFloat(process.env.POSITIONING_MIN_SURPLUS || '100'),
      minMaxTransAmount: partial.minMaxTransAmount ?? parseFloat(process.env.POSITIONING_MIN_MAX_TRANS || '5000'),

      // Estrategia de precio
      undercutAmount: partial.undercutAmount ?? parseFloat(process.env.POSITIONING_UNDERCUT_CENTS || '1'),
      undercutPercent: partial.undercutPercent ?? parseFloat(process.env.POSITIONING_UNDERCUT_PERCENT || '0'),
      minMargin: partial.minMargin ?? parseFloat(process.env.POSITIONING_MIN_MARGIN || '0.5'),
      maxMargin: partial.maxMargin ?? parseFloat(process.env.POSITIONING_MAX_MARGIN || '2.0'),

      // Comportamiento
      updateIntervalMs: partial.updateIntervalMs ?? parseInt(process.env.POSITIONING_UPDATE_INTERVAL || '30000'),
      maxCompetitorsToAnalyze: partial.maxCompetitorsToAnalyze ?? parseInt(process.env.POSITIONING_MAX_COMPETITORS || '20'),
    };
  }

  /**
   * Apply all filters to a single ad
   */
  private filterAd(ad: AdData): FilteredCompetitor {
    const passed: string[] = [];
    const failed: string[] = [];
    const adv = ad.advertiser;

    // Filter 1: User Grade
    if (adv.userGrade >= this.config.minUserGrade) {
      passed.push(`grade:${adv.userGrade}`);
    } else {
      failed.push(`grade:${adv.userGrade}<${this.config.minUserGrade}`);
    }

    // Filter 2: Month Finish Rate
    if (adv.monthFinishRate >= this.config.minMonthFinishRate) {
      passed.push(`finishRate:${(adv.monthFinishRate * 100).toFixed(0)}%`);
    } else {
      failed.push(`finishRate:${(adv.monthFinishRate * 100).toFixed(0)}%<${(this.config.minMonthFinishRate * 100).toFixed(0)}%`);
    }

    // Filter 3: Month Order Count
    if (adv.monthOrderCount >= this.config.minMonthOrderCount) {
      passed.push(`orders:${adv.monthOrderCount}`);
    } else {
      failed.push(`orders:${adv.monthOrderCount}<${this.config.minMonthOrderCount}`);
    }

    // Filter 4: Positive Rate
    if (adv.positiveRate >= this.config.minPositiveRate) {
      passed.push(`positive:${(adv.positiveRate * 100).toFixed(0)}%`);
    } else {
      failed.push(`positive:${(adv.positiveRate * 100).toFixed(0)}%<${(this.config.minPositiveRate * 100).toFixed(0)}%`);
    }

    // Filter 5: Online Status
    if (!this.config.requireOnline || adv.isOnline) {
      passed.push(`online:${adv.isOnline}`);
    } else {
      failed.push('online:false');
    }

    // Filter 6: Pro Merchant
    if (!this.config.requireProMerchant || adv.proMerchant) {
      passed.push(`proMerchant:${adv.proMerchant}`);
    } else {
      failed.push('proMerchant:false');
    }

    // Filter 7: Surplus Amount
    const surplus = parseFloat(ad.surplusAmount);
    if (surplus >= this.config.minSurplusAmount) {
      passed.push(`surplus:${surplus.toFixed(0)}`);
    } else {
      failed.push(`surplus:${surplus.toFixed(0)}<${this.config.minSurplusAmount}`);
    }

    // Filter 8: Max Transaction Amount
    const maxTrans = parseFloat(ad.maxSingleTransAmount);
    if (maxTrans >= this.config.minMaxTransAmount) {
      passed.push(`maxTrans:${maxTrans.toFixed(0)}`);
    } else {
      failed.push(`maxTrans:${maxTrans.toFixed(0)}<${this.config.minMaxTransAmount}`);
    }

    return { ad, passedFilters: passed, failedFilters: failed };
  }

  /**
   * Analyze market and filter competitors
   */
  async analyzeMarket(
    asset: string,
    fiat: string,
    tradeType: TradeType
  ): Promise<{
    allAds: AdData[];
    qualifiedAds: AdData[];
    filterResults: FilterResults;
    bestQualifiedPrice: number;
    averagePrice: number;
  }> {
    // Fetch competitor ads
    const allAds = await this.client.searchAds({
      asset,
      fiat,
      tradeType,
      page: 1,
      rows: this.config.maxCompetitorsToAnalyze,
    });

    logger.info({
      asset,
      fiat,
      tradeType,
      adsFound: allAds.length,
    }, '📊 [SMART POSITIONING] Fetched competitor ads');

    // Apply filters
    const filterResults: FilterResults = {
      total: allAds.length,
      passedGrade: 0,
      passedFinishRate: 0,
      passedOrderCount: 0,
      passedPositiveRate: 0,
      passedOnline: 0,
      passedProMerchant: 0,
      passedSurplus: 0,
      passedMaxTrans: 0,
      qualified: 0,
    };

    const qualifiedAds: AdData[] = [];

    for (const ad of allAds) {
      const result = this.filterAd(ad);
      const adv = ad.advertiser;

      // Track individual filter passes
      if (adv.userGrade >= this.config.minUserGrade) filterResults.passedGrade++;
      if (adv.monthFinishRate >= this.config.minMonthFinishRate) filterResults.passedFinishRate++;
      if (adv.monthOrderCount >= this.config.minMonthOrderCount) filterResults.passedOrderCount++;
      if (adv.positiveRate >= this.config.minPositiveRate) filterResults.passedPositiveRate++;
      if (!this.config.requireOnline || adv.isOnline) filterResults.passedOnline++;
      if (!this.config.requireProMerchant || adv.proMerchant) filterResults.passedProMerchant++;
      if (parseFloat(ad.surplusAmount) >= this.config.minSurplusAmount) filterResults.passedSurplus++;
      if (parseFloat(ad.maxSingleTransAmount) >= this.config.minMaxTransAmount) filterResults.passedMaxTrans++;

      // Only include if ALL filters passed
      if (result.failedFilters.length === 0) {
        qualifiedAds.push(ad);
        filterResults.qualified++;

        logger.debug({
          nickName: adv.nickName,
          price: ad.price,
          passed: result.passedFilters.join(', '),
        }, '✅ [FILTER] Ad passed all filters');
      } else {
        logger.debug({
          nickName: adv.nickName,
          price: ad.price,
          failed: result.failedFilters.join(', '),
        }, '❌ [FILTER] Ad failed filters');
      }
    }

    // Sort by price (for SELL: ascending, for BUY: descending)
    qualifiedAds.sort((a, b) => {
      const priceA = parseFloat(a.price);
      const priceB = parseFloat(b.price);
      return tradeType === TradeType.SELL ? priceA - priceB : priceB - priceA;
    });

    const bestQualifiedPrice = qualifiedAds.length > 0
      ? parseFloat(qualifiedAds[0].price)
      : 0;

    const averagePrice = qualifiedAds.length > 0
      ? qualifiedAds.reduce((sum, ad) => sum + parseFloat(ad.price), 0) / qualifiedAds.length
      : 0;

    logger.info({
      total: allAds.length,
      qualified: qualifiedAds.length,
      bestPrice: bestQualifiedPrice.toFixed(2),
      avgPrice: averagePrice.toFixed(2),
      filterSummary: {
        grade: `${filterResults.passedGrade}/${allAds.length}`,
        finishRate: `${filterResults.passedFinishRate}/${allAds.length}`,
        orderCount: `${filterResults.passedOrderCount}/${allAds.length}`,
        positiveRate: `${filterResults.passedPositiveRate}/${allAds.length}`,
        online: `${filterResults.passedOnline}/${allAds.length}`,
        surplus: `${filterResults.passedSurplus}/${allAds.length}`,
      },
    }, '📊 [SMART POSITIONING] Filter results');

    return {
      allAds,
      qualifiedAds,
      filterResults,
      bestQualifiedPrice,
      averagePrice,
    };
  }

  /**
   * Calculate target price based on analysis
   */
  calculateTargetPrice(
    bestQualifiedPrice: number,
    referencePrice: number,
    tradeType: TradeType
  ): number {
    if (bestQualifiedPrice === 0) {
      // No qualified competitors - use reference price with min margin
      return referencePrice * (1 + this.config.minMargin / 100);
    }

    let targetPrice: number;

    // Apply undercut strategy
    if (this.config.undercutAmount > 0) {
      // Undercut by fixed amount (centavos)
      const undercutValue = this.config.undercutAmount / 100; // Convert centavos to pesos
      targetPrice = tradeType === TradeType.SELL
        ? bestQualifiedPrice - undercutValue
        : bestQualifiedPrice + undercutValue;
    } else if (this.config.undercutPercent > 0) {
      // Undercut by percentage
      targetPrice = tradeType === TradeType.SELL
        ? bestQualifiedPrice * (1 - this.config.undercutPercent / 100)
        : bestQualifiedPrice * (1 + this.config.undercutPercent / 100);
    } else {
      // Match best price
      targetPrice = bestQualifiedPrice;
    }

    // Apply margin limits
    const minPrice = referencePrice * (1 + this.config.minMargin / 100);
    const maxPrice = referencePrice * (1 + this.config.maxMargin / 100);

    if (tradeType === TradeType.SELL) {
      targetPrice = Math.max(minPrice, Math.min(maxPrice, targetPrice));
    } else {
      // For BUY, the logic is inverted
      targetPrice = Math.min(maxPrice, Math.max(minPrice, targetPrice));
    }

    logger.info({
      bestQualified: bestQualifiedPrice.toFixed(2),
      reference: referencePrice.toFixed(2),
      target: targetPrice.toFixed(2),
      minPrice: minPrice.toFixed(2),
      maxPrice: maxPrice.toFixed(2),
      undercutCents: this.config.undercutAmount,
    }, '💰 [SMART POSITIONING] Calculated target price');

    return targetPrice;
  }

  /**
   * Full analysis and price recommendation
   */
  async getRecommendedPrice(
    asset: string,
    fiat: string,
    tradeType: TradeType
  ): Promise<PositioningAnalysis> {
    const timestamp = new Date();

    // Get reference price
    const refPriceData = await this.client.getReferencePrice(asset, fiat, tradeType);
    const referencePrice = parseFloat(refPriceData.price);

    // Analyze market
    const analysis = await this.analyzeMarket(asset, fiat, tradeType);

    // Calculate target price
    const targetPrice = this.calculateTargetPrice(
      analysis.bestQualifiedPrice,
      referencePrice,
      tradeType
    );

    // Calculate margin
    const marginPercent = ((targetPrice - referencePrice) / referencePrice) * 100;

    return {
      timestamp,
      mode: 'smart',
      totalAdsAnalyzed: analysis.allAds.length,
      qualifiedCompetitors: analysis.qualifiedAds.length,
      bestQualifiedPrice: analysis.bestQualifiedPrice,
      averagePrice: analysis.averagePrice,
      referencePrice,
      currentPrice: 0, // Will be set by orchestrator
      targetPrice,
      priceChanged: false, // Will be set by orchestrator
      marginPercent,
      filterResults: {
        passedGrade: analysis.filterResults.passedGrade,
        passedFinishRate: analysis.filterResults.passedFinishRate,
        passedOrderCount: analysis.filterResults.passedOrderCount,
        passedPositiveRate: analysis.filterResults.passedPositiveRate,
        passedOnline: analysis.filterResults.passedOnline,
        passedSurplus: analysis.filterResults.passedSurplus,
        passedMaxTrans: analysis.filterResults.passedMaxTrans,
      },
    };
  }

  /**
   * Get qualified competitors (for dashboard display)
   */
  async getQualifiedCompetitors(
    asset: string,
    fiat: string,
    tradeType: TradeType
  ): Promise<Array<{
    nickName: string;
    price: number;
    surplus: number;
    monthFinishRate: number;
    monthOrderCount: number;
    positiveRate: number;
    isOnline: boolean;
    proMerchant: boolean;
  }>> {
    const analysis = await this.analyzeMarket(asset, fiat, tradeType);

    return analysis.qualifiedAds.map(ad => ({
      nickName: ad.advertiser.nickName,
      price: parseFloat(ad.price),
      surplus: parseFloat(ad.surplusAmount),
      monthFinishRate: ad.advertiser.monthFinishRate,
      monthOrderCount: ad.advertiser.monthOrderCount,
      positiveRate: ad.advertiser.positiveRate,
      isOnline: ad.advertiser.isOnline,
      proMerchant: ad.advertiser.proMerchant,
    }));
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SmartPositioningConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info({ config: this.config }, '📊 [SMART POSITIONING] Config updated');
  }

  /**
   * Get current configuration
   */
  getConfig(): SmartPositioningConfig {
    return { ...this.config };
  }
}

// Factory function
export function createSmartPositioning(config?: Partial<SmartPositioningConfig>): SmartPositioning {
  return new SmartPositioning(config);
}
