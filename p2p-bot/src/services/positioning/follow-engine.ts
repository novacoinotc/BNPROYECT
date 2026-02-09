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
  minPrice?: number | null; // Price floor for SELL ads - won't go below this
  ignoredAdvertisers?: string[]; // List of nicknames to always ignore
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

    // Check if target is in ignored list (warn but don't block - user explicitly set this target)
    if (this.config.ignoredAdvertisers?.length) {
      const isIgnored = this.config.ignoredAdvertisers.some(
        ignored => ignored.toLowerCase() === this.config.targetNickName.toLowerCase()
      );
      if (isIgnored) {
        logger.warn(`⚠️ [FOLLOW] Target "${this.config.targetNickName}" is in ignored list - skipping`);
        return null;
      }
    }

    // API tradeType from USER perspective:
    // - tradeType='BUY' returns ads from "Buy" tab (SELLERS)
    // - tradeType='SELL' returns ads from "Sell" tab (BUYERS)
    //
    // Our positioning logic:
    // - Our SELL ad → we compete with other SELLERS → search 'BUY' tab
    // - Our BUY ad → we compete with other BUYERS → search 'SELL' tab
    const searchType = this.adType === 'SELL' ? TradeType.BUY : TradeType.SELL;

    logger.debug(`🔍 [FOLLOW] Searching '${searchType}' tab for "${this.config.targetNickName}" in ${asset}/${fiat}`);

    // Search multiple pages to find target and collect all ads (for floor fallback)
    let targetAd: AdData | null = null;
    let allAds: AdData[] = [];

    for (let page = 1; page <= 3; page++) {
      const ads = await this.client.searchAds({
        asset,
        fiat,
        tradeType: searchType,
        page,
        rows: 20,
      });

      if (ads.length === 0) break;
      allAds.push(...ads);

      // Find target by nickname (case insensitive)
      if (!targetAd) {
        const found = ads.find(ad =>
          ad.advertiser.nickName.toLowerCase() === this.config.targetNickName.toLowerCase()
        );
        if (found) {
          targetAd = found;
        }
      }
    }

    if (!targetAd) {
      logger.warn(`⚠️ [FOLLOW] Target "${this.config.targetNickName}" NOT FOUND in ${asset}/${fiat} (searched 3 pages)`);
      return null;
    }

    const targetPrice = parseFloat(targetAd.price);
    logger.debug(`✅ [FOLLOW] Found "${targetAd.advertiser.nickName}" at $${targetPrice.toFixed(2)}`);

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

    // Apply price floor for SELL ads
    if (this.adType === 'SELL' && this.config.minPrice && ourPrice < this.config.minPrice) {
      logger.info(`🛑 [FOLLOW] Price $${ourPrice.toFixed(2)} below floor $${this.config.minPrice.toFixed(2)} - searching for next competitor above floor`);

      // Find next best competitor ABOVE the floor
      const myNickName = process.env.BINANCE_MY_NICKNAME?.toLowerCase() || '';
      const competitorsAboveFloor = allAds
        .filter(ad => {
          const price = parseFloat(ad.price);
          const nick = ad.advertiser.nickName.toLowerCase();
          // Exclude self and ignored advertisers
          const isSelf = myNickName && nick === myNickName;
          const isIgnored = this.config.ignoredAdvertisers?.some(
            ignored => ignored.toLowerCase() === nick
          );
          return price >= this.config.minPrice! && !isSelf && !isIgnored;
        })
        .sort((a, b) => parseFloat(a.price) - parseFloat(b.price)); // Sort by price ascending

      if (competitorsAboveFloor.length > 0) {
        // Undercut the cheapest competitor above floor
        const nextCompetitor = competitorsAboveFloor[0];
        const nextPrice = parseFloat(nextCompetitor.price);
        const undercutValue = this.config.undercutCents / 100;
        ourPrice = Math.max(nextPrice - undercutValue, this.config.minPrice);

        logger.info(`📈 [FOLLOW] Repositioning below "${nextCompetitor.advertiser.nickName}" at $${nextPrice.toFixed(2)} → $${ourPrice.toFixed(2)}`);

        return {
          success: true,
          targetPrice: Math.round(ourPrice * 100) / 100,
          targetNickName: nextCompetitor.advertiser.nickName,
          targetFoundPrice: nextPrice,
        };
      } else {
        // No competitors above floor - stay at floor
        ourPrice = this.config.minPrice;
        logger.info(`📈 [FOLLOW] No competitors above floor - staying at floor $${ourPrice.toFixed(2)}`);
      }
    }

    return {
      success: true,
      targetPrice: Math.round(ourPrice * 100) / 100,
      targetNickName: targetAd.advertiser.nickName,
      targetFoundPrice: targetPrice,
    };
  }
}
