// =====================================================
// AUTO-SWAP MANAGER
// Polls Funding + Spot balances, transfers Funding→Spot,
// then market-sells crypto to USDT automatically.
// =====================================================

import { EventEmitter } from 'events';
import { getBinanceClient, BinanceC2CClient } from './binance-client.js';
import { logger } from '../utils/logger.js';
import {
  saveSwapRecord,
  updateSwapRecord,
  getSwapRecords,
  SwapRecord,
} from './database-pg.js';

// ==================== INTERFACES ====================

export interface AutoSwapConfig {
  assets: string[];          // e.g. ['BTC', 'ETH', 'BNB', 'SOL', 'XRP']
  pollIntervalMs: number;    // default 15000
  minSwapUsdt: number;       // minimum notional to swap (default 5)
  dustThreshold: number;     // skip if value < this (default 1)
}

interface LotSizeInfo {
  minQty: number;
  maxQty: number;
  stepSize: number;
}

// ==================== AUTO-SWAP MANAGER ====================

export class AutoSwapManager extends EventEmitter {
  private client: BinanceC2CClient;
  private config: AutoSwapConfig;
  private isRunning = false;
  private isPolling = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private lotSizeCache = new Map<string, LotSizeInfo>();
  private consecutiveErrors = 0;
  private readonly maxConsecutiveErrors = 5;
  private totalSwaps = 0;
  private totalReceivedUsdt = 0;
  private totalTransfers = 0;

  constructor(config?: Partial<AutoSwapConfig>) {
    super();
    this.client = getBinanceClient();

    const assetsEnv = process.env.AUTO_SWAP_ASSETS || 'BTC,USDC,BNB,ETH,FDUSD,DOGE,WLD,ADA,XRP,TRUMP,SOL';
    this.config = {
      assets: assetsEnv.split(',').map(a => a.trim().toUpperCase()).filter(Boolean),
      pollIntervalMs: parseInt(process.env.AUTO_SWAP_POLL_INTERVAL_MS || '30000'),
      minSwapUsdt: parseFloat(process.env.AUTO_SWAP_MIN_USDT || '5'),
      dustThreshold: parseFloat(process.env.AUTO_SWAP_DUST_THRESHOLD || '1'),
      ...config,
    };
  }

  // ==================== LIFECYCLE ====================

  async start(): Promise<void> {
    if (this.isRunning) return;

    logger.info({
      assets: this.config.assets,
      pollInterval: this.config.pollIntervalMs,
      minSwapUsdt: this.config.minSwapUsdt,
      dustThreshold: this.config.dustThreshold,
    }, '[AUTO-SWAP] Module starting');

    // Pre-load lot sizes for all configured assets
    await this.loadLotSizes();

    this.isRunning = true;
    logger.info('[AUTO-SWAP] Module started');

    // First poll immediately
    await this.pollAndSwap();

    // Then schedule interval
    this.pollInterval = setInterval(() => this.pollAndSwap(), this.config.pollIntervalMs);
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    logger.info('[AUTO-SWAP] Module stopped');
  }

  getStatus(): {
    isRunning: boolean;
    assets: string[];
    pollIntervalMs: number;
    minSwapUsdt: number;
    dustThreshold: number;
    totalSwaps: number;
    totalReceivedUsdt: number;
    totalTransfers: number;
    consecutiveErrors: number;
    cachedSymbols: string[];
  } {
    return {
      isRunning: this.isRunning,
      assets: this.config.assets,
      pollIntervalMs: this.config.pollIntervalMs,
      minSwapUsdt: this.config.minSwapUsdt,
      dustThreshold: this.config.dustThreshold,
      totalSwaps: this.totalSwaps,
      totalReceivedUsdt: this.totalReceivedUsdt,
      totalTransfers: this.totalTransfers,
      consecutiveErrors: this.consecutiveErrors,
      cachedSymbols: Array.from(this.lotSizeCache.keys()),
    };
  }

  async getRecentSwaps(limit: number = 50): Promise<SwapRecord[]> {
    return getSwapRecords(limit);
  }

  async getSpotBalances(): Promise<{ asset: string; free: string; locked: string }[]> {
    const allBalances = await this.client.getSpotBalances();
    return allBalances.filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
  }

  // ==================== LOT SIZE ====================

