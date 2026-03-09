// =====================================================
// OKX AUTO-SWAP MANAGER
// Polls balances, transfers funding→trading, market sells to USDT
// Uses OKX Trading API (/api/v5/)
// =====================================================

import { EventEmitter } from 'events';
import { getOkxClient, OkxClient } from './okx-client.js';
import { OkxInstrumentInfo } from './okx-types.js';
import { logger } from '../../utils/logger.js';
import { saveSwapRecord, updateSwapRecord, getSwapRecords, SwapRecord } from '../../services/database-pg.js';

const log = logger.child({ module: 'okx-swap' });

// ==================== CONFIG ====================

export interface OkxAutoSwapConfig {
  assets: string[];
  pollIntervalMs: number;
  minSwapUsdt: number;
  dustThreshold: number;
}

interface LotSizeInfo {
  minSz: number;
  lotSz: number; // step size
}

// ==================== AUTO-SWAP ====================

export class OkxAutoSwap extends EventEmitter {
  private client: OkxClient;
  private config: OkxAutoSwapConfig;
  private isRunning = false;
  private isPolling = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private lotSizeCache = new Map<string, LotSizeInfo>();
  private consecutiveErrors = 0;
  private readonly maxConsecutiveErrors = 5;
  private totalSwaps = 0;
  private totalReceivedUsdt = 0;
  private totalTransfers = 0;

  constructor(config?: Partial<OkxAutoSwapConfig>) {
    super();
    this.client = getOkxClient();

    const assetsEnv = process.env.OKX_AUTO_SWAP_ASSETS || 'BTC,ETH,SOL';
    this.config = {
      assets: assetsEnv.split(',').map(a => a.trim().toUpperCase()).filter(Boolean),
      pollIntervalMs: parseInt(process.env.OKX_AUTO_SWAP_POLL_INTERVAL_MS || '30000'),
      minSwapUsdt: parseFloat(process.env.OKX_AUTO_SWAP_MIN_USDT || '5'),
      dustThreshold: parseFloat(process.env.OKX_AUTO_SWAP_DUST_THRESHOLD || '1'),
      ...config,
    };
  }

  // ==================== LIFECYCLE ====================

