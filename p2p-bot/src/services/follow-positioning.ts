// =====================================================
// FOLLOW POSITIONING ENGINE
// Follows a specific seller's price (match or undercut)
// =====================================================

import { getBinanceClient, BinanceC2CClient } from './binance-client.js';
import { logger } from '../utils/logger.js';
import {
  AdData,
  TradeType,
  FollowModeConfig,
  PositioningAnalysis,
} from '../types/binance.js';

export interface TargetInfo {
  nickName: string;
  userNo: string;
  price: number;
  isOnline: boolean;
  found: boolean;
  ad?: AdData;
}

export class FollowPositioning {
  private client: BinanceC2CClient;
  private config: FollowModeConfig;
  private lastTargetInfo: TargetInfo | null = null;

  constructor(config: Partial<FollowModeConfig> = {}) {
    this.client = getBinanceClient();
    this.config = this.buildConfig(config);

    if (this.config.enabled) {
      logger.info({
        targetNickName: this.config.targetNickName,
        targetUserNo: this.config.targetUserNo || '(not set)',
        strategy: this.config.followStrategy,
        undercutAmount: this.config.undercutAmount,
        fallbackToSmart: this.config.fallbackToSmart,
      }, '👁️ [FOLLOW MODE] Initialized');
    }
  }

  private buildConfig(partial: Partial<FollowModeConfig>): FollowModeConfig {
    return {
      enabled: partial.enabled ?? process.env.FOLLOW_MODE_ENABLED === 'true',
      targetNickName: partial.targetNickName ?? (process.env.FOLLOW_TARGET_NICKNAME || ''),
      targetUserNo: partial.targetUserNo ?? process.env.FOLLOW_TARGET_USERNO,

      // Estrategia
      followStrategy: partial.followStrategy ?? ((process.env.FOLLOW_STRATEGY as 'match' | 'undercut') || 'undercut'),
      undercutAmount: partial.undercutAmount ?? parseFloat(process.env.FOLLOW_UNDERCUT_CENTS || '1'),

      // Fallback
      fallbackToSmart: partial.fallbackToSmart ?? process.env.FOLLOW_FALLBACK_ENABLED === 'true',

      // Límites
      minMargin: partial.minMargin ?? parseFloat(process.env.FOLLOW_MIN_MARGIN || '0.3'),
      maxMargin: partial.maxMargin ?? parseFloat(process.env.FOLLOW_MAX_MARGIN || '2.0'),

      // Comportamiento
      updateIntervalMs: partial.updateIntervalMs ?? parseInt(process.env.FOLLOW_UPDATE_INTERVAL || '15000'),
    };
  }

  /**
   * Search for target seller in competitor ads
   */
  async findTarget(
    asset: string,
    fiat: string,
    tradeType: TradeType
  ): Promise<TargetInfo> {
    // Fetch competitor ads
    const ads = await this.client.searchAds({
      asset,
      fiat,
      tradeType,
      page: 1,
      rows: 50, // Fetch more to ensure we find our target
    });

    logger.debug({
      targetNickName: this.config.targetNickName,
      targetUserNo: this.config.targetUserNo,
      adsToSearch: ads.length,
    }, '👁️ [FOLLOW MODE] Searching for target');

    // Search by userNo first (more stable), then by nickName
    let targetAd: AdData | undefined;

    if (this.config.targetUserNo) {
      targetAd = ads.find(ad => ad.advertiser.userNo === this.config.targetUserNo);
    }

    if (!targetAd && this.config.targetNickName) {
      // Try exact match first
      targetAd = ads.find(ad =>
        ad.advertiser.nickName.toLowerCase() === this.config.targetNickName.toLowerCase()
      );

      // Try partial match if exact not found
      if (!targetAd) {
        targetAd = ads.find(ad =>
          ad.advertiser.nickName.toLowerCase().includes(this.config.targetNickName.toLowerCase()) ||
          this.config.targetNickName.toLowerCase().includes(ad.advertiser.nickName.toLowerCase())
        );
      }
    }

    if (targetAd) {
      const info: TargetInfo = {
        nickName: targetAd.advertiser.nickName,
        userNo: targetAd.advertiser.userNo,
        price: parseFloat(targetAd.price),
        isOnline: targetAd.advertiser.isOnline,
        found: true,
        ad: targetAd,
      };

      this.lastTargetInfo = info;

      logger.info({
        nickName: info.nickName,
        userNo: info.userNo,
        price: info.price.toFixed(2),
        isOnline: info.isOnline,
      }, '✅ [FOLLOW MODE] Target found!');

      return info;
    }

    // Target not found
    const notFoundInfo: TargetInfo = {
      nickName: this.config.targetNickName,
      userNo: this.config.targetUserNo || '',
      price: 0,
      isOnline: false,
      found: false,
    };

    this.lastTargetInfo = notFoundInfo;

    logger.warn({
      targetNickName: this.config.targetNickName,
      targetUserNo: this.config.targetUserNo,
      adsSearched: ads.length,
    }, '⚠️ [FOLLOW MODE] Target NOT found in competitor ads');

    return notFoundInfo;
  }