  private async loadLotSizes(): Promise<void> {
    for (const asset of this.config.assets) {
      // USDC/FDUSD swap to USDT via their own pair, not *USDT
      const symbol = this.getSymbol(asset);
      if (!symbol) continue; // stablecoins that don't need lot size

      try {
        const info = await this.client.getExchangeInfo(symbol);
        const lotFilter = info.filters.find(f => f.filterType === 'LOT_SIZE');
        if (lotFilter && lotFilter.minQty && lotFilter.stepSize) {
          this.lotSizeCache.set(symbol, {
            minQty: parseFloat(lotFilter.minQty),
            maxQty: parseFloat(lotFilter.maxQty || '999999999'),
            stepSize: parseFloat(lotFilter.stepSize),
          });
          logger.debug({ symbol, minQty: lotFilter.minQty, stepSize: lotFilter.stepSize }, '[AUTO-SWAP] Lot size cached');
        }
      } catch (error: any) {
        logger.warn({ symbol, error: error?.message }, '[AUTO-SWAP] Failed to load lot size — will skip this asset');
      }
    }

    logger.info({
      cached: Array.from(this.lotSizeCache.keys()),
    }, '[AUTO-SWAP] Lot sizes loaded');
  }

  /**
   * Get the trading symbol for an asset.
   * Most assets trade as ASSETUSDT, but stablecoins use specific pairs.
   * USDC → USDCUSDT (sell USDC, receive USDT)
   * FDUSD → FDUSDUSDT (sell FDUSD, receive USDT)
   */
  private getSymbol(asset: string): string | null {
    // USDT itself doesn't need swapping
    if (asset === 'USDT') return null;
    // All others trade against USDT
    return `${asset}USDT`;
  }

  /**
   * Adjust quantity to lot size constraints.
   * Returns null if adjusted qty is below minQty.
   *
   * Uses integer math to avoid floating-point precision bugs:
   * e.g. Math.floor(0.3 / 0.1) = 2 (not 3!) due to IEEE 754
   */
  private adjustToLotSize(quantity: number, lotSize: LotSizeInfo): string | null {
    const { minQty, stepSize } = lotSize;

    // Determine decimal precision from stepSize string
    const stepStr = stepSize.toString();
    const decimalIndex = stepStr.indexOf('.');
    const precision = decimalIndex === -1 ? 0 : stepStr.length - decimalIndex - 1;

    // Scale to integers to avoid floating-point division bugs
    const scale = Math.pow(10, precision);
    const scaledQty = Math.floor(quantity * scale + 0.5e-9); // tiny epsilon for float noise
    const scaledStep = Math.round(stepSize * scale);
    const scaledMin = Math.round(minQty * scale);

    const adjusted = Math.floor(scaledQty / scaledStep) * scaledStep;

    if (adjusted < scaledMin) return null;

    return (adjusted / scale).toFixed(precision);
  }

  // ==================== FUNDING → SPOT TRANSFER ====================

  /**
   * Check funding wallet and transfer any configured assets to spot.
   * Returns a map of asset → amount transferred.
   */
  private async transferFundingToSpot(): Promise<Map<string, number>> {
    const transferred = new Map<string, number>();

    try {
      const fundingBalances = await this.client.getFundingBalances();

      for (const asset of this.config.assets) {
        // USDT doesn't need swapping but we still transfer it to Spot
        // so it's available for trading
        const balance = fundingBalances.find(b => b.asset === asset);
        if (!balance) continue;

        const freeNum = parseFloat(balance.free);
        if (freeNum <= 0) continue;

        // Transfer full free balance from Funding → Spot
        // Use original string from API to preserve decimal precision
        try {
          await this.client.walletTransfer(asset, balance.free, 'FUNDING_MAIN');
          transferred.set(asset, freeNum);
          this.totalTransfers++;

          logger.info({
            asset, amount: balance.free,
          }, '[AUTO-SWAP] Transferred Funding → Spot');
        } catch (transferError: any) {
          const errorMsg = transferError?.response?.data?.msg || transferError?.message || '';
          // Ignore "no need to transfer" type errors (already in spot, or zero balance race)
          if (!errorMsg.includes('You don') && !errorMsg.includes('The amount')) {
            logger.error({
              asset, amount: balance.free, error: errorMsg,
            }, '[AUTO-SWAP] Funding → Spot transfer failed');
          }
        }
      }
    } catch (error: any) {
      logger.error({ error: error?.message }, '[AUTO-SWAP] Failed to fetch funding balances');
    }

    return transferred;
  }

  // ==================== POLL & SWAP ====================

