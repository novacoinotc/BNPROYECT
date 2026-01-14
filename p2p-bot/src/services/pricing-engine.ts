// =====================================================
// DYNAMIC PRICING ENGINE
// Auto-adjusts prices to stay competitive
// =====================================================

import { getBinanceClient, BinanceC2CClient } from './binance-client.js';
import { pricingLogger as logger } from '../utils/logger.js';
import {
  AdData,
  TradeType,
  PriceType,
  PricingConfig,
  ReferencePrice,
} from '../types/binance.js';

export interface PriceAnalysis {
  referencePrice: number;
  competitorPrices: number[];
  bestCompetitorPrice: number;
  averagePrice: number;
  recommendedPrice: number;
  pricePosition: 'best' | 'competitive' | 'below_average' | 'above_average';
  margin: number;
}

export interface PricingStrategy {
  calculate(analysis: PriceAnalysis, config: PricingConfig): number;
}

// ==================== PRICING STRATEGIES ====================

/**
 * Competitive Strategy: Undercut the best competitor by a percentage
 */
class CompetitiveStrategy implements PricingStrategy {
  calculate(analysis: PriceAnalysis, config: PricingConfig): number {
    const { bestCompetitorPrice, referencePrice } = analysis;
    const { undercutPercentage, minMargin, maxMargin } = config;

    // Calculate undercut price
    let targetPrice = bestCompetitorPrice * (1 - undercutPercentage / 100);

    // Ensure minimum margin
    const minPrice = referencePrice * (1 + minMargin / 100);
    const maxPrice = referencePrice * (1 + maxMargin / 100);

    // Clamp to min/max margins
    targetPrice = Math.max(minPrice, Math.min(maxPrice, targetPrice));

    logger.debug({
      bestCompetitor: bestCompetitorPrice,
      undercut: undercutPercentage,
      target: targetPrice,
      min: minPrice,
      max: maxPrice,
    }, 'Competitive price calculation');

    return targetPrice;
  }
}

/**
 * Fixed Margin Strategy: Always maintain a fixed margin over reference
 */
class FixedMarginStrategy implements PricingStrategy {
  calculate(analysis: PriceAnalysis, config: PricingConfig): number {
    const { referencePrice } = analysis;
    const { minMargin } = config;

    return referencePrice * (1 + minMargin / 100);
  }
}

/**
 * Floating Strategy: Follow market average with adjustments
 */
class FloatingStrategy implements PricingStrategy {
  calculate(analysis: PriceAnalysis, config: PricingConfig): number {
    const { averagePrice, referencePrice } = analysis;
    const { minMargin, maxMargin } = config;

    // Target slightly below average
    let targetPrice = averagePrice * 0.995;

    // Ensure within margin bounds
    const minPrice = referencePrice * (1 + minMargin / 100);
    const maxPrice = referencePrice * (1 + maxMargin / 100);

    return Math.max(minPrice, Math.min(maxPrice, targetPrice));
  }
}

// ==================== PRICING ENGINE ====================

export class PricingEngine {
  private client: BinanceC2CClient;
  private config: PricingConfig;
  private strategy: PricingStrategy;
  private updateInterval: NodeJS.Timeout | null = null;
  private currentPrice: number = 0;
  private lastAnalysis: PriceAnalysis | null = null;

  // Events
  private onPriceUpdateCallbacks: ((price: number, analysis: PriceAnalysis) => void)[] = [];

  constructor(config: PricingConfig) {
    this.client = getBinanceClient();
    this.config = config;

    // Select strategy based on config
    switch (config.strategy) {
      case 'competitive':
        this.strategy = new CompetitiveStrategy();
        break;
      case 'fixed':
        this.strategy = new FixedMarginStrategy();
        break;
      case 'floating':
        this.strategy = new FloatingStrategy();
        break;
      default:
        this.strategy = new CompetitiveStrategy();
    }

    logger.info({ strategy: config.strategy }, 'Pricing engine initialized');
  }

  /**
   * Analyze market prices
   */
  async analyzeMarket(
    asset: string,
    fiat: string,
    tradeType: TradeType
  ): Promise<PriceAnalysis> {
    logger.debug({ asset, fiat, tradeType }, 'Analyzing market');

    // Get reference price
    const refPrice = await this.client.getReferencePrice(asset, fiat, tradeType);
    const referencePrice = parseFloat(refPrice.price);

    // Search competitor ads
    const competitorAds = await this.client.searchAds({
      asset,
      fiat,
      tradeType,
      page: 1,
      rows: 20, // Top 20 competitors
    });

    // Extract and sort prices
    const competitorPrices = competitorAds
      .map(ad => parseFloat(ad.price))
      .filter(price => price > 0)
      .sort((a, b) => tradeType === TradeType.SELL ? a - b : b - a);

    // Calculate metrics
    const bestCompetitorPrice = competitorPrices[0] || referencePrice;
    const averagePrice = competitorPrices.length > 0
      ? competitorPrices.reduce((a, b) => a + b, 0) / competitorPrices.length
      : referencePrice;

    // Calculate recommended price using strategy
    const tempAnalysis: PriceAnalysis = {
      referencePrice,
      competitorPrices,
      bestCompetitorPrice,
      averagePrice,
      recommendedPrice: 0,
      pricePosition: 'competitive',
      margin: 0,
    };

    const recommendedPrice = this.strategy.calculate(tempAnalysis, this.config);

    // Determine price position
    let pricePosition: PriceAnalysis['pricePosition'];
    if (tradeType === TradeType.SELL) {
      if (recommendedPrice <= bestCompetitorPrice) pricePosition = 'best';
      else if (recommendedPrice <= averagePrice) pricePosition = 'competitive';
      else pricePosition = 'above_average';
    } else {
      if (recommendedPrice >= bestCompetitorPrice) pricePosition = 'best';
      else if (recommendedPrice >= averagePrice) pricePosition = 'competitive';
      else pricePosition = 'below_average';
    }

    // Calculate margin
    const margin = ((recommendedPrice - referencePrice) / referencePrice) * 100;

    const analysis: PriceAnalysis = {
      referencePrice,
      competitorPrices,
      bestCompetitorPrice,
      averagePrice,
      recommendedPrice,
      pricePosition,
      margin,
    };

    this.lastAnalysis = analysis;

    logger.info({
      referencePrice: referencePrice.toFixed(2),
      bestCompetitor: bestCompetitorPrice.toFixed(2),
      recommended: recommendedPrice.toFixed(2),
      margin: margin.toFixed(2) + '%',
      position: pricePosition,
    }, 'Market analysis complete');

    return analysis;
  }

