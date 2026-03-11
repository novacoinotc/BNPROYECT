// =====================================================
// BYBIT MULTI-AD POSITIONING COORDINATOR
// Manages positioning for all active Bybit ads
// Unlike OKX, Bybit keeps the same ad ID after updates
// =====================================================

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import { getBotConfig } from '../../services/database-pg.js';
import { BybitClient, getBybitClient } from './bybit-client.js';
import { BybitAdManager } from './bybit-ad-manager.js';
import { BybitSmartEngine, BybitSmartConfig } from './bybit-smart-engine.js';
import { BybitFollowEngine, BybitFollowConfig } from './bybit-follow-engine.js';
import { BybitMyAd } from './bybit-types.js';

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

  // Config from DB
  private currentMode = 'smart';
  private followTarget: string | null = null;
  private undercutCents = 1;
  private priceFloor: number | null = null;
  private priceCeiling: number | null = null;

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
      mode: this.currentMode,
      target: this.followTarget,
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
      const config = await getBotConfig();
      const oldMode = this.currentMode;

      this.currentMode = config.positioningMode || 'smart';
      this.followTarget = config.followTargetNickName || null;
      this.undercutCents = config.undercutCents || 1;

      // Price limits from env
      const floorEnv = process.env.BYBIT_PRICE_FLOOR;
      this.priceFloor = floorEnv ? parseFloat(floorEnv) : null;
      const ceilingEnv = process.env.BYBIT_PRICE_CEILING;
      this.priceCeiling = ceilingEnv ? parseFloat(ceilingEnv) : null;

      if (oldMode !== this.currentMode) {
        log.info({ oldMode, newMode: this.currentMode }, 'Bybit: Mode changed');
      }
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
    let targetPrice: number | null = null;

    if (this.currentMode === 'follow' && this.followTarget) {
      ad.mode = 'follow';
      const engine = this.getFollowEngine(ad);
      const result = await engine.getPrice(ad.tokenId, ad.currencyId);

      if (result) {
        targetPrice = result.targetPrice;
      } else {
        // Fallback to smart
        ad.mode = 'smart';
        const smartEngine = this.getSmartEngine(ad);
        const smartResult = await smartEngine.getPrice(ad.tokenId, ad.currencyId);
        if (smartResult) targetPrice = smartResult.targetPrice;
      }
    } else {
      ad.mode = 'smart';
      const engine = this.getSmartEngine(ad);
      const result = await engine.getPrice(ad.tokenId, ad.currencyId);
      if (result) targetPrice = result.targetPrice;
    }

    if (targetPrice === null) return;

    ad.targetPrice = targetPrice;

    // Check if update needed
    const priceDiff = Math.round(Math.abs(ad.currentPrice - targetPrice) * 100) / 100;
    if (priceDiff < this.PRICE_UPDATE_THRESHOLD) return;

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

  private getSmartEngine(ad: TrackedAd): BybitSmartEngine {
    const key = `${ad.side}-${ad.tokenId}-${ad.currencyId}`;
    let engine = this.smartEngines.get(key);

    if (!engine) {
      engine = new BybitSmartEngine(ad.side, {
        undercutCents: this.undercutCents,
        minPrice: ad.side === 'sell' ? this.priceFloor : undefined,
        maxPrice: ad.side === 'buy' ? this.priceCeiling : undefined,
        myNickName: process.env.BYBIT_MY_NICKNAME,
      });
      this.smartEngines.set(key, engine);
    }

    engine.updateConfig({
      undercutCents: this.undercutCents,
      minPrice: ad.side === 'sell' ? this.priceFloor : undefined,
      maxPrice: ad.side === 'buy' ? this.priceCeiling : undefined,
    });

    return engine;
  }

  private getFollowEngine(ad: TrackedAd): BybitFollowEngine {
    const key = `${ad.side}-${ad.tokenId}-${ad.currencyId}`;
    let engine = this.followEngines.get(key);

    if (!engine) {
      engine = new BybitFollowEngine(ad.side, {
        targetNickName: this.followTarget || '',
        undercutCents: this.undercutCents,
        matchPrice: false,
        minPrice: ad.side === 'sell' ? this.priceFloor : undefined,
        maxPrice: ad.side === 'buy' ? this.priceCeiling : undefined,
      });
      this.followEngines.set(key, engine);
    }

    engine.updateConfig({
      targetNickName: this.followTarget || '',
      undercutCents: this.undercutCents,
      minPrice: ad.side === 'sell' ? this.priceFloor : undefined,
      maxPrice: ad.side === 'buy' ? this.priceCeiling : undefined,
    });

    return engine;
  }

  // ==================== STATUS ====================

  getStatus(): BybitPositioningStatus {
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

export function createBybitPositioning(): BybitPositioning {
  return new BybitPositioning();
}
