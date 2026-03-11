import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import { getBybitClient } from './bybit-client.js';
import { toOrderData, BankWebhookPayload } from './bybit-types.js';
import * as db from '../../services/database-pg.js';

const log = logger.child({ module: 'bybit-api-server' });

export interface BybitApiServerConfig {
  port: number;
  webhookSecret?: string;
  webhookPath?: string;
}

export class BybitApiServer extends EventEmitter {
  private app: express.Application;
  private config: BybitApiServerConfig;
  private server: any = null;
  private isRunning = false;

  private sseClients: Set<express.Response> = new Set();
  private recentPayments: Map<string, Date> = new Map();
  private readonly DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

  private services: {
    orderManager?: any;
    positioning?: any;
    autoRelease?: any;
    autoSwap?: any;
    buyOrderManager?: any;
  } = {};

  constructor(config: BybitApiServerConfig) {
    super();
    this.config = config;
    this.app = express();
    this.app.use(express.json({
      verify: (req: any, _res, buf) => { req.rawBody = buf; },
    }));
    this.setupRoutes();
  }

  setServices(services: {
    orderManager?: any;
    positioning?: any;
    autoRelease?: any;
    autoSwap?: any;
    buyOrderManager?: any;
  }): void {
    this.services = { ...this.services, ...services };
    log.info({ services: Object.keys(services).filter(k => !!(services as any)[k]) }, 'Services connected to Bybit API server');
  }

