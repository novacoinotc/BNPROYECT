// =====================================================
// BUY AD MANAGER - Manages only BUY ads independently
// Includes spot price ceiling from Bitso to prevent overpaying
// =====================================================

import { EventEmitter } from 'events';
import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { FollowEngine, FollowConfig } from './follow-engine.js';
import { SmartEngine, SmartConfig } from './smart-engine.js';
import { getBotConfig, getPositioningConfigForAd, BotConfig } from '../database-pg.js';
import { fetchBuyAds as fetchBuyAdsApi, updateAdPrice as updateAdPriceApi, AdInfo } from '../binance-api.js';
import { getBinanceClient } from '../binance-client.js';

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

// Bitso book name mapping (assets that have direct MXN pairs on Bitso)
const BITSO_MXN_BOOKS: Record<string, string> = {
  BTC: 'btc_mxn',
  ETH: 'eth_mxn',
  XRP: 'xrp_mxn',
  SOL: 'sol_mxn',
  LTC: 'ltc_mxn',
  USDT: 'usdt_mxn',
  BAT: 'bat_mxn',
  MANA: 'mana_mxn',
  TRX: 'trx_mxn',
  AVAX: 'avax_mxn',
};

// Wrapper functions using shared API helper with proxy support
async function fetchBuyAds(): Promise<BuyAd[]> {
  const ads = await fetchBuyAdsApi();
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
    logger.info(`✅ [BUY] API Update OK: advNo=${advNo} → $${(Math.round(price * 100) / 100).toFixed(2)}`);
  } else {
    logger.warn({
      advNo,
      price,
      binanceCode: result.code,
      binanceMsg: result.message,
    }, `⚠️ [BUY] API Update FAILED: [${result.code || 'NO_CODE'}] ${result.message || 'Unknown error'}`);
  }
  return result.success;
}

export class BuyAdManager extends EventEmitter {
  private ads: Map<string, BuyAd> = new Map();
  private followEngine: FollowEngine;
  private smartEngine: SmartEngine;
  private config: BuyManagerConfig;
  private dbConfig: BotConfig | null = null;
  private interval: NodeJS.Timeout | null = null;
  private isRunning = false;
  // Spot ceiling cache: asset → { price, timestamp }
  private spotCeilingCache = new Map<string, { price: number; ts: number }>();
  private readonly spotCacheTtlMs = 30000; // 30s cache

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

    this.isRunning = true;

    if (this.ads.size === 0) {
      logger.info('⏳ [BUY] No active BUY ads found - will keep checking for new ads');
    } else {
      logger.info(`🚀 [BUY] Managing ${this.ads.size} BUY ads, modo ${this.config.mode}${this.config.followTarget ? ` → ${this.config.followTarget}` : ''}`);
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

  // ==================== SPOT PRICE CEILING (Bitso) ====================

  /**
   * Get spot price in MXN for an asset.
   * Uses Bitso API for direct MXN pairs (BTC, ETH, XRP, SOL, USDT).
   * For others: Binance spot crypto/USDT × Bitso USDT/MXN.
   * Cached 30s per asset to avoid hammering APIs.
   */
  private async getSpotPriceMxn(asset: string): Promise<number | null> {
    // Check cache
    const cached = this.spotCeilingCache.get(asset);
    if (cached && Date.now() - cached.ts < this.spotCacheTtlMs) {
      return cached.price;
    }

    try {
      let priceMxn: number | null = null;

      // Try direct Bitso MXN pair first
      const bitsoBook = BITSO_MXN_BOOKS[asset];
      if (bitsoBook) {
        priceMxn = await this.fetchBitsoPrice(bitsoBook);
      }

      // Fallback: crypto/USDT from Binance × USDT/MXN from Bitso
      if (priceMxn === null && asset !== 'USDT') {
        const usdtMxn = await this.getSpotPriceMxn('USDT');
        if (usdtMxn) {
          try {
            const client = getBinanceClient();
            const ticker = await client.getTickerPrice(`${asset}USDT`);
            const cryptoUsdt = parseFloat(ticker);
            if (cryptoUsdt > 0) {
              priceMxn = cryptoUsdt * usdtMxn;
            }
          } catch {
            // Ticker not available
          }
        }
      }

      if (priceMxn !== null && priceMxn > 0) {
        this.spotCeilingCache.set(asset, { price: priceMxn, ts: Date.now() });
        return priceMxn;
      }
    } catch (error: any) {
      logger.debug({ asset, error: error?.message }, '[BUY] Failed to get spot price');
    }

    // Return stale cache if fresh fetch failed
    return cached?.price ?? null;
  }

  /**
   * Fetch last price from Bitso public API
   */
  private async fetchBitsoPrice(book: string): Promise<number | null> {
    try {
      const response = await axios.get(`https://api.bitso.com/v3/ticker/?book=${book}`, {
        timeout: 5000,
      });
      const last = response.data?.payload?.last;
      if (last) {
        return parseFloat(last);
      }
    } catch {
      // Silent - will use fallback
    }
    return null;
  }

  // ==================== AD UPDATE ====================

  private async updateAd(ad: BuyAd): Promise<void> {
    // Get per-asset config (or fallback to defaults)
    const assetConfig = this.dbConfig
      ? getPositioningConfigForAd(this.dbConfig, 'BUY', ad.asset)
      : { enabled: true, mode: this.config.mode, followTarget: this.config.followTarget, matchPrice: this.config.matchPrice, undercutCents: this.config.undercutCents, minPrice: null, maxPrice: null, smartMinOrderCount: 10, smartMinSurplus: 100 };

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

    // SPOT CEILING: only for SMART mode — never buy above Bitso spot price
    // Follow mode is exempt: it trusts the target advertiser's price directly
    if (assetConfig.mode === 'smart') {
      const spotPrice = await this.getSpotPriceMxn(ad.asset);
      if (spotPrice !== null) {
        const spotCeiling = Math.round(spotPrice * 100) / 100;
        if (targetPrice > spotCeiling) {
          logger.warn(
            `🛑 [BUY] ${ad.asset}: Precio ${targetPrice.toFixed(2)} excede spot Bitso ${spotCeiling.toFixed(2)} → capado`
          );
          targetPrice = spotCeiling;
          logInfo += ` [techo spot: $${spotCeiling.toFixed(2)}]`;
        }
      }
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
