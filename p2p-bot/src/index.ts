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
import { createTOTPService, TOTPService } from './services/totp-service.js';
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
let totpService: TOTPService;

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

  // TOTP Service for 2FA code generation
  totpService = createTOTPService();
  if (totpService.isConfigured()) {
    logger.info('TOTP service configured - auto-release 2FA ready');
  } else {
    logger.warn('TOTP_SECRET not configured - auto-release will require manual 2FA');
  }

  // Auto Release Orchestrator
  autoRelease = createAutoReleaseOrchestrator(
    {},
    orderManager,
    chatHandler,
    webhookReceiver,
    ocrService
  );

  // Setup 2FA code provider using TOTP
  autoRelease.setVerificationCodeProvider(async (orderNumber, authType) => {
    // Check if TOTP is configured for automatic code generation
    if (totpService.isConfigured() && authType === AuthType.GOOGLE) {
      const code = totpService.generateCode();
      logger.info({
        orderNumber,
        authType,
        timeRemaining: totpService.getTimeRemaining(),
      }, '🔐 Generated TOTP code for auto-release');
      return code;
    }

    // If TOTP not configured, log and throw error for manual handling
    logger.warn({
      orderNumber,
      authType,
      totpConfigured: totpService.isConfigured(),
    }, '⚠️ Manual 2FA code required - TOTP not available');

    throw new Error('TOTP not configured - manual release required');
  });

  logger.info({
    autoReleaseEnabled: BOT_CONFIG.enableAutoRelease,
    totpConfigured: totpService.isConfigured(),
    maxAmount: process.env.MAX_AUTO_RELEASE_AMOUNT || '50000',
  }, 'Auto-release orchestrator initialized');
}

function setupEventHandlers(): void {
  // Order events - broadcast to SSE clients for real-time updates
  orderManager.on('order', (event) => {
    // Only log significant events, not routine updates
    if (event.type === 'new' || event.type === 'paid') {
      logger.info({
        type: event.type,
        orderNumber: event.order.orderNumber,
        amount: event.order.totalPrice,
        buyer: event.order.counterPartNickName,
      }, `📦 Order ${event.type === 'new' ? 'NEW' : 'PAID'}`);
    } else if (event.type === 'released') {
      logger.info({ orderNumber: event.order.orderNumber }, '✅ Order completed');
    } else if (event.type === 'cancelled') {
      logger.info({ orderNumber: event.order.orderNumber }, '❌ Order cancelled');
    }

    // Broadcast to SSE clients for real-time dashboard updates
    webhookReceiver.broadcastSSE({
      type: 'order_update',
      eventType: event.type,
      orderNumber: event.order.orderNumber,
      status: event.order.orderStatus,
      amount: event.order.totalPrice,
      buyer: event.order.counterPartNickName,
      timestamp: new Date().toISOString(),
    });
  });

  // Price update events - pricing-engine already logs changes

  // Release events - only log important ones
  autoRelease.on('release', (event) => {
    switch (event.type) {
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
