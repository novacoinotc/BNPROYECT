// =====================================================
// MULTI-AD POSITIONING MANAGER
// Handles positioning for ALL active ads simultaneously
// =====================================================

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import { getBinanceClient } from './binance-client.js';
import { SmartPositioning, createSmartPositioning } from './smart-positioning.js';
import { TradeType, PriceType, SmartPositioningConfig } from '../types/binance.js';

// ==================== TYPES ====================

interface AdInfo {
  advNo: string;
  tradeType: 'BUY' | 'SELL';
  asset: string;
  fiatUnit: string;
  price: string;
  advStatus: number; // 1=online, 4=offline
  surplusAmount: string;
}

interface ManagedAd {
  advNo: string;
  tradeType: 'BUY' | 'SELL';
  asset: string;
  fiat: string;
  currentPrice: number;
  lastUpdate: Date | null;
  updateCount: number;
  errorCount: number;
}

export interface MultiAdStatus {
  isRunning: boolean;
  managedAds: ManagedAd[];
  totalUpdates: number;
  totalErrors: number;
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
    // Use POST /listWithPagination which works correctly
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
    if (data.data?.sellList) {
      allAds.push(...data.data.sellList);
      if (data.data.buyList) allAds.push(...data.data.buyList);
    } else if (Array.isArray(data.data)) {
      allAds.push(...data.data);
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
  private updateInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private fiat: string = 'MXN';

  // Threshold for price updates (0.01% = $0.01 on $100)
  private readonly PRICE_UPDATE_THRESHOLD = 0.0001;

  constructor(smartConfig?: Partial<SmartPositioningConfig>) {
    super();
    this.smartPositioning = createSmartPositioning(smartConfig);
  }

  /**
   * Start managing all active ads
   */
  async start(fiat: string = 'MXN', intervalMs: number = 5000): Promise<void> {
    this.fiat = fiat;

    // Discover all active ads
    await this.discoverActiveAds();

    if (this.managedAds.size === 0) {
      logger.warn('⚠️ [MULTI-AD] No active ads found. Nothing to manage.');
      return;
    }

    this.isRunning = true;

    logger.info({
      adCount: this.managedAds.size,
      ads: Array.from(this.managedAds.values()).map(a => ({
        advNo: a.advNo.slice(-6),
        type: a.tradeType,
        asset: a.asset,
        price: a.currentPrice,
      })),
    }, '🚀 [MULTI-AD] Started positioning for all active ads');

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
   * Discover and register all active ads
   */
  private async discoverActiveAds(): Promise<void> {
    const allAds = await fetchAllAds();

    // Filter only online ads
    const activeAds = allAds.filter(ad => ad.advStatus === 1);

    // Clear and repopulate managed ads
    this.managedAds.clear();

    for (const ad of activeAds) {
      this.managedAds.set(ad.advNo, {
        advNo: ad.advNo,
        tradeType: ad.tradeType as 'BUY' | 'SELL',
        asset: ad.asset,
        fiat: ad.fiatUnit,
        currentPrice: parseFloat(ad.price),
        lastUpdate: null,
        updateCount: 0,
        errorCount: 0,
      });
    }

    logger.info({
      total: allAds.length,
      active: activeAds.length,
      assets: [...new Set(activeAds.map(a => a.asset))],
    }, '🔍 [MULTI-AD] Discovered ads');
  }

  /**
   * Run a single update cycle for all managed ads
   */
  private async runUpdateCycle(): Promise<void> {
    // First, refresh the list of active ads (in case user activated/deactivated)
    await this.discoverActiveAds();

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
   * Update a single ad's price
   */
  private async updateSingleAd(ad: ManagedAd): Promise<void> {
    // Determine search type (inverse of ad type)
    // SELL ad → search BUY (other sellers)
    // BUY ad → search SELL (other buyers)
    const searchType = ad.tradeType === 'SELL' ? TradeType.BUY : TradeType.SELL;

    // Get recommended price from smart positioning
    const analysis = await this.smartPositioning.getRecommendedPrice(
      ad.asset,
      ad.fiat,
      searchType
    );

    if (!analysis) {
      return; // No recommendation available
    }

    // Check if price should be updated
    const priceDiff = Math.abs(ad.currentPrice - analysis.targetPrice);
    const threshold = ad.currentPrice * this.PRICE_UPDATE_THRESHOLD;
    const shouldUpdate = priceDiff > threshold || ad.currentPrice === 0;

    if (shouldUpdate) {
      const success = await updateAdPrice(ad.advNo, analysis.targetPrice);

      if (success) {
        const oldPrice = ad.currentPrice;
        ad.currentPrice = analysis.targetPrice;
        ad.lastUpdate = new Date();
        ad.updateCount++;

        // Only log when price actually changes
        logger.info({
          asset: ad.asset,
          type: ad.tradeType,
          oldPrice: oldPrice.toFixed(2),
          newPrice: analysis.targetPrice.toFixed(2),
          margin: `${analysis.marginPercent.toFixed(2)}%`,
        }, '💰 [MULTI-AD] Price updated');

        this.emit('priceUpdated', {
          advNo: ad.advNo,
          asset: ad.asset,
          tradeType: ad.tradeType,
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
      managedAds,
      totalUpdates: managedAds.reduce((sum, ad) => sum + ad.updateCount, 0),
      totalErrors: managedAds.reduce((sum, ad) => sum + ad.errorCount, 0),
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
export function createMultiAdPositioningManager(
  smartConfig?: Partial<SmartPositioningConfig>
): MultiAdPositioningManager {
  return new MultiAdPositioningManager(smartConfig);
}