  /**
   * Update ad price based on market analysis
   */
  async updateAdPrice(
    advNo: string,
    asset: string,
    fiat: string,
    tradeType: TradeType
  ): Promise<number> {
    const analysis = await this.analyzeMarket(asset, fiat, tradeType);

    // Only update if price changed significantly (> 0.01%)
    const priceDiff = Math.abs(this.currentPrice - analysis.recommendedPrice);
    const threshold = this.currentPrice * 0.0001;

    if (priceDiff > threshold || this.currentPrice === 0) {
      await this.client.updateAd({
        advNo,
        price: analysis.recommendedPrice,
        priceType: PriceType.FIXED,
      });

      this.currentPrice = analysis.recommendedPrice;

      logger.info({
        advNo,
        oldPrice: this.currentPrice.toFixed(2),
        newPrice: analysis.recommendedPrice.toFixed(2),
        change: ((priceDiff / this.currentPrice) * 100).toFixed(4) + '%',
      }, 'Ad price updated');

      // Trigger callbacks
      this.onPriceUpdateCallbacks.forEach(cb => cb(analysis.recommendedPrice, analysis));
    } else {
      logger.debug({ advNo, price: this.currentPrice }, 'Price unchanged');
    }

    return analysis.recommendedPrice;
  }

  /**
   * Start automatic price updates
   */
  startAutoUpdate(
    advNo: string,
    asset: string,
    fiat: string,
    tradeType: TradeType
  ): void {
    if (this.updateInterval) {
      this.stopAutoUpdate();
    }

    logger.info({
      advNo,
      interval: this.config.updateIntervalMs,
    }, 'Starting auto price updates');

    // Initial update with error handling
    this.safeUpdateAdPrice(advNo, asset, fiat, tradeType);

    // Schedule periodic updates
    this.updateInterval = setInterval(
      () => this.safeUpdateAdPrice(advNo, asset, fiat, tradeType),
      this.config.updateIntervalMs
    );
  }

  /**
   * Safe wrapper for updateAdPrice with error handling
   */
  private async safeUpdateAdPrice(
    advNo: string,
    asset: string,
    fiat: string,
    tradeType: TradeType
  ): Promise<void> {
    try {
      await this.updateAdPrice(advNo, asset, fiat, tradeType);
    } catch (error) {
      logger.warn({ advNo, error }, 'Failed to update ad price - will retry next interval');
    }
  }

  /**
   * Stop automatic price updates
   */
  stopAutoUpdate(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      logger.info('Stopped auto price updates');
    }
  }

  /**
   * Register callback for price updates
   */
  onPriceUpdate(callback: (price: number, analysis: PriceAnalysis) => void): void {
    this.onPriceUpdateCallbacks.push(callback);
  }

  /**
   * Get current price
   */
  getCurrentPrice(): number {
    return this.currentPrice;
  }

  /**
   * Get last analysis
   */
  getLastAnalysis(): PriceAnalysis | null {
    return this.lastAnalysis;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<PricingConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info({ config: this.config }, 'Pricing config updated');
  }

  /**
   * Manual price override
   */
  async setManualPrice(advNo: string, price: number): Promise<void> {
    await this.client.updateAd({
      advNo,
      price,
      priceType: PriceType.FIXED,
    });

    this.currentPrice = price;
    logger.info({ advNo, price }, 'Manual price set');
  }
}

// Factory function
export function createPricingEngine(config?: Partial<PricingConfig>): PricingEngine {
  const defaultConfig: PricingConfig = {
    strategy: (process.env.PRICING_STRATEGY as PricingConfig['strategy']) || 'competitive',
    undercutPercentage: parseFloat(process.env.PRICING_UNDERCUT_PERCENTAGE || '0.1'),
    minMargin: parseFloat(process.env.PRICING_MIN_MARGIN || '0.5'),
    maxMargin: parseFloat(process.env.PRICING_MAX_MARGIN || '2.0'),
    updateIntervalMs: parseInt(process.env.PRICING_UPDATE_INTERVAL_MS || '30000'),
  };

  return new PricingEngine({ ...defaultConfig, ...config });
}
