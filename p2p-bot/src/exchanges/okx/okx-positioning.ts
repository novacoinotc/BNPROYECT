// =====================================================
// OKX MULTI-AD POSITIONING COORDINATOR
// Manages positioning for all active OKX ads
// Handles OKX's ad ID change on update
// =====================================================

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import { getBotConfig, BotConfig } from '../../services/database-pg.js';
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
  targetPrice: number | null;
  lastUpdate: Date | null;
  updateCount: number;
  errorCount: number;
  mode: 'smart' | 'follow' | 'idle';
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
  private smartEngines: Map<string, OkxSmartEngine> = new Map(); // key: "side-crypto-fiat"
  private followEngines: Map<string, OkxFollowEngine> = new Map();
  private trackedAds: Map<string, TrackedAd> = new Map();
  private updateInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  // Config from DB
  private currentMode = 'smart';
  private followTarget: string | null = null;
  private undercutCents = 1;
  private spotPriceCeiling: number | null = null; // For BUY ads
  private spotPriceFloor: number | null = null;   // For SELL ads

  private readonly PRICE_UPDATE_THRESHOLD = 0.01;

  constructor() {
    super();
    this.adManager = createOkxAdManager();
  }

  // ==================== LIFECYCLE ====================

  async start(intervalMs: number = 12000): Promise<void> {
    // Load config
    await this.loadConfig();

    // Discover active ads
    await this.discoverActiveAds();

    if (this.trackedAds.size === 0) {
      log.warn('OKX Positioning: No active ads found');
      return;
    }

    this.isRunning = true;
    log.info({
      adCount: this.trackedAds.size,
      mode: this.currentMode,
      target: this.followTarget,
    }, 'OKX Positioning started');

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
    log.info('OKX Positioning stopped');
  }

  // ==================== CONFIG ====================

  private async loadConfig(): Promise<void> {
    try {
      const config = await getBotConfig();
      const oldMode = this.currentMode;

      this.currentMode = config.positioningMode || 'smart';
      this.followTarget = config.followTargetNickName || null;
      this.undercutCents = config.undercutCents || 1;

      // Load spot price limits from env
      const floorEnv = process.env.OKX_PRICE_FLOOR;
      this.spotPriceFloor = floorEnv ? parseFloat(floorEnv) : null;

      if (oldMode !== this.currentMode) {
        log.info({ oldMode, newMode: this.currentMode }, 'OKX: Mode changed');
      }
    } catch (error: any) {
      log.error({ error: error.message }, 'OKX: Failed to load config');
    }
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
      } else {
        this.trackedAds.set(ad.adId, {
          adId: ad.adId,
          side: ad.side,
          crypto: ad.crypto,
          fiat: ad.fiat,
          currentPrice: ad.currentPrice,
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
          log.error({ adId, error: error.message }, 'OKX: Error updating ad');
        }
      }

      // Delay between ads
      await new Promise(r => setTimeout(r, 200));
    }
  }

  private async updateSingleAd(ad: TrackedAd): Promise<void> {
    let targetPrice: number | null = null;

    if (this.currentMode === 'follow' && this.followTarget) {
      ad.mode = 'follow';
      const engine = this.getFollowEngine(ad);
      const result = await engine.getPrice(ad.crypto, ad.fiat);

      if (result) {
        targetPrice = result.targetPrice;
      } else {
        // Fallback to smart
        ad.mode = 'smart';
        const smartEngine = this.getSmartEngine(ad);
        const smartResult = await smartEngine.getPrice(ad.crypto, ad.fiat);
        if (smartResult) targetPrice = smartResult.targetPrice;
      }
    } else {
      ad.mode = 'smart';
      const engine = this.getSmartEngine(ad);
      const result = await engine.getPrice(ad.crypto, ad.fiat);
      if (result) targetPrice = result.targetPrice;
    }

    if (targetPrice === null) return;

    ad.targetPrice = targetPrice;

    // Check if update needed
    const priceDiff = Math.round(Math.abs(ad.currentPrice - targetPrice) * 100) / 100;
    if (priceDiff < this.PRICE_UPDATE_THRESHOLD) return;

    // Execute update
    const result = await this.adManager.updateAdPrice(ad.adId, targetPrice);

    if (result) {
      const oldPrice = ad.currentPrice;
      const oldAdId = ad.adId;

      // CRITICAL: OKX creates new ad on update — track new ID
      if (result.newAdId && result.newAdId !== oldAdId) {
        // Remove old tracking, add new
        this.trackedAds.delete(oldAdId);
        ad.adId = result.newAdId;
        this.trackedAds.set(result.newAdId, ad);
        log.debug({ oldAdId, newAdId: result.newAdId }, 'OKX: Ad ID changed after update');
      }

      ad.currentPrice = targetPrice;
      ad.lastUpdate = new Date();
      ad.updateCount++;

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

  private getSmartEngine(ad: TrackedAd): OkxSmartEngine {
    const key = `${ad.side}-${ad.crypto}-${ad.fiat}`;
    let engine = this.smartEngines.get(key);

    if (!engine) {
      engine = new OkxSmartEngine(ad.side, {
        undercutCents: this.undercutCents,
        minPrice: ad.side === 'sell' ? this.spotPriceFloor : undefined,
        maxPrice: ad.side === 'buy' ? this.spotPriceCeiling : undefined,
        myNickName: process.env.OKX_MY_NICKNAME,
      });
      this.smartEngines.set(key, engine);
    }

    // Update config each cycle
    engine.updateConfig({
      undercutCents: this.undercutCents,
      minPrice: ad.side === 'sell' ? this.spotPriceFloor : undefined,
      maxPrice: ad.side === 'buy' ? this.spotPriceCeiling : undefined,
    });

    return engine;
  }

  private getFollowEngine(ad: TrackedAd): OkxFollowEngine {
    const key = `${ad.side}-${ad.crypto}-${ad.fiat}`;
    let engine = this.followEngines.get(key);

    if (!engine) {
      engine = new OkxFollowEngine(ad.side, {
        targetNickName: this.followTarget || '',
        undercutCents: this.undercutCents,
        matchPrice: false,
        minPrice: ad.side === 'sell' ? this.spotPriceFloor : undefined,
        maxPrice: ad.side === 'buy' ? this.spotPriceCeiling : undefined,
      });
      this.followEngines.set(key, engine);
    }

    engine.updateConfig({
      targetNickName: this.followTarget || '',
      undercutCents: this.undercutCents,
      minPrice: ad.side === 'sell' ? this.spotPriceFloor : undefined,
      maxPrice: ad.side === 'buy' ? this.spotPriceCeiling : undefined,
    });

    return engine;
  }

  // ==================== STATUS ====================

  getStatus(): OkxPositioningStatus {
    const ads = Array.from(this.trackedAds.values());
    return {
      isRunning: this.isRunning,
      mode: this.currentMode,
      followTarget: this.followTarget,
      undercutCents: this.undercutCents,
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
