// =====================================================
// WEBHOOK RECEIVER
// Receives payment notifications from bank core
// =====================================================

import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { webhookLogger as logger } from '../utils/logger.js';
import { BankWebhookPayload } from '../types/binance.js';

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
    // Health check
    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        service: 'p2p-bot-webhook',
        timestamp: new Date().toISOString(),
        endpoints: [
          'POST /webhook/bank - Bank core webhook',
          'POST /webhook/opm - OPM direct webhook',
          'POST /webhook/payment - Generic payment webhook',
        ],
      });
    });

    // Bank payment webhook (primary endpoint)
    this.app.post('/webhook/bank', this.handlePaymentWebhook.bind(this));

    // OPM direct webhook (if core forwards directly)
    this.app.post('/webhook/opm', this.handlePaymentWebhook.bind(this));

    // Legacy/configured path
    this.app.post(this.config.webhookPath, this.handlePaymentWebhook.bind(this));

    // Payment reversal webhook (chargebacks)
    this.app.post('/webhook/reversal', this.handleReversalWebhook.bind(this));
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

  // ==================== WEBHOOK HANDLERS ====================

  /**
   * Handle incoming payment webhook
   */
  private async handlePaymentWebhook(req: Request, res: Response): Promise<void> {
    try {
      // Verify authentication (support multiple methods)
      if (!this.verifyAuth(req)) {
        logger.warn({ ip: this.getClientIP(req) }, 'Unauthorized webhook request');
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Parse payload (supports multiple formats including OPM)
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

      // Mark as received
      this.recentPayments.set(payload.transactionId, new Date());

      logger.info({
        transactionId: payload.transactionId,
        amount: payload.amount,
        sender: payload.senderName,
        status: payload.status,
      }, '💰 Bank payment webhook received');

      // Only process completed payments
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
   * Verify authentication (supports Bearer token or signature)
   */
  private verifyAuth(req: Request): boolean {
    // Method 1: Bearer token
    const authHeader = req.headers['authorization'] as string;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      if (token === this.config.webhookSecret) {
        return true;
      }
    }

    // Method 2: X-API-Key header
    const apiKey = req.headers['x-api-key'] as string;
    if (apiKey === this.config.webhookSecret) {
      return true;
    }

    // Method 3: HMAC signature (original method)
    const signature = req.headers['x-webhook-signature'] as string;
    const timestamp = req.headers['x-webhook-timestamp'] as string;
    if (signature && timestamp) {
      return this.verifySignature((req as any).rawBody, signature, timestamp);
    }

    // Method 4: Allow if from whitelisted IP and no auth required
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
   * Supports: Standard format, OPM format, and generic bank formats
   */
  private parsePayload(body: any): BankWebhookPayload | null {
    try {
      let payload: BankWebhookPayload;

      // Detect OPM format (has trackingKey and payerName)
      if (body.trackingKey || body.payerName || body.beneficiaryAccount) {
        payload = this.parseOPMFormat(body);
      }
      // Detect wrapped OPM format (type: "supply", data: {...})
      else if (body.type === 'supply' && body.data) {
        payload = this.parseOPMFormat(body.data);
      }
      // Standard/generic format
      else {
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
          status: this.normalizeStatus(body.status || body.estado || 'completed'),
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
   * Parse OPM (Open Payment Mexico) format
   */
  private parseOPMFormat(data: any): BankWebhookPayload {
    return {
      transactionId: data.trackingKey || data.id || `opm_${Date.now()}`,
      amount: parseFloat(data.amount || data.monto || '0'),
      currency: 'MXN',
      senderName: data.payerName || data.ordenante || '',
      senderAccount: data.payerAccount || data.cuenta_ordenante || '',
      receiverAccount: data.beneficiaryAccount || data.cuenta_beneficiario || '',
      concept: data.concept || data.concepto || '',
      timestamp: data.receivedTimestamp
        ? new Date(data.receivedTimestamp).toISOString()
        : new Date().toISOString(),
      bankReference: data.numericalReference?.toString() || data.referencia || '',
      status: 'completed', // OPM webhooks are always for completed deposits
    };
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
