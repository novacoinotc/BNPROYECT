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
    let allAds: AdData[] = [];
    let targetAds: AdData[] = [];

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

      // Collect ALL ads from target (not just the first one)
      const found = ads.filter(ad =>
        ad.advertiser.nickName.toLowerCase() === this.config.targetNickName.toLowerCase()
      );
      targetAds.push(...found);
    }

    if (targetAds.length === 0) {
      logger.warn(`⚠️ [FOLLOW] Target "${this.config.targetNickName}" NOT FOUND in ${asset}/${fiat} (searched 3 pages)`);
      return null;
    }

    // Smart target ad selection: when target has multiple ads and a price floor is set,
    // pick the ad that gives the best competitive position ABOVE the floor.
    // This prevents manipulation where the target places a "trap" ad at the floor.
    let targetAd: AdData;

    if (targetAds.length === 1 || !this.config.minPrice || this.adType !== 'SELL') {
      // Single ad, no floor, or BUY ad → pick first (most competitive)
      targetAd = targetAds[0];
    } else {
      // Multiple target ads + SELL + floor → evaluate each against the floor
      const undercutValue = this.config.matchPrice ? 0 : this.config.undercutCents / 100;

      const validTargetAds = targetAds
        .map(ad => ({
          ad,
          price: parseFloat(ad.price),
          ourPrice: parseFloat(ad.price) - undercutValue,
        }))
        .filter(entry => entry.ourPrice >= this.config.minPrice!)
        .sort((a, b) => a.ourPrice - b.ourPrice); // Cheapest valid first

      if (validTargetAds.length > 0) {
        targetAd = validTargetAds[0].ad;
        logger.info(
          `🎯 [FOLLOW] Target tiene ${targetAds.length} anuncios. ` +
          `Ignorando ${targetAds.length - validTargetAds.length} debajo del piso. ` +
          `Siguiendo $${validTargetAds[0].price.toFixed(2)} (nuestro precio: $${validTargetAds[0].ourPrice.toFixed(2)})`
        );
      } else {
        // ALL target ads put us below floor → pick cheapest, floor fallback will handle it
        targetAd = targetAds[0];
        logger.info(
          `🎯 [FOLLOW] Target tiene ${targetAds.length} anuncios, TODOS debajo del piso $${this.config.minPrice.toFixed(2)}. ` +
          `Cayendo al fallback de piso.`
        );
      }
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
          // Exclude self, target (trap ads), and ignored advertisers
          const isSelf = myNickName && nick === myNickName;
          const isTarget = nick === this.config.targetNickName.toLowerCase();
          const isIgnored = this.config.ignoredAdvertisers?.some(
            ignored => ignored.toLowerCase() === nick
          );
          return price >= this.config.minPrice! && !isSelf && !isTarget && !isIgnored;
        })
        .sort((a, b) => parseFloat(a.price) - parseFloat(b.price)); // Sort by price ascending

      if (competitorsAboveFloor.length > 0) {
        // MATCH the cheapest competitor above floor (don't undercut - we're at our cost limit)
        const nextCompetitor = competitorsAboveFloor[0];
        const nextPrice = parseFloat(nextCompetitor.price);
        ourPrice = nextPrice;

        logger.info(`📈 [FOLLOW] At floor - matching "${nextCompetitor.advertiser.nickName}" at $${ourPrice.toFixed(2)}`);

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
