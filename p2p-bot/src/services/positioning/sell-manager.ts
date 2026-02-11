// =====================================================
// SELL AD MANAGER - Manages only SELL ads independently
// =====================================================

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import { FollowEngine, FollowConfig } from './follow-engine.js';
import { SmartEngine, SmartConfig } from './smart-engine.js';
import { getBotConfig, getPositioningConfigForAd, BotConfig } from '../database-pg.js';
import { fetchSellAds as fetchSellAdsApi, updateAdPrice as updateAdPriceApi, AdInfo } from '../binance-api.js';

interface SellAd {
  advNo: string;
  asset: string;
  fiat: string;
  currentPrice: number;
  lastUpdate: Date | null;
}

interface SellManagerConfig {
  mode: 'follow' | 'smart';
  followTarget: string | null;
  undercutCents: number;
  matchPrice: boolean;
  smartConfig: Partial<SmartConfig>;
}

// Wrapper functions using shared API helper with proxy support
async function fetchSellAds(): Promise<SellAd[]> {
  const ads = await fetchSellAdsApi();
  return ads.map(ad => ({
    advNo: ad.advNo,
    asset: ad.asset,
    fiat: ad.fiat,
    currentPrice: ad.currentPrice,
    lastUpdate: null,
  }));
}

async function updateAdPrice(advNo: string, price: number): Promise<boolean> {
  const result = await updateAdPriceApi(advNo, price);
  if (result.success) {
    logger.info(`✅ [SELL] API Update OK: advNo=${advNo} → $${(Math.round(price * 100) / 100).toFixed(2)}`);
  } else {
    logger.warn({
      advNo,
      price,
      binanceCode: result.code,
      binanceMsg: result.message,
    }, `⚠️ [SELL] API Update FAILED: [${result.code || 'NO_CODE'}] ${result.message || 'Unknown error'}`);
  }
  return result.success;
}

export class SellAdManager extends EventEmitter {
  private ads: Map<string, SellAd> = new Map();
  private followEngine: FollowEngine;
  private smartEngine: SmartEngine;
  private config: SellManagerConfig;
  private dbConfig: BotConfig | null = null;
  private interval: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor() {
    super();
    this.config = {
      mode: 'smart',
      followTarget: null,
      undercutCents: 1,
      matchPrice: false,
      smartConfig: {},
    };
    this.followEngine = new FollowEngine('SELL', {
      targetNickName: '',
      undercutCents: 1,
      matchPrice: false,
    });
    this.smartEngine = new SmartEngine('SELL');
  }

