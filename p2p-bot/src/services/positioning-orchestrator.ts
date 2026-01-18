// =====================================================
// POSITIONING ORCHESTRATOR
// Coordinates Smart and Follow positioning modes
// Handles automatic price updates
// =====================================================

import { EventEmitter } from 'events';
import { getBinanceClient, BinanceC2CClient } from './binance-client.js';
import { SmartPositioning, createSmartPositioning } from './smart-positioning.js';
import { FollowPositioning, createFollowPositioning } from './follow-positioning.js';
import { updateBotLastActive } from './database-pg.js';
import { logger } from '../utils/logger.js';
import {
  TradeType,
  PriceType,
  SmartPositioningConfig,
  FollowModeConfig,
  PositioningAnalysis,
} from '../types/binance.js';

export type PositioningMode = 'smart' | 'follow' | 'manual' | 'off';

export interface PositioningStatus {
  mode: PositioningMode;
  isRunning: boolean;
  currentPrice: number;
  lastAnalysis: PositioningAnalysis | null;
  lastUpdateTime: Date | null;
  updateCount: number;
  errorCount: number;
}

export interface PositioningEvent {
  type: 'price_updated' | 'price_unchanged' | 'mode_changed' | 'error' | 'target_lost' | 'fallback_activated';
  mode: PositioningMode;
  analysis?: PositioningAnalysis;
  error?: string;
  oldPrice?: number;
  newPrice?: number;
}

export class PositioningOrchestrator extends EventEmitter {
  private client: BinanceC2CClient;
  private smartPositioning: SmartPositioning;
  private followPositioning: FollowPositioning;

  private mode: PositioningMode = 'off';
  private currentPrice: number = 0;
  private lastAnalysis: PositioningAnalysis | null = null;
  private lastUpdateTime: Date | null = null;
  private updateCount: number = 0;
  private errorCount: number = 0;

  private updateInterval: NodeJS.Timeout | null = null;
  private advNo: string = '';
  private asset: string = 'USDT';
  private fiat: string = 'MXN';
  private tradeType: TradeType = TradeType.SELL;

  // Threshold for price updates (0.01% = $0.01 on $100)
  private readonly PRICE_UPDATE_THRESHOLD = 0.0001;

  constructor(
    smartConfig?: Partial<SmartPositioningConfig>,
    followConfig?: Partial<FollowModeConfig>
  ) {
    super();
    this.client = getBinanceClient();
    this.smartPositioning = createSmartPositioning(smartConfig);
    this.followPositioning = createFollowPositioning(followConfig);

    // Determine initial mode (silent - mode will be set by integration)
    this.mode = 'off';
  }

  /**
   * Start automatic positioning updates
   * @param intervalMs - Override interval in milliseconds (default: 5000 = 5 seconds)
   */
  start(
    advNo: string,
    asset: string = 'USDT',
    fiat: string = 'MXN',
    tradeType: TradeType = TradeType.SELL,
    intervalMs: number = 5000 // Default 5 seconds for fast market checks
  ): void {
    if (this.mode === 'off') {
      return; // Silent - no warning
    }

    this.advNo = advNo;
    this.asset = asset;
    this.fiat = fiat;
    this.tradeType = tradeType;

    // Stop any existing interval
    this.stop();

    // Log only once when starting (not every check)
    logger.info({ mode: this.mode, intervalMs }, '🎯 [POSITIONING] Started');

    // Initial update
    this.runUpdate();

    // Schedule periodic updates (silent)
    this.updateInterval = setInterval(() => this.runUpdate(), intervalMs);
  }