  /**
   * Calculate target price based on target's price
   */
  calculateTargetPrice(
    targetPrice: number,
    referencePrice: number,
    tradeType: TradeType
  ): number {
    let calculatedPrice: number;

    if (this.config.followStrategy === 'match') {
      // Match target's price exactly
      calculatedPrice = targetPrice;
      logger.info({
        targetPrice: targetPrice.toFixed(2),
        strategy: 'match',
        calculatedPrice: calculatedPrice.toFixed(2),
      }, '📍 [FOLLOW MODE] Matching target price');
    } else {
      // Undercut by specified amount
      const undercutValue = this.config.undercutAmount / 100; // Convert centavos to pesos
      if (tradeType === TradeType.SELL) {
        calculatedPrice = targetPrice - undercutValue;
      } else {
        calculatedPrice = targetPrice + undercutValue;
      }
      logger.info({
        targetPrice: targetPrice.toFixed(2),
        strategy: 'undercut',
        undercutCents: this.config.undercutAmount,
        calculatedPrice: calculatedPrice.toFixed(2),
      }, '📍 [FOLLOW MODE] Undercutting target price');
    }

    // Apply margin limits for safety
    const minPrice = referencePrice * (1 + this.config.minMargin / 100);
    const maxPrice = referencePrice * (1 + this.config.maxMargin / 100);

    const originalPrice = calculatedPrice;

    if (tradeType === TradeType.SELL) {
      calculatedPrice = Math.max(minPrice, Math.min(maxPrice, calculatedPrice));
    } else {
      calculatedPrice = Math.min(maxPrice, Math.max(minPrice, calculatedPrice));
    }

    if (calculatedPrice !== originalPrice) {
      logger.warn({
        originalPrice: originalPrice.toFixed(2),
        clampedPrice: calculatedPrice.toFixed(2),
        minPrice: minPrice.toFixed(2),
        maxPrice: maxPrice.toFixed(2),
        reason: originalPrice < minPrice ? 'below_min_margin' : 'above_max_margin',
      }, '⚠️ [FOLLOW MODE] Price clamped to margin limits');
    }

    return calculatedPrice;
  }

  /**
   * Full analysis and price recommendation
   */
  async getRecommendedPrice(
    asset: string,
    fiat: string,
    tradeType: TradeType
  ): Promise<PositioningAnalysis | null> {
    if (!this.config.enabled) {
      logger.debug('👁️ [FOLLOW MODE] Mode is disabled');
      return null;
    }

    if (!this.config.targetNickName && !this.config.targetUserNo) {
      logger.warn('⚠️ [FOLLOW MODE] No target specified (set FOLLOW_TARGET_NICKNAME or FOLLOW_TARGET_USERNO)');
      return null;
    }

    const timestamp = new Date();

    // Find target
    const targetInfo = await this.findTarget(asset, fiat, tradeType);

    if (!targetInfo.found) {
      // Target not found - return null to trigger fallback
      logger.warn({
        fallbackToSmart: this.config.fallbackToSmart,
      }, '⚠️ [FOLLOW MODE] Target not found, fallback may be triggered');
      return null;
    }

    // Get reference price for margin calculation
    const refPriceData = await this.client.getReferencePrice(asset, fiat, tradeType);
    const referencePrice = parseFloat(refPriceData.price);

    // Calculate target price
    const targetPrice = this.calculateTargetPrice(
      targetInfo.price,
      referencePrice,
      tradeType
    );

    // Calculate margin
    const marginPercent = ((targetPrice - referencePrice) / referencePrice) * 100;

    return {
      timestamp,
      mode: 'follow',
      totalAdsAnalyzed: 0, // Not relevant for follow mode
      qualifiedCompetitors: 1, // Just the target
      bestQualifiedPrice: targetInfo.price,
      averagePrice: targetInfo.price,
      referencePrice,
      currentPrice: 0, // Will be set by orchestrator
      targetPrice,
      priceChanged: false, // Will be set by orchestrator
      marginPercent,
      targetInfo: {
        nickName: targetInfo.nickName,
        userNo: targetInfo.userNo,
        price: targetInfo.price,
        isOnline: targetInfo.isOnline,
        found: targetInfo.found,
      },
    };
  }

  /**
   * Check if follow mode is enabled and properly configured
   */
  isEnabled(): boolean {
    return this.config.enabled && (!!this.config.targetNickName || !!this.config.targetUserNo);
  }

  /**
   * Check if fallback to smart mode should be used
   */
  shouldFallbackToSmart(): boolean {
    return this.config.fallbackToSmart;
  }

  /**
   * Get last known target info
   */
  getLastTargetInfo(): TargetInfo | null {
    return this.lastTargetInfo;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<FollowModeConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info({
      targetNickName: this.config.targetNickName,
      strategy: this.config.followStrategy,
      enabled: this.config.enabled,
    }, '👁️ [FOLLOW MODE] Config updated');
  }

  /**
   * Get current configuration
   */
  getConfig(): FollowModeConfig {
    return { ...this.config };
  }

  /**
   * Set new target to follow
   */
  setTarget(nickName?: string, userNo?: string): void {
    if (nickName) this.config.targetNickName = nickName;
    if (userNo) this.config.targetUserNo = userNo;

    logger.info({
      targetNickName: this.config.targetNickName,
      targetUserNo: this.config.targetUserNo,
    }, '👁️ [FOLLOW MODE] New target set');
  }
}

// Factory function
export function createFollowPositioning(config?: Partial<FollowModeConfig>): FollowPositioning {
  return new FollowPositioning(config);
}
