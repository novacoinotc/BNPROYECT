// =====================================================
// STANDALONE OPERATOR MONITOR (v2 — Authenticated APIs)
// Runs as its own Railway service
// Monitors operators across Binance, OKX, and Bybit
// Uses authenticated API calls — checks each operator's
// own ads directly (no marketplace search needed)
// =====================================================

import 'dotenv/config';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import * as db from './database-pg.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';

const log = logger.child({ module: 'operator-monitor' });

// ==================== TYPES ====================

interface OperatorConfig {
  nickname: string;
  displayName: string;
  exchange: 'binance' | 'okx' | 'bybit';
  apiKey: string;
  apiSecret: string;
  passphrase?: string; // OKX only
}

interface AdStatus {
  isOnline: boolean;
  surplusAmount: number | null;
  adPrice: number | null;
  onlineAdsCount: number;
}

interface MonitorConfig {
  operators: OperatorConfig[];
  lowFundsThreshold: number;
  checkIntervalMs: number;
  workdayStart: number;
  workdayEnd: number;
}

// ==================== PROXY ====================

function getProxyAgent(): HttpsProxyAgent<string> | undefined {
  const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.OKX_PROXY_URL;
  if (!proxyUrl) return undefined;
  return new HttpsProxyAgent(proxyUrl);
}

// ==================== BINANCE API ====================

