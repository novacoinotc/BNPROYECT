// =====================================================
// MULTI-AD POSITIONING MANAGER
// Handles positioning for ALL active ads simultaneously
// Respects dashboard config (smart/follow mode)
// =====================================================

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import { getBinanceClient } from './binance-client.js';
import { SmartPositioning, createSmartPositioning } from './smart-positioning.js';
import { FollowPositioning, createFollowPositioning } from './follow-positioning.js';
import { getBotConfig, BotConfig } from './database-pg.js';
import { TradeType, SmartPositioningConfig, FollowModeConfig, PositioningAnalysis } from '../types/binance.js';

// ==================== TYPES ====================

interface AdInfo {
  advNo: string;
  tradeType: 'BUY' | 'SELL';
  asset: string;
  fiatUnit: string;
  price: string;
  advStatus: number; // 1=online, 3=paused, 4=offline
  surplusAmount: string;
}

export interface ManagedAd {
  advNo: string;
  tradeType: 'BUY' | 'SELL';
  asset: string;
  fiat: string;
  currentPrice: number;
  targetPrice: number | null;
  lastUpdate: Date | null;
  updateCount: number;
  errorCount: number;
  mode: 'smart' | 'follow' | 'idle';
  followTarget: string | null;
}

export interface MultiAdStatus {
  isRunning: boolean;
  mode: string;
  followTarget: string | null;
  undercutCents: number;
  managedAds: ManagedAd[];
  totalUpdates: number;
  totalErrors: number;
  lastConfigCheck: Date | null;
}

// ==================== API HELPERS ====================

function signQuery(query: string): string {
  const secret = process.env.BINANCE_API_SECRET || '';
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

async function fetchAllAds(): Promise<AdInfo[]> {
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
    const allAds: AdInfo[] = [];

    // Handle different response formats
    if (Array.isArray(data.data)) {
      allAds.push(...data.data);
    } else if (data.data?.sellList) {
      allAds.push(...data.data.sellList);
      if (data.data.buyList) allAds.push(...data.data.buyList);
    }

    return allAds;
  } catch (error: any) {
    logger.error({ error: error.message }, '❌ [MULTI-AD] Failed to fetch ads');
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
  } catch (error: any) {
    logger.error({ advNo, error: error.message }, '❌ [MULTI-AD] Failed to update price');
    return false;
  }
}

// ==================== MULTI-AD MANAGER ====================

export class MultiAdPositioningManager extends EventEmitter {
  private managedAds: Map<string, ManagedAd> = new Map();
  private smartPositioning: SmartPositioning;
  private followPositioning: FollowPositioning;
  private updateInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private fiat: string = 'MXN';

  // Current config from database
  private currentMode: string = 'smart';
  private followTarget: string | null = null;
  private undercutCents: number = 1;
  private lastConfigCheck: Date | null = null;

  // Threshold for price updates (0.01 MXN)
  private readonly PRICE_UPDATE_THRESHOLD = 0.01;

  constructor() {
    super();
    this.smartPositioning = createSmartPositioning();
    this.followPositioning = createFollowPositioning();
  }

  /**
   * Start managing all active ads
   */
  async start(fiat: string = 'MXN', intervalMs: number = 5000): Promise<void> {
    this.fiat = fiat;

    // Load config from database
    await this.loadConfig();

    // Discover all active ads
    await this.discoverActiveAds();

    if (this.managedAds.size === 0) {
      logger.warn('⚠️ [MULTI-AD] No active ads found. Nothing to manage.');
      return;
    }

    this.isRunning = true;

    logger.info({
      adCount: this.managedAds.size,
      mode: this.currentMode,
      followTarget: this.followTarget,
      undercutCents: this.undercutCents,
      ads: Array.from(this.managedAds.values()).map(a => ({
        advNo: a.advNo.slice(-6),
        type: a.tradeType,
        asset: a.asset,
        price: a.currentPrice,
      })),
    }, '🚀 [MULTI-AD] Started positioning');

    // Run initial update
    await this.runUpdateCycle();

    // Schedule periodic updates
    this.updateInterval = setInterval(() => this.runUpdateCycle(), intervalMs);
  }

