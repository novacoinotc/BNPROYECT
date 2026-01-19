// =====================================================
// FOLLOW ENGINE - Independent module for following a target
// =====================================================

import { getBinanceClient, BinanceC2CClient } from '../binance-client.js';
import { AdData, TradeType } from '../../types/binance.js';
import { logger } from '../../utils/logger.js';

export interface FollowConfig {
  targetNickName: string;
  undercutCents: number;
  matchPrice: boolean; // true = exact match, false = undercut
}

export interface FollowResult {
  success: boolean;
  targetPrice: number;
  targetNickName: string | null;
  targetFoundPrice: number | null;
}

export class FollowEngine {
  private client: BinanceC2CClient;
  private config: FollowConfig;
  private adType: 'BUY' | 'SELL';

  constructor(adType: 'BUY' | 'SELL', config: FollowConfig) {
    this.client = getBinanceClient();
    this.adType = adType;
    this.config = config;
  }

  updateConfig(config: Partial<FollowConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get recommended price by following target
   * Returns null if target not found
   */
  async getPrice(asset: string, fiat: string): Promise<FollowResult | null> {
    if (!this.config.targetNickName) {
      return null;
    }

    // API tradeType from USER perspective:
    // - tradeType='BUY' returns ads from "Buy" tab (SELLERS)
    // - tradeType='SELL' returns ads from "Sell" tab (BUYERS)
    //
    // Our positioning logic:
    // - Our SELL ad → we compete with other SELLERS → search 'BUY' tab
    // - Our BUY ad → we compete with other BUYERS → search 'SELL' tab
    const searchType = this.adType === 'SELL' ? TradeType.BUY : TradeType.SELL;

    logger.info(`🔍 [FOLLOW] Our ${this.adType} ad → searching '${searchType}' tab for "${this.config.targetNickName}" in ${asset}/${fiat}`);

    // Search multiple pages to find target
    let targetAd: AdData | null = null;

    for (let page = 1; page <= 3; page++) {
      const ads = await this.client.searchAds({
        asset,
        fiat,
        tradeType: searchType,
        page,
        rows: 20,
      });

      if (ads.length === 0) break;

      // Find target by nickname (case insensitive)
      const found = ads.find(ad =>
        ad.advertiser.nickName.toLowerCase() === this.config.targetNickName.toLowerCase()
      );

      if (found) {
        targetAd = found;
        break;
      }
    }

    if (!targetAd) {
      logger.warn(`⚠️ [FOLLOW] Target "${this.config.targetNickName}" NOT FOUND in ${asset}/${fiat} (searched 3 pages)`);
      return null;
    }

    const targetPrice = parseFloat(targetAd.price);
    logger.info(`✅ [FOLLOW] Found "${targetAd.advertiser.nickName}" at $${targetPrice.toFixed(2)} in ${asset}/${fiat}`);

    // If matchPrice is true, use exact same price
    // Otherwise, undercut by the configured cents
    let ourPrice: number;
    if (this.config.matchPrice) {
      ourPrice = targetPrice;
    } else {
      const undercutValue = this.config.undercutCents / 100;
      // SELL ad → go LOWER to attract buyers
      // BUY ad → go HIGHER to attract sellers
      ourPrice = this.adType === 'SELL'
        ? targetPrice - undercutValue
        : targetPrice + undercutValue;
    }

    return {
      success: true,
      targetPrice: Math.round(ourPrice * 100) / 100,
      targetNickName: targetAd.advertiser.nickName,
      targetFoundPrice: targetPrice,
    };
  }
}
