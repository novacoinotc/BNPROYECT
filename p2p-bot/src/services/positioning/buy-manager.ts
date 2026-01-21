// =====================================================
// BUY AD MANAGER - Manages only BUY ads independently
// =====================================================

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import { FollowEngine, FollowConfig } from './follow-engine.js';
import { SmartEngine, SmartConfig } from './smart-engine.js';
import { getBotConfig, getPositioningConfigForAd, BotConfig } from '../database-pg.js';

interface BuyAd {
  advNo: string;
  asset: string;
  fiat: string;
  currentPrice: number;
  lastUpdate: Date | null;
}

interface BuyManagerConfig {
  mode: 'follow' | 'smart';
  followTarget: string | null;
  undercutCents: number;
  matchPrice: boolean;
  smartConfig: Partial<SmartConfig>;
}

// API helpers
function signQuery(query: string): string {
  const secret = process.env.BINANCE_API_SECRET || '';
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

async function fetchBuyAds(): Promise<BuyAd[]> {
  const apiKey = process.env.BINANCE_API_KEY || '';
  const ts = Date.now();
  const query = `timestamp=${ts}`;

  try {
    const res = await fetch(
      `https://api.binance.com/sapi/v1/c2c/ads/listWithPagination?${query}&signature=${signQuery(query)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MBX-APIKEY': apiKey,
        },
        body: JSON.stringify({ page: 1, rows: 50 }),
      }
    );

    const text = await res.text();
    if (!text) return [];

    const data = JSON.parse(text);
    const allAds: any[] = [];

    // Handle different API response formats
    if (Array.isArray(data.data)) {
      // Direct array format
      allAds.push(...data.data);
    } else if (data.data) {
      // Object format with lists
      if (data.data.buyList) {
        allAds.push(...data.data.buyList);
      }
      if (data.data.sellList) {
        // Also check sellList in case BUY ads are mixed in
        allAds.push(...data.data.sellList);
      }
    }

    // Filter only online BUY ads (advStatus === 1)
    const filtered = allAds
      .filter(ad => ad.tradeType === 'BUY' && ad.advStatus === 1)
      .map(ad => ({
        advNo: ad.advNo,
        asset: ad.asset,
        fiat: ad.fiatUnit,
        currentPrice: parseFloat(ad.price),
        lastUpdate: null,
      }));
    return filtered;
  } catch (error: any) {
    logger.error(`❌ [BUY] Error fetching ads: ${error.message}`);
    return [];
  }
}

async function updateAdPrice(advNo: string, price: number): Promise<boolean> {
  const apiKey = process.env.BINANCE_API_KEY || '';
  const roundedPrice = Math.round(price * 100) / 100;
  const ts = Date.now();
  const query = `timestamp=${ts}`;

  const requestBody = { advNo, price: roundedPrice };

  try {
    const res = await fetch(
      `https://api.binance.com/sapi/v1/c2c/ads/update?${query}&signature=${signQuery(query)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MBX-APIKEY': apiKey },
        body: JSON.stringify(requestBody),
      }
    );

    const text = await res.text();

    if (!text) {
      logger.warn(`⚠️ [BUY] Empty API response for advNo=${advNo}`);
      return false;
    }

    const data = JSON.parse(text);
    const success = data.success === true || data.code === '000000';

    if (success) {
      logger.info(`✅ [BUY] API Update OK: advNo=${advNo} → $${roundedPrice}`);
    } else {
      logger.warn(`⚠️ [BUY] API Update FAILED: code=${data.code} msg=${data.msg || data.message || JSON.stringify(data)}`);
    }

    return success;
  } catch (error: any) {
    logger.error(`❌ [BUY] API Error: ${error.message}`);
    return false;
  }
}

