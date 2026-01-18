// =====================================================
// FOLLOW ENGINE - Independent module for following a target
// =====================================================

import { getBinanceClient, BinanceC2CClient } from '../binance-client.js';
import { AdData, TradeType } from '../../types/binance.js';

export interface FollowConfig {
  targetNickName: string;
  undercutCents: number;
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

    // Search type is from CLIENT perspective:
    // - Our SELL ad → search with BUY → finds other sellers
    // - Our BUY ad → search with SELL → finds other buyers
    const searchType = this.adType === 'SELL' ? TradeType.BUY : TradeType.SELL;

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
      return null;
    }

    const targetPrice = parseFloat(targetAd.price);
    const undercutValue = this.config.undercutCents / 100;

    // Calculate our price based on ad type:
    // SELL ad → go LOWER to attract buyers
    // BUY ad → go HIGHER to attract sellers
    const ourPrice = this.adType === 'SELL'
      ? targetPrice - undercutValue
      : targetPrice + undercutValue;

    return {
      success: true,
      targetPrice: Math.round(ourPrice * 100) / 100,
      targetNickName: targetAd.advertiser.nickName,
      targetFoundPrice: targetPrice,
    };
  }
}
