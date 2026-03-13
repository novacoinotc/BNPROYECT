// =====================================================
// OKX P2P TRADING BOT — ENTRY POINT
// Runs independently from Binance bot
// npx tsx src/exchanges/okx/okx-index.ts
// =====================================================

import 'dotenv/config';
import { logger } from '../../utils/logger.js';
import { getOkxClient } from './okx-client.js';
import { createOkxOrderManager, OkxOrderManager } from './okx-order-manager.js';
import { createOkxAutoRelease, OkxAutoRelease } from './okx-auto-release.js';
import { createOkxPositioning, OkxPositioning } from './okx-positioning.js';
import { createOkxAutoSwap, OkxAutoSwap } from './okx-auto-swap.js';
import { testConnection, disconnect, isPositioningEnabled, getBotConfig } from '../../services/database-pg.js';

const log = logger.child({ module: 'okx-main' });

// ==================== CONFIGURATION ====================

const OKX_CONFIG = {
  // Trading
  tradingAsset: process.env.OKX_TRADING_ASSET || 'USDT',
  tradingFiat: process.env.OKX_TRADING_FIAT || 'MXN',
  tradeType: (process.env.OKX_TRADE_TYPE?.toLowerCase() || 'sell') as 'buy' | 'sell',

  // Features
  enableAutoRelease: process.env.OKX_ENABLE_AUTO_RELEASE === 'true',
  enablePositioning: process.env.OKX_ENABLE_POSITIONING !== 'false',
  enableAutoSwap: process.env.OKX_ENABLE_AUTO_SWAP === 'true',
  enableWebhook: process.env.OKX_ENABLE_WEBHOOK !== 'false',
};

// ==================== SERVICE INSTANCES ====================

let orderManager: OkxOrderManager | null = null;
let autoRelease: OkxAutoRelease | null = null;
let positioning: OkxPositioning | null = null;
let autoSwap: OkxAutoSwap | null = null;
let positioningCheckInterval: NodeJS.Timeout | null = null;

// ==================== INITIALIZATION ====================

async function main(): Promise<void> {
  log.info('='.repeat(50));
  log.info('OKX P2P Trading Bot Starting...');
  log.info('='.repeat(50));

  // 1. Validate env vars
  if (!process.env.OKX_API_KEY || !process.env.OKX_API_SECRET || !process.env.OKX_PASSPHRASE) {
    throw new Error('OKX_API_KEY, OKX_API_SECRET, and OKX_PASSPHRASE are required');
  }

  // 2. Test DB connection
  log.info('Testing database connection...');
  const dbConnected = await testConnection();
  if (!dbConnected) {
    log.error('Database connection failed — orders will not be saved');
  }

  // 3. Test OKX API connection
  log.info('Testing OKX API connection...');
  const client = getOkxClient();
  const userInfo = await client.getUserInfo();
  if (userInfo) {
    log.info({ nickName: userInfo.nickName, merchantId: userInfo.merchantId }, 'OKX API connected');
  } else {
    log.warn('OKX getUserInfo returned null — check credentials');
  }

  log.info({
    asset: OKX_CONFIG.tradingAsset,
    fiat: OKX_CONFIG.tradingFiat,
    tradeType: OKX_CONFIG.tradeType,
    autoRelease: OKX_CONFIG.enableAutoRelease,
    positioning: OKX_CONFIG.enablePositioning,
    autoSwap: OKX_CONFIG.enableAutoSwap,
  }, 'OKX Bot configuration');

  // 4. Initialize services
  await initializeServices();

  // 5. Wire events
  setupEventHandlers();

  // 6. Start services
  await startServices();

  log.info('='.repeat(50));
  log.info('OKX Bot fully operational!');
  log.info('='.repeat(50));
}

// ==================== SERVICE INITIALIZATION ====================