export class BuyAdManager extends EventEmitter {
  private ads: Map<string, BuyAd> = new Map();
  private followEngine: FollowEngine;
  private smartEngine: SmartEngine;
  private config: BuyManagerConfig;
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
    this.followEngine = new FollowEngine('BUY', {
      targetNickName: '',
      undercutCents: 1,
      matchPrice: false,
    });
    this.smartEngine = new SmartEngine('BUY');
  }

  async start(intervalMs: number = 5000): Promise<void> {
    await this.loadConfig();
    await this.discoverAds();

    if (this.ads.size === 0) {
      logger.warn('⚠️ [BUY] No active BUY ads found');
      return;
    }

    this.isRunning = true;
    logger.info(`🚀 [BUY] Managing ${this.ads.size} BUY ads, modo ${this.config.mode}${this.config.followTarget ? ` → ${this.config.followTarget}` : ''}`);

    await this.runCycle();
    this.interval = setInterval(() => this.runCycle(), intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    logger.info('🛑 [BUY] Stopped');
  }

  private async loadConfig(): Promise<void> {
    try {
      const dbConfig = await getBotConfig();
      this.dbConfig = dbConfig;
      const oldMode = this.config.mode;
      const oldTarget = this.config.followTarget;

      // Use BUY-specific config as defaults (buyMode, buyFollowTarget)
      this.config.mode = (dbConfig.buyMode as 'follow' | 'smart') || 'smart';
      this.config.followTarget = dbConfig.buyFollowTarget || null;
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
        logger.info(`📋 [BUY] Modo default: ${oldMode} → ${this.config.mode}`);
      }
      if (oldTarget !== this.config.followTarget && this.config.mode === 'follow') {
        logger.info(`📋 [BUY] Siguiendo default: ${this.config.followTarget}`);
      }
    } catch (error: any) {
      // Silent error
    }
  }

  private async discoverAds(): Promise<void> {
    const buyAds = await fetchBuyAds();
    const activeAdvNos = new Set(buyAds.map(ad => ad.advNo));

    // Remove inactive
    for (const advNo of this.ads.keys()) {
      if (!activeAdvNos.has(advNo)) {
        this.ads.delete(advNo);
      }
    }

    // Add or update
    for (const ad of buyAds) {
      const existing = this.ads.get(ad.advNo);
      if (existing) {
        // Only log if price changed significantly
        if (Math.abs(existing.currentPrice - ad.currentPrice) >= 0.01) {
          logger.info(`🔄 [BUY] ${ad.asset} price changed: $${existing.currentPrice.toFixed(2)} → $${ad.currentPrice.toFixed(2)}`);
        }
        existing.currentPrice = ad.currentPrice;
      } else {
        logger.info(`📌 [BUY] Discovered ad: ${ad.asset} @ ${ad.currentPrice.toFixed(2)}`);
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

  private async updateAd(ad: BuyAd): Promise<void> {
    // Get per-asset config (or fallback to defaults)
    const assetConfig = this.dbConfig
      ? getPositioningConfigForAd(this.dbConfig, 'BUY', ad.asset)
      : { enabled: true, mode: this.config.mode, followTarget: this.config.followTarget, matchPrice: this.config.matchPrice, undercutCents: this.config.undercutCents, smartMinOrderCount: 10, smartMinSurplus: 100 };

    // Skip if this asset is disabled (silent - no log spam)
    if (assetConfig.enabled === false) {
      return;
    }

    // Log config only at debug level to reduce noise
    logger.debug(`🔧 [BUY] ${ad.asset}: mode=${assetConfig.mode}, target=${assetConfig.followTarget || 'N/A'}, match=${assetConfig.matchPrice}, undercut=${assetConfig.undercutCents}`);

    let targetPrice: number | null = null;
    let logInfo = '';

    // Follow mode - if target not found, keep current price (NO automatic fallback to smart)
    if (assetConfig.mode === 'follow' && assetConfig.followTarget) {
      // Update follow engine with per-asset config (including per-asset price strategy)
      this.followEngine.updateConfig({
        targetNickName: assetConfig.followTarget,
        undercutCents: assetConfig.undercutCents,
        matchPrice: assetConfig.matchPrice,
      });
      const result = await this.followEngine.getPrice(ad.asset, ad.fiat);
      if (result?.success) {
        targetPrice = result.targetPrice;
        logInfo = `siguiendo ${result.targetNickName}@${result.targetFoundPrice}`;
      } else {
        // Target not found - keep current price, don't switch to smart mode
        logger.warn(`⚠️ [BUY] ${ad.asset}: Target "${assetConfig.followTarget}" no encontrado/offline - manteniendo precio actual $${ad.currentPrice.toFixed(2)}`);
        return; // Exit without changing price
      }
    }

    // Smart mode - only if explicitly configured as smart (not as fallback)
    if (assetConfig.mode === 'smart') {
      // Update smart engine with per-asset config (price strategy + smart filters)
      this.smartEngine.updateConfig({
        undercutCents: assetConfig.undercutCents,
        matchPrice: assetConfig.matchPrice,
        minMonthOrderCount: assetConfig.smartMinOrderCount,
        minSurplusAmount: assetConfig.smartMinSurplus,
      });
      const result = await this.smartEngine.getPrice(ad.asset, ad.fiat);
      if (result?.success) {
        targetPrice = result.targetPrice;
        logInfo = `smart (${result.qualifiedCount} calificados)`;
      }
    }

    if (targetPrice === null) {
      logger.warn(`⚠️ [BUY] ${ad.asset}: No se pudo calcular precio objetivo`);
      return;
    }

    // Check if update needed (diff >= 0.01)
    // Round to 2 decimals to avoid floating point errors (e.g., 17.74-17.73=0.00999... instead of 0.01)
    const diff = Math.round(Math.abs(ad.currentPrice - targetPrice) * 100) / 100;
    if (diff < 0.01) {
      logger.debug(`✓ [BUY] ${ad.asset}: Sin cambio (actual=${ad.currentPrice.toFixed(2)}, target=${targetPrice.toFixed(2)}, diff=${diff.toFixed(2)})`);
      return;
    }

    // Update price
    const success = await updateAdPrice(ad.advNo, targetPrice);
    if (success) {
      logger.info(`💰 [BUY] ${ad.asset} ${ad.currentPrice.toFixed(2)} → ${targetPrice.toFixed(2)} (${logInfo})`);
      ad.currentPrice = targetPrice;
      ad.lastUpdate = new Date();
      this.emit('priceUpdated', { advNo: ad.advNo, asset: ad.asset, oldPrice: ad.currentPrice, newPrice: targetPrice });
    }
  }

  getStatus() {
    return {
      type: 'BUY' as const,
      isRunning: this.isRunning,
      mode: this.config.mode,
      followTarget: this.config.followTarget,
      ads: Array.from(this.ads.values()),
    };
  }
}

export function createBuyAdManager(): BuyAdManager {
  return new BuyAdManager();
}
