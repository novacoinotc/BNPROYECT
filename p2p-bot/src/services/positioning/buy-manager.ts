// =====================================================
// BUY AD MANAGER - Manages only BUY ads independently
// =====================================================

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import { FollowEngine, FollowConfig } from './follow-engine.js';
import { SmartEngine, SmartConfig } from './smart-engine.js';
import { getBotConfig } from '../database-pg.js';

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

    if (Array.isArray(data.data)) {
      allAds.push(...data.data);
    } else if (data.data?.buyList) {
      allAds.push(...data.data.buyList);
    }

    // Filter only online BUY ads
    return allAds
      .filter(ad => ad.tradeType === 'BUY' && ad.advStatus === 1)
      .map(ad => ({
        advNo: ad.advNo,
        asset: ad.asset,
        fiat: ad.fiatUnit,
        currentPrice: parseFloat(ad.price),
        lastUpdate: null,
      }));
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

export class BuyAdManager extends EventEmitter {
  private ads: Map<string, BuyAd> = new Map();
  private followEngine: FollowEngine;
  private smartEngine: SmartEngine;
  private config: BuyManagerConfig;
  private interval: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor() {
    super();
    this.config = {
      mode: 'smart',
      followTarget: null,
      undercutCents: 1,
      smartConfig: {},
    };
    this.followEngine = new FollowEngine('BUY', {
      targetNickName: '',
      undercutCents: 1,
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
      const oldMode = this.config.mode;
      const oldTarget = this.config.followTarget;

      // BUY ads use separate config fields (can be added to DB later)
      // For now, use same config as SELL
      this.config.mode = (dbConfig.positioningMode as 'follow' | 'smart') || 'smart';
      this.config.followTarget = dbConfig.followTargetNickName || null;
      this.config.undercutCents = dbConfig.undercutCents || 1;

      // Update engines
      this.followEngine.updateConfig({
        targetNickName: this.config.followTarget || '',
        undercutCents: this.config.undercutCents,
      });

      this.smartEngine.updateConfig({
        minUserGrade: dbConfig.smartMinUserGrade,
        minMonthFinishRate: dbConfig.smartMinFinishRate,
        minMonthOrderCount: dbConfig.smartMinOrderCount,
        minPositiveRate: dbConfig.smartMinPositiveRate,
        requireOnline: dbConfig.smartRequireOnline,
        minSurplusAmount: dbConfig.smartMinSurplus,
        undercutCents: dbConfig.undercutCents,
      });

      if (oldMode !== this.config.mode) {
        logger.info(`📋 [BUY] Modo: ${oldMode} → ${this.config.mode}`);
      }
      if (oldTarget !== this.config.followTarget && this.config.mode === 'follow') {
        logger.info(`📋 [BUY] Siguiendo: ${this.config.followTarget}`);
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

  private async updateAd(ad: BuyAd): Promise<void> {
    let targetPrice: number | null = null;
    let logInfo = '';

    // Try follow mode first
    if (this.config.mode === 'follow' && this.config.followTarget) {
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
