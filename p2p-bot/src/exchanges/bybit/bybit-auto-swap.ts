// =====================================================
// BYBIT AUTO-SWAP MANAGER
// Polls balances, transfers FUND→UNIFIED, market sells to USDT
// Uses Bybit V5 Trading + Asset Transfer APIs
// ZERO dependency on Binance or OKX code
// =====================================================

import { EventEmitter } from 'events';
import { BybitClient, getBybitClient } from './bybit-client.js';
import { logger } from '../../utils/logger.js';
import { saveSwapRecord, updateSwapRecord, getSwapRecords, SwapRecord } from '../../services/database-pg.js';

const log = logger.child({ module: 'bybit-swap' });

// ==================== CONFIG ====================

export interface BybitAutoSwapConfig {
  assets: string[];
  pollIntervalMs: number;
  minSwapUsdt: number;
  dustThreshold: number;
}

interface LotSizeInfo {
  minQty: number;
  stepSize: number;
  precision: number;
}

// ==================== AUTO-SWAP ====================

export class BybitAutoSwap extends EventEmitter {
  private client: BybitClient;
  private config: BybitAutoSwapConfig;
  private isRunning = false;
  private isPolling = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private lotSizeCache = new Map<string, LotSizeInfo>();
  private consecutiveErrors = 0;
  private readonly maxConsecutiveErrors = 5;
  private totalSwaps = 0;
  private totalReceivedUsdt = 0;
  private totalTransfers = 0;

  constructor(config?: Partial<BybitAutoSwapConfig>) {
    super();
    this.client = getBybitClient();

    const assetsEnv = process.env.BYBIT_AUTO_SWAP_ASSETS || 'BTC,ETH,SOL';
    this.config = {
      assets: assetsEnv.split(',').map(a => a.trim().toUpperCase()).filter(Boolean),
      pollIntervalMs: parseInt(process.env.BYBIT_AUTO_SWAP_POLL_INTERVAL_MS || '30000'),
      minSwapUsdt: parseFloat(process.env.BYBIT_AUTO_SWAP_MIN_USDT || '5'),
      dustThreshold: parseFloat(process.env.BYBIT_AUTO_SWAP_DUST_THRESHOLD || '1'),
      ...config,
    };
  }

  // ==================== LIFECYCLE ====================

  async start(): Promise<void> {
    if (this.isRunning) return;

    log.info({
      assets: this.config.assets,
      pollInterval: this.config.pollIntervalMs,
    }, '[BYBIT-SWAP] Starting');

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
    log.info('[BYBIT-SWAP] Stopped');
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
      const symbol = `${asset}USDT`;

      try {
        const info = await this.client.getInstrumentInfo(symbol);
        if (info) {
          const stepSize = parseFloat(info.basePrecision);
          const stepStr = info.basePrecision;
          const decimalIndex = stepStr.indexOf('.');
          const precision = decimalIndex === -1 ? 0 : stepStr.length - decimalIndex - 1;

          this.lotSizeCache.set(symbol, {
            minQty: parseFloat(info.minOrderQty),
            stepSize,
            precision,
          });
          log.debug({ symbol, minQty: info.minOrderQty, stepSize: info.basePrecision }, '[BYBIT-SWAP] Lot size cached');
        }
      } catch (error: any) {
        log.warn({ symbol, error: error.message }, '[BYBIT-SWAP] Failed to load lot size');
      }
    }

