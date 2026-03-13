// =====================================================
// OKX MULTI-AD POSITIONING COORDINATOR
// Manages positioning for all active OKX ads
// Handles OKX's ad ID change on update
// Uses getPositioningConfigForAd() like Binance/Bybit
// =====================================================

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import { getBotConfig, BotConfig, getPositioningConfigForAd, AssetPositioningConfig } from '../../services/database-pg.js';
import { OkxAdManager, OkxManagedAd, createOkxAdManager } from './okx-ad-manager.js';
import { OkxSmartEngine, OkxSmartConfig } from './okx-smart-engine.js';
import { OkxFollowEngine, OkxFollowConfig } from './okx-follow-engine.js';

const log = logger.child({ module: 'okx-positioning' });

// ==================== TYPES ====================

interface TrackedAd {
  adId: string;
  side: 'buy' | 'sell';
  crypto: string;
  fiat: string;
  currentPrice: number;
  availableAmount: string;
  targetPrice: number | null;
  lastUpdate: Date | null;
  updateCount: number;
  errorCount: number;
  mode: 'smart' | 'follow' | 'idle';
  type: string; // 'limit' or 'floating_market'
}

export interface OkxPositioningStatus {
  isRunning: boolean;
  mode: string;
  followTarget: string | null;
  undercutCents: number;
  managedAds: TrackedAd[];
  totalUpdates: number;
  totalErrors: number;
}

// ==================== POSITIONING COORDINATOR ====================

export class OkxPositioning extends EventEmitter {
  private adManager: OkxAdManager;
  private smartEngines: Map<string, OkxSmartEngine> = new Map();
  private followEngines: Map<string, OkxFollowEngine> = new Map();
  private trackedAds: Map<string, TrackedAd> = new Map();
  private updateInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  // Full DB config — used by getPositioningConfigForAd()
  private dbConfig: BotConfig | null = null;

  private readonly PRICE_UPDATE_THRESHOLD = 0.01;

  constructor() {
    super();
    this.adManager = createOkxAdManager();
  }

  // ==================== LIFECYCLE ====================

