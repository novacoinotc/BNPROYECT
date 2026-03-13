// =====================================================
// STANDALONE OPERATOR MONITOR
// Runs as its own Railway service
// Monitors operators across Binance, OKX, and Bybit
// Uses direct HTTP calls — no exchange API keys needed
// =====================================================

import 'dotenv/config';
import { logger } from '../utils/logger.js';
import * as db from './database-pg.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import axios, { AxiosRequestConfig } from 'axios';

const log = logger.child({ module: 'operator-monitor-all' });

// ==================== TYPES ====================

interface OperatorEntry {
  nickname: string;
  exchange: 'binance' | 'okx' | 'bybit';
  displayName: string; // e.g. "ProcorpCrypto (OKX)"
}

interface MonitorConfig {
  operators: OperatorEntry[];
  lowFundsThreshold: number;
  checkIntervalMs: number;
  workdayStart: number; // Hour in CDMX timezone
  workdayEnd: number;   // Hour in CDMX timezone
}

// ==================== MARKETPLACE SEARCH (PUBLIC APIs) ====================

/**
 * Get proxy agent for OKX/Bybit (they block US IPs)
 * NOTE: Node's native fetch() does NOT support the `agent` option.
 * We use axios with httpsAgent instead.
 */
function getProxyAgent(): HttpsProxyAgent<string> | undefined {
  const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.OKX_PROXY_URL;
  if (!proxyUrl) return undefined;
  return new HttpsProxyAgent(proxyUrl);
}

/**
 * Search Binance P2P marketplace (public, no auth needed)
 */
async function searchBinance(asset: string, fiat: string, pages: number = 5): Promise<Array<{
  nickName: string;
  surplusAmount: number;
  price: number;
}>> {
  const results: Array<{ nickName: string; surplusAmount: number; price: number }> = [];

  for (let page = 1; page <= pages; page++) {
    try {
      const res = await fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asset,
          fiat,
          tradeType: 'BUY', // BUY tab = sellers
          page,
          rows: 20,
          publisherType: null,
        }),
      });

      const data = await res.json() as any;
      const ads = data?.data || [];
      if (ads.length === 0) break;

      for (const ad of ads) {
        results.push({
          nickName: ad.advertiser?.nickName || '',
          surplusAmount: parseFloat(ad.adv?.surplusAmount || '0'),
          price: parseFloat(ad.adv?.price || '0'),
        });
      }
    } catch (err) {
      log.error({ err, page }, 'Binance marketplace search failed');
      break;
    }
  }

  return results;
}

/**
 * Search OKX P2P marketplace (public, but needs proxy)
 * Uses axios because Node's native fetch() ignores the proxy agent
 */
async function searchOkx(asset: string, fiat: string, pages: number = 5): Promise<Array<{
  nickName: string;
  surplusAmount: number;
  price: number;
}>> {
  const results: Array<{ nickName: string; surplusAmount: number; price: number }> = [];
  const agent = getProxyAgent();

  for (let page = 1; page <= pages; page++) {
    try {
      const params = new URLSearchParams({
        side: 'sell',
        cryptoCurrency: asset,
        fiatCurrency: fiat,
        pageIndex: String(page),
        pageSize: '20',
      });

      const config: AxiosRequestConfig = {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      };
      if (agent) {
        config.httpsAgent = agent;
      }

      const res = await axios.get(
        `https://www.okx.com/api/v5/p2p/ad/marketplace-list?${params}`,
        config
      );

      const data = res.data;
      const wrapper = data?.data?.[0] || data?.data || {};
      const ads = wrapper?.sellAds || wrapper?.buyAds || (Array.isArray(data?.data) ? data.data : []);

      log.debug({ page, adsCount: ads.length, hasWrapper: !!wrapper?.sellAds }, 'OKX marketplace page');

      if (ads.length === 0) break;

      for (const ad of ads) {
        results.push({
          nickName: ad.creator?.nickName || ad.nickName || '',
          surplusAmount: parseFloat(ad.availableAmount || '0'),
          price: parseFloat(ad.unitPrice || '0'),
        });
      }
    } catch (err: any) {
      log.error({ error: err.message, page }, 'OKX marketplace search failed');
      break;
    }
  }

  log.info({ totalResults: results.length }, 'OKX marketplace search complete');
  return results;
}

/**
 * Search Bybit P2P marketplace (public, but needs proxy)
 * Uses axios because Node's native fetch() ignores the proxy agent
 */
async function searchBybit(asset: string, fiat: string, pages: number = 5): Promise<Array<{
  nickName: string;
  surplusAmount: number;
  price: number;
}>> {
  const results: Array<{ nickName: string; surplusAmount: number; price: number }> = [];
  const agent = getProxyAgent();

  for (let page = 1; page <= pages; page++) {
    try {
      const config: AxiosRequestConfig = {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      };
      if (agent) {
        config.httpsAgent = agent;
      }

      const res = await axios.post(
        'https://api2.bybit.com/fiat/otc/item/online',
        {
          tokenId: asset,
          currencyId: fiat,
          side: '1', // 1 = sell
          page: String(page),
          size: '20',
        },
        config
      );

      const data = res.data;
      const items = data?.result?.items || [];
      if (items.length === 0) break;

      for (const item of items) {
        results.push({
          nickName: item.nickName || '',
          surplusAmount: parseFloat(item.lastQuantity || '0'),
          price: parseFloat(item.price || '0'),
        });
      }
    } catch (err: any) {
      log.error({ error: err.message, page }, 'Bybit marketplace search failed');
      break;
    }
  }

  log.info({ totalResults: results.length }, 'Bybit marketplace search complete');
  return results;
}

