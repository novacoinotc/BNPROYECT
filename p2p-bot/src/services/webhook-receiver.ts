// =====================================================
// WEBHOOK RECEIVER
// Receives payment notifications from bank core
// =====================================================

import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { webhookLogger as logger } from '../utils/logger.js';
import { BankWebhookPayload } from '../types/binance.js';
import * as db from './database-pg.js';
import { getBinanceClient } from './binance-client.js';

export interface WebhookConfig {
  port: number;
  webhookSecret: string;
  webhookPath: string;
  allowedIPs?: string[];
}

export interface WebhookEvent {
  type: 'payment' | 'reversal' | 'error';
  payload: BankWebhookPayload;
  verified: boolean;
  receivedAt: Date;
}

export class WebhookReceiver extends EventEmitter {
  private app: express.Application;
  private config: WebhookConfig;
  private server: any = null;
  private isRunning: boolean = false;

  // Store recent payments to detect duplicates
  private recentPayments: Map<string, Date> = new Map();
  private readonly DUPLICATE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

  constructor(config: WebhookConfig) {
    super();
    this.config = config;
    this.app = express();

    this.setupMiddleware();
    this.setupRoutes();

    logger.info({ port: config.port }, 'Webhook receiver initialized');
  }

  // ==================== MIDDLEWARE ====================

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    // Parse raw body for signature verification
    this.app.use(express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }));

    // IP whitelist middleware
    if (this.config.allowedIPs && this.config.allowedIPs.length > 0) {
      this.app.use(this.config.webhookPath, (req, res, next) => {
        const clientIP = this.getClientIP(req);

        if (!this.config.allowedIPs!.includes(clientIP)) {
          logger.warn({ clientIP }, 'Blocked request from unauthorized IP');
          return res.status(403).json({ error: 'Forbidden' });
        }

        next();
      });
    }

    // Request logging
    this.app.use((req, _res, next) => {
      logger.debug({
        method: req.method,
        path: req.path,
        ip: this.getClientIP(req),
      }, 'Incoming request');
      next();
    });
  }

  /**
   * Get client IP from request
   */
  private getClientIP(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      return (forwarded as string).split(',')[0].trim();
    }
    return req.socket.remoteAddress || '';
  }

  // ==================== ROUTES ====================

  /**
   * Setup webhook routes
   */
  private setupRoutes(): void {
    // CORS middleware for API endpoints
    this.app.use('/api', (req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    });

    // Health check
    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        service: 'p2p-bot-webhook',
        timestamp: new Date().toISOString(),
      });
    });

    // ==================== PROXY ENDPOINTS (for dashboard) ====================

    // Ads proxy - allows dashboard to fetch ads through Railway (bypasses geo-restriction)
    this.app.get('/api/ads', this.handleAdsProxy.bind(this));

    // Orders sync - fetches orders from Binance and saves to DB
    this.app.post('/api/orders/sync', this.handleOrdersSync.bind(this));

    // Bank payment webhook
    this.app.post(this.config.webhookPath, this.handlePaymentWebhook.bind(this));

    // Alias route for core bancario integration
    this.app.post('/webhook/bank', this.handlePaymentWebhook.bind(this));

    // Payment reversal webhook (chargebacks)
    this.app.post(`${this.config.webhookPath}/reversal`, this.handleReversalWebhook.bind(this));

    // 404 handler
    this.app.use((_req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    // Error handler
    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      logger.error({ error: err }, 'Webhook error');
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  // ==================== PROXY HANDLERS ====================

  /**
   * Handle ads proxy request (for dashboard)
   * This bypasses Binance geo-restriction by running from Railway (EU)
   */
  private async handleAdsProxy(_req: Request, res: Response): Promise<void> {
    try {
      const client = getBinanceClient();
      const adsData = await client.listMyAds();

      // listMyAds returns MerchantAdsDetail with sellList, buyList, merchant
      const sellAds = adsData.sellList || [];
      const buyAds = adsData.buyList || [];
      const merchant = adsData.merchant || null;

      res.json({
        success: true,
        sellAds,
        buyAds,
        merchant,
        source: 'railway-proxy',
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Ads proxy error');
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to fetch ads from Binance',
      });
    }
  }

  /**
   * Handle orders sync request (for dashboard)
   * Fetches orders from Binance and saves them to the database
   */
  private async handleOrdersSync(_req: Request, res: Response): Promise<void> {
    try {
      const client = getBinanceClient();

      logger.info('Starting orders sync from Binance...');

      // Fetch pending orders (TRADING, BUYER_PAYED)
      let pendingOrders: any[] = [];
      try {
        pendingOrders = await client.listPendingOrders(50);
        logger.info({ count: pendingOrders.length }, 'Fetched pending orders');
      } catch (err: any) {
        logger.warn({ error: err.message }, 'Failed to fetch pending orders');
      }

      // Fetch recent order history (includes COMPLETED, CANCELLED)
      let recentOrders: any[] = [];
      try {
        recentOrders = await client.listOrderHistory({
          tradeType: 'SELL' as any,
          rows: 50,
        });
        logger.info({ count: recentOrders.length }, 'Fetched recent orders');
      } catch (err: any) {
        logger.warn({ error: err.message }, 'Failed to fetch recent orders');
      }

      // Combine and deduplicate
      const allOrders = new Map<string, any>();
      for (const order of [...pendingOrders, ...recentOrders]) {
        allOrders.set(order.orderNumber, order);
      }

      logger.info({ total: allOrders.size }, 'Total unique orders to sync');

      // Save all orders to database
      let savedCount = 0;
      let errorCount = 0;
      let verificationTriggered = 0;
      const savedOrders: any[] = [];

      for (const order of allOrders.values()) {
        try {
          await db.saveOrder(order);
          savedCount++;
          savedOrders.push({
            orderNumber: order.orderNumber,
            status: order.orderStatus,
            amount: order.totalPrice,
            buyer: order.counterPartNickName || order.buyer?.nickName,
          });

          // For BUYER_PAYED orders, check if they need verification started
          if (order.orderStatus === 'BUYER_PAYED') {
            const dbOrder = await db.getOrder(order.orderNumber);

            // If no verification status, start verification process
            if (!dbOrder?.verificationStatus) {
              logger.info({ orderNumber: order.orderNumber }, '📝 Starting verification for BUYER_PAYED order during sync');

              // Add initial verification step
              await db.addVerificationStep(
                order.orderNumber,
                'BUYER_MARKED_PAID' as any,
                'Comprador marcó como pagado - Esperando confirmación bancaria',
                {
                  expectedAmount: order.totalPrice,
                  buyerName: order.counterPartNickName,
                  timestamp: new Date().toISOString(),
                  source: 'sync_endpoint',
                }
              );

              // Try to find matching payment
              const expectedAmount = parseFloat(order.totalPrice);
              const existingPayments = await db.findUnmatchedPaymentsByAmount(expectedAmount, 1, 120);

              if (existingPayments.length > 0) {
                // Found a potential matching payment - link it
                const payment = existingPayments[0];
                logger.info({
                  orderNumber: order.orderNumber,
                  transactionId: payment.transactionId,
                  amount: payment.amount,
                }, '🔗 Found existing payment during sync - linking to order');

                await db.addVerificationStep(
                  order.orderNumber,
                  'PAYMENT_MATCHED' as any,
                  `Pago bancario vinculado durante sincronización`,
                  {
                    transactionId: payment.transactionId,
                    receivedAmount: payment.amount,
                    senderName: payment.senderName,
                    matchType: 'sync_match',
                  }
                );

                await db.matchPaymentToOrder(payment.transactionId, order.orderNumber, 'BANK_WEBHOOK');

                // Verify amount
                const amountDiff = Math.abs(payment.amount - expectedAmount);
                const amountTolerance = expectedAmount * 0.01;
                const amountMatches = amountDiff <= amountTolerance;

                if (amountMatches) {
                  await db.addVerificationStep(
                    order.orderNumber,
                    'AMOUNT_VERIFIED' as any,
                    `Monto verificado: $${payment.amount.toFixed(2)} ≈ $${expectedAmount.toFixed(2)}`,
                    { receivedAmount: payment.amount, expectedAmount, withinTolerance: true }
                  );

                  // Set to READY_TO_RELEASE if amount matches
                  await db.addVerificationStep(
                    order.orderNumber,
                    'READY_TO_RELEASE' as any,
                    'Verificación completa - Listo para liberar',
                    { autoRelease: false, reason: 'sync_verification' }
                  );
                } else {
                  await db.addVerificationStep(
                    order.orderNumber,
                    'AMOUNT_MISMATCH' as any,
                    `⚠️ Monto diferente: Recibido $${payment.amount.toFixed(2)} vs Esperado $${expectedAmount.toFixed(2)}`,
                    { receivedAmount: payment.amount, expectedAmount, withinTolerance: false }
                  );

                  await db.addVerificationStep(
                    order.orderNumber,
                    'MANUAL_REVIEW' as any,
                    'Requiere revisión manual por diferencia de monto',
                    { reason: 'amount_mismatch' }
                  );
                }
              }

              verificationTriggered++;
            }
          }
        } catch (err: any) {
          // Likely duplicate, just log at debug level
          logger.debug({ orderNumber: order.orderNumber, error: err.message }, 'Order save skipped');
          errorCount++;
        }
      }

      // Log status breakdown
      const statusCounts: Record<string, number> = {};
      for (const order of allOrders.values()) {
        statusCounts[order.orderStatus] = (statusCounts[order.orderStatus] || 0) + 1;
      }

      logger.info({
        savedCount,
        errorCount,
        verificationTriggered,
        statusCounts
      }, 'Orders sync complete');

      res.json({
        success: true,
        message: `Synced ${savedCount} orders from Binance (${verificationTriggered} verification started)`,
        total: allOrders.size,
        saved: savedCount,
        skipped: errorCount,
        verificationTriggered,
        statusBreakdown: statusCounts,
        orders: savedOrders,
        source: 'railway-proxy',
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Orders sync error');
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to sync orders from Binance',
      });
    }
  }

  // ==================== WEBHOOK HANDLERS ====================

  /**
   * Handle incoming payment webhook
   */
  private async handlePaymentWebhook(req: Request, res: Response): Promise<void> {
    try {
      // Verify authentication (multiple methods supported)
      const isAuthenticated = this.verifyAuthentication(req);

      if (!isAuthenticated) {
        logger.warn({ ip: this.getClientIP(req) }, 'Unauthorized webhook request');
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Parse payload (supports OPM format and generic format)
      const payload = this.parsePayload(req.body);

      if (!payload) {
        res.status(400).json({ error: 'Invalid payload' });
        return;
      }

      // Check for duplicate
      if (this.isDuplicate(payload.transactionId)) {
        logger.warn({ transactionId: payload.transactionId }, 'Duplicate payment ignored');
        res.json({ status: 'acknowledged', duplicate: true });
        return;
      }

      // Mark as received in memory
      this.recentPayments.set(payload.transactionId, new Date());

      logger.info({
        transactionId: payload.transactionId,
        amount: payload.amount,
        sender: payload.senderName,
        status: payload.status,
      }, '💰 Bank payment received via webhook');

      // ALWAYS save to database for later matching
      try {
        await db.savePayment(payload);
        logger.info({ transactionId: payload.transactionId }, 'Payment saved to DB for matching');
      } catch (dbError) {
        logger.error({ error: dbError }, 'Failed to save payment to DB');
        // Continue - don't fail the webhook
      }

      // Only emit event for completed payments
      if (payload.status === 'completed') {
        const event: WebhookEvent = {
          type: 'payment',
          payload,
          verified: true,
          receivedAt: new Date(),
        };

        this.emit('payment', event);
      }

      // Acknowledge receipt
      res.json({
        status: 'acknowledged',
        transactionId: payload.transactionId,
      });
    } catch (error) {
      logger.error({ error }, 'Error processing payment webhook');
      res.status(500).json({ error: 'Processing error' });
    }
  }

  /**
   * Verify authentication using multiple methods
   */
  private verifyAuthentication(req: Request): boolean {
    // Method 1: Bearer token
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      if (token === this.config.webhookSecret) {
        return true;
      }
    }

    // Method 2: x-webhook-signature (legacy)
    const signature = req.headers['x-webhook-signature'] as string;
    const timestamp = req.headers['x-webhook-timestamp'] as string;
    if (signature && timestamp) {
      return this.verifySignature((req as any).rawBody, signature, timestamp);
    }

    // Method 3: IP whitelist only (if configured and no other auth)
    if (this.config.allowedIPs && this.config.allowedIPs.length > 0) {
      const clientIP = this.getClientIP(req);
      if (this.config.allowedIPs.includes(clientIP)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Handle payment reversal (chargeback) webhook
   */
  private async handleReversalWebhook(req: Request, res: Response): Promise<void> {
    try {
      const signature = req.headers['x-webhook-signature'] as string;
      const timestamp = req.headers['x-webhook-timestamp'] as string;

      if (!this.verifySignature((req as any).rawBody, signature, timestamp)) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }

      const payload = this.parsePayload(req.body);

      if (!payload) {
        res.status(400).json({ error: 'Invalid payload' });
        return;
      }

      logger.warn({
        transactionId: payload.transactionId,
        amount: payload.amount,
      }, 'Payment REVERSAL received');

      const event: WebhookEvent = {
        type: 'reversal',
        payload,
        verified: true,
        receivedAt: new Date(),
      };

      this.emit('reversal', event);

      res.json({
        status: 'acknowledged',
        transactionId: payload.transactionId,
      });
    } catch (error) {
      logger.error({ error }, 'Error processing reversal webhook');
      res.status(500).json({ error: 'Processing error' });
    }
  }

  // ==================== SIGNATURE VERIFICATION ====================

  /**
   * Verify webhook signature
   */
  private verifySignature(
    body: Buffer,
    signature: string,
    timestamp: string
  ): boolean {
    if (!signature || !timestamp) {
      return false;
    }

    // Check timestamp (prevent replay attacks)
    const now = Date.now();
    const webhookTimestamp = parseInt(timestamp, 10);
    const fiveMinutes = 5 * 60 * 1000;

    if (Math.abs(now - webhookTimestamp) > fiveMinutes) {
      logger.warn({ webhookTimestamp, now }, 'Webhook timestamp too old');
      return false;
    }

    // Compute expected signature
    const signaturePayload = `${timestamp}.${body.toString()}`;
    const expectedSignature = crypto
      .createHmac('sha256', this.config.webhookSecret)
      .update(signaturePayload)
      .digest('hex');

    // Constant-time comparison
    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
      );
    } catch {
      return false;
    }
  }

  // ==================== PAYLOAD PROCESSING ====================

  /**
   * Parse and validate webhook payload
   * Supports: OPM format, generic bank format, legacy formats
   */
  private parsePayload(body: any): BankWebhookPayload | null {
    try {
      // Detect OPM format (has trackingKey and payerName)
      const isOpmFormat = body.trackingKey && body.payerName;

      let payload: BankWebhookPayload;

      if (isOpmFormat) {
        // OPM Format from core bancario
        payload = {
          transactionId: body.trackingKey,
          amount: parseFloat(body.amount || '0'),
          currency: 'MXN',
          senderName: body.payerName || '',
          senderAccount: body.payerAccount || '',
          receiverAccount: body.beneficiaryAccount || '',
          concept: body.concept || '',
          timestamp: body.receivedTimestamp
            ? new Date(body.receivedTimestamp).toISOString()
            : new Date().toISOString(),
          bankReference: body.numericalReference?.toString() || '',
          status: 'completed', // OPM webhooks are always completed deposits
        };

        logger.debug({ format: 'OPM', trackingKey: body.trackingKey }, 'Parsed OPM format payload');
      } else {
        // Generic/legacy format
        payload = {
          transactionId: body.transactionId || body.transaction_id || body.id,
          amount: parseFloat(body.amount || body.monto || '0'),
          currency: body.currency || body.moneda || 'MXN',
          senderName: body.senderName || body.sender_name || body.ordenante || '',
          senderAccount: body.senderAccount || body.sender_account || body.cuenta_origen || '',
          receiverAccount: body.receiverAccount || body.receiver_account || body.cuenta_destino || '',
          concept: body.concept || body.concepto || body.description || '',
          timestamp: body.timestamp || body.fecha || new Date().toISOString(),
          bankReference: body.bankReference || body.bank_reference || body.referencia || '',
          status: this.normalizeStatus(body.status || body.estado),
        };
      }

      // Validate required fields
      if (!payload.transactionId || payload.amount <= 0) {
        logger.warn({ payload }, 'Invalid payload - missing required fields');
        return null;
      }

      return payload;
    } catch (error) {
      logger.error({ error, body }, 'Error parsing webhook payload');
      return null;
    }
  }

  /**
   * Normalize payment status
   */
  private normalizeStatus(status: string): 'completed' | 'pending' | 'failed' {
    const statusLower = (status || '').toLowerCase();

    if (['completed', 'completado', 'success', 'exitoso', 'liquidado'].includes(statusLower)) {
      return 'completed';
    }

    if (['pending', 'pendiente', 'processing', 'en_proceso'].includes(statusLower)) {
      return 'pending';
    }

    return 'failed';
  }

  /**
   * Check if payment is duplicate
   */
  private isDuplicate(transactionId: string): boolean {
    const existing = this.recentPayments.get(transactionId);

    if (!existing) {
      return false;
    }

    const age = Date.now() - existing.getTime();
    return age < this.DUPLICATE_WINDOW_MS;
  }

  // ==================== CLEANUP ====================

  /**
   * Clean old entries from duplicate detection
   */
  private cleanupDuplicates(): void {
    const now = Date.now();

    for (const [transactionId, timestamp] of this.recentPayments) {
      if (now - timestamp.getTime() > this.DUPLICATE_WINDOW_MS) {
        this.recentPayments.delete(transactionId);
      }
    }
  }

  // ==================== SERVER CONTROL ====================

  /**
   * Start webhook server
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isRunning) {
        logger.warn('Webhook server already running');
        resolve();
        return;
      }

      try {
        this.server = this.app.listen(this.config.port, () => {
          this.isRunning = true;

          logger.info({
            port: this.config.port,
            path: this.config.webhookPath,
          }, 'Webhook server started');

          // Periodic cleanup
          setInterval(() => this.cleanupDuplicates(), 60000);

          resolve();
        });

        this.server.on('error', (error: Error) => {
          logger.error({ error }, 'Webhook server error');
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop webhook server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server || !this.isRunning) {
        resolve();
        return;
      }

      this.server.close(() => {
        this.isRunning = false;
        logger.info('Webhook server stopped');
        resolve();
      });
    });
  }

  /**
   * Check if server is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get Express app (for testing)
   */
  getApp(): express.Application {
    return this.app;
  }
}

// Factory function
export function createWebhookReceiver(config?: Partial<WebhookConfig>): WebhookReceiver {
  const defaultConfig: WebhookConfig = {
    port: parseInt(process.env.WEBHOOK_PORT || '3001'),
    webhookSecret: process.env.WEBHOOK_SECRET || 'your-webhook-secret',
    webhookPath: process.env.WEBHOOK_PATH || '/webhook/payment',
    allowedIPs: process.env.WEBHOOK_ALLOWED_IPS?.split(',').map(ip => ip.trim()),
  };

  return new WebhookReceiver({ ...defaultConfig, ...config });
}
