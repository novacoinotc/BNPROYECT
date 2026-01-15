// =====================================================
// BINANCE P2P TRADING BOT
// Main entry point
// =====================================================

import 'dotenv/config';
import { logger } from './utils/logger.js';
import { getBinanceClient } from './services/binance-client.js';
import { createPricingEngine } from './services/pricing-engine.js';
import { createOrderManager } from './services/order-manager.js';
import { getChatHandler } from './services/chat-handler.js';
import { createWebhookReceiver } from './services/webhook-receiver.js';
import { createOCRService } from './services/ocr-service.js';
import { createAutoReleaseOrchestrator } from './services/auto-release.js';
import { testConnection, disconnect } from './services/database-pg.js';
import { TradeType, AuthType } from './types/binance.js';

// ==================== CONFIGURATION ====================

const BOT_CONFIG = {
  // Trading pair
  asset: process.env.TRADING_ASSET || 'USDT',
  fiat: process.env.TRADING_FIAT || 'MXN',
  tradeType: (process.env.TRADE_TYPE as TradeType) || TradeType.SELL,

  // Advertisement
  advNo: process.env.BINANCE_ADV_NO || '',

  // Features
  enablePricing: process.env.ENABLE_PRICING !== 'false',
  enableChat: process.env.ENABLE_CHAT !== 'false',
  enableWebhook: process.env.ENABLE_WEBHOOK !== 'false',
  enableOcr: process.env.ENABLE_OCR !== 'false',
  enableAutoRelease: process.env.ENABLE_AUTO_RELEASE === 'true',
};

// ==================== SERVICES ====================

let pricingEngine: ReturnType<typeof createPricingEngine>;
let orderManager: ReturnType<typeof createOrderManager>;
let chatHandler: ReturnType<typeof getChatHandler>;
let webhookReceiver: ReturnType<typeof createWebhookReceiver>;
let ocrService: ReturnType<typeof createOCRService>;
let autoRelease: ReturnType<typeof createAutoReleaseOrchestrator>;

// ==================== INITIALIZATION ====================

async function initialize(): Promise<void> {
  logger.info('='.repeat(50));
  logger.info('Binance P2P Trading Bot Starting...');
  logger.info('='.repeat(50));

  // Validate required configuration
  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
    throw new Error('BINANCE_API_KEY and BINANCE_API_SECRET are required');
  }

  // Test database connection first
  logger.info('Testing database connection...');
  const dbConnected = await testConnection();
  if (!dbConnected) {
    logger.error('Database connection failed - orders will not be saved');
  }

  // Initialize Binance client (validates connection)
  const client = getBinanceClient();

  logger.info({
    asset: BOT_CONFIG.asset,
    fiat: BOT_CONFIG.fiat,
    tradeType: BOT_CONFIG.tradeType,
  }, 'Bot configuration loaded');

  // Initialize services
  await initializeServices();

  // Setup event handlers
  setupEventHandlers();

  // Start services
  await startServices();

  logger.info('='.repeat(50));
  logger.info('Bot fully operational!');
  logger.info('='.repeat(50));
}

async function initializeServices(): Promise<void> {
  // Order Manager
  orderManager = createOrderManager();
  logger.info('Order manager initialized');

  // Pricing Engine
  pricingEngine = createPricingEngine();
  logger.info('Pricing engine initialized');

  // Chat Handler
  chatHandler = getChatHandler();
  logger.info('Chat handler initialized');

  // Webhook Receiver
  webhookReceiver = createWebhookReceiver();
  logger.info('Webhook receiver initialized');

  // OCR Service
  ocrService = createOCRService();
  if (BOT_CONFIG.enableOcr) {
    await ocrService.initialize();
    logger.info('OCR service initialized');
  }

  // Auto Release Orchestrator
  autoRelease = createAutoReleaseOrchestrator(
    {},
    orderManager,
    chatHandler,
    webhookReceiver,
    ocrService
  );

  // Setup 2FA code provider
  autoRelease.setVerificationCodeProvider(async (orderNumber, authType) => {
    // TODO: Implement TOTP generation or manual input
    // For now, this requires manual intervention
    logger.warn({
      orderNumber,
      authType,
    }, 'Manual 2FA code required for release');

    // This should be replaced with actual TOTP generation
    // using a library like 'otplib' with the secret from env
    throw new Error('2FA code provider not implemented');
  });

  logger.info('Auto-release orchestrator initialized');
}

function setupEventHandlers(): void {
  // Order events
  orderManager.on('order', (event) => {
    logger.info({
      type: event.type,
      orderNumber: event.order.orderNumber,
      amount: event.order.totalPrice,
    }, 'Order event');
  });

  // Price update events
  pricingEngine.onPriceUpdate((price, analysis) => {
    logger.info({
      price: price.toFixed(2),
      margin: analysis.margin.toFixed(2) + '%',
      position: analysis.pricePosition,
    }, 'Price updated');
  });

  // Release events
  autoRelease.on('release', (event) => {
    switch (event.type) {
      case 'verification_started':
        logger.info({ orderNumber: event.orderNumber }, 'Verification started');
        break;

      case 'verification_complete':
        logger.info({
          orderNumber: event.orderNumber,
          data: event.data,
        }, 'Verification complete');
        break;

      case 'release_success':
        logger.info({
          orderNumber: event.orderNumber,
          data: event.data,
        }, '✓ CRYPTO RELEASED');
        break;

      case 'release_failed':
        logger.error({
          orderNumber: event.orderNumber,
          reason: event.reason,
        }, '✗ Release failed');
        break;

      case 'manual_required':
        logger.warn({
          orderNumber: event.orderNumber,
          reason: event.reason,
        }, '⚠ Manual intervention required');
        break;
    }
  });

  // Webhook events
  webhookReceiver.on('payment', (event) => {
    logger.info({
      transactionId: event.payload.transactionId,
      amount: event.payload.amount,
      sender: event.payload.senderName,
    }, 'Bank payment received');
  });

  // Graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function startServices(): Promise<void> {
  // Start order polling (includes initial sync)
  await orderManager.start();
  logger.info('Order polling started');

  // Start chat WebSocket
  if (BOT_CONFIG.enableChat) {
    await chatHandler.connect();
    logger.info('Chat WebSocket connected');
  }

  // Start webhook server
  if (BOT_CONFIG.enableWebhook) {
    await webhookReceiver.start();
    logger.info('Webhook server started');
  }

  // Start price auto-update
  if (BOT_CONFIG.enablePricing && BOT_CONFIG.advNo) {
    pricingEngine.startAutoUpdate(
      BOT_CONFIG.advNo,
      BOT_CONFIG.asset,
      BOT_CONFIG.fiat,
      BOT_CONFIG.tradeType
    );
    logger.info('Price auto-update started');
  }
}

// ==================== SHUTDOWN ====================

async function shutdown(): Promise<void> {
  logger.info('Shutting down...');

  // Stop services
  orderManager.stop();
  pricingEngine.stopAutoUpdate();
  chatHandler.disconnect();
  await webhookReceiver.stop();
  await ocrService.terminate();
  await disconnect();

  logger.info('Goodbye!');
  process.exit(0);
}

// ==================== ERROR HANDLING ====================

process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled rejection');
});

// ==================== START ====================

initialize().catch((error) => {
  logger.fatal({ error }, 'Failed to initialize bot');
  process.exit(1);
});

// ==================== EXPORTS (for testing) ====================

export {
  pricingEngine,
  orderManager,
  chatHandler,
  webhookReceiver,
  ocrService,
  autoRelease,
  BOT_CONFIG,
};