  async pollAndSwap(): Promise<void> {
    if (this.isPolling) return; // Prevent overlap
    this.isPolling = true;

    try {
      // Circuit breaker: skip if too many consecutive errors
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        logger.warn({
          consecutiveErrors: this.consecutiveErrors,
        }, '[AUTO-SWAP] Circuit breaker active — skipping poll (will retry next interval)');
        // Reset after one skip to retry
        this.consecutiveErrors = 0;
        return;
      }

      // Step 1: Transfer any crypto from Funding → Spot
      const transferred = await this.transferFundingToSpot();
      if (transferred.size > 0) {
        // Small delay to let Binance process the internal transfer
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Step 2: Get all spot balances
      const balances = await this.client.getSpotBalances();

      // Step 3: Process each configured asset
      for (const asset of this.config.assets) {
        const symbol = this.getSymbol(asset);
        if (!symbol) continue; // Skip USDT

        const balance = balances.find(b => b.asset === asset);
        if (!balance) continue;

        const free = parseFloat(balance.free);
        if (free <= 0) continue;

        // Check lot size cache
        const lotSize = this.lotSizeCache.get(symbol);
        if (!lotSize) {
          logger.debug({ asset, symbol }, '[AUTO-SWAP] No lot size info — skipping');
          continue;
        }

        try {
          // Get current price
          const price = await this.client.getTickerPrice(symbol);
          const priceNum = parseFloat(price);
          const valueUsdt = free * priceNum;

          // Skip dust
          if (valueUsdt < this.config.dustThreshold) continue;

          // Skip below minimum
          if (valueUsdt < this.config.minSwapUsdt) {
            logger.debug({
              asset, free, valueUsdt, minSwapUsdt: this.config.minSwapUsdt,
            }, '[AUTO-SWAP] Below min swap threshold — skipping');
            continue;
          }

          // Adjust to lot size
          const adjustedQty = this.adjustToLotSize(free, lotSize);
          if (!adjustedQty) {
            logger.debug({ asset, free, minQty: lotSize.minQty }, '[AUTO-SWAP] Adjusted qty below minQty — skipping');
            continue;
          }

          const estimatedUsdt = (parseFloat(adjustedQty) * priceNum).toFixed(2);

          logger.info({
            asset, symbol, quantity: adjustedQty, estimatedUsdt, price,
          }, '[AUTO-SWAP] Swapping crypto to USDT');

          // Save pending record
          const record = await saveSwapRecord({
            asset,
            symbol,
            quantity: adjustedQty,
            estimatedUsdt,
          });

          // Execute market sell
          try {
            const result = await this.client.spotMarketSell(symbol, adjustedQty);

            const receivedUsdt = result.cummulativeQuoteQty;
            const executedQty = result.executedQty;
            const avgPrice = parseFloat(executedQty) > 0
              ? (parseFloat(receivedUsdt) / parseFloat(executedQty)).toFixed(6)
              : '0';

            await updateSwapRecord(record.id, {
              status: 'COMPLETED',
              executedQty,
              receivedUsdt,
              avgPrice,
              binanceOrderId: String(result.orderId),
              completedAt: new Date(),
            });

            this.totalSwaps++;
            this.totalReceivedUsdt += parseFloat(receivedUsdt);

            logger.info({
              asset, symbol, executedQty, receivedUsdt, avgPrice,
              orderId: result.orderId,
            }, '[AUTO-SWAP] Swap completed');

            // Step 7: Transfer USDT back to Funding wallet for P2P selling
            try {
              await this.client.walletTransfer('USDT', receivedUsdt, 'MAIN_FUNDING');
              logger.info({
                amount: receivedUsdt,
              }, '[AUTO-SWAP] USDT transferred Spot → Funding (ready for P2P)');
            } catch (fundingError: any) {
              // Non-critical — USDT stays in Spot, can be moved manually
              logger.warn({
                amount: receivedUsdt,
                error: fundingError?.response?.data?.msg || fundingError?.message,
              }, '[AUTO-SWAP] Spot → Funding transfer failed (USDT remains in Spot)');
            }

            this.emit('swap', {
              type: 'completed',
              asset,
              symbol,
              executedQty,
              receivedUsdt,
              avgPrice,
            });
          } catch (orderError: any) {
            const errorMsg = orderError?.response?.data?.msg || orderError?.message || 'Unknown error';

            await updateSwapRecord(record.id, {
              status: 'FAILED',
              error: errorMsg,
              completedAt: new Date(),
            });

            logger.error({
              asset, symbol, quantity: adjustedQty, error: errorMsg,
            }, '[AUTO-SWAP] Market sell failed');

            this.emit('swap', {
              type: 'failed',
              asset,
              symbol,
              error: errorMsg,
            });
          }
        } catch (assetError: any) {
          logger.error({
            asset, error: assetError?.message,
          }, '[AUTO-SWAP] Error processing asset');
        }
      }

      // Reset consecutive errors on successful poll
      this.consecutiveErrors = 0;
    } catch (error: any) {
      this.consecutiveErrors++;
      logger.error({
        error: error?.message,
        consecutiveErrors: this.consecutiveErrors,
      }, '[AUTO-SWAP] Poll error');
    } finally {
      this.isPolling = false;
    }
  }
}

// ==================== FACTORY ====================

export function createAutoSwapManager(config?: Partial<AutoSwapConfig>): AutoSwapManager {
  return new AutoSwapManager(config);
}