async function initializeServices(): Promise<void> {
  // Order Manager
  orderManager = createOkxOrderManager({
    tradeType: OKX_CONFIG.tradeType,
  });
  log.info('OKX Order manager initialized');

  // Auto Release (NO chatHandler, NO totpService needed)
  autoRelease = createOkxAutoRelease({}, orderManager);
  log.info('OKX Auto-Release initialized');

  // Connect webhook receiver if available
  // The webhook receiver is shared with Binance — it's started from the Binance process
  // OKX connects to it via events. If running standalone, we need our own webhook.
  if (OKX_CONFIG.enableWebhook) {
    try {
      // Try to import and reuse the existing webhook receiver
      const { createWebhookReceiver } = await import('../../services/webhook-receiver.js');
      const webhookReceiver = createWebhookReceiver();
      autoRelease.connectWebhook(webhookReceiver);

      // Add OKX API endpoints to the webhook server
      const app = webhookReceiver.getApp();
      setupApiEndpoints(app);

      // Start webhook if not already running
      await webhookReceiver.start();
      log.info('Webhook receiver connected to OKX Auto-Release');
    } catch (error) {
      log.warn('Could not start webhook receiver — bank payment matching disabled');
    }
  }
}

// ==================== API ENDPOINTS ====================

function setupApiEndpoints(app: import('express').Application): void {
  const client = getOkxClient();

  // Sellers endpoint — used by dashboard to show OKX competitors
  app.get('/api/sellers', async (req, res) => {
    try {
      const asset = (req.query.asset as string) || 'USDT';
      const fiat = (req.query.fiat as string) || 'MXN';
      const tradeType = (req.query.tradeType as string) || 'SELL';
      const rows = parseInt(req.query.rows as string) || 20;

      // Dashboard: SELL panel sends tradeType=BUY (wants seller ads to compare)
      const side: 'buy' | 'sell' = tradeType === 'BUY' ? 'sell' : 'buy';

      const perPage = 20;
      const pages = Math.ceil(rows / perPage);
      let allAds: import('./okx-types.js').OkxAdData[] = [];

      for (let page = 1; page <= pages; page++) {
        const ads = await client.searchAds(side, asset, fiat, page, perPage);
        allAds.push(...ads);
        if (ads.length < perPage) break;
      }

      const sellers = allAds.filter(ad => ad.creator).slice(0, rows).map((ad, idx) => ({
        position: idx + 1,
        userNo: ad.creator?.userId || ad.creator?.merchantId || '',
        nickName: ad.creator?.nickName || 'unknown',
        price: ad.unitPrice,
        surplusAmount: ad.availableAmount,
        minAmount: ad.minAmount,
        maxAmount: ad.maxAmount,
        isOnline: ad.creator?.isOnline ?? true,
        userGrade: ad.creator?.userGrade || 0,
        monthFinishRate: ad.creator?.completionRate || 0,
        monthOrderCount: ad.creator?.completedOrders || 0,
        positiveRate: ad.creator?.completionRate || 0,
        proMerchant: (ad.creator?.userGrade || 0) >= 2,
      }));

      res.json({
        success: true,
        sellers,
        asset,
        fiat,
        tradeType,
        timestamp: new Date().toISOString(),
        source: 'okx-proxy',
      });
    } catch (error: any) {
      log.error({ error: error.message }, 'OKX sellers fetch error');
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Ads endpoint — used by dashboard to show our own OKX ads
  app.get('/api/ads', async (_req, res) => {
    try {
      const sellAds = await client.getActiveAds('sell', OKX_CONFIG.tradingAsset, OKX_CONFIG.tradingFiat);
      const buyAds = await client.getActiveAds('buy', OKX_CONFIG.tradingAsset, OKX_CONFIG.tradingFiat);
      const userInfo = await client.getUserInfo();

      res.json({
        success: true,
        sellAds: sellAds.map(ad => ({
          advNo: ad.adId,
          price: ad.unitPrice,
          surplusAmount: ad.availableAmount,
          minSingleTransAmount: ad.minAmount,
          maxSingleTransAmount: ad.maxAmount,
          tradableQuantity: ad.availableAmount,
          asset: ad.cryptoCurrency,
          fiat: ad.fiatCurrency,
          tradeType: 'SELL',
          advStatus: ad.status === 'online' ? 1 : 0,
        })),
        buyAds: buyAds.map(ad => ({
          advNo: ad.adId,
          price: ad.unitPrice,
          surplusAmount: ad.availableAmount,
          minSingleTransAmount: ad.minAmount,
          maxSingleTransAmount: ad.maxAmount,
          tradableQuantity: ad.availableAmount,
          asset: ad.cryptoCurrency,
          fiat: ad.fiatCurrency,
          tradeType: 'BUY',
          advStatus: ad.status === 'online' ? 1 : 0,
        })),
        merchant: userInfo ? { nickName: userInfo.nickName } : null,
        source: 'okx-proxy',
      });
    } catch (error: any) {
      log.error({ error: error.message }, 'OKX ads fetch error');
      res.status(500).json({ success: false, error: error.message });
    }
  });

  log.info('OKX API endpoints registered (/api/sellers, /api/ads)');
}

function setupEventHandlers(): void {
  if (!orderManager || !autoRelease) return;

  // Order events → log + broadcast
  orderManager.on('order', (event) => {
    if (event.type === 'new' || event.type === 'paid') {
      log.info({
        type: event.type,
        orderId: event.order.orderNumber,
        amount: event.order.totalPrice,
        buyer: event.order.counterPartNickName,
      }, `OKX Order ${event.type.toUpperCase()}`);
    } else if (event.type === 'released') {
      log.info({ orderId: event.order.orderNumber }, 'OKX Order completed');
    } else if (event.type === 'cancelled') {
      log.info({ orderId: event.order.orderNumber }, 'OKX Order cancelled');
    }
  });

  // Release events
  autoRelease.on('release', (event) => {
    switch (event.type) {
      case 'release_success':
        log.info({ orderId: event.orderNumber }, 'OKX: CRYPTO RELEASED');
        break;
      case 'release_failed':
        log.error({ orderId: event.orderNumber, reason: event.reason }, 'OKX: Release failed');
        break;
      case 'manual_required':
        log.warn({ orderId: event.orderNumber, reason: event.reason }, 'OKX: Manual intervention required');
        break;
    }
  });

  // Graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ==================== START SERVICES ====================

async function startServices(): Promise<void> {
  if (!orderManager) return;

  // Start order polling
  await orderManager.start();
  log.info('OKX Order polling started');

  // Start positioning check loop
  if (OKX_CONFIG.enablePositioning) {
    positioningCheckInterval = setInterval(checkPositioningStatus, 30000);
    // Initial check after 5s
    setTimeout(checkPositioningStatus, 5000);
    log.info('OKX Positioning check started (30s interval)');
  }

  // Start auto-swap
  if (OKX_CONFIG.enableAutoSwap) {
    autoSwap = createOkxAutoSwap();
    await autoSwap.start();
    log.info('OKX Auto-Swap started');
  }
}

// ==================== POSITIONING CHECK ====================

async function checkPositioningStatus(): Promise<void> {
  try {
    const enabled = await isPositioningEnabled();

    if (enabled && !positioning) {
      positioning = createOkxPositioning();
      await positioning.start(12000);
      log.info('OKX Positioning started');
    } else if (!enabled && positioning) {
      positioning.stop();
      positioning = null;
      log.info('OKX Positioning stopped');
    }
  } catch {
    // Silent — don't spam logs on DB issues
  }
}

// ==================== SHUTDOWN ====================

async function shutdown(): Promise<void> {
  log.info('OKX Bot shutting down...');

  if (positioningCheckInterval) {
    clearInterval(positioningCheckInterval);
    positioningCheckInterval = null;
  }

  if (positioning) {
    positioning.stop();
    positioning = null;
  }

  if (autoSwap) {
    autoSwap.stop();
    autoSwap = null;
  }

  if (orderManager) {
    orderManager.stop();
    orderManager = null;
  }

  await disconnect();

  log.info('OKX Bot goodbye!');
  process.exit(0);
}

// ==================== ERROR HANDLING ====================

process.on('uncaughtException', (error) => {
  log.fatal({ error }, 'OKX: Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'OKX: Unhandled rejection');
});

// ==================== START ====================

main().catch((error) => {
  log.fatal({ error }, 'OKX: Failed to initialize');
  process.exit(1);
});

// ==================== EXPORTS ====================

export {
  orderManager,
  autoRelease,
  positioning,
  autoSwap,
  OKX_CONFIG,
};
