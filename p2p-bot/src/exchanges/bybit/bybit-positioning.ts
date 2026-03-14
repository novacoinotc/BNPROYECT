// =====================================================
// BYBIT MULTI-AD POSITIONING COORDINATOR
// Manages positioning for all active Bybit ads
// Uses per-asset config from database (same as Binance)
// =====================================================

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import { getBotConfig, getPositioningConfigForAd, BotConfig } from '../../services/database-pg.js';
import { BybitClient, getBybitClient } from './bybit-client.js';
import { BybitAdManager } from './bybit-ad-manager.js';
import { BybitSmartEngine, BybitSmartConfig } from './bybit-smart-engine.js';
import { BybitFollowEngine, BybitFollowConfig } from './bybit-follow-engine.js';
import { BybitMyAd } from './bybit-types.js';
import { getSpotPriceMxn } from '../../utils/spot-price.js';

const log = logger.child({ module: 'bybit-positioning' });

// ==================== TYPES ====================

interface TrackedAd {
  adId: string;
  side: 'buy' | 'sell';
  tokenId: string;
  currencyId: string;
  currentPrice: number;
  targetPrice: number | null;
  lastUpdate: Date | null;
  updateCount: number;
  errorCount: number;
  mode: 'smart' | 'follow' | 'idle';
}

export interface BybitPositioningStatus {
  isRunning: boolean;
  mode: string;
  followTarget: string | null;
  undercutCents: number;
  managedAds: TrackedAd[];
  totalUpdates: number;
  totalErrors: number;
}

// ==================== POSITIONING COORDINATOR ====================

export class BybitPositioning extends EventEmitter {
  private client: BybitClient;
  private adManager: BybitAdManager;
  private smartEngines: Map<string, BybitSmartEngine> = new Map();
  private followEngines: Map<string, BybitFollowEngine> = new Map();
  private trackedAds: Map<string, TrackedAd> = new Map();
  private updateInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  // Full DB config (for per-asset lookups)
  private dbConfig: BotConfig | null = null;

  private readonly PRICE_UPDATE_THRESHOLD = 0.01;

  constructor() {
    super();
    this.client = getBybitClient();
    this.adManager = new BybitAdManager(this.client);
  }

  // ==================== LIFECYCLE ====================