  /**
   * Stop managing ads
   */
  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    this.isRunning = false;
    logger.info('🛑 [MULTI-AD] Stopped');
  }

  /**
   * Load configuration from database
   */
  private async loadConfig(): Promise<void> {
    try {
      const config = await getBotConfig();
      const oldMode = this.currentMode;
      const oldTarget = this.followTarget;

      this.currentMode = config.positioningMode || 'smart';
      this.followTarget = config.followTargetNickName || null;
      this.undercutCents = config.undercutCents || 1;
      this.lastConfigCheck = new Date();

      // Update follow positioning config
      // Use very wide margins for follow mode to allow tracking target price closely
      this.followPositioning.updateConfig({
        enabled: this.currentMode === 'follow',
        targetNickName: this.followTarget || '',
        undercutAmount: this.undercutCents,
        followStrategy: 'undercut',
        fallbackToSmart: true,
        minMargin: -5, // Allow 5% below reference price
        maxMargin: 10, // Allow 10% above reference price
      });

      // Update smart positioning config from DB
      // Map BotConfig property names to SmartPositioningConfig names
      this.smartPositioning.updateConfig({
        minUserGrade: config.smartMinUserGrade,
        minMonthFinishRate: config.smartMinFinishRate,
        minMonthOrderCount: config.smartMinOrderCount,
        minPositiveRate: config.smartMinPositiveRate,
        requireOnline: config.smartRequireOnline,
        minSurplusAmount: config.smartMinSurplus,
        undercutAmount: config.undercutCents,
      });

      // Only log if config changed
      if (oldMode !== this.currentMode || oldTarget !== this.followTarget) {
        logger.info(
          `📋 [CONFIG] Mode: ${this.currentMode}, Target: ${this.followTarget || 'none'}, Undercut: ${this.undercutCents}¢`
        );
      }
    } catch (error: any) {
      logger.error({ error: error.message }, '[MULTI-AD] Failed to load config');
    }
  }

  /**
   * Discover and register all active ads
   */
  private async discoverActiveAds(): Promise<void> {
    const allAds = await fetchAllAds();

    // Filter only online ads (advStatus === 1)
    const activeAds = allAds.filter(ad => ad.advStatus === 1);

    // Update existing or add new, remove deactivated
    const activeAdvNos = new Set(activeAds.map(ad => ad.advNo));

    // Remove ads that are no longer active
    for (const advNo of this.managedAds.keys()) {
      if (!activeAdvNos.has(advNo)) {
        this.managedAds.delete(advNo);
      }
    }

    // Add or update active ads
    for (const ad of activeAds) {
      const existing = this.managedAds.get(ad.advNo);
      if (existing) {
        // Update current price if changed externally
        existing.currentPrice = parseFloat(ad.price);
      } else {
        // New ad
        this.managedAds.set(ad.advNo, {
          advNo: ad.advNo,
          tradeType: ad.tradeType as 'BUY' | 'SELL',
          asset: ad.asset,
          fiat: ad.fiatUnit,
          currentPrice: parseFloat(ad.price),
          targetPrice: null,
          lastUpdate: null,
          updateCount: 0,
          errorCount: 0,
          mode: 'idle',
          followTarget: null,
        });
      }
    }
  }

  /**
   * Run a single update cycle for all managed ads
   */
  private async runUpdateCycle(): Promise<void> {
    // Reload config from database each cycle
    await this.loadConfig();

    // Refresh the list of active ads
    await this.discoverActiveAds();

    if (this.managedAds.size === 0) {
      return;
    }

    // Update each managed ad
    for (const [advNo, ad] of this.managedAds) {
      try {
        await this.updateSingleAd(ad);
      } catch (error: any) {
        ad.errorCount++;
        if (ad.errorCount % 10 === 1) {
          logger.error({
            advNo: advNo.slice(-6),
            asset: ad.asset,
            error: error.message,
          }, '❌ [MULTI-AD] Update error');
        }
      }

      // Small delay between ads to avoid rate limits
      await new Promise(r => setTimeout(r, 200));
    }
  }

  /**
   * Update a single ad's price based on current mode
   */
  private async updateSingleAd(ad: ManagedAd): Promise<void> {
    // Binance API uses CLIENT perspective for tradeType:
    // - tradeType: BUY in request → returns SELL ads (merchants who SELL)
    // - tradeType: SELL in request → returns BUY ads (merchants who BUY)
    //
    // So to find competitors:
    // - Our SELL ad → search with BUY → finds other sellers
    // - Our BUY ad → search with SELL → finds other buyers
    const searchType = ad.tradeType === 'SELL' ? TradeType.BUY : TradeType.SELL;

    let analysis: PositioningAnalysis | null = null;

    // Use the mode from dashboard config
    if (this.currentMode === 'follow' && this.followTarget) {
      // Follow mode - track specific seller
      ad.mode = 'follow';
      ad.followTarget = this.followTarget;

      analysis = await this.followPositioning.getRecommendedPrice(
        ad.asset,
        ad.fiat,
        searchType
      );

      // If target not found, fallback to smart
      if (!analysis) {
        logger.warn({
          target: this.followTarget,
          asset: ad.asset,
        }, '⚠️ [FOLLOW] Target NOT FOUND - using SMART mode');

        analysis = await this.smartPositioning.getRecommendedPrice(
          ad.asset,
          ad.fiat,
          searchType
        );
        ad.mode = 'smart'; // Mark as fallback
      }
    } else {
      // Smart mode - use algorithm
      ad.mode = 'smart';
      ad.followTarget = null;

      analysis = await this.smartPositioning.getRecommendedPrice(
        ad.asset,
        ad.fiat,
        searchType
      );
    }

    if (!analysis) {
      logger.warn({ asset: ad.asset, mode: ad.mode }, '❌ [MULTI-AD] No analysis returned');
      return;
    }

    ad.targetPrice = analysis.targetPrice;

    // Check if price should be updated (more than 1 centavo difference)
    const priceDiff = Math.abs(ad.currentPrice - analysis.targetPrice);
    const shouldUpdate = priceDiff >= this.PRICE_UPDATE_THRESHOLD;

    // Log price status - show mode and key info
    if (ad.mode === 'follow' && analysis.targetInfo) {
      logger.info(
        `🎯 [FOLLOW] ${analysis.targetInfo.nickName}@${analysis.targetInfo.price} → ` +
        `Tu precio: ${ad.currentPrice} → Target: ${analysis.targetPrice.toFixed(2)} ` +
        `(diff: ${priceDiff.toFixed(2)}, update: ${shouldUpdate})`
      );
    } else {
      logger.info(
        `🧠 [SMART] Best: ${analysis.bestQualifiedPrice} → ` +
        `Tu precio: ${ad.currentPrice} → Target: ${analysis.targetPrice.toFixed(2)} ` +
        `(diff: ${priceDiff.toFixed(2)}, update: ${shouldUpdate})`
      );
    }

    if (shouldUpdate) {
      const success = await updateAdPrice(ad.advNo, analysis.targetPrice);

      if (success) {
        const oldPrice = ad.currentPrice;
        ad.currentPrice = analysis.targetPrice;
        ad.lastUpdate = new Date();
        ad.updateCount++;

        // Log price change with mode info
        logger.info({
          asset: ad.asset,
          type: ad.tradeType,
          mode: ad.mode,
          target: ad.followTarget,
          oldPrice: oldPrice.toFixed(2),
          newPrice: analysis.targetPrice.toFixed(2),
          diff: (analysis.targetPrice - oldPrice).toFixed(2),
        }, '💰 [MULTI-AD] Price updated');

        this.emit('priceUpdated', {
          advNo: ad.advNo,
          asset: ad.asset,
          tradeType: ad.tradeType,
          mode: ad.mode,
          oldPrice,
          newPrice: analysis.targetPrice,
        });
      } else {
        ad.errorCount++;
      }
    }
  }

  /**
   * Force refresh of all ads
   */
  async refresh(): Promise<void> {
    await this.loadConfig();
    await this.discoverActiveAds();
    await this.runUpdateCycle();
  }

  /**
   * Get current status
   */
  getStatus(): MultiAdStatus {
    const managedAds = Array.from(this.managedAds.values());
    return {
      isRunning: this.isRunning,
      mode: this.currentMode,
      followTarget: this.followTarget,
      undercutCents: this.undercutCents,
      managedAds,
      totalUpdates: managedAds.reduce((sum, ad) => sum + ad.updateCount, 0),
      totalErrors: managedAds.reduce((sum, ad) => sum + ad.errorCount, 0),
      lastConfigCheck: this.lastConfigCheck,
    };
  }

  /**
   * Get list of managed ads (for dashboard)
   */
  getManagedAds(): ManagedAd[] {
    return Array.from(this.managedAds.values());
  }
}

// Factory function
export function createMultiAdPositioningManager(): MultiAdPositioningManager {
  return new MultiAdPositioningManager();
}