async function checkBinanceAds(op: OperatorConfig): Promise<AdStatus> {
  try {
    const timestamp = Date.now();
    const params = `page=1&rows=20&timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', op.apiSecret).update(params).digest('hex');
    const queryString = `${params}&signature=${signature}`;

    const response = await axios.get(
      `https://api.binance.com/sapi/v1/c2c/ads/list?${queryString}`,
      {
        headers: {
          'X-MBX-APIKEY': op.apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    const data = response.data?.data;
    if (!data) return { isOnline: false, surplusAmount: null, adPrice: null, onlineAdsCount: 0 };

    // Response can be { sellList, buyList } or array
    let allAds: any[] = [];
    if (data.sellList || data.buyList) {
      allAds = [...(data.sellList || []), ...(data.buyList || [])];
    } else if (Array.isArray(data)) {
      allAds = data;
    }

    // Filter online SELL ads (advStatus 1 = online)
    const onlineSellAds = allAds.filter((ad: any) =>
      (ad.advStatus === 1 || ad.advStatus === '1') &&
      (ad.tradeType === 'SELL' || ad.tradeType === 1)
    );

    if (onlineSellAds.length === 0) {
      // Check if there are ANY online ads (buy too)
      const anyOnline = allAds.filter((ad: any) => ad.advStatus === 1 || ad.advStatus === '1');
      if (anyOnline.length > 0) {
        const best = anyOnline[0];
        return {
          isOnline: true,
          surplusAmount: parseFloat(best.surplusAmount || '0'),
          adPrice: parseFloat(best.price || '0'),
          onlineAdsCount: anyOnline.length,
        };
      }
      return { isOnline: false, surplusAmount: null, adPrice: null, onlineAdsCount: 0 };
    }

    // Get best sell ad (lowest price)
    const best = onlineSellAds.sort((a: any, b: any) =>
      parseFloat(a.price || '0') - parseFloat(b.price || '0')
    )[0];

    return {
      isOnline: true,
      surplusAmount: parseFloat(best.surplusAmount || '0'),
      adPrice: parseFloat(best.price || '0'),
      onlineAdsCount: onlineSellAds.length,
    };
  } catch (error: any) {
    log.error({ operator: op.displayName, error: error.message }, 'Binance API check failed');
    return { isOnline: false, surplusAmount: null, adPrice: null, onlineAdsCount: 0 };
  }
}

// ==================== OKX API ====================

async function checkOkxAds(op: OperatorConfig): Promise<AdStatus> {
  try {
    const endpoint = '/api/v5/p2p/ad/active-list';
    const timestamp = new Date().toISOString();
    const prehash = timestamp + 'GET' + endpoint;
    const signature = crypto.createHmac('sha256', op.apiSecret).update(prehash).digest('base64');

    const agent = getProxyAgent();
    const config: AxiosRequestConfig = {
      headers: {
        'OK-ACCESS-KEY': op.apiKey,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': op.passphrase || '',
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    };
    if (agent) config.httpsAgent = agent;

    const response = await axios.get(`https://www.okx.com${endpoint}`, config);

    const data = response.data?.data;
    if (!data) return { isOnline: false, surplusAmount: null, adPrice: null, onlineAdsCount: 0 };

    // Parse OKX response: can be [{ sellAds: [], buyAds: [] }] or { sellAds: [], buyAds: [] }
    let sellAds: any[] = [];
    if (Array.isArray(data) && data[0]) {
      sellAds = data[0].sellAds || data[0].sell || [];
    } else if (data.sellAds || data.sell) {
      sellAds = data.sellAds || data.sell || [];
    }

    // All ads returned by active-list are active
    if (sellAds.length === 0) {
      // Check buy ads too
      let buyAds: any[] = [];
      if (Array.isArray(data) && data[0]) {
        buyAds = data[0].buyAds || data[0].buy || [];
      } else if (data.buyAds || data.buy) {
        buyAds = data.buyAds || data.buy || [];
      }

      if (buyAds.length > 0) {
        const best = buyAds[0];
        return {
          isOnline: true,
          surplusAmount: parseFloat(best.availableAmount || best.surplusAmount || '0'),
          adPrice: parseFloat(best.unitPrice || best.price || '0'),
          onlineAdsCount: buyAds.length,
        };
      }
      return { isOnline: false, surplusAmount: null, adPrice: null, onlineAdsCount: 0 };
    }

    // Get best sell ad (lowest price)
    const best = sellAds.sort((a: any, b: any) =>
      parseFloat(a.unitPrice || a.price || '0') - parseFloat(b.unitPrice || b.price || '0')
    )[0];

    return {
      isOnline: true,
      surplusAmount: parseFloat(best.availableAmount || best.surplusAmount || '0'),
      adPrice: parseFloat(best.unitPrice || best.price || '0'),
      onlineAdsCount: sellAds.length,
    };
  } catch (error: any) {
    log.error({ operator: op.displayName, error: error.message }, 'OKX API check failed');
    return { isOnline: false, surplusAmount: null, adPrice: null, onlineAdsCount: 0 };
  }
}

// ==================== BYBIT API ====================

async function checkBybitAds(op: OperatorConfig): Promise<AdStatus> {
  try {
    const endpoint = '/v5/p2p/item/personal/list';
    const body = JSON.stringify({});
    const recvWindow = '5000';
    const timestamp = Date.now().toString();
    const prehash = timestamp + op.apiKey + recvWindow + body;
    const signature = crypto.createHmac('sha256', op.apiSecret).update(prehash).digest('hex');

    const agent = getProxyAgent();
    const config: AxiosRequestConfig = {
      headers: {
        'X-BAPI-API-KEY': op.apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-SIGN': signature,
        'X-BAPI-RECV-WINDOW': recvWindow,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    };
    if (agent) config.httpsAgent = agent;

    const response = await axios.post(`https://api.bybit.com${endpoint}`, {}, config);

    const result = response.data?.result;
    if (!result?.items) return { isOnline: false, surplusAmount: null, adPrice: null, onlineAdsCount: 0 };

    // status 10 = online, side 1 = sell
    const onlineSellAds = result.items.filter((ad: any) =>
      ad.status === 10 && ad.side === 1
    );

    if (onlineSellAds.length === 0) {
      // Check any online ads (buy too)
      const anyOnline = result.items.filter((ad: any) => ad.status === 10);
      if (anyOnline.length > 0) {
        const best = anyOnline[0];
        return {
          isOnline: true,
          surplusAmount: parseFloat(best.lastQuantity || best.quantity || '0'),
          adPrice: parseFloat(best.price || '0'),
          onlineAdsCount: anyOnline.length,
        };
      }
      return { isOnline: false, surplusAmount: null, adPrice: null, onlineAdsCount: 0 };
    }

    // Get best sell ad (lowest price)
    const best = onlineSellAds.sort((a: any, b: any) =>
      parseFloat(a.price || '0') - parseFloat(b.price || '0')
    )[0];

    return {
      isOnline: true,
      surplusAmount: parseFloat(best.lastQuantity || best.quantity || '0'),
      adPrice: parseFloat(best.price || '0'),
      onlineAdsCount: onlineSellAds.length,
    };
  } catch (error: any) {
    log.error({ operator: op.displayName, error: error.message }, 'Bybit API check failed');
    return { isOnline: false, surplusAmount: null, adPrice: null, onlineAdsCount: 0 };
  }
}

// ==================== MONITOR ====================

function getCdmxHour(): number {
  const now = new Date();
  const cdmxTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  return cdmxTime.getHours();
}

async function checkOperator(op: OperatorConfig): Promise<AdStatus> {
  switch (op.exchange) {
    case 'binance': return checkBinanceAds(op);
    case 'okx': return checkOkxAds(op);
    case 'bybit': return checkBybitAds(op);
  }
}

async function runCheck(config: MonitorConfig): Promise<void> {
  const cdmxHour = getCdmxHour();
  const isWorkHour = cdmxHour >= config.workdayStart && cdmxHour < config.workdayEnd;

  // Check all operators in parallel
  const results = await Promise.all(
    config.operators.map(async (op) => {
      const status = await checkOperator(op);
      return { op, status };
    })
  );

  for (const { op, status } of results) {
    const lowFunds = status.surplusAmount !== null && status.surplusAmount < config.lowFundsThreshold;

    if (status.isOnline) {
      log.info(
        `✅ ${op.displayName}: ONLINE (${status.onlineAdsCount} ads, best price ${status.adPrice?.toFixed(2)}, ${status.surplusAmount?.toFixed(0)} USDT)`
      );
    } else {
      log.info(`❌ ${op.displayName}: OFFLINE`);
    }

    await db.saveOperatorSnapshot({
      nickname: op.displayName,
      isAdOnline: status.isOnline,
      surplusAmount: status.surplusAmount,
      adPrice: status.adPrice,
      lowFunds,
    });

    if (!status.isOnline && isWorkHour) {
      log.warn(`⚠️ ${op.displayName} OFFLINE during work hours (${cdmxHour}:00 CDMX)`);
    } else if (lowFunds && isWorkHour) {
      log.warn(`💸 ${op.displayName} LOW FUNDS: ${status.surplusAmount?.toFixed(2)} USDT`);
    }
  }
}

// ==================== MAIN ====================

function parseOperatorConfig(): OperatorConfig[] {
  // Method 1: JSON config (preferred)
  // MONITOR_CONFIG=[{"nickname":"VillarrealCrypto","displayName":"VillarrealCrypto","exchange":"binance","apiKey":"xxx","apiSecret":"xxx"}, ...]
  let jsonConfig = process.env.MONITOR_CONFIG;
  if (jsonConfig) {
    // Railway sometimes wraps env vars in extra quotes
    jsonConfig = jsonConfig.trim();
    if ((jsonConfig.startsWith('"') && jsonConfig.endsWith('"')) ||
        (jsonConfig.startsWith("'") && jsonConfig.endsWith("'"))) {
      jsonConfig = jsonConfig.slice(1, -1);
    }
    // Unescape any escaped quotes from Railway
    jsonConfig = jsonConfig.replace(/\\"/g, '"');

    try {
      const parsed = JSON.parse(jsonConfig) as OperatorConfig[];
      log.info(`Loaded ${parsed.length} operators from MONITOR_CONFIG JSON`);
      return parsed;
    } catch (e: any) {
      log.error({
        error: e.message,
        rawLength: jsonConfig.length,
        rawStart: jsonConfig.substring(0, 120),
        rawEnd: jsonConfig.substring(jsonConfig.length - 60),
      }, 'Failed to parse MONITOR_CONFIG JSON');
    }
  }

  // Method 2: Individual env vars per operator
  // MONITOR_OPS=VillarrealCrypto:binance,MisterShops:binance,ProcorpCrypto:okx,...
  // MONITOR_VILLARREALCRYPTO_KEY=xxx
  // MONITOR_VILLARREALCRYPTO_SECRET=xxx
  const opsList = process.env.MONITOR_OPS;
  if (opsList) {
    const operators: OperatorConfig[] = [];
    const entries = opsList.split(',').map(s => s.trim()).filter(Boolean);

    for (const entry of entries) {
      const [nickname, exchange] = entry.split(':');
      if (!nickname || !exchange) continue;

      // Normalize key name: strip special chars, uppercase
      const keyName = nickname.replace(/[-_\s]/g, '').toUpperCase();
      const apiKey = process.env[`MONITOR_${keyName}_KEY`] || '';
      const apiSecret = process.env[`MONITOR_${keyName}_SECRET`] || '';
      const passphrase = process.env[`MONITOR_${keyName}_PASSPHRASE`];

      if (!apiKey || !apiSecret) {
        log.warn(`Missing API keys for ${nickname} (MONITOR_${keyName}_KEY/SECRET)`);
        continue;
      }

      let displayName = nickname;
      if (exchange === 'okx') displayName = `${nickname} (OKX)`;
      if (exchange === 'bybit') displayName = `${nickname} (Bybit)`;

      operators.push({
        nickname,
        displayName,
        exchange: exchange as 'binance' | 'okx' | 'bybit',
        apiKey,
        apiSecret,
        passphrase,
      });
    }

    log.info(`Loaded ${operators.length} operators from MONITOR_OPS env vars`);
    return operators;
  }

  return [];
}

async function main(): Promise<void> {
  log.info('='.repeat(50));
  log.info('Operator Monitor v2 (Authenticated APIs)');
  log.info('='.repeat(50));

  const dbOk = await db.testConnection();
  if (!dbOk) {
    log.error('Database connection failed');
    process.exit(1);
  }
  log.info('Database connected');

  const operators = parseOperatorConfig();

  if (operators.length === 0) {
    log.error('No operators configured. Set MONITOR_CONFIG (JSON) or MONITOR_OPS + per-operator keys');
    log.error('Example MONITOR_CONFIG:');
    log.error('[{"nickname":"VillarrealCrypto","displayName":"VillarrealCrypto","exchange":"binance","apiKey":"xxx","apiSecret":"xxx"}]');
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
    operators: operators.map(o => `${o.displayName} (${o.exchange})`),
    intervalMinutes: config.checkIntervalMs / 60000,
    workday: `${config.workdayStart}:00 - ${config.workdayEnd}:00 (CDMX)`,
    lowFundsThreshold: config.lowFundsThreshold,
    proxy: getProxyAgent() ? 'configured' : 'none',
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