  async start(intervalMs: number = 12000): Promise<void> {
    await this.loadConfig();
    await this.discoverActiveAds();

    if (this.trackedAds.size === 0) {
      log.warn('OKX Positioning: No active ads found');
      return;
    }

    this.isRunning = true;
    log.info({ adCount: this.trackedAds.size }, 'OKX Positioning started');

    await this.runUpdateCycle();
    this.updateInterval = setInterval(() => this.runUpdateCycle(), intervalMs);
  }

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    this.isRunning = false;
    log.info('OKX Positioning stopped');
  }

  // ==================== CONFIG ====================

  private async loadConfig(): Promise<void> {
    try {
      this.dbConfig = await getBotConfig();
    } catch (error: any) {
      log.error({ error: error.message }, 'OKX: Failed to load config');
    }
  }

  /**
   * Get per-ad config using the same function as Binance/Bybit.
   * Reads from positioningConfigs["SELL:USDT"] with fallback to global defaults.
   */
  private getAdConfig(ad: TrackedAd): AssetPositioningConfig {
    if (!this.dbConfig) {
      return {
        enabled: true,
        mode: 'smart',
        followTarget: null,
        matchPrice: false,
        undercutCents: 1,
        minPrice: null,
        maxPrice: null,
        spotMarginCents: 0,
        smartMinOrderCount: 10,
        smartMinSurplus: 100,
        smartMinFinishRate: 0,
      };
    }
    const tradeType = ad.side === 'sell' ? 'SELL' : 'BUY';
    const asset = ad.crypto.toUpperCase();
    return getPositioningConfigForAd(this.dbConfig, tradeType, asset);
  }

  // ==================== AD DISCOVERY ====================

  private async discoverActiveAds(): Promise<void> {
    const activeAds = await this.adManager.getActiveAds();
    const activeIds = new Set(activeAds.map(ad => ad.adId));

    // Remove deactivated ads
    for (const adId of this.trackedAds.keys()) {
      if (!activeIds.has(adId)) {
        this.trackedAds.delete(adId);
      }
    }

    // Add/update active ads
    for (const ad of activeAds) {
      const existing = this.trackedAds.get(ad.adId);
      if (existing) {
        existing.currentPrice = ad.currentPrice;
        existing.availableAmount = ad.availableAmount;
      } else {
        this.trackedAds.set(ad.adId, {
          adId: ad.adId,
          side: ad.side,
          crypto: ad.crypto,
          fiat: ad.fiat,
          currentPrice: ad.currentPrice,
          availableAmount: ad.availableAmount,
          targetPrice: null,
          lastUpdate: null,
          updateCount: 0,
          errorCount: 0,
          mode: 'idle',
          type: ad.type || 'limit',
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
      // Skip ads that fail too many times
      if (ad.errorCount >= 5) {
        if (ad.errorCount === 5) {
          log.warn(`OKX: Skipping ad ${adId} (${ad.crypto} ${ad.side}) after 5 consecutive failures`);
          ad.errorCount = 6;
        }
        continue;
      }

      // Get per-ad config from DB (reads positioningConfigs["SELL:USDT"] etc.)
      const adConfig = this.getAdConfig(ad);

      // Skip disabled ads
      if (!adConfig.enabled) {
        log.debug(`OKX: Ad ${adId} (${ad.side} ${ad.crypto}) disabled in config, skipping`);
        continue;
      }

      try {
        await this.updateSingleAd(ad, adConfig);
      } catch (error: any) {
        ad.errorCount++;
        log.warn(`OKX: Error updating ad ${adId}: ${error.message}`);
      }

      // Delay between ads to avoid rate limits
      await new Promise(r => setTimeout(r, 500));
    }
  }

  private async updateSingleAd(ad: TrackedAd, adConfig: AssetPositioningConfig): Promise<void> {
    let targetPrice: number | null = null;

    log.info({
      mode: adConfig.mode,
      followTarget: adConfig.followTarget,
      matchPrice: adConfig.matchPrice,
      undercutCents: adConfig.undercutCents,
      minOrders: adConfig.smartMinOrderCount,
      minSurplus: adConfig.smartMinSurplus,
      adId: ad.adId,
      side: ad.side,
      crypto: ad.crypto,
      price: ad.currentPrice,
    }, `OKX positioning: ${ad.side} ${ad.crypto} mode=${adConfig.mode}`);

    if (adConfig.mode === 'follow' && adConfig.followTarget) {
      ad.mode = 'follow';
      const engine = this.getFollowEngine(ad, adConfig);
      const result = await engine.getPrice(ad.crypto, ad.fiat);

      if (result) {
        targetPrice = result.targetPrice;
        log.info(`OKX follow: target=${result.targetNickName} price=${result.targetFoundPrice} -> our=${result.targetPrice}`);
      } else {
        log.warn('OKX follow returned null — falling back to smart');
        ad.mode = 'smart';
        const smartEngine = this.getSmartEngine(ad, adConfig);
        const smartResult = await smartEngine.getPrice(ad.crypto, ad.fiat);
        if (smartResult) targetPrice = smartResult.targetPrice;
      }
    } else {
      ad.mode = 'smart';
      const engine = this.getSmartEngine(ad, adConfig);
      const result = await engine.getPrice(ad.crypto, ad.fiat);
      if (result) {
        targetPrice = result.targetPrice;
        log.info(`OKX smart: targetPrice=${targetPrice}, qualified=${result.qualifiedCount}, bestCompetitor=${result.bestCompetitorPrice}`);
      } else {
        log.info('OKX smart: no qualified competitors found');
      }
    }

    if (targetPrice === null) {
      log.warn(`OKX positioning: No target price for ad ${ad.adId}`);
      return;
    }

    ad.targetPrice = targetPrice;

    // Check if update needed
    const priceDiff = Math.round(Math.abs(ad.currentPrice - targetPrice) * 100) / 100;
    if (priceDiff < this.PRICE_UPDATE_THRESHOLD) {
      log.debug(`OKX positioning: Price diff ${priceDiff} < threshold, skipping`);
      return;
    }

    // Execute update
    const result = await this.adManager.updateAdPrice(ad.adId, targetPrice, ad.type, ad.availableAmount);

    if (result) {
      const oldPrice = ad.currentPrice;
      const oldAdId = ad.adId;

      // CRITICAL: OKX creates new ad on update — track new ID
      if (result.newAdId && result.newAdId !== oldAdId) {
        this.trackedAds.delete(oldAdId);
        ad.adId = result.newAdId;
        this.trackedAds.set(result.newAdId, ad);
        log.debug({ oldAdId, newAdId: result.newAdId }, 'OKX: Ad ID changed after update');
      }

      ad.currentPrice = targetPrice;
      ad.lastUpdate = new Date();
      ad.updateCount++;
      ad.errorCount = 0;

      log.info({
        crypto: ad.crypto,
        side: ad.side,
        oldPrice: oldPrice.toFixed(2),
        newPrice: targetPrice.toFixed(2),
        mode: ad.mode,
      }, `OKX: ${ad.crypto} ${oldPrice.toFixed(2)} -> ${targetPrice.toFixed(2)}`);

      this.emit('priceUpdated', {
        adId: ad.adId,
        crypto: ad.crypto,
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

  private getSmartEngine(ad: TrackedAd, adConfig: AssetPositioningConfig): OkxSmartEngine {
    const key = `${ad.side}-${ad.crypto}-${ad.fiat}`;
    let engine = this.smartEngines.get(key);

    if (!engine) {
      engine = new OkxSmartEngine(ad.side, {
        myNickName: process.env.OKX_MY_NICKNAME,
      });
      this.smartEngines.set(key, engine);
    }

    // Update config each cycle from per-ad DB config
    engine.updateConfig({
      undercutCents: adConfig.undercutCents,
      matchPrice: adConfig.matchPrice,
      minMonthOrderCount: adConfig.smartMinOrderCount,
      minSurplusAmount: adConfig.smartMinSurplus,
      ignoredAdvertisers: this.dbConfig?.ignoredAdvertisers ?? [],
      minPrice: ad.side === 'sell' ? (adConfig.minPrice ?? null) : undefined,
      maxPrice: ad.side === 'buy' ? (adConfig.maxPrice ?? null) : undefined,
    });

    return engine;
  }

  private getFollowEngine(ad: TrackedAd, adConfig: AssetPositioningConfig): OkxFollowEngine {
    const key = `${ad.side}-${ad.crypto}-${ad.fiat}`;
    let engine = this.followEngines.get(key);

    if (!engine) {
      engine = new OkxFollowEngine(ad.side, {
        targetNickName: adConfig.followTarget || '',
        undercutCents: adConfig.undercutCents,
        matchPrice: adConfig.matchPrice,
        minPrice: ad.side === 'sell' ? (adConfig.minPrice ?? null) : undefined,
        maxPrice: ad.side === 'buy' ? (adConfig.maxPrice ?? null) : undefined,
      });
      this.followEngines.set(key, engine);
    }

    engine.updateConfig({
      targetNickName: adConfig.followTarget || '',
      undercutCents: adConfig.undercutCents,
      matchPrice: adConfig.matchPrice,
      minPrice: ad.side === 'sell' ? (adConfig.minPrice ?? null) : undefined,
      maxPrice: ad.side === 'buy' ? (adConfig.maxPrice ?? null) : undefined,
    });

    return engine;
  }

  // ==================== STATUS ====================

  getStatus(): OkxPositioningStatus {
    const ads = Array.from(this.trackedAds.values());
    // Use first ad's config for status display
    const firstAd = ads[0];
    const adConfig = firstAd ? this.getAdConfig(firstAd) : null;

    return {
      isRunning: this.isRunning,
      mode: adConfig?.mode || 'smart',
      followTarget: adConfig?.followTarget || null,
      undercutCents: adConfig?.undercutCents || 1,
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

export function createOkxPositioning(): OkxPositioning {
  return new OkxPositioning();
}