  async start(intervalMs: number = 5000): Promise<void> {
    await this.loadConfig();
    await this.discoverAds();

    this.isRunning = true;

    if (this.ads.size === 0) {
      logger.info('⏳ [SELL] No active SELL ads found - will keep checking for new ads');
    } else {
      logger.info(`🚀 [SELL] Managing ${this.ads.size} SELL ads, modo ${this.config.mode}${this.config.followTarget ? ` → ${this.config.followTarget}` : ''}`);
    }

    // Always start the interval - ads may come online later
    await this.runCycle();
    this.interval = setInterval(() => this.runCycle(), intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    logger.info('🛑 [SELL] Stopped');
  }

  private async loadConfig(): Promise<void> {
    try {
      const dbConfig = await getBotConfig();
      this.dbConfig = dbConfig;
      const oldMode = this.config.mode;
      const oldTarget = this.config.followTarget;

      // Log merchant ID for debugging config loading
      logger.debug({
        merchantId: process.env.MERCHANT_ID || 'NOT_SET',
        sellMode: dbConfig.sellMode,
        sellFollowTarget: dbConfig.sellFollowTarget,
        hasPositioningConfigs: Object.keys(dbConfig.positioningConfigs || {}).length,
      }, '📋 [SELL] Config loaded');

      // Use SELL-specific config as defaults (sellMode, sellFollowTarget)
      this.config.mode = (dbConfig.sellMode as 'follow' | 'smart') || 'smart';
      this.config.followTarget = dbConfig.sellFollowTarget || null;
      this.config.undercutCents = dbConfig.undercutCents || 1;
      this.config.matchPrice = dbConfig.matchPrice ?? false;

      // Update smart engine shared config
      this.smartEngine.updateConfig({
        minMonthOrderCount: dbConfig.smartMinOrderCount,
        minSurplusAmount: dbConfig.smartMinSurplus,
        undercutCents: dbConfig.undercutCents,
        matchPrice: this.config.matchPrice,
        myNickName: process.env.BINANCE_MY_NICKNAME || undefined,
        ignoredAdvertisers: dbConfig.ignoredAdvertisers || [],
      });

      // Update follow engine with ignored advertisers
      this.followEngine.updateConfig({
        ignoredAdvertisers: dbConfig.ignoredAdvertisers || [],
      });

      if (oldMode !== this.config.mode) {
        logger.info(`📋 [SELL] Modo default: ${oldMode} → ${this.config.mode}`);
      }
      if (oldTarget !== this.config.followTarget && this.config.mode === 'follow') {
        logger.info(`📋 [SELL] Siguiendo default: ${this.config.followTarget}`);
      }
    } catch (error: any) {
      // Silent error
    }
  }

  private async discoverAds(): Promise<void> {
    const sellAds = await fetchSellAds();
    const activeAdvNos = new Set(sellAds.map(ad => ad.advNo));

    // Remove inactive
    for (const advNo of this.ads.keys()) {
      if (!activeAdvNos.has(advNo)) {
        this.ads.delete(advNo);
      }
    }

    // Add or update
    for (const ad of sellAds) {
      const existing = this.ads.get(ad.advNo);
      if (existing) {
        // Only log if price changed significantly
        if (Math.abs(existing.currentPrice - ad.currentPrice) >= 0.01) {
          logger.info(`🔄 [SELL] ${ad.asset} price changed: $${existing.currentPrice.toFixed(2)} → $${ad.currentPrice.toFixed(2)}`);
        }
        existing.currentPrice = ad.currentPrice;
      } else {
        logger.info(`📌 [SELL] Discovered ad: ${ad.asset} @ ${ad.currentPrice.toFixed(2)}`);
        this.ads.set(ad.advNo, ad);
      }
    }
  }

  private async runCycle(): Promise<void> {
    await this.loadConfig();
    await this.discoverAds();

    for (const [advNo, ad] of this.ads) {
      try {
        await this.updateAd(ad);
      } catch {
        // Silent error
      }
      await new Promise(r => setTimeout(r, 200));
    }
  }

  private async updateAd(ad: SellAd): Promise<void> {
    // Get per-asset config (or fallback to defaults)
    const assetConfig = this.dbConfig
      ? getPositioningConfigForAd(this.dbConfig, 'SELL', ad.asset)
      : { enabled: true, mode: this.config.mode, followTarget: this.config.followTarget, matchPrice: this.config.matchPrice, undercutCents: this.config.undercutCents, minPrice: null, smartMinOrderCount: 10, smartMinSurplus: 100 };

    // Skip if this asset is disabled (silent - no log spam)
    if (assetConfig.enabled === false) {
      return;
    }

    // Log config at debug level
    logger.debug(`🔧 [SELL] ${ad.asset}: mode=${assetConfig.mode}, target=${assetConfig.followTarget || 'N/A'}`);

    let targetPrice: number | null = null;
    let logInfo = '';

    // Follow mode - if target not found, keep current price (NO automatic fallback to smart)
    if (assetConfig.mode === 'follow' && assetConfig.followTarget) {
      // Update follow engine with per-asset config (including per-asset price strategy and floor)
      this.followEngine.updateConfig({
        targetNickName: assetConfig.followTarget,
        undercutCents: assetConfig.undercutCents,
        matchPrice: assetConfig.matchPrice,
        minPrice: assetConfig.minPrice,  // Price floor
      });
      const result = await this.followEngine.getPrice(ad.asset, ad.fiat);
      if (result?.success) {
        targetPrice = result.targetPrice;
        logInfo = `siguiendo ${result.targetNickName}@${result.targetFoundPrice}`;
        if (assetConfig.minPrice && targetPrice <= assetConfig.minPrice) {
          logInfo += ` [piso: $${assetConfig.minPrice}]`;
        }
      } else {
        // Target not found - keep current price, don't switch to smart mode
        logger.warn(`⚠️ [SELL] ${ad.asset}: Target "${assetConfig.followTarget}" no encontrado/offline - manteniendo precio actual $${ad.currentPrice.toFixed(2)}`);
        return; // Exit without changing price
      }
    }

    // Smart mode - only if explicitly configured as smart (not as fallback)
    if (assetConfig.mode === 'smart') {
      // Update smart engine with per-asset config (price strategy + smart filters + floor)
      this.smartEngine.updateConfig({
        undercutCents: assetConfig.undercutCents,
        matchPrice: assetConfig.matchPrice,
        minPrice: assetConfig.minPrice,  // Price floor
        minMonthOrderCount: assetConfig.smartMinOrderCount,
        minSurplusAmount: assetConfig.smartMinSurplus,
      });
      const result = await this.smartEngine.getPrice(ad.asset, ad.fiat);
      if (result?.success) {
        targetPrice = result.targetPrice;
        logInfo = `smart (${result.qualifiedCount} calificados)`;
        if (assetConfig.minPrice && targetPrice <= assetConfig.minPrice) {
          logInfo += ` [piso: $${assetConfig.minPrice}]`;
        }
      }
    }

    if (targetPrice === null) {
      logger.warn(`⚠️ [SELL] ${ad.asset}: No se pudo calcular precio objetivo`);
      return;
    }

    // Check if update needed (diff >= 0.01)
    // Round to 2 decimals to avoid floating point errors (e.g., 17.74-17.73=0.00999... instead of 0.01)
    const diff = Math.round(Math.abs(ad.currentPrice - targetPrice) * 100) / 100;
    if (diff < 0.01) {
      logger.debug(`✓ [SELL] ${ad.asset}: Sin cambio (actual=${ad.currentPrice.toFixed(2)}, target=${targetPrice.toFixed(2)}, diff=${diff.toFixed(2)})`);
      return;
    }

    // Update price
    const success = await updateAdPrice(ad.advNo, targetPrice);
    if (success) {
      logger.info(`💰 [SELL] ${ad.asset} ${ad.currentPrice.toFixed(2)} → ${targetPrice.toFixed(2)} (${logInfo})`);
      ad.currentPrice = targetPrice;
      ad.lastUpdate = new Date();
      this.emit('priceUpdated', { advNo: ad.advNo, asset: ad.asset, oldPrice: ad.currentPrice, newPrice: targetPrice });
    }
  }

  getStatus() {
    return {
      type: 'SELL' as const,
      isRunning: this.isRunning,
      mode: this.config.mode,
      followTarget: this.config.followTarget,
      ads: Array.from(this.ads.values()),
    };
  }
}

export function createSellAdManager(): SellAdManager {
  return new SellAdManager();
}