  /**
   * Stop automatic positioning updates
   */
  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      logger.info('🎯 [POSITIONING] Stopped');
    }
  }

  /**
   * Run a single positioning update (SILENT - only logs on price change)
   */
  private async runUpdate(): Promise<void> {
    try {
      let analysis: PositioningAnalysis | null = null;

      if (this.mode === 'follow') {
        const followConfig = this.followPositioning.getConfig();
        logger.debug({
          mode: 'follow',
          enabled: followConfig.enabled,
          target: followConfig.targetNickName,
        }, '🎯 [POSITIONING] Running follow update');

        // Try follow mode first
        analysis = await this.followPositioning.getRecommendedPrice(
          this.asset,
          this.fiat,
          this.tradeType
        );

        // If target not found and fallback enabled, switch to smart
        if (!analysis && this.followPositioning.shouldFallbackToSmart()) {
          logger.info('🎯 [POSITIONING] Target not found, falling back to smart mode');
          this.emit('positioning', {
            type: 'fallback_activated',
            mode: 'smart',
          } as PositioningEvent);

          analysis = await this.smartPositioning.getRecommendedPrice(
            this.asset,
            this.fiat,
            this.tradeType
          );

          if (analysis) {
            analysis.mode = 'smart'; // Mark as fallback
          }
        } else if (!analysis) {
          // Target not found and no fallback - log this!
          const lastTarget = this.followPositioning.getLastTargetInfo();
          logger.warn({
            targetNickName: followConfig.targetNickName,
            lastTargetInfo: lastTarget,
          }, '🎯 [POSITIONING] Target not found in market');
          this.emit('positioning', {
            type: 'target_lost',
            mode: 'follow',
          } as PositioningEvent);
          this.errorCount++;
          return;
        }
      } else if (this.mode === 'smart') {
        analysis = await this.smartPositioning.getRecommendedPrice(
          this.asset,
          this.fiat,
          this.tradeType
        );
      } else if (this.mode === 'manual') {
        // Manual mode - don't update automatically
        return;
      }

      if (!analysis) {
        return; // Silent - no analysis result
      }

      // Set current price in analysis
      analysis.currentPrice = this.currentPrice;

      // Check if price should be updated
      const priceDiff = Math.abs(this.currentPrice - analysis.targetPrice);
      const threshold = this.currentPrice * this.PRICE_UPDATE_THRESHOLD;
      const shouldUpdate = priceDiff > threshold || this.currentPrice === 0;

      if (shouldUpdate) {
        // Update the ad price
        await this.updateAdPrice(analysis.targetPrice);

        const oldPrice = this.currentPrice;
        this.currentPrice = analysis.targetPrice;
        analysis.priceChanged = true;

        // Update last active timestamp in database
        updateBotLastActive('positioning').catch(() => {});

        // ONLY LOG WHEN PRICE ACTUALLY CHANGES
        logger.info({
          mode: analysis.mode,
          oldPrice: oldPrice.toFixed(2),
          newPrice: analysis.targetPrice.toFixed(2),
          margin: `${analysis.marginPercent.toFixed(2)}%`,
          competitors: analysis.qualifiedCompetitors,
        }, '💰 [POSITIONING] Price changed');

        this.emit('positioning', {
          type: 'price_updated',
          mode: this.mode,
          analysis,
          oldPrice,
          newPrice: analysis.targetPrice,
        } as PositioningEvent);
      } else {
        // Silent - no log when price unchanged
        this.emit('positioning', {
          type: 'price_unchanged',
          mode: this.mode,
          analysis,
        } as PositioningEvent);
      }

      this.lastAnalysis = analysis;
      this.lastUpdateTime = new Date();
      this.updateCount++;

    } catch (error) {
      this.errorCount++;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Only log errors every 10th occurrence to reduce noise
      if (this.errorCount % 10 === 1) {
        logger.error({
          error: errorMessage,
          mode: this.mode,
          errorCount: this.errorCount,
        }, '❌ [POSITIONING] Update error');
      }

      this.emit('positioning', {
        type: 'error',
        mode: this.mode,
        error: errorMessage,
      } as PositioningEvent);
    }
  }

  /**
   * Update the ad price via Binance API
   */
  private async updateAdPrice(price: number): Promise<void> {
    await this.client.updateAd({
      advNo: this.advNo,
      price,
      priceType: PriceType.FIXED,
    });
  }

  /**
   * Set positioning mode
   */
  setMode(mode: PositioningMode): void {
    const oldMode = this.mode;
    this.mode = mode;

    // Only log if mode actually changed
    if (oldMode !== mode) {
      logger.info({ oldMode, newMode: mode }, '🎯 [POSITIONING] Mode changed');
    }

    this.emit('positioning', {
      type: 'mode_changed',
      mode,
    } as PositioningEvent);

    // If running, restart with new interval
    if (this.updateInterval) {
      this.stop();
      this.start(this.advNo, this.asset, this.fiat, this.tradeType);
    }
  }

  /**
   * Set manual price (stops auto updates)
   */
  async setManualPrice(price: number): Promise<void> {
    this.mode = 'manual';
    this.stop();

    await this.updateAdPrice(price);
    this.currentPrice = price;

    logger.info({ price: price.toFixed(2) }, '✋ [POSITIONING] Manual price set');
  }

  /**
   * Force immediate update
   */
  async forceUpdate(): Promise<void> {
    await this.runUpdate();
  }

  /**
   * Get current status
   */
  getStatus(): PositioningStatus {
    return {
      mode: this.mode,
      isRunning: this.updateInterval !== null,
      currentPrice: this.currentPrice,
      lastAnalysis: this.lastAnalysis,
      lastUpdateTime: this.lastUpdateTime,
      updateCount: this.updateCount,
      errorCount: this.errorCount,
    };
  }

  /**
   * Get qualified competitors (for dashboard)
   */
  async getQualifiedCompetitors() {
    return this.smartPositioning.getQualifiedCompetitors(
      this.asset,
      this.fiat,
      this.tradeType
    );
  }

  /**
   * Update smart positioning config
   */
  updateSmartConfig(config: Partial<SmartPositioningConfig>): void {
    this.smartPositioning.updateConfig(config);
  }

  /**
   * Update follow positioning config
   */
  updateFollowConfig(config: Partial<FollowModeConfig>): void {
    this.followPositioning.updateConfig(config);
  }

  /**
   * Get current configs
   */
  getConfigs() {
    return {
      smart: this.smartPositioning.getConfig(),
      follow: this.followPositioning.getConfig(),
    };
  }

  /**
   * Set follow target
   */
  setFollowTarget(nickName?: string, userNo?: string): void {
    this.followPositioning.setTarget(nickName, userNo);
  }
}

// Factory function
export function createPositioningOrchestrator(
  smartConfig?: Partial<SmartPositioningConfig>,
  followConfig?: Partial<FollowModeConfig>
): PositioningOrchestrator {
  return new PositioningOrchestrator(smartConfig, followConfig);
}
