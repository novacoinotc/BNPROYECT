// =====================================================
// BYBIT FOLLOW ENGINE
// Tracks a specific seller and matches/undercuts price
// Falls back to smart engine if target not found
// =====================================================

import { BybitClient, getBybitClient } from './bybit-client.js';
import { BybitMarketplaceAd } from './bybit-types.js';
import { logger } from '../../utils/logger.js';

const log = logger.child({ module: 'bybit-follow' });

// ==================== CONFIG ====================

export interface BybitFollowConfig {
  targetNickName: string;
  undercutCents: number;
  matchPrice: boolean;
  minPrice?: number | null;
  maxPrice?: number | null;
}

export interface BybitFollowResult {
  targetPrice: number;
  targetFound: boolean;
  targetAdPrice: number;
  targetNickName: string;
}

// ==================== FOLLOW ENGINE ====================

export class BybitFollowEngine {
  private client: BybitClient;
  private config: BybitFollowConfig;
  private adSide: 'buy' | 'sell';

  constructor(adSide: 'buy' | 'sell', config: BybitFollowConfig) {
    this.client = getBybitClient();
    this.adSide = adSide;
    this.config = config;
  }

  updateConfig(config: Partial<BybitFollowConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Search for target across multiple pages
   */
  async getPrice(tokenId: string, currencyId: string): Promise<BybitFollowResult | null> {
    const searchSide = this.adSide === 'sell' ? '1' : '0';
    const target = this.config.targetNickName;

    if (!target) return null;

    // Search up to 3 pages (60 ads)
    let targetAd: BybitMarketplaceAd | null = null;

    for (let page = 1; page <= 3; page++) {
      const { items: ads } = await this.client.searchAds(
        tokenId, currencyId, searchSide as '0' | '1', page, 20
      );

      if (ads.length === 0) break;

      const found = ads.find(ad =>
        ad.nickName.toLowerCase() === target.toLowerCase()
      );

      if (found) {
        targetAd = found;
        break;
      }
    }

    if (!targetAd) {
      log.debug({ target, tokenId, currencyId }, 'Bybit Follow: Target not found');
      return null;
    }

    const targetPrice = parseFloat(targetAd.price);
    let ourPrice: number;

    if (this.config.matchPrice) {
      ourPrice = targetPrice;
    } else {
      const undercutValue = this.config.undercutCents / 100;
      ourPrice = this.adSide === 'sell'
        ? targetPrice - undercutValue
        : targetPrice + undercutValue;
    }

    // Apply price floor for SELL
    if (this.adSide === 'sell' && this.config.minPrice && ourPrice < this.config.minPrice) {
      ourPrice = this.config.minPrice;
      log.info({ price: ourPrice.toFixed(2) }, 'Bybit Follow: Clamped to floor');
    }

    // Apply price ceiling for BUY
    if (this.adSide === 'buy' && this.config.maxPrice && ourPrice > this.config.maxPrice) {
      ourPrice = this.config.maxPrice;
      log.info({ price: ourPrice.toFixed(2) }, 'Bybit Follow: Capped at ceiling');
    }

    return {
      targetPrice: Math.round(ourPrice * 100) / 100,
      targetFound: true,
      targetAdPrice: targetPrice,
      targetNickName: targetAd.nickName,
    };
  }
}
