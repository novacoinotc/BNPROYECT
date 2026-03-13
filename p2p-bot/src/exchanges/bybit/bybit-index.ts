// =====================================================
// BYBIT P2P TRADING BOT — ENTRY POINT
// Runs independently from Binance and OKX bots
// npx tsx src/exchanges/bybit/bybit-index.ts
// =====================================================

import 'dotenv/config';
import { logger } from '../../utils/logger.js';
import { getBybitClient } from './bybit-client.js';
import { createBybitPositioning, BybitPositioning } from './bybit-positioning.js';
import { createBybitOrderManager, BybitOrderManager } from './bybit-order-manager.js';
import { createBybitAutoRelease, BybitAutoRelease } from './bybit-auto-release.js';
import { createBybitAutoSwap, BybitAutoSwap } from './bybit-auto-swap.js';
import { createBybitBuyOrderManager, BybitBuyOrderManager } from './bybit-buy-order-manager.js';
import { createBybitApiServer, BybitApiServer } from './bybit-api-server.js';
import { createBybitOperatorMonitor } from './bybit-operator-monitor.js';
import { testConnection, disconnect, isPositioningEnabled, isReleaseEnabled } from '../../services/database-pg.js';

const log = logger.child({ module: 'bybit-main' });

// ==================== CONFIGURATION ====================

const BYBIT_CONFIG = {
  tradingAsset: process.env.BYBIT_TRADING_ASSET || 'USDT',
  tradingFiat: process.env.BYBIT_TRADING_FIAT || 'MXN',

  enablePositioning: process.env.BYBIT_ENABLE_POSITIONING !== 'false',
  enableOrderManager: process.env.BYBIT_ENABLE_ORDER_MANAGER !== 'false',
  enableAutoRelease: process.env.BYBIT_ENABLE_AUTO_RELEASE === 'true',
  enableAutoSwap: process.env.BYBIT_ENABLE_AUTO_SWAP === 'true',
  enableAutoBuy: process.env.BYBIT_ENABLE_AUTO_BUY === 'true',
  enableWebhook: process.env.BYBIT_ENABLE_WEBHOOK !== 'false',
};

// ==================== SERVICE INSTANCES ====================

let positioning: BybitPositioning | null = null;
let orderManager: BybitOrderManager | null = null;
let autoRelease: BybitAutoRelease | null = null;
let autoSwap: BybitAutoSwap | null = null;
let buyOrderManager: BybitBuyOrderManager | null = null;
let apiServer: BybitApiServer | null = null;
let positioningCheckInterval: NodeJS.Timeout | null = null;

// ==================== INITIALIZATION ====================

async function main(): Promise<void> {
  log.info('='.repeat(50));
  log.info('Bybit P2P Trading Bot Starting...');
  log.info('='.repeat(50));

  // 1. Validate env vars
  if (!process.env.BYBIT_API_KEY || !process.env.BYBIT_API_SECRET) {
    throw new Error('BYBIT_API_KEY and BYBIT_API_SECRET are required');
  }

  // 2. Test DB connection
  log.info('Testing database connection...');
  const dbConnected = await testConnection();
  if (!dbConnected) {
    log.error('Database connection failed');
  }

  // 3. Test Bybit API connection
  log.info('Testing Bybit API connection...');
  const client = getBybitClient();
  const userInfo = await client.getUserInfo();
  if (userInfo) {
    log.info({
      nickName: userInfo.nickName,
      userId: userInfo.userId,
      totalOrders: userInfo.totalFinishCount,
    }, 'Bybit API connected');
  } else {
    log.warn('Bybit getUserInfo returned null — check credentials');
  }

  // 4. Check balance
  const balances = await client.getCoinBalance('FUND', 'USDT');
  const usdt = balances.find(b => b.coin === 'USDT');
  if (usdt) {
    log.info({ balance: usdt.walletBalance, transferable: usdt.transferBalance }, 'USDT Balance');
  }

  log.info({
    asset: BYBIT_CONFIG.tradingAsset,
    fiat: BYBIT_CONFIG.tradingFiat,
    positioning: BYBIT_CONFIG.enablePositioning,
    orderManager: BYBIT_CONFIG.enableOrderManager,
    autoRelease: BYBIT_CONFIG.enableAutoRelease,
    webhook: BYBIT_CONFIG.enableWebhook,
    autoSwap: BYBIT_CONFIG.enableAutoSwap,
    autoBuy: BYBIT_CONFIG.enableAutoBuy,
  }, 'Bybit Bot configuration');

  // 5. Start services
  await startServices();

  // 6. Graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info('='.repeat(50));
  log.info('Bybit Bot fully operational!');
  log.info('='.repeat(50));
}

// ==================== START SERVICES ====================