  async start(intervalMs: number = 12000): Promise<void> {
    await this.loadConfig();
    await this.discoverActiveAds();

    if (this.trackedAds.size === 0) {
      log.warn('Bybit Positioning: No active ads found');
      return;
    }

    this.isRunning = true;
    log.info({
      adCount: this.trackedAds.size,
      hasPerAssetConfigs: this.dbConfig?.positioningConfigs ? Object.keys(this.dbConfig.positioningConfigs).length : 0,
    }, 'Bybit Positioning started');

    // Initial update
    await this.runUpdateCycle();

    // Schedule periodic updates
    this.updateInterval = setInterval(() => this.runUpdateCycle(), intervalMs);
  }

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    this.isRunning = false;
    log.info('Bybit Positioning stopped');
  }

  // ==================== CONFIG ====================

  private async loadConfig(): Promise<void> {
    try {
      this.dbConfig = await getBotConfig();
    } catch (error: any) {
      log.error({ error: error.message }, 'Bybit: Failed to load config');
    }
  }

  // ==================== AD DISCOVERY ====================

  private async discoverActiveAds(): Promise<void> {
    const { items } = await this.client.getMyAds({ status: '2' }); // '2' = available

    // Only track online ads (status 10)
    const onlineAds = items.filter(ad => ad.status === 10);
    const activeIds = new Set(onlineAds.map(ad => ad.id));

    // Remove deactivated ads
    for (const adId of this.trackedAds.keys()) {
      if (!activeIds.has(adId)) {
        this.trackedAds.delete(adId);
      }
    }

    // Add/update active ads
    for (const ad of onlineAds) {
      const side = ad.side === 1 ? 'sell' : 'buy';
      const existing = this.trackedAds.get(ad.id);

      if (existing) {
        existing.currentPrice = parseFloat(ad.price);
      } else {
        this.trackedAds.set(ad.id, {
          adId: ad.id,
          side,
          tokenId: ad.tokenId,
          currencyId: ad.currencyId,
          currentPrice: parseFloat(ad.price),
          targetPrice: null,
          lastUpdate: null,
          updateCount: 0,
          errorCount: 0,
          mode: 'idle',
        });
      }
    }
  }

  // ==================== UPDATE CYCLE ====================

  private async runUpdateCycle(): Promise<void> {
    await this.loadConfig();
    await this.discoverActiveAds();

    if (this.trackedAds.size === 0) return;

    for (const [adId, ad] of this.trackedAds) {
      try {
        await this.updateSingleAd(ad);
      } catch (error: any) {
        ad.errorCount++;
        if (ad.errorCount % 50 === 1) {
          log.error({ adId, error: error.message }, 'Bybit: Error updating ad');
        }
      }

      // Delay between ads to respect rate limits
      await new Promise(r => setTimeout(r, 200));
    }
  }

  private async updateSingleAd(ad: TrackedAd): Promise<void> {
    if (!this.dbConfig) return;

    // Get per-asset config from database (same logic as Binance)
    const tradeType = ad.side === 'sell' ? 'SELL' : 'BUY';
    const assetConfig = getPositioningConfigForAd(this.dbConfig, tradeType as 'SELL' | 'BUY', ad.tokenId);

    // Skip disabled assets
    if (!assetConfig.enabled) {
      ad.mode = 'idle';
      return;
    }

    let targetPrice: number | null = null;

    log.info({
      mode: assetConfig.mode,
      followTarget: assetConfig.followTarget,
      matchPrice: assetConfig.matchPrice,
      undercutCents: assetConfig.undercutCents,
      adId: ad.adId,
      side: ad.side,
      token: ad.tokenId,
      price: ad.currentPrice,
    }, `Bybit positioning: ${ad.side} ${ad.tokenId} mode=${assetConfig.mode}`);

    if (assetConfig.mode === 'follow' && assetConfig.followTarget) {
      ad.mode = 'follow';
      const engine = this.getFollowEngine(ad, assetConfig);
      const result = await engine.getPrice(ad.tokenId, ad.currencyId);

      if (result) {
        targetPrice = result.targetPrice;
        log.info(`Bybit follow: target=${result.targetNickName}@${result.targetAdPrice} -> our=${result.targetPrice}`);
      } else {
        // Fallback to smart if target not found
        ad.mode = 'smart';
        const smartEngine = this.getSmartEngine(ad, assetConfig);
        const smartResult = await smartEngine.getPrice(ad.tokenId, ad.currencyId);
        if (smartResult) targetPrice = smartResult.targetPrice;
      }
    } else {
      ad.mode = 'smart';
      const engine = this.getSmartEngine(ad, assetConfig);
      const result = await engine.getPrice(ad.tokenId, ad.currencyId);
      if (result) targetPrice = result.targetPrice;
    }

    if (targetPrice === null) return;

    // SPOT PRICE PROTECTION (Bitso) — all modes, MXN fiat
    // SELL: never sell below Bitso spot price
    // BUY: never buy above Bitso spot price (+ optional margin)
    if (ad.currencyId.toUpperCase() === 'MXN') {
      const spotPrice = await getSpotPriceMxn(ad.tokenId);
      if (spotPrice !== null) {
        if (ad.side === 'sell') {
          const spotFloor = Math.round(spotPrice * 100) / 100;
          if (targetPrice < spotFloor) {
            log.warn(
              `🛑 Bybit [SELL] ${ad.tokenId}: Precio ${targetPrice.toFixed(2)} debajo de spot Bitso ${spotFloor.toFixed(2)} → subido a spot`
            );
            targetPrice = spotFloor;
          }
        } else if (ad.side === 'buy') {
          const marginValue = (assetConfig.spotMarginCents ?? 0) / 100;
          const spotCeiling = Math.round((spotPrice + marginValue) * 100) / 100;
          if (targetPrice > spotCeiling) {
            log.warn(
              `🛑 Bybit [BUY] ${ad.tokenId}: Precio ${targetPrice.toFixed(2)} excede techo spot ${spotCeiling.toFixed(2)} (Bitso ${spotPrice.toFixed(2)}${marginValue > 0 ? ` +${(marginValue * 100).toFixed(0)}¢` : ''}) → capado`
            );
            targetPrice = spotCeiling;
          }
        }
      }
    }

    ad.targetPrice = targetPrice;

    // Check if update needed
    const priceDiff = Math.round(Math.abs(ad.currentPrice - targetPrice) * 100) / 100;
    if (priceDiff < this.PRICE_UPDATE_THRESHOLD) {
      log.debug(`Bybit positioning: ${ad.tokenId} price=${ad.currentPrice} target=${targetPrice} diff=${priceDiff} < threshold, skipping`);
      return;
    }

    // Execute update
    const success = await this.adManager.updateAdPrice(ad.adId, targetPrice.toFixed(2));

    if (success) {
      const oldPrice = ad.currentPrice;
      ad.currentPrice = targetPrice;
      ad.lastUpdate = new Date();
      ad.updateCount++;

      log.info({
        tokenId: ad.tokenId,
        side: ad.side,
        oldPrice: oldPrice.toFixed(2),
        newPrice: targetPrice.toFixed(2),
        mode: ad.mode,
        followTarget: assetConfig.followTarget,
      }, `Bybit: ${ad.tokenId} ${oldPrice.toFixed(2)} -> ${targetPrice.toFixed(2)}`);

      this.emit('priceUpdated', {
        adId: ad.adId,
        tokenId: ad.tokenId,
        side: ad.side,
        mode: ad.mode,
        oldPrice,
        newPrice: targetPrice,
      });
    } else {
      ad.errorCount++;
    }
  }

  // ==================== ENGINE MANAGEMENT ====================

  private getSmartEngine(ad: TrackedAd, assetConfig: ReturnType<typeof getPositioningConfigForAd>): BybitSmartEngine {
    const key = `${ad.side}-${ad.tokenId}-${ad.currencyId}`;
    let engine = this.smartEngines.get(key);

    if (!engine) {
      engine = new BybitSmartEngine(ad.side, {
        undercutCents: assetConfig.undercutCents,
        matchPrice: assetConfig.matchPrice,
        minPrice: ad.side === 'sell' ? (assetConfig.minPrice ?? undefined) : undefined,
        maxPrice: ad.side === 'buy' ? (assetConfig.maxPrice ?? undefined) : undefined,
        myNickName: process.env.BYBIT_MY_NICKNAME,
        minMonthOrderCount: assetConfig.smartMinOrderCount,
        minSurplusAmount: assetConfig.smartMinSurplus,
        minFinishRate: assetConfig.smartMinFinishRate,
        ignoredAdvertisers: this.dbConfig?.ignoredAdvertisers,
      });
      this.smartEngines.set(key, engine);
    }

    engine.updateConfig({
      undercutCents: assetConfig.undercutCents,
      matchPrice: assetConfig.matchPrice,
      minPrice: ad.side === 'sell' ? (assetConfig.minPrice ?? undefined) : undefined,
      maxPrice: ad.side === 'buy' ? (assetConfig.maxPrice ?? undefined) : undefined,
      minMonthOrderCount: assetConfig.smartMinOrderCount,
      minSurplusAmount: assetConfig.smartMinSurplus,
      minFinishRate: assetConfig.smartMinFinishRate,
      ignoredAdvertisers: this.dbConfig?.ignoredAdvertisers,
    });

    return engine;
  }

  private getFollowEngine(ad: TrackedAd, assetConfig: ReturnType<typeof getPositioningConfigForAd>): BybitFollowEngine {
    const key = `${ad.side}-${ad.tokenId}-${ad.currencyId}`;
    let engine = this.followEngines.get(key);

    if (!engine) {
      engine = new BybitFollowEngine(ad.side, {
        targetNickName: assetConfig.followTarget || '',
        undercutCents: assetConfig.undercutCents,
        matchPrice: assetConfig.matchPrice,
        minPrice: ad.side === 'sell' ? (assetConfig.minPrice ?? undefined) : undefined,
        maxPrice: ad.side === 'buy' ? (assetConfig.maxPrice ?? undefined) : undefined,
      });
      this.followEngines.set(key, engine);
    }

    engine.updateConfig({
      targetNickName: assetConfig.followTarget || '',
      undercutCents: assetConfig.undercutCents,
      matchPrice: assetConfig.matchPrice,
      minPrice: ad.side === 'sell' ? (assetConfig.minPrice ?? undefined) : undefined,
      maxPrice: ad.side === 'buy' ? (assetConfig.maxPrice ?? undefined) : undefined,
    });

    return engine;
  }

  // ==================== STATUS ====================

  getStatus(): BybitPositioningStatus {
    const ads = Array.from(this.trackedAds.values());
    // Return first non-idle ad's config for display
    const firstSellAd = ads.find(a => a.side === 'sell');
    let displayMode = 'smart';
    let displayTarget: string | null = null;
    let displayUndercut = 1;

    if (this.dbConfig && firstSellAd) {
      const cfg = getPositioningConfigForAd(this.dbConfig, 'SELL', firstSellAd.tokenId);
      displayMode = cfg.mode;
      displayTarget = cfg.followTarget;
      displayUndercut = cfg.undercutCents;
    }

    return {
      isRunning: this.isRunning,
      mode: displayMode,
      followTarget: displayTarget,
      undercutCents: displayUndercut,
      managedAds: ads,
      totalUpdates: ads.reduce((sum, ad) => sum + ad.updateCount, 0),
      totalErrors: ads.reduce((sum, ad) => sum + ad.errorCount, 0),
    };
  }

  async refresh(): Promise<void> {
    await this.loadConfig();
    await this.discoverActiveAds();
    await this.runUpdateCycle();
  }
}

// ==================== FACTORY ====================

export function createBybitPositioning(): BybitPositioning {
  return new BybitPositioning();
}
