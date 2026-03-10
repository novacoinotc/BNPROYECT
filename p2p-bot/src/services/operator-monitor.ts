// =====================================================
// OPERATOR MONITOR
// Tracks operator online hours and USDT volume
// Polls Binance P2P marketplace every 5 minutes
// =====================================================

import { getBinanceClient } from './binance-client.js';
import { TradeType, AdData } from '../types/binance.js';
import { logger } from '../utils/logger.js';
import * as db from './database-pg.js';

const log = logger.child({ module: 'operator-monitor' });

export interface OperatorMonitorConfig {
  nicknames: string[];           // Binance nicknames to monitor
  asset: string;                 // Default: USDT
  fiat: string;                  // Default: MXN
  lowFundsThreshold: number;     // Default: 1000 USDT
  checkIntervalMs: number;       // Default: 5 minutes
  workdayStart: number;          // Default: 9 (9 AM)
  workdayEnd: number;            // Default: 22 (10 PM)
}

const DEFAULT_CONFIG: OperatorMonitorConfig = {
  nicknames: [],
  asset: 'USDT',
  fiat: 'MXN',
  lowFundsThreshold: 1000,
  checkIntervalMs: 5 * 60 * 1000, // 5 minutes
  workdayStart: 9,
  workdayEnd: 22,
};

export class OperatorMonitor {
  private config: OperatorMonitorConfig;
  private interval: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(config: Partial<OperatorMonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async start(): Promise<void> {
    if (this.config.nicknames.length === 0) {
      log.warn('No operator nicknames configured — monitor not started');
      return;
    }

    this.isRunning = true;
    log.info({
      nicknames: this.config.nicknames,
      asset: this.config.asset,
      fiat: this.config.fiat,
      lowFundsThreshold: this.config.lowFundsThreshold,
      intervalMinutes: this.config.checkIntervalMs / 60000,
      workday: `${this.config.workdayStart}:00 - ${this.config.workdayEnd}:00`,
    }, '👁️ [OPERATOR MONITOR] Started');

    // Run first check immediately
    await this.runCheck();

    // Then schedule periodic checks
    this.interval = setInterval(() => this.runCheck(), this.config.checkIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    log.info('👁️ [OPERATOR MONITOR] Stopped');
  }

  private async runCheck(): Promise<void> {
    try {
      const client = getBinanceClient();

      // Search SELL ads for USDT/MXN (tradeType BUY = sellers in marketplace)
      const allAds: AdData[] = [];
      for (let page = 1; page <= 5; page++) {
        const ads = await client.searchAds({
          asset: this.config.asset,
          fiat: this.config.fiat,
          tradeType: TradeType.BUY, // BUY tab = sellers
          page,
          rows: 20,
        });
        if (ads.length === 0) break;
        allAds.push(...ads);
      }

      // Check each operator
      for (const nickname of this.config.nicknames) {
        const operatorAd = allAds.find(
          ad => ad.advertiser.nickName.toLowerCase() === nickname.toLowerCase()
        );

        const isAdOnline = !!operatorAd;
        const surplusAmount = operatorAd ? parseFloat(operatorAd.surplusAmount) : null;
        const adPrice = operatorAd ? parseFloat(operatorAd.price) : null;
        const lowFunds = surplusAmount !== null && surplusAmount < this.config.lowFundsThreshold;

        // Save snapshot to DB
        await db.saveOperatorSnapshot({
          nickname,
          isAdOnline,
          surplusAmount,
          adPrice,
          lowFunds,
        });

        // Log status changes and alerts
        if (!isAdOnline) {
          const now = new Date();
          const hour = now.getHours();
          const isWorkHour = hour >= this.config.workdayStart && hour < this.config.workdayEnd;

          if (isWorkHour) {
            log.warn({ nickname, hour }, `⚠️ [OPERATOR] ${nickname} OFFLINE during work hours`);
          } else {
            log.debug({ nickname }, `[OPERATOR] ${nickname} offline (outside work hours)`);
          }
        } else if (lowFunds) {
          log.warn({
            nickname,
            surplusAmount: surplusAmount?.toFixed(2),
            threshold: this.config.lowFundsThreshold,
          }, `💸 [OPERATOR] ${nickname} LOW FUNDS: ${surplusAmount?.toFixed(2)} USDT`);
        }
      }
    } catch (err) {
      log.error({ err }, '👁️ [OPERATOR MONITOR] Check failed');
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      nicknames: this.config.nicknames,
      asset: this.config.asset,
      fiat: this.config.fiat,
      lowFundsThreshold: this.config.lowFundsThreshold,
    };
  }
}

// ==================== FACTORY ====================

export function createOperatorMonitor(): OperatorMonitor | null {
  const nicknamesStr = process.env.OPERATOR_NICKNAMES;
  if (!nicknamesStr) {
    return null;
  }

  const nicknames = nicknamesStr.split(',').map(n => n.trim()).filter(n => n.length > 0);
  if (nicknames.length === 0) {
    return null;
  }

  return new OperatorMonitor({
    nicknames,
    asset: process.env.OPERATOR_MONITOR_ASSET || 'USDT',
    fiat: process.env.OPERATOR_MONITOR_FIAT || 'MXN',
    lowFundsThreshold: parseInt(process.env.OPERATOR_LOW_FUNDS_THRESHOLD || '1000'),
    checkIntervalMs: parseInt(process.env.OPERATOR_CHECK_INTERVAL_MS || '300000'), // 5 min
    workdayStart: parseInt(process.env.OPERATOR_WORKDAY_START || '9'),
    workdayEnd: parseInt(process.env.OPERATOR_WORKDAY_END || '22'),
  });
}