async function startServices(): Promise<void> {
  // Order Manager — always start if enabled (needed by auto-release)
  if (BYBIT_CONFIG.enableOrderManager) {
    orderManager = createBybitOrderManager();
    await orderManager.start();

    orderManager.on('order', (event) => {
      log.info({
        type: event.type,
        orderId: event.order.orderNumber,
        amount: event.order.totalPrice,
        status: event.order.orderStatus,
      }, `Bybit ORDER: ${event.type}`);
    });

    log.info('Bybit Order Manager started');
  }

  // API Server — dashboard endpoints + webhook receiver
  if (BYBIT_CONFIG.enableWebhook) {
    apiServer = createBybitApiServer({
      port: parseInt(process.env.PORT || process.env.BYBIT_WEBHOOK_PORT || '3002'),
      webhookSecret: process.env.BYBIT_WEBHOOK_SECRET,
      webhookPath: process.env.BYBIT_WEBHOOK_PATH || '/webhook/bank-deposit',
    });

    apiServer.on('payment', (event) => {
      log.info({
        transactionId: event.payload.transactionId,
        amount: event.payload.amount,
        sender: event.payload.senderName,
      }, 'Bybit: Bank payment received');
    });

    await apiServer.start();
    log.info({ port: process.env.PORT || process.env.BYBIT_WEBHOOK_PORT || '3002' }, 'Bybit API Server started');
  }

  // Auto-Release — requires order manager
  if (BYBIT_CONFIG.enableAutoRelease && orderManager) {
    autoRelease = createBybitAutoRelease({}, orderManager);

    autoRelease.on('release', (event) => {
      log.info({
        type: event.type,
        orderId: event.orderNumber,
        reason: event.reason,
      }, `Bybit RELEASE: ${event.type}`);

      // Broadcast to dashboard via SSE
      if (apiServer) {
        apiServer.broadcastSSE({
          type: 'order_released',
          orderNumber: event.orderNumber,
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Connect webhook for bank payment matching
    if (apiServer) {
      autoRelease.connectWebhook(apiServer);
      log.info('Bybit Auto-Release connected to API server');
    }

    log.info('Bybit Auto-Release started');
  }

  // Positioning — check DB toggle periodically
  if (BYBIT_CONFIG.enablePositioning) {
    positioningCheckInterval = setInterval(checkPositioningStatus, 30000);
    setTimeout(checkPositioningStatus, 5000);
    log.info('Bybit Positioning check started (30s interval)');
  }

  // Auto-Swap
  if (BYBIT_CONFIG.enableAutoSwap) {
    autoSwap = createBybitAutoSwap();
    await autoSwap.start();

    autoSwap.on('swap', (event) => {
      if (event.type === 'completed') {
        log.info({
          asset: event.asset,
          qty: event.executedQty,
          usdt: event.receivedUsdt,
        }, `Bybit SWAP: ${event.asset} -> USDT`);
      } else {
        log.error({ asset: event.asset, error: event.error }, 'Bybit SWAP failed');
      }
    });

    log.info('Bybit Auto-Swap started');
  }

  // Auto-Buy (Autopago)
  if (BYBIT_CONFIG.enableAutoBuy) {
    buyOrderManager = createBybitBuyOrderManager();
    await buyOrderManager.start();

    buyOrderManager.on('dispatch', (event) => {
      log.info({
        type: event.type,
        orderId: event.orderId,
        amount: event.amount,
      }, `Bybit BUY DISPATCH: ${event.type}`);
    });

    log.info('Bybit Auto-Buy started');
  }

  // Operator monitor
  const operatorMonitor = createBybitOperatorMonitor();
  if (operatorMonitor) {
    await operatorMonitor.start();
  }

  // Wire service references to API server for dashboard endpoints
  if (apiServer) {
    apiServer.setServices({
      orderManager: orderManager || undefined,
      positioning: positioning || undefined,
      autoRelease: autoRelease || undefined,
      autoSwap: autoSwap || undefined,
      buyOrderManager: buyOrderManager || undefined,
    });
  }

  // Broadcast order events to dashboard via SSE
  if (orderManager && apiServer) {
    orderManager.on('order', (event) => {
      apiServer!.broadcastSSE({
        type: 'order_update',
        eventType: event.type,
        orderNumber: event.order.orderNumber,
        status: event.order.orderStatus,
        amount: event.order.totalPrice,
        timestamp: new Date().toISOString(),
      });
    });
  }
}

// ==================== POSITIONING CHECK ====================

async function checkPositioningStatus(): Promise<void> {
  try {
    const enabled = await isPositioningEnabled();

    if (enabled && !positioning) {
      positioning = createBybitPositioning();
      await positioning.start(12000);

      positioning.on('priceUpdated', (event) => {
        log.info({
          tokenId: event.tokenId,
          side: event.side,
          oldPrice: event.oldPrice.toFixed(2),
          newPrice: event.newPrice.toFixed(2),
          mode: event.mode,
        }, `Bybit PRICE UPDATE: ${event.oldPrice.toFixed(2)} -> ${event.newPrice.toFixed(2)}`);
      });

      if (apiServer) apiServer.setServices({ positioning });
      log.info('Bybit Positioning started');
    } else if (!enabled && positioning) {
      positioning.stop();
      positioning = null;
      log.info('Bybit Positioning stopped');
    }
  } catch {
    // Silent — don't spam logs on DB issues
  }
}

// ==================== SHUTDOWN ====================

async function shutdown(): Promise<void> {
  log.info('Bybit Bot shutting down...');

  if (positioningCheckInterval) {
    clearInterval(positioningCheckInterval);
    positioningCheckInterval = null;
  }

  if (positioning) {
    positioning.stop();
    positioning = null;
  }

  if (orderManager) {
    orderManager.stop();
    orderManager = null;
  }

  if (autoSwap) {
    autoSwap.stop();
    autoSwap = null;
  }

  if (buyOrderManager) {
    buyOrderManager.stop();
    buyOrderManager = null;
  }

  autoRelease = null;

  if (apiServer) {
    await apiServer.stop();
    apiServer = null;
  }

  await disconnect();

  log.info('Bybit Bot goodbye!');
  process.exit(0);
}

// ==================== ERROR HANDLING ====================

process.on('uncaughtException', (error) => {
  log.fatal({ error }, 'Bybit: Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'Bybit: Unhandled rejection');
});

// ==================== START ====================

main().catch((error) => {
  log.fatal({ error }, 'Bybit: Failed to initialize');
  process.exit(1);
});

// ==================== EXPORTS ====================

export { positioning, orderManager, autoRelease, autoSwap, buyOrderManager, apiServer, BYBIT_CONFIG };
