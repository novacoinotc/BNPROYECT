// =====================================================
// OKX OPERATOR MONITOR
// Tracks operator online hours and USDT volume
// Polls OKX P2P marketplace every 5 minutes
// =====================================================

import { getOkxClient } from './okx-client.js';
import { logger } from '../../utils/logger.js';
import * as db from '../../services/database-pg.js';

const log = logger.child({ module: 'okx-operator-monitor' });

export interface OkxOperatorMonitorConfig {
  nicknames: string[];
  asset: string;
  fiat: string;
  lowFundsThreshold: number;
  checkIntervalMs: number;
  workdayStart: number;
  workdayEnd: number;
}

export class OkxOperatorMonitor {
  private config: OkxOperatorMonitorConfig;
  private interval: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(config: Partial<OkxOperatorMonitorConfig> = {}) {
    this.config = {
      nicknames: config.nicknames || [],
      asset: config.asset || 'USDT',
      fiat: config.fiat || 'MXN',
      lowFundsThreshold: config.lowFundsThreshold ?? 1000,
      checkIntervalMs: config.checkIntervalMs ?? 5 * 60 * 1000,
      workdayStart: config.workdayStart ?? 9,
      workdayEnd: config.workdayEnd ?? 22,
    };
  }

  async start(): Promise<void> {
    if (this.config.nicknames.length === 0) {
      log.warn('No OKX operator nicknames configured — monitor not started');
      return;
    }

    this.isRunning = true;
    log.info({
      nicknames: this.config.nicknames,
      intervalMinutes: this.config.checkIntervalMs / 60000,
    }, '👁️ [OKX OPERATOR MONITOR] Started');

    await this.runCheck();
    this.interval = setInterval(() => this.runCheck(), this.config.checkIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    log.info('👁️ [OKX OPERATOR MONITOR] Stopped');
  }

  private async runCheck(): Promise<void> {
    try {
      const client = getOkxClient();

      // Search SELL ads on OKX marketplace (up to 5 pages)
      const allAds: any[] = [];
      for (let page = 1; page <= 5; page++) {
        const ads = await client.searchAds('sell', this.config.asset, this.config.fiat, page, 20);
        if (ads.length === 0) break;
        allAds.push(...ads);
      }

      for (const nickname of this.config.nicknames) {
        const operatorAd = allAds.find(
          (ad: any) => ad.creator?.nickName?.toLowerCase() === nickname.toLowerCase()
        );

        const isAdOnline = !!operatorAd;
        const surplusAmount = operatorAd ? parseFloat(operatorAd.availableAmount) : null;
        const adPrice = operatorAd ? parseFloat(operatorAd.unitPrice) : null;
        const lowFunds = surplusAmount !== null && surplusAmount < this.config.lowFundsThreshold;

        await db.saveOperatorSnapshot({
          nickname: `${nickname} (OKX)`,
          isAdOnline,
          surplusAmount,
          adPrice,
          lowFunds,
        });

        if (!isAdOnline) {
          const hour = new Date().getHours();
          if (hour >= this.config.workdayStart && hour < this.config.workdayEnd) {
            log.warn({ nickname }, `⚠️ [OKX OPERATOR] ${nickname} OFFLINE during work hours`);
          }
        } else if (lowFunds) {
          log.warn({ nickname, surplusAmount: surplusAmount?.toFixed(2) },
            `💸 [OKX OPERATOR] ${nickname} LOW FUNDS: ${surplusAmount?.toFixed(2)} USDT`);
        }
      }
    } catch (err) {
      log.error({ err }, '👁️ [OKX OPERATOR MONITOR] Check failed');
    }
  }
}

export function createOkxOperatorMonitor(): OkxOperatorMonitor | null {
  const nicknamesStr = process.env.OPERATOR_NICKNAMES;
  if (!nicknamesStr) return null;

  const nicknames = nicknamesStr.split(',').map(n => n.trim()).filter(n => n.length > 0);
  if (nicknames.length === 0) return null;

  return new OkxOperatorMonitor({
    nicknames,
    asset: process.env.OPERATOR_MONITOR_ASSET || 'USDT',
    fiat: process.env.OPERATOR_MONITOR_FIAT || 'MXN',
    lowFundsThreshold: parseInt(process.env.OPERATOR_LOW_FUNDS_THRESHOLD || '1000'),
    checkIntervalMs: parseInt(process.env.OPERATOR_CHECK_INTERVAL_MS || '300000'),
    workdayStart: parseInt(process.env.OPERATOR_WORKDAY_START || '9'),
    workdayEnd: parseInt(process.env.OPERATOR_WORKDAY_END || '22'),
  });
}