// ==================== MONITOR ====================

/**
 * Get current hour in CDMX timezone (America/Mexico_City)
 */
function getCdmxHour(): number {
  const now = new Date();
  const cdmxTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  return cdmxTime.getHours();
}

async function runCheck(config: MonitorConfig): Promise<void> {
  // Group operators by exchange
  const binanceOps = config.operators.filter(o => o.exchange === 'binance');
  const okxOps = config.operators.filter(o => o.exchange === 'okx');
  const bybitOps = config.operators.filter(o => o.exchange === 'bybit');

  // Search all exchanges in parallel
  const [binanceAds, okxAds, bybitAds] = await Promise.all([
    binanceOps.length > 0 ? searchBinance('USDT', 'MXN') : Promise.resolve([]),
    okxOps.length > 0 ? searchOkx('USDT', 'MXN') : Promise.resolve([]),
    bybitOps.length > 0 ? searchBybit('USDT', 'MXN') : Promise.resolve([]),
  ]);

  log.debug({
    binanceAds: binanceAds.length,
    okxAds: okxAds.length,
    bybitAds: bybitAds.length,
  }, 'Marketplace search results');

  const cdmxHour = getCdmxHour();
  const isWorkHour = cdmxHour >= config.workdayStart && cdmxHour < config.workdayEnd;

  // Check each operator
  for (const op of config.operators) {
    let ads: typeof binanceAds;
    switch (op.exchange) {
      case 'binance': ads = binanceAds; break;
      case 'okx': ads = okxAds; break;
      case 'bybit': ads = bybitAds; break;
    }

    const found = ads.find(a => a.nickName.toLowerCase() === op.nickname.toLowerCase());
    const isAdOnline = !!found;
    const surplusAmount = found?.surplusAmount ?? null;
    const adPrice = found?.price ?? null;
    const lowFunds = surplusAmount !== null && surplusAmount < config.lowFundsThreshold;

    await db.saveOperatorSnapshot({
      nickname: op.displayName,
      isAdOnline,
      surplusAmount,
      adPrice,
      lowFunds,
    });

    if (!isAdOnline && isWorkHour) {
      log.warn({ operator: op.displayName, cdmxHour },
        `⚠️ ${op.displayName} OFFLINE during work hours`);
    } else if (lowFunds && isWorkHour) {
      log.warn({ operator: op.displayName, surplusAmount: surplusAmount?.toFixed(2) },
        `💸 ${op.displayName} LOW FUNDS: ${surplusAmount?.toFixed(2)} USDT`);
    }
  }
}

// ==================== MAIN ====================

async function main(): Promise<void> {
  log.info('='.repeat(50));
  log.info('Operator Monitor Service Starting...');
  log.info('='.repeat(50));

  // Test DB
  const dbOk = await db.testConnection();
  if (!dbOk) {
    log.error('Database connection failed');
    process.exit(1);
  }
  log.info('Database connected');

  // Parse operator config
  const operators: OperatorEntry[] = [];

  const binanceNicks = (process.env.BINANCE_OPERATORS || '').split(',').map(n => n.trim()).filter(Boolean);
  for (const nick of binanceNicks) {
    operators.push({ nickname: nick, exchange: 'binance', displayName: nick });
  }

  const okxNicks = (process.env.OKX_OPERATORS || '').split(',').map(n => n.trim()).filter(Boolean);
  for (const nick of okxNicks) {
    operators.push({ nickname: nick, exchange: 'okx', displayName: `${nick} (OKX)` });
  }

  const bybitNicks = (process.env.BYBIT_OPERATORS || '').split(',').map(n => n.trim()).filter(Boolean);
  for (const nick of bybitNicks) {
    operators.push({ nickname: nick, exchange: 'bybit', displayName: `${nick} (Bybit)` });
  }

  if (operators.length === 0) {
    log.error('No operators configured. Set BINANCE_OPERATORS, OKX_OPERATORS, BYBIT_OPERATORS');
    process.exit(1);
  }

  const config: MonitorConfig = {
    operators,
    lowFundsThreshold: parseInt(process.env.OPERATOR_LOW_FUNDS_THRESHOLD || '1000'),
    checkIntervalMs: parseInt(process.env.OPERATOR_CHECK_INTERVAL_MS || '300000'),
    workdayStart: parseInt(process.env.OPERATOR_WORKDAY_START || '9'),
    workdayEnd: parseInt(process.env.OPERATOR_WORKDAY_END || '22'),
  };

  log.info({
    operators: operators.map(o => o.displayName),
    intervalMinutes: config.checkIntervalMs / 60000,
    workday: `${config.workdayStart}:00 - ${config.workdayEnd}:00 (CDMX)`,
    lowFundsThreshold: config.lowFundsThreshold,
    proxy: process.env.HTTP_PROXY ? 'configured' : 'none',
  }, 'Operator Monitor configured');

  // First check immediately
  await runCheck(config);

  // Then periodic
  setInterval(() => runCheck(config), config.checkIntervalMs);

  log.info('='.repeat(50));
  log.info('Operator Monitor running!');
  log.info('='.repeat(50));
}

main().catch(err => {
  log.fatal({ err }, 'Operator Monitor fatal error');
  process.exit(1);
});
