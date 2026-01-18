// =====================================================
// SELL AD MANAGER - Manages only SELL ads independently
// =====================================================

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import { FollowEngine, FollowConfig } from './follow-engine.js';
import { SmartEngine, SmartConfig } from './smart-engine.js';
import { getBotConfig, getPositioningConfigForAd, BotConfig } from '../database-pg.js';

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

// API helpers
function signQuery(query: string): string {
  const secret = process.env.BINANCE_API_SECRET || '';
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

async function fetchSellAds(): Promise<SellAd[]> {
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

    if (Array.isArray(data.data)) {
      allAds.push(...data.data);
    } else if (data.data?.sellList) {
      allAds.push(...data.data.sellList);
    }

    // Filter only online SELL ads
    return allAds
      .filter(ad => ad.tradeType === 'SELL' && ad.advStatus === 1)
      .map(ad => ({
        advNo: ad.advNo,
        asset: ad.asset,
        fiat: ad.fiatUnit,
        currentPrice: parseFloat(ad.price),
        lastUpdate: null,
      }));
  } catch (error: any) {
    logger.error(`❌ [SELL] Error fetching ads: ${error.message}`);
    return [];
  }
}

async function updateAdPrice(advNo: string, price: number): Promise<boolean> {
  const apiKey = process.env.BINANCE_API_KEY || '';
  const roundedPrice = Math.round(price * 100) / 100;
  const ts = Date.now();
  const query = `timestamp=${ts}`;

  try {
    const res = await fetch(
      `https://api.binance.com/sapi/v1/c2c/ads/update?${query}&signature=${signQuery(query)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MBX-APIKEY': apiKey },
        body: JSON.stringify({ advNo, price: roundedPrice }),
      }
    );

    const data = await res.json() as any;
    return data.success === true || data.code === '000000';
  } catch {
    return false;
  }
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

    if (this.ads.size === 0) {
      logger.warn('⚠️ [SELL] No active SELL ads found');
      return;
    }

    this.isRunning = true;
    logger.info(`🚀 [SELL] Managing ${this.ads.size} SELL ads, modo ${this.config.mode}${this.config.followTarget ? ` → ${this.config.followTarget}` : ''}`);

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

      // Use SELL-specific config as defaults (sellMode, sellFollowTarget)
      this.config.mode = (dbConfig.sellMode as 'follow' | 'smart') || 'smart';
      this.config.followTarget = dbConfig.sellFollowTarget || null;
      this.config.undercutCents = dbConfig.undercutCents || 1;
      this.config.matchPrice = dbConfig.matchPrice ?? false;

      // Update smart engine shared config
      this.smartEngine.updateConfig({
        minUserGrade: dbConfig.smartMinUserGrade,
        minMonthFinishRate: dbConfig.smartMinFinishRate,
        minMonthOrderCount: dbConfig.smartMinOrderCount,
        minPositiveRate: dbConfig.smartMinPositiveRate,
        requireOnline: dbConfig.smartRequireOnline,
        minSurplusAmount: dbConfig.smartMinSurplus,
        undercutCents: dbConfig.undercutCents,
        matchPrice: this.config.matchPrice,
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
        existing.currentPrice = ad.currentPrice;
      } else {
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
    let targetPrice: number | null = null;
    let logInfo = '';

    // Get per-asset config (or fallback to defaults)
    const assetConfig = this.dbConfig
      ? getPositioningConfigForAd(this.dbConfig, 'SELL', ad.asset)
      : { mode: this.config.mode, followTarget: this.config.followTarget };

    // Try follow mode first
    if (assetConfig.mode === 'follow' && assetConfig.followTarget) {
      // Update follow engine with per-asset target
      this.followEngine.updateConfig({
        targetNickName: assetConfig.followTarget,
        undercutCents: this.config.undercutCents,
        matchPrice: this.config.matchPrice,
      });
      const result = await this.followEngine.getPrice(ad.asset, ad.fiat);
      if (result?.success) {
        targetPrice = result.targetPrice;
        logInfo = `siguiendo ${result.targetNickName}@${result.targetFoundPrice}`;
      }
    }

    // Fallback to smart mode
    if (targetPrice === null) {
      const result = await this.smartEngine.getPrice(ad.asset, ad.fiat);
      if (result?.success) {
        targetPrice = result.targetPrice;
        logInfo = `smart (${result.qualifiedCount} calificados)`;
      }
    }

    if (targetPrice === null) return;

    // Check if update needed (diff >= 0.01)
    const diff = Math.abs(ad.currentPrice - targetPrice);
    if (diff < 0.01) return;

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