    log.info({ cached: Array.from(this.lotSizeCache.keys()) }, '[BYBIT-SWAP] Lot sizes loaded');
  }

  private adjustToLotSize(quantity: number, lotSize: LotSizeInfo): string | null {
    const { minQty, stepSize, precision } = lotSize;

    const scale = Math.pow(10, precision);
    const scaledQty = Math.floor(quantity * scale + 0.5e-9);
    const scaledStep = Math.round(stepSize * scale);
    const scaledMin = Math.round(minQty * scale);

    const adjusted = Math.floor(scaledQty / scaledStep) * scaledStep;
    if (adjusted < scaledMin) return null;

    return (adjusted / scale).toFixed(precision);
  }

  // ==================== TRANSFER ====================

  private async transferFundToUnified(): Promise<Map<string, number>> {
    const transferred = new Map<string, number>();

    try {
      for (const asset of this.config.assets) {
        if (asset === 'USDT') continue;

        const balances = await this.client.getCoinBalance('FUND', asset);
        const balance = balances.find(b => b.coin === asset);
        if (!balance) continue;

        const available = parseFloat(balance.transferBalance);
        if (available <= 0) continue;

        try {
          // Transfer from FUND to UNIFIED (Bybit unified trading account)
          await this.client.interTransfer({
            coin: asset,
            amount: balance.transferBalance,
            fromAccountType: 'FUND',
            toAccountType: 'UNIFIED',
          });
          transferred.set(asset, available);
          this.totalTransfers++;
          log.info({ asset, amount: balance.transferBalance }, '[BYBIT-SWAP] Transferred FUND -> UNIFIED');
        } catch (error: any) {
          log.debug({ asset, error: error.message }, '[BYBIT-SWAP] Transfer failed');
        }
      }
    } catch (error: any) {
      log.error({ error: error.message }, '[BYBIT-SWAP] Failed to fetch funding balances');
    }

    return transferred;
  }

  // ==================== POLL & SWAP ====================

  private async pollAndSwap(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        log.warn({ errors: this.consecutiveErrors }, '[BYBIT-SWAP] Circuit breaker — skipping');
        this.consecutiveErrors = 0;
        return;
      }

      // Step 1: Transfer FUND → UNIFIED
      const transferred = await this.transferFundToUnified();
      if (transferred.size > 0) {
        await new Promise(r => setTimeout(r, 500));
      }

      // Step 2: Check unified account balances and swap
      for (const asset of this.config.assets) {
        if (asset === 'USDT') continue;
        const symbol = `${asset}USDT`;

        // Check balance in UNIFIED account
        const balances = await this.client.getCoinBalance('UNIFIED', asset);
        const balance = balances.find(b => b.coin === asset);
        if (!balance) continue;

        const free = parseFloat(balance.transferBalance);
        if (free <= 0) continue;

        const lotSize = this.lotSizeCache.get(symbol);
        if (!lotSize) continue;

        try {
          // Get current price
          const price = await this.client.getTickerPrice(symbol);
          const priceNum = parseFloat(price);
          const valueUsdt = free * priceNum;

          if (valueUsdt < this.config.dustThreshold) continue;
          if (valueUsdt < this.config.minSwapUsdt) continue;

          const adjustedQty = this.adjustToLotSize(free, lotSize);
          if (!adjustedQty) continue;

          const estimatedUsdt = (parseFloat(adjustedQty) * priceNum).toFixed(2);
          log.info({ asset, symbol, quantity: adjustedQty, estimatedUsdt }, '[BYBIT-SWAP] Swapping');

          // Save pending record
          const record = await saveSwapRecord({
            asset,
            symbol,
            quantity: adjustedQty,
            estimatedUsdt,
          });

          try {
            // Market sell
            const orderResult = await this.client.spotOrder(symbol, 'Sell', 'Market', adjustedQty);

            // Wait briefly then get order details
            await new Promise(r => setTimeout(r, 1000));
            const orderDetail = await this.client.getSpotOrder(symbol, orderResult.orderId);

            const executedQty = orderDetail?.cumExecQty || adjustedQty;
            const avgPrice = orderDetail?.avgPrice || price;
            const receivedUsdt = (parseFloat(executedQty) * parseFloat(avgPrice)).toFixed(2);

            await updateSwapRecord(record.id, {
              status: 'COMPLETED',
              executedQty,
              receivedUsdt,
              avgPrice,
              binanceOrderId: orderResult.orderId,
              completedAt: new Date(),
            });

            this.totalSwaps++;
            this.totalReceivedUsdt += parseFloat(receivedUsdt);

            log.info({
              asset, symbol, executedQty, receivedUsdt, avgPrice,
            }, '[BYBIT-SWAP] Swap completed');

            // Transfer USDT back to FUND for P2P
            try {
              await this.client.interTransfer({
                coin: 'USDT',
                amount: receivedUsdt,
                fromAccountType: 'UNIFIED',
                toAccountType: 'FUND',
              });
              log.info({ amount: receivedUsdt }, '[BYBIT-SWAP] USDT transferred UNIFIED -> FUND');

              // Reload sell ad with new USDT
              await this.reloadSellAd(parseFloat(receivedUsdt));
            } catch (fundingError: any) {
              log.warn({ amount: receivedUsdt, error: fundingError.message }, '[BYBIT-SWAP] UNIFIED -> FUND failed');
            }

            this.emit('swap', { type: 'completed', asset, executedQty, receivedUsdt });

          } catch (orderError: any) {
            const errorMsg = orderError.message || 'Unknown';
            await updateSwapRecord(record.id, {
              status: 'FAILED',
              error: errorMsg,
              completedAt: new Date(),
            });
            log.error({ asset, symbol, error: errorMsg }, '[BYBIT-SWAP] Market sell failed');
            this.emit('swap', { type: 'failed', asset, error: errorMsg });
          }
        } catch (assetError: any) {
          log.error({ asset, error: assetError.message }, '[BYBIT-SWAP] Error processing asset');
        }
      }

      this.consecutiveErrors = 0;
    } catch (error: any) {
      this.consecutiveErrors++;
      log.error({ error: error.message, errors: this.consecutiveErrors }, '[BYBIT-SWAP] Poll error');
    } finally {
      this.isPolling = false;
    }
  }

  // ==================== RELOAD SELL AD ====================

  private async reloadSellAd(addedUsdt: number): Promise<void> {
    try {
      const { items } = await this.client.getMyAds({ side: '1', status: '2' });
      const sellAd = items.find(ad => ad.status === 10 && ad.tokenId === 'USDT');
      if (!sellAd) return;

      const detail = await this.client.getAdDetail(sellAd.id);
      if (!detail) return;

      const currentQty = parseFloat(detail.lastQuantity);
      const newQty = Math.floor((currentQty + addedUsdt) * 100) / 100;

      // Build full update payload (Bybit requires ALL fields)
      const paymentIds = detail.paymentTerms?.map(pt => String(pt.id)) || detail.payments || [];
      const tps: Record<string, string> = {};
      if (detail.tradingPreferenceSet) {
        for (const [k, v] of Object.entries(detail.tradingPreferenceSet)) {
          tps[k] = String(v);
        }
      }

      await this.client.updateAd({
        id: detail.id,
        priceType: String(detail.priceType) as '0' | '1',
        premium: String(detail.premium || '0'),
        price: detail.price,
        minAmount: String(detail.minAmount),
        maxAmount: String(detail.maxAmount),
        remark: detail.remark || '',
        tradingPreferenceSet: tps,
        paymentIds,
        actionType: 'MODIFY',
        quantity: String(newQty),
        paymentPeriod: String(detail.paymentPeriod),
      });

      log.info({ addedUsdt, newQty, adId: sellAd.id }, '[BYBIT-SWAP] Sell ad reloaded');
    } catch (error: any) {
      log.warn({ error: error.message }, '[BYBIT-SWAP] Failed to reload sell ad');
    }
  }
}

// ==================== FACTORY ====================

export function createBybitAutoSwap(config?: Partial<BybitAutoSwapConfig>): BybitAutoSwap {
  return new BybitAutoSwap(config);
}