  private setupRoutes(): void {
    this.app.use('/api', (req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    });

    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        service: 'bybit-p2p-bot',
        timestamp: new Date().toISOString(),
      });
    });

    this.app.get('/api/sellers', this.handleSellers.bind(this));
    this.app.get('/api/ads', this.handleAds.bind(this));
    this.app.post('/api/ads/update', this.handleAdUpdate.bind(this));
    this.app.post('/api/orders/sync', this.handleOrdersSync.bind(this));
    this.app.post('/api/orders/release', this.handleRelease.bind(this));
    this.app.get('/api/chat/:orderNumber', this.handleChat.bind(this));
    this.app.get('/api/events', this.handleSSE.bind(this));
    this.app.get('/api/positioning/status', this.handlePositioningStatus.bind(this));
    this.app.get('/api/proxy-image', this.handleImageProxy.bind(this));

    // Auto-buy endpoints
    this.app.get('/api/auto-buy/status', (_req, res) => {
      const mgr = this.services.buyOrderManager;
      if (mgr) {
        res.json({ success: true, ...mgr.getStatus() });
      } else {
        res.json({ success: true, isRunning: false, message: 'Auto-buy module not enabled' });
      }
    });

    this.app.get('/api/auto-buy/dispatches', async (req, res) => {
      try {
        const mgr = this.services.buyOrderManager;
        if (!mgr) return res.json({ success: true, dispatches: [] });
        const status = req.query.status as string | undefined;
        const dispatches = await mgr.getDispatches(status);
        res.json({ success: true, dispatches });
      } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/auto-buy/dispatches/:id/approve', async (req, res) => {
      try {
        const mgr = this.services.buyOrderManager;
        if (!mgr) return res.status(400).json({ success: false, error: 'Auto-buy module not running' });
        const result = await mgr.approveDispatch(req.params.id);
        res.json({ success: result.success, error: result.error });
      } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/auto-buy/dispatches/:id/reject', async (req, res) => {
      try {
        const mgr = this.services.buyOrderManager;
        if (!mgr) return res.status(400).json({ success: false, error: 'Auto-buy module not running' });
        const result = await mgr.rejectDispatch(req.params.id);
        res.json({ success: result.success, error: result.error });
      } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/auto-buy/dispatches/:id/retry', async (req, res) => {
      try {
        const mgr = this.services.buyOrderManager;
        if (!mgr) return res.status(400).json({ success: false, error: 'Auto-buy module not running' });
        const result = await mgr.retryDispatch(req.params.id);
        res.json({ success: result.success, error: result.error });
      } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Auto-swap endpoints
    this.app.get('/api/auto-swap/status', (_req, res) => {
      const mgr = this.services.autoSwap;
      if (mgr) {
        res.json({ success: true, ...mgr.getStatus() });
      } else {
        res.json({ success: true, isRunning: false, message: 'Auto-swap module not enabled' });
      }
    });

    this.app.get('/api/auto-swap/records', async (req, res) => {
      try {
        const mgr = this.services.autoSwap;
        if (!mgr) return res.json({ success: true, records: [] });
        const limit = parseInt(req.query.limit as string) || 50;
        const records = await mgr.getRecentSwaps(limit);
        res.json({ success: true, records });
      } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Webhook endpoints
    const webhookPath = this.config.webhookPath || '/webhook/bank-deposit';
    this.app.post(webhookPath, this.handlePaymentWebhook.bind(this));
    this.app.post('/webhook/bank', this.handlePaymentWebhook.bind(this));
    this.app.post('/webhook/spei-status', this.handleSpeiStatusWebhook.bind(this));

    this.app.use((_req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      log.error({ error: err }, 'Server error');
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  // ==================== SELLERS (COMPETITORS) ====================

  private async handleSellers(req: Request, res: Response): Promise<void> {
    try {
      const asset = (req.query.asset as string) || 'USDT';
      const tradeType = (req.query.tradeType as string) || 'SELL';
      const rows = parseInt(req.query.rows as string) || 20;

      // Bybit side: '0' = buy ads, '1' = sell ads
      // Dashboard already flips tradeType: our SELL panel sends tradeType=BUY (wants seller ads)
      // So tradeType=BUY → side='1' (sellers), tradeType=SELL → side='0' (buyers)
      const side: '0' | '1' = tradeType === 'BUY' ? '1' : '0';
      const currencyId = (req.query.fiat as string) || 'MXN';

      const client = getBybitClient();
      const perPage = 20;
      const pages = Math.ceil(rows / perPage);
      let allItems: any[] = [];

      for (let page = 1; page <= pages; page++) {
        const result = await client.searchAds(asset, currencyId, side, page, perPage);
        allItems.push(...(result.items || []));
        if ((result.items || []).length < perPage) break;
      }

      const sellers = allItems.slice(0, rows).map((ad: any, idx: number) => ({
        position: idx + 1,
        userNo: String(ad.userId),
        nickName: ad.nickName,
        price: ad.price,
        surplusAmount: ad.lastQuantity,
        minAmount: ad.minAmount,
        maxAmount: ad.maxAmount,
        isOnline: ad.isOnline ?? false,
        userGrade: 0,
        monthFinishRate: parseFloat(ad.recentExecuteRate) || 0,
        monthOrderCount: parseInt(ad.recentOrderNum) || 0,
        positiveRate: 0,
        proMerchant: (ad.authTag || []).includes('BA'),
      }));

      res.json({
        success: true,
        sellers,
        asset,
        fiat: currencyId,
        tradeType,
        timestamp: new Date().toISOString(),
        source: 'bybit-proxy',
      });
    } catch (error: any) {
      log.error({ error: error.message }, 'Sellers fetch error');
      res.status(500).json({ success: false, error: error.message });
    }
  }

  // ==================== ADS ====================

  private async handleAds(_req: Request, res: Response): Promise<void> {
    try {
      const client = getBybitClient();
      const [sellResult, buyResult] = await Promise.all([
        client.getMyAds({ side: '1' }),
        client.getMyAds({ side: '0' }),
      ]);

      const mapAd = (ad: any) => ({
        id: ad.id,
        tokenId: ad.tokenId,
        currencyId: ad.currencyId,
        side: ad.side,
        price: ad.price,
        lastQuantity: ad.lastQuantity,
        quantity: ad.quantity,
        minAmount: ad.minAmount,
        maxAmount: ad.maxAmount,
        status: ad.status,
        payments: ad.payments,
        remark: ad.remark,
        priceType: ad.priceType,
        premium: ad.premium,
        paymentPeriod: ad.paymentPeriod,
      });

      res.json({
        success: true,
        sellAds: (sellResult.items || []).map(mapAd),
        buyAds: (buyResult.items || []).map(mapAd),
        source: 'bybit-proxy',
      });
    } catch (error: any) {
      log.error({ error: error.message }, 'Ads fetch error');
      res.status(500).json({ success: false, error: error.message });
    }
  }

  private async handleAdUpdate(req: Request, res: Response): Promise<void> {
    try {
      const { advNo, price } = req.body;
      if (!advNo || !price) {
        res.status(400).json({ success: false, error: 'advNo and price are required' });
        return;
      }

      const client = getBybitClient();

      // Fetch current ad to get all required fields for update
      const adDetail = await client.getAdDetail(advNo);
      if (!adDetail) {
        res.status(404).json({ success: false, error: 'Ad not found' });
        return;
      }

      await client.updateAd({
        id: advNo,
        priceType: String(adDetail.priceType),
        premium: adDetail.premium,
        price: String(price),
        minAmount: adDetail.minAmount,
        maxAmount: adDetail.maxAmount,
        remark: adDetail.remark,
        tradingPreferenceSet: adDetail.tradingPreferenceSet,
        paymentIds: adDetail.payments || [],
        actionType: 'MODIFY',
        quantity: adDetail.quantity,
        paymentPeriod: String(adDetail.paymentPeriod),
      });

      res.json({ success: true, advNo, newPrice: price, source: 'bybit-proxy' });
    } catch (error: any) {
      log.error({ error: error.message }, 'Ad update error');
      res.status(500).json({ success: false, error: error.message });
    }
  }

  // ==================== ORDERS ====================

  private async handleOrdersSync(_req: Request, res: Response): Promise<void> {
    try {
      const client = getBybitClient();

      const [sellPending, sellRecent, buyPending, buyRecent] = await Promise.all([
        client.listPendingOrders({ side: 1, size: 30 }).catch(() => ({ count: 0, items: [] })),
        client.listOrders({ page: 1, size: 30, side: 1 }).catch(() => ({ count: 0, items: [] })),
        client.listPendingOrders({ side: 0, size: 30 }).catch(() => ({ count: 0, items: [] })),
        client.listOrders({ page: 1, size: 30, side: 0 }).catch(() => ({ count: 0, items: [] })),
      ]);

      const allOrders = new Map<string, any>();
      for (const order of [...sellPending.items, ...sellRecent.items, ...buyPending.items, ...buyRecent.items]) {
        allOrders.set(order.id, order);
      }

      let savedCount = 0;
      let errorCount = 0;

      for (const bybitOrder of allOrders.values()) {
        const order = toOrderData(bybitOrder);
        try {
          await db.saveOrder(order);
          savedCount++;
        } catch {
          errorCount++;
        }
      }

      // Stale order recovery
      let staleUpdated = 0;
      try {
        const staleOrders = await db.getStaleOrders(30, 20);
        const staleToCheck = staleOrders.filter(o => !allOrders.has(o.orderNumber));

        for (const stale of staleToCheck) {
          try {
            const detail = await client.getOrderDetail(stale.orderNumber);
            if (!detail) continue;
            const order = toOrderData(detail as any);
            await db.saveOrder(order);
            staleUpdated++;
            await new Promise(resolve => setTimeout(resolve, 300));
          } catch {
            // skip
          }
        }
      } catch {
        // skip stale check errors
      }

      res.json({
        success: true,
        message: `Synced ${savedCount} orders from Bybit (${staleUpdated} stale resolved)`,
        total: allOrders.size,
        saved: savedCount,
        skipped: errorCount,
        staleUpdated,
        source: 'bybit-proxy',
      });
    } catch (error: any) {
      log.error({ error: error.message }, 'Orders sync error');
      res.status(500).json({ success: false, error: error.message });
    }
  }

  private async handleRelease(req: Request, res: Response): Promise<void> {
    try {
      const { orderNumber } = req.body;
      if (!orderNumber) {
        res.status(400).json({ success: false, error: 'orderNumber is required' });
        return;
      }

      const client = getBybitClient();
      await client.releaseCrypto(orderNumber);

      await db.addVerificationStep(
        orderNumber,
        'RELEASED' as any,
        'Crypto liberado desde dashboard (Bybit - sin TOTP)',
        { releasedBy: 'dashboard', timestamp: new Date().toISOString() }
      );

      this.broadcastSSE({
        type: 'order_released',
        orderNumber,
        timestamp: new Date().toISOString(),
      });

      log.info({ orderNumber }, 'Order released successfully');

      res.json({
        success: true,
        message: 'Order released successfully',
        orderNumber,
      });
    } catch (error: any) {
      log.error({ error: error.message, orderNumber: req.body?.orderNumber }, 'Release error');
      res.status(500).json({ success: false, error: error.message });
    }
  }

  // ==================== CHAT ====================

  private async handleChat(req: Request, res: Response): Promise<void> {
    try {
      const { orderNumber } = req.params;
      if (!orderNumber) {
        res.status(400).json({ success: false, error: 'Order number is required' });
        return;
      }

      const client = getBybitClient();
      const messages = await client.getChatMessages(orderNumber);

      for (const msg of messages) {
        try {
          const isImage = msg.contentType === 2 || msg.contentType === '2';
          await db.saveChatMessage({
            id: parseInt(msg.id) || Date.now(),
            orderNo: orderNumber,
            content: msg.message || msg.content || '',
            type: isImage ? 'image' as any : 'text' as any,
            fromNickName: msg.nickName || '',
            self: !!msg.isSelf,
            status: 'read',
            uuid: msg.id || `bybit-${orderNumber}-${Date.now()}`,
            imageUrl: isImage ? msg.message : undefined,
            createTime: msg.createTime || String(Date.now()),
          });
        } catch {
          // skip duplicates
        }
      }

      res.json({
        success: true,
        orderNumber,
        messages: messages.map((msg: any) => ({
          id: msg.id || `bybit-${orderNumber}-${msg.createTime || Date.now()}`,
          content: msg.message || msg.content || '',
          type: String(msg.contentType || 1),
          fromNickName: msg.nickName || '',
          isSelf: !!msg.isSelf,
          imageUrl: msg.contentType === 2 ? msg.message : undefined,
          timestamp: parseInt(msg.createTime) || Date.now(),
        })),
        source: 'bybit-proxy',
      });
    } catch (error: any) {
      log.error({ error: error.message }, 'Chat fetch error');
      res.status(500).json({ success: false, error: error.message });
    }
  }

  // ==================== SSE ====================

  private handleSSE(req: Request, res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    this.sseClients.add(res);

    res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

    const keepAlive = setInterval(() => {
      res.write(`data: ${JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() })}\n\n`);
    }, 30000);

    req.on('close', () => {
      clearInterval(keepAlive);
      this.sseClients.delete(res);
    });
  }

  broadcastSSE(data: any): void {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(message);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  // ==================== POSITIONING ====================

  private handlePositioningStatus(_req: Request, res: Response): void {
    const mgr = this.services.positioning;
    if (!mgr) {
      res.json({
        success: true,
        isRunning: false,
        mode: 'off',
        followTarget: null,
        undercutCents: 1,
        managedAds: [],
        totalUpdates: 0,
        totalErrors: 0,
      });
      return;
    }

    res.json({ success: true, ...mgr.getStatus() });
  }

  // ==================== IMAGE PROXY ====================

  private async handleImageProxy(req: Request, res: Response): Promise<void> {
    try {
      const imageUrl = req.query.url as string;
      if (!imageUrl) {
        res.status(400).json({ success: false, error: 'url query param is required' });
        return;
      }

      const response = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        res.status(response.status).json({ success: false, error: 'Failed to download image' });
        return;
      }

      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', buffer.length);
      res.send(buffer);
    } catch (error: any) {
      log.error({ error: error.message }, 'Image proxy error');
      res.status(500).json({ success: false, error: 'Failed to proxy image' });
    }
  }

  // ==================== WEBHOOKS ====================

  private async handlePaymentWebhook(req: Request, res: Response): Promise<void> {
    try {
      if (!this.verifyAuthentication(req)) {
        log.warn({ ip: req.socket.remoteAddress }, 'Unauthorized webhook request');
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const payload = this.parsePayload(req.body);
      if (!payload) {
        res.status(400).json({ error: 'Invalid payload' });
        return;
      }

      if (this.isDuplicate(payload.transactionId)) {
        res.json({ status: 'acknowledged', duplicate: true });
        return;
      }

      this.recentPayments.set(payload.transactionId, new Date());

      log.info({
        transactionId: payload.transactionId,
        amount: payload.amount,
        sender: payload.senderName,
      }, 'Bank payment received via webhook');

      try {
        await db.savePayment(payload);
      } catch (dbError) {
        log.error({ error: dbError }, 'Failed to save payment to DB');
      }

      if (payload.status === 'completed') {
        this.emit('payment', {
          type: 'payment',
          payload,
          verified: true,
          receivedAt: new Date(),
        });

        this.broadcastSSE({
          type: 'payment_received',
          transactionId: payload.transactionId,
          amount: payload.amount,
          senderName: payload.senderName,
          timestamp: new Date().toISOString(),
        });
      }

      res.json({ status: 'acknowledged', transactionId: payload.transactionId });
    } catch (error) {
      log.error({ error }, 'Error processing payment webhook');
      res.status(500).json({ error: 'Processing error' });
    }
  }

  private async handleSpeiStatusWebhook(req: Request, res: Response): Promise<void> {
    try {
      const novacoreSecret = process.env.NOVACORE_WEBHOOK_SECRET;
      if (!novacoreSecret) {
        res.status(500).json({ error: 'Webhook secret not configured' });
        return;
      }

      const signature = req.headers['x-novacore-signature'] as string;
      if (!signature || !(req as any).rawBody) {
        res.status(401).json({ error: 'Missing signature' });
        return;
      }

      const expectedSignature = crypto
        .createHmac('sha256', novacoreSecret)
        .update((req as any).rawBody)
        .digest('hex');

      const isValid = crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
      );

      if (!isValid) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }

      const { trackingKey, externalReference, status, timestamp } = req.body;
      if (!trackingKey || !status) {
        res.status(400).json({ error: 'Missing trackingKey or status' });
        return;
      }

      log.info({ trackingKey, externalReference, status, timestamp }, '[SPEI-STATUS] Received transfer status update');

      let dispatch = await db.getBuyDispatchByTrackingKey(trackingKey);
      if (!dispatch && externalReference) {
        dispatch = await db.getBuyDispatchByOrderNumber(externalReference);
      }

      if (!dispatch) {
        log.warn({ trackingKey, externalReference }, '[SPEI-STATUS] No matching BuyDispatch found');
        res.json({ status: 'acknowledged', matched: false });
        return;
      }

      await db.updateBuyDispatch(dispatch.id, { transferStatus: status });

      log.info({
        orderNumber: dispatch.orderNumber,
        amount: dispatch.amount,
        transferStatus: status,
      }, `[SPEI-STATUS] Transfer ${status} for order ${dispatch.orderNumber}`);

      this.broadcastSSE({
        type: 'spei_status',
        orderNumber: dispatch.orderNumber,
        transferStatus: status,
        amount: dispatch.amount,
        trackingKey,
        timestamp: timestamp || new Date().toISOString(),
      });

      this.emit('spei_status', { dispatch, transferStatus: status, trackingKey, timestamp });

      res.json({ status: 'acknowledged', matched: true, orderNumber: dispatch.orderNumber });
    } catch (error: any) {
      log.error({ error: error.message }, '[SPEI-STATUS] Error processing webhook');
      res.status(500).json({ error: 'Processing error' });
    }
  }

  // ==================== AUTH HELPERS ====================

  private verifyAuthentication(req: Request): boolean {
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ') && this.config.webhookSecret) {
      if (authHeader.substring(7) === this.config.webhookSecret) return true;
    }

    const signature = req.headers['x-webhook-signature'] as string;
    const timestamp = req.headers['x-webhook-timestamp'] as string;
    if (signature && timestamp && this.config.webhookSecret) {
      return this.verifySignature((req as any).rawBody, signature, timestamp);
    }

    return false;
  }

  private verifySignature(body: Buffer, signature: string, timestamp: string): boolean {
    if (!signature || !timestamp || !this.config.webhookSecret) return false;

    const now = Date.now();
    const ts = parseInt(timestamp, 10);
    if (Math.abs(now - ts) > 5 * 60 * 1000) return false;

    const expected = crypto
      .createHmac('sha256', this.config.webhookSecret)
      .update(`${timestamp}.${body.toString()}`)
      .digest('hex');

    try {
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  // ==================== PAYLOAD PARSING ====================

  private parsePayload(body: any): BankWebhookPayload | null {
    try {
      const isOpmFormat = body.trackingKey && body.payerName;

      let payload: BankWebhookPayload;

      if (isOpmFormat) {
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
          status: 'completed',
        };
      } else {
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

      if (!payload.transactionId || payload.amount <= 0) return null;
      return payload;
    } catch {
      return null;
    }
  }

  private normalizeStatus(status: string): 'completed' | 'pending' | 'failed' {
    const s = (status || '').toLowerCase();
    if (['completed', 'completado', 'success', 'exitoso', 'liquidado'].includes(s)) return 'completed';
    if (['pending', 'pendiente', 'processing', 'en_proceso'].includes(s)) return 'pending';
    return 'failed';
  }

  private isDuplicate(transactionId: string): boolean {
    const existing = this.recentPayments.get(transactionId);
    if (!existing) return false;
    return (Date.now() - existing.getTime()) < this.DUPLICATE_WINDOW_MS;
  }

  private cleanupDuplicates(): void {
    const now = Date.now();
    for (const [id, ts] of this.recentPayments) {
      if (now - ts.getTime() > this.DUPLICATE_WINDOW_MS) {
        this.recentPayments.delete(id);
      }
    }
  }

  // ==================== LIFECYCLE ====================

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isRunning) {
        resolve();
        return;
      }

      try {
        this.server = this.app.listen(this.config.port, () => {
          this.isRunning = true;
          log.info({ port: this.config.port }, 'Bybit API server started');
          setInterval(() => this.cleanupDuplicates(), 60000);
          resolve();
        });

        this.server.on('error', (error: Error) => {
          log.error({ error }, 'Bybit API server error');
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server || !this.isRunning) {
        resolve();
        return;
      }

      this.server.close(() => {
        this.isRunning = false;
        log.info('Bybit API server stopped');
        resolve();
      });
    });
  }
}

export function createBybitApiServer(config?: Partial<BybitApiServerConfig>): BybitApiServer {
  // Railway assigns PORT env var — app MUST listen on it for external traffic to work
  const defaultConfig: BybitApiServerConfig = {
    port: parseInt(process.env.PORT || process.env.BYBIT_WEBHOOK_PORT || '3002'),
    webhookSecret: process.env.BYBIT_WEBHOOK_SECRET,
    webhookPath: process.env.BYBIT_WEBHOOK_PATH || '/webhook/bank-deposit',
  };

  return new BybitApiServer({ ...defaultConfig, ...config });
}
