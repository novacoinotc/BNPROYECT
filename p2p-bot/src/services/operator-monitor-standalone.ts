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
  proxyUrl?: string;   // Per-operator proxy
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

function getProxyAgent(op?: OperatorConfig): HttpsProxyAgent<string> | undefined {
  const proxyUrl = op?.proxyUrl || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  if (!proxyUrl) return undefined;
  return new HttpsProxyAgent(proxyUrl);
}

// ==================== BINANCE API ====================

function binanceSign(queryString: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

function parseBinanceAds(data: any): AdStatus {
  if (!data) return { isOnline: false, surplusAmount: null, adPrice: null, onlineAdsCount: 0 };

  // Response can be { sellList, buyList } or flat array
  let allAds: any[] = [];
  if (data.sellList || data.buyList) {
    allAds = [...(data.sellList || []), ...(data.buyList || [])];
  } else if (Array.isArray(data)) {
    allAds = data;
  }

  // advStatus: 1=online, 3=paused/offline
  const onlineAds = allAds.filter((ad: any) =>
    String(ad.advStatus) === '1'
  );
  const onlineSellAds = onlineAds.filter((ad: any) =>
    ad.tradeType === 'SELL' || String(ad.tradeType) === '1'
  );

  const bestPool = onlineSellAds.length > 0 ? onlineSellAds : onlineAds;
  if (bestPool.length === 0) {
    return { isOnline: false, surplusAmount: null, adPrice: null, onlineAdsCount: 0 };
  }

  const best = bestPool.sort((a: any, b: any) =>
    parseFloat(a.price || '0') - parseFloat(b.price || '0')
  )[0];

  return {
    isOnline: true,
    surplusAmount: parseFloat(best.surplusAmount || '0'),
    adPrice: parseFloat(best.price || '0'),
    onlineAdsCount: bestPool.length,
  };
}

async function checkBinanceAds(op: OperatorConfig): Promise<AdStatus> {
  const headers = { 'X-MBX-APIKEY': op.apiKey, 'Content-Type': 'application/json' };
  const agent = getProxyAgent(op);

  // POST /sapi/v1/c2c/ads/listWithPagination (confirmed working endpoint)
  try {
    const timestamp = Date.now();
    const params = `timestamp=${timestamp}`;
    const sig = binanceSign(params, op.apiSecret);
    const config: AxiosRequestConfig = { headers, timeout: 15000 };
    if (agent) config.httpsAgent = agent;
    const response = await axios.post(
      `https://api.binance.com/sapi/v1/c2c/ads/listWithPagination?${params}&signature=${sig}`,
      { page: 1, rows: 20 },
      config
    );
    return parseBinanceAds(response.data?.data);
  } catch (error: any) {
    const status = error.response?.status;
    const respData = error.response?.data;
    log.error({
      operator: op.displayName,
      status,
      respCode: respData?.code,
      respMsg: respData?.msg,
      error: error.message,
    }, 'Binance API check failed');
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

    const agent = getProxyAgent(op);
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

    // OKX active-list returns: array of ad objects directly, OR [{ sellAds, buyAds }] wrapper
    let allAds: any[] = [];

    if (Array.isArray(data)) {
      if (data.length > 0 && (data[0].sellAds || data[0].buyAds)) {
        // Wrapper format: [{ sellAds: [], buyAds: [] }]
        allAds = [...(data[0].sellAds || []), ...(data[0].buyAds || [])];
      } else {
        // Direct array of ad objects (confirmed from real API response)
        allAds = data;
      }
    }

    if (allAds.length === 0) {
      return { isOnline: false, surplusAmount: null, adPrice: null, onlineAdsCount: 0 };
    }

    // Filter sell ads (side=sell or tradeType)
    const sellAds = allAds.filter((ad: any) =>
      ad.side === 'sell' || ad.tradeType === 'sell'
    );

    const bestPool = sellAds.length > 0 ? sellAds : allAds;

    const best = bestPool.sort((a: any, b: any) =>
      parseFloat(a.unitPrice || a.price || '0') - parseFloat(b.unitPrice || b.price || '0')
    )[0];

    return {
      isOnline: true,
      surplusAmount: parseFloat(best.availableAmount || best.surplusAmount || '0'),
      adPrice: parseFloat(best.unitPrice || best.price || '0'),
      onlineAdsCount: bestPool.length,
    };
  } catch (error: any) {
    const status = error.response?.status;
    const respData = error.response?.data;
    log.error({ operator: op.displayName, status, respCode: respData?.code, respMsg: respData?.msg, error: error.message }, 'OKX API check failed');
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

    const agent = getProxyAgent(op);
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
  // Method 0: Base64-encoded JSON (most reliable for Railway)
  // MONITOR_CONFIG_B64=<base64 of JSON array>
  const b64Config = process.env.MONITOR_CONFIG_B64;
  if (b64Config) {
    try {
      const jsonStr = Buffer.from(b64Config.trim(), 'base64').toString('utf-8');
      const parsed = JSON.parse(jsonStr) as OperatorConfig[];
      log.info(`Loaded ${parsed.length} operators from MONITOR_CONFIG_B64`);
      return parsed;
    } catch (e: any) {
      log.error({ error: e.message }, 'Failed to parse MONITOR_CONFIG_B64');
    }
  }

  // Method 1: JSON config (direct)
  let jsonConfig = process.env.MONITOR_CONFIG;
  if (jsonConfig) {
    jsonConfig = jsonConfig.trim();
    if ((jsonConfig.startsWith('"') && jsonConfig.endsWith('"')) ||
        (jsonConfig.startsWith("'") && jsonConfig.endsWith("'"))) {
      jsonConfig = jsonConfig.slice(1, -1);
    }
    jsonConfig = jsonConfig.replace(/\\"/g, '"');

    try {
      const parsed = JSON.parse(jsonConfig) as OperatorConfig[];
      log.info(`Loaded ${parsed.length} operators from MONITOR_CONFIG JSON`);
      return parsed;
    } catch (e: any) {
      log.error({
        error: e.message,
        rawLength: jsonConfig.length,
        rawFirst50: jsonConfig.substring(0, 50),
      }, 'Failed to parse MONITOR_CONFIG JSON');
    }
  }

  // Method 2: Individual env vars per operator
  // MONITOR_OPS=VillarrealCrypto:binance,MisterShops:binance,ProcorpCrypto:okx,ProcorpCrypto:bybit,MisterOs:bybit
  // For each entry, tries: MONITOR_{NAME}_{EXCHANGE}_KEY first, then MONITOR_{NAME}_KEY
  // This handles operators with same name on different exchanges (e.g. ProcorpCrypto on OKX + Bybit)
  const opsList = process.env.MONITOR_OPS;
  if (opsList) {
    const operators: OperatorConfig[] = [];
    const entries = opsList.split(',').map(s => s.trim()).filter(Boolean);

    for (const entry of entries) {
      const [nickname, exchange] = entry.split(':');
      if (!nickname || !exchange) continue;

      const keyName = nickname.replace(/[-_\s]/g, '').toUpperCase();
      const exchUp = exchange.toUpperCase();

      // Try exchange-specific key first (for duplicates like ProcorpCrypto on OKX + Bybit)
      const apiKey = process.env[`MONITOR_${keyName}_${exchUp}_KEY`] || process.env[`MONITOR_${keyName}_KEY`] || '';
      const apiSecret = process.env[`MONITOR_${keyName}_${exchUp}_SECRET`] || process.env[`MONITOR_${keyName}_SECRET`] || '';
      const passphrase = process.env[`MONITOR_${keyName}_${exchUp}_PASSPHRASE`] || process.env[`MONITOR_${keyName}_PASSPHRASE`];
      const proxyUrl = process.env[`MONITOR_${keyName}_${exchUp}_PROXY`] || process.env[`MONITOR_${keyName}_PROXY`];

      if (!apiKey || !apiSecret) {
        log.warn(`Missing API keys for ${nickname}:${exchange} (tried MONITOR_${keyName}_${exchUp}_KEY and MONITOR_${keyName}_KEY)`);
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
        proxyUrl,
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
    operators: operators.map(o => {
      const proxyIp = o.proxyUrl ? o.proxyUrl.match(/@([^:]+)/)?.[1] || 'yes' : 'none';
      return `${o.displayName} (proxy=${proxyIp})`;
    }),
    intervalMinutes: config.checkIntervalMs / 60000,
    workday: `${config.workdayStart}:00 - ${config.workdayEnd}:00 (CDMX)`,
    lowFundsThreshold: config.lowFundsThreshold,
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