  async start(): Promise<void> {
    if (this.isRunning) return;

    log.info({
      assets: this.config.assets,
      pollInterval: this.config.pollIntervalMs,
    }, '[OKX-SWAP] Starting');

    await this.loadLotSizes();

    this.isRunning = true;
    await this.pollAndSwap();
    this.pollInterval = setInterval(() => this.pollAndSwap(), this.config.pollIntervalMs);
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    log.info('[OKX-SWAP] Stopped');
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      assets: this.config.assets,
      totalSwaps: this.totalSwaps,
      totalReceivedUsdt: this.totalReceivedUsdt,
      totalTransfers: this.totalTransfers,
      consecutiveErrors: this.consecutiveErrors,
    };
  }

  async getRecentSwaps(limit: number = 50): Promise<SwapRecord[]> {
    return getSwapRecords(limit);
  }

  // ==================== LOT SIZE ====================

  private async loadLotSizes(): Promise<void> {
    for (const asset of this.config.assets) {
      if (asset === 'USDT') continue;
      const instId = `${asset}-USDT`;

      try {
        const info = await this.client.getInstrument(instId);
        if (info) {
          this.lotSizeCache.set(instId, {
            minSz: parseFloat(info.minSz),
            lotSz: parseFloat(info.lotSz),
          });
          log.debug({ instId, minSz: info.minSz, lotSz: info.lotSz }, '[OKX-SWAP] Lot size cached');
        }
      } catch (error: any) {
        log.warn({ instId, error: error.message }, '[OKX-SWAP] Failed to load lot size');
      }
    }

    log.info({ cached: Array.from(this.lotSizeCache.keys()) }, '[OKX-SWAP] Lot sizes loaded');
  }

  private adjustToLotSize(quantity: number, lotSize: LotSizeInfo): string | null {
    const { minSz, lotSz } = lotSize;

    const lotStr = lotSz.toString();
    const decimalIndex = lotStr.indexOf('.');
    const precision = decimalIndex === -1 ? 0 : lotStr.length - decimalIndex - 1;

    const scale = Math.pow(10, precision);
    const scaledQty = Math.floor(quantity * scale + 0.5e-9);
    const scaledLot = Math.round(lotSz * scale);
    const scaledMin = Math.round(minSz * scale);

    const adjusted = Math.floor(scaledQty / scaledLot) * scaledLot;
    if (adjusted < scaledMin) return null;

    return (adjusted / scale).toFixed(precision);
  }

  // ==================== TRANSFER ====================

  private async transferFundingToTrading(): Promise<Map<string, number>> {
    const transferred = new Map<string, number>();

    try {
      for (const asset of this.config.assets) {
        if (asset === 'USDT') continue;

        const balances = await this.client.getFundingBalance(asset);
        const balance = balances.find(b => b.ccy === asset);
        if (!balance) continue;

        const available = parseFloat(balance.availBal);
        if (available <= 0) continue;

        try {
          // Transfer from funding (6) to trading (18)
          await this.client.transfer({
            ccy: asset,
            amt: balance.availBal,
            from: '6',
            to: '18',
          });
          transferred.set(asset, available);
          this.totalTransfers++;
          log.info({ asset, amount: balance.availBal }, '[OKX-SWAP] Transferred funding -> trading');
        } catch (error: any) {
          log.debug({ asset, error: error.message }, '[OKX-SWAP] Transfer failed');
        }
      }
    } catch (error: any) {
      log.error({ error: error.message }, '[OKX-SWAP] Failed to fetch funding balances');
    }

    return transferred;
  }

  // ==================== POLL & SWAP ====================

  private async pollAndSwap(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        log.warn({ errors: this.consecutiveErrors }, '[OKX-SWAP] Circuit breaker — skipping');
        this.consecutiveErrors = 0;
        return;
      }

      // Step 1: Transfer funding → trading
      const transferred = await this.transferFundingToTrading();
      if (transferred.size > 0) {
        await new Promise(r => setTimeout(r, 500));
      }

      // Step 2: Get trading account balances
      const balances = await this.client.getSpotBalance();

      // Step 3: Process each asset
      for (const asset of this.config.assets) {
        if (asset === 'USDT') continue;
        const instId = `${asset}-USDT`;

        const balance = balances.find(b => b.ccy === asset);
        if (!balance) continue;

        const free = parseFloat(balance.availBal);
        if (free <= 0) continue;

        const lotSize = this.lotSizeCache.get(instId);
        if (!lotSize) continue;

        try {
          // Get current price
          const price = await this.client.getTickerPrice(instId);
          const priceNum = parseFloat(price);
          const valueUsdt = free * priceNum;

          if (valueUsdt < this.config.dustThreshold) continue;
          if (valueUsdt < this.config.minSwapUsdt) continue;

          const adjustedQty = this.adjustToLotSize(free, lotSize);
          if (!adjustedQty) continue;

          const estimatedUsdt = (parseFloat(adjustedQty) * priceNum).toFixed(2);
          log.info({ asset, instId, quantity: adjustedQty, estimatedUsdt }, '[OKX-SWAP] Swapping');

          // Save pending record
          const record = await saveSwapRecord({
            asset,
            symbol: instId,
            quantity: adjustedQty,
            estimatedUsdt,
          });

          try {
            // Market sell
            const orderResult = await this.client.spotOrder(instId, 'sell', 'market', adjustedQty);

            // Wait briefly then get order details
            await new Promise(r => setTimeout(r, 1000));
            const orderDetail = await this.client.getSpotOrder(instId, orderResult.ordId);

            const executedQty = orderDetail?.accFillSz || adjustedQty;
            const avgPrice = orderDetail?.avgPx || price;
            const receivedUsdt = (parseFloat(executedQty) * parseFloat(avgPrice)).toFixed(2);

            await updateSwapRecord(record.id, {
              status: 'COMPLETED',
              executedQty,
              receivedUsdt,
              avgPrice,
              binanceOrderId: orderResult.ordId,
              completedAt: new Date(),
            });

            this.totalSwaps++;
            this.totalReceivedUsdt += parseFloat(receivedUsdt);

            log.info({
              asset, instId, executedQty, receivedUsdt, avgPrice,
            }, '[OKX-SWAP] Swap completed');

            // Transfer USDT back to funding for P2P
            try {
              await this.client.transfer({
                ccy: 'USDT',
                amt: receivedUsdt,
                from: '18',
                to: '6',
              });
              log.info({ amount: receivedUsdt }, '[OKX-SWAP] USDT transferred trading -> funding');
            } catch (fundingError: any) {
              log.warn({ amount: receivedUsdt, error: fundingError.message }, '[OKX-SWAP] Trading -> funding failed');
            }

            this.emit('swap', { type: 'completed', asset, executedQty, receivedUsdt });

          } catch (orderError: any) {
            const errorMsg = orderError.message || 'Unknown';
            await updateSwapRecord(record.id, {
              status: 'FAILED',
              error: errorMsg,
              completedAt: new Date(),
            });
            log.error({ asset, instId, error: errorMsg }, '[OKX-SWAP] Market sell failed');
            this.emit('swap', { type: 'failed', asset, error: errorMsg });
          }
        } catch (assetError: any) {
          log.error({ asset, error: assetError.message }, '[OKX-SWAP] Error processing asset');
        }
      }

      this.consecutiveErrors = 0;
    } catch (error: any) {
      this.consecutiveErrors++;
      log.error({ error: error.message, errors: this.consecutiveErrors }, '[OKX-SWAP] Poll error');
    } finally {
      this.isPolling = false;
    }
  }
}

// ==================== FACTORY ====================

export function createOkxAutoSwap(config?: Partial<OkxAutoSwapConfig>): OkxAutoSwap {
  return new OkxAutoSwap(config);
}
