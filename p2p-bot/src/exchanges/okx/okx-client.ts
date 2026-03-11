// =====================================================
// OKX P2P API CLIENT
// Handles OKX-specific authentication, signing, and API requests
// Supports HTTP proxy for static IP
// ZERO dependency on Binance code
// =====================================================

import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { logger } from '../../utils/logger.js';
import {
  OkxApiResponse,
  OkxOrderData,
  OkxAdData,
  OkxAdParams,
  OkxAdUpdateResult,
  OkxUserInfo,
  OkxBalanceInfo,
  OkxPaymentMethod,
  OkxInstrumentInfo,
  OkxSpotOrderResult,
  OkxSpotOrderDetail,
  OkxTransferParams,
} from './okx-types.js';

const log = logger.child({ module: 'okx-client' });

// ==================== PROXY ====================

function createProxyAgent(): HttpsProxyAgent<string> | undefined {
  const proxyUrl = process.env.OKX_PROXY_URL || process.env.PROXY_URL;
  if (proxyUrl) {
    log.info({ proxyUrl: proxyUrl.replace(/:[^:@]+@/, ':***@') }, 'Using HTTP proxy for OKX API');
    return new HttpsProxyAgent(proxyUrl);
  }
  return undefined;
}

// ==================== OKX CLIENT ====================

export class OkxClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly passphrase: string;
  private readonly baseUrl: string;
  private readonly p2pClient: AxiosInstance;
  private readonly spotClient: AxiosInstance;

  constructor(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
    baseUrl: string = 'https://www.okx.com'
  ) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.passphrase = passphrase;
    this.baseUrl = baseUrl;

    const proxyAgent = createProxyAgent();
    const proxyConfig = proxyAgent ? { httpsAgent: proxyAgent, proxy: false as const } : {};

    // P2P API client (endpoints under /api/v5/p2p/)
    this.p2pClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
      ...proxyConfig,
    });

    // Spot/Trading API client (endpoints under /api/v5/)
    this.spotClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
      ...proxyConfig,
    });

    this.setupInterceptors(this.p2pClient, 'P2P');
    this.setupInterceptors(this.spotClient, 'SPOT');
  }

  private setupInterceptors(client: AxiosInstance, label: string): void {
    client.interceptors.request.use((config) => {
      log.debug({ method: config.method, url: config.url }, `[${label}] Request`);
      return config;
    });

    client.interceptors.response.use(
      (response) => {
        log.debug({ status: response.status }, `[${label}] Response`);
        return response;
      },
      (error) => {
        log.error({
          status: error.response?.status,
          data: JSON.stringify(error.response?.data),
          message: error.message,
          url: error.config?.url,
        }, `[${label}] API Error`);
        throw error;
      }
    );
  }

  // ==================== OKX SIGNATURE ====================

  /**
   * Generate OKX HMAC-SHA256 signature
   * Sign: Base64(HMAC-SHA256(timestamp + method + requestPath + body, secret))
   */
  private sign(
    timestamp: string,
    method: string,
    requestPath: string,
    body: string = ''
  ): string {
    const prehash = timestamp + method.toUpperCase() + requestPath + body;
    const hmac = crypto.createHmac('sha256', this.apiSecret);
    hmac.update(prehash);
    return hmac.digest('base64');
  }

  /**
   * Build auth headers for OKX API
   */
  private getAuthHeaders(
    method: string,
    requestPath: string,
    body: string = ''
  ): Record<string, string> {
    const timestamp = new Date().toISOString();
    const sign = this.sign(timestamp, method, requestPath, body);

    return {
      'OK-ACCESS-KEY': this.apiKey,
      'OK-ACCESS-SIGN': sign,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': this.passphrase,
      'Content-Type': 'application/json',
    };
  }

  // ==================== REQUEST HELPERS ====================

  /**
   * Signed GET request to OKX P2P API
   */
  private async p2pGet<T>(endpoint: string, params: Record<string, any> = {}): Promise<T> {
    // Build query string
    const queryParts = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
    const queryString = queryParts.length > 0 ? '?' + queryParts.join('&') : '';
    const requestPath = endpoint + queryString;

    const headers = this.getAuthHeaders('GET', requestPath);
    const response = await this.p2pClient.get<OkxApiResponse<T>>(requestPath, { headers });

    if (response.data.code !== '0') {
      throw new Error(`OKX P2P API error: ${response.data.code} - ${response.data.msg}`);
    }

    return response.data.data;
  }

  /**
   * Signed POST request to OKX P2P API
   */
  private async p2pPost<T>(endpoint: string, body: Record<string, any> = {}): Promise<T> {
    const bodyStr = JSON.stringify(body);
    const headers = this.getAuthHeaders('POST', endpoint, bodyStr);
    const response = await this.p2pClient.post<OkxApiResponse<T>>(endpoint, body, { headers });

    if (response.data.code !== '0') {
      throw new Error(`OKX P2P API error: ${response.data.code} - ${response.data.msg}`);
    }

    return response.data.data;
  }

  /**
   * Signed GET request to OKX Spot/Trading API
   */
  private async spotGet<T>(endpoint: string, params: Record<string, any> = {}): Promise<T> {
    const queryParts = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
    const queryString = queryParts.length > 0 ? '?' + queryParts.join('&') : '';
    const requestPath = endpoint + queryString;

    const headers = this.getAuthHeaders('GET', requestPath);
    const response = await this.spotClient.get<OkxApiResponse<T>>(requestPath, { headers });

    if (response.data.code !== '0') {
      throw new Error(`OKX Spot API error: ${response.data.code} - ${response.data.msg}`);
    }

    return response.data.data;
  }

  /**
   * Signed POST request to OKX Spot/Trading API
   */
  private async spotPost<T>(endpoint: string, body: Record<string, any> = {}): Promise<T> {
    const bodyStr = JSON.stringify(body);
    const headers = this.getAuthHeaders('POST', endpoint, bodyStr);
    const response = await this.spotClient.post<OkxApiResponse<T>>(endpoint, body, { headers });

    if (response.data.code !== '0') {
      throw new Error(`OKX Spot API error: ${response.data.code} - ${response.data.msg}`);
    }

    return response.data.data;
  }

  // ==================== P2P: ADS MANAGEMENT ====================

  /**
   * Search marketplace ads (competitor analysis)
   * GET /api/v5/p2p/ad/marketplace-list
   */
  async searchAds(
    side: 'buy' | 'sell',
    cryptoCurrency: string,
    fiatCurrency: string,
    pageIndex: number = 1,
    pageSize: number = 20
  ): Promise<OkxAdData[]> {
    try {
      const result = await this.p2pGet<OkxAdData[]>('/api/v5/p2p/ad/marketplace-list', {
        side,
        cryptoCurrency,
        fiatCurrency,
        pageIndex: String(pageIndex),
        pageSize: String(pageSize),
      });
      return result || [];
    } catch (error: any) {
      log.error({ error: error.message, side, cryptoCurrency, fiatCurrency }, 'searchAds failed');
      return [];
    }
  }

  /**
   * Get our own active ads
   * GET /api/v5/p2p/ad/active-list
   */
  async getActiveAds(
    side?: 'buy' | 'sell',
    cryptoCurrency?: string,
    fiatCurrency?: string
  ): Promise<OkxAdData[]> {
    const params: Record<string, any> = {};
    if (side) params.side = side;
    if (cryptoCurrency) params.cryptoCurrency = cryptoCurrency;
    if (fiatCurrency) params.fiatCurrency = fiatCurrency;

    try {
      const result = await this.p2pGet<OkxAdData[]>('/api/v5/p2p/ad/active-list', params);
      return result || [];
    } catch (error: any) {
      log.error({ error: error.message }, 'getActiveAds failed');
      return [];
    }
  }

  /**
   * Get single ad detail
   * GET /api/v5/p2p/ad
   */
  async getAd(adId: string): Promise<OkxAdData | null> {
    try {
      const result = await this.p2pGet<OkxAdData>('/api/v5/p2p/ad', { adId });
      return result;
    } catch (error: any) {
      log.error({ error: error.message, adId }, 'getAd failed');
      return null;
    }
  }

  /**
   * Create a new ad
   * POST /api/v5/p2p/ad/create
   */
  async createAd(params: OkxAdParams): Promise<string> {
    const result = await this.p2pPost<{ adId: string }>('/api/v5/p2p/ad/create', params);
    log.info({ adId: result.adId, side: params.side, price: params.unitPrice }, 'Ad created');
    return result.adId;
  }

  /**
   * Update an ad (OKX cancels old + creates new, returns both IDs)
   * POST /api/v5/p2p/ad/update
   */
  async updateAd(adId: string, params: Partial<OkxAdParams>): Promise<OkxAdUpdateResult> {
    const result = await this.p2pPost<OkxAdUpdateResult>('/api/v5/p2p/ad/update', {
      adId,
      ...params,
    });
    log.info({ oldAdId: result.oldAdId, newAdId: result.newAdId }, 'Ad updated (cancel+create)');
    return result;
  }

  /**
   * Update ad active status (show/hide)
   * POST /api/v5/p2p/ad/update-active-status
   */
  async updateAdStatus(adId: string, status: 'hidden' | 'show'): Promise<void> {
    await this.p2pPost('/api/v5/p2p/ad/update-active-status', { adId, status });
    log.info({ adId, status }, 'Ad status updated');
  }

  /**
   * Cancel an ad
   * POST /api/v5/p2p/ad/cancel
   */
  async cancelAd(adId: string): Promise<void> {
    await this.p2pPost('/api/v5/p2p/ad/cancel', { adId });
    log.info({ adId }, 'Ad cancelled');
  }

  /**
   * Get optimal price for a trading pair
   * GET /api/v5/p2p/ad/optimal-price
   */
  async getOptimalPrice(cryptoCurrency: string, fiatCurrency: string): Promise<string> {
    try {
      const result = await this.p2pGet<{ optimalPrice: string }>('/api/v5/p2p/ad/optimal-price', {
        cryptoCurrency,
        fiatCurrency,
      });
      return result.optimalPrice || '0';
    } catch (error: any) {
      log.warn({ error: error.message, cryptoCurrency, fiatCurrency }, 'getOptimalPrice failed');
      return '0';
    }
  }

  // ==================== P2P: ORDER MANAGEMENT ====================

  /**
   * List orders with filters
   * GET /api/v5/p2p/order/list
   */
  async listOrders(filters: {
    side?: 'buy' | 'sell';
    completionStatus?: 'pending' | 'completed' | 'cancelled';
    pageIndex?: number;
    pageSize?: number;
  } = {}): Promise<OkxOrderData[]> {
    try {
      const result = await this.p2pGet<OkxOrderData[]>('/api/v5/p2p/order/list', {
        side: filters.side,
        completionStatus: filters.completionStatus || 'pending',
        pageIndex: String(filters.pageIndex || 1),
        pageSize: String(filters.pageSize || 50),
      });
      return result || [];
    } catch (error: any) {
      log.error({ error: error.message, filters }, 'listOrders failed');
      return [];
    }
  }

  /**
   * Get single order detail (includes counterparty info)
   * GET /api/v5/p2p/order
   */
  async getOrder(orderId: string): Promise<OkxOrderData | null> {
    try {
      const result = await this.p2pGet<OkxOrderData>('/api/v5/p2p/order', { orderId });
      return result;
    } catch (error: any) {
      log.error({ error: error.message, orderId }, 'getOrder failed');
      return null;
    }
  }

  /**
   * Get counterparty user info for an order
   * GET /api/v5/p2p/order/counterparty-user-info
   */
  async getCounterpartyInfo(orderId: string): Promise<OkxCounterpartyInfo | null> {
    try {
      const result = await this.p2pGet<OkxCounterpartyInfo>(
        '/api/v5/p2p/order/counterparty-user-info',
        { orderId }
      );
      return result;
    } catch (error: any) {
      log.warn({ error: error.message, orderId }, 'getCounterpartyInfo failed');
      return null;
    }
  }

  /**
   * Mark order as paid (buyer side)
   * POST /api/v5/p2p/order/mark-as-paid
   */
  async markAsPaid(orderId: string): Promise<void> {
    await this.p2pPost('/api/v5/p2p/order/mark-as-paid', { orderId });
    log.info({ orderId }, 'Order marked as paid');
  }

  /**
   * Mark order as unpaid
   * POST /api/v5/p2p/order/mark-as-unpaid
   */
  async markAsUnpaid(orderId: string): Promise<void> {
    await this.p2pPost('/api/v5/p2p/order/mark-as-unpaid', { orderId });
    log.info({ orderId }, 'Order marked as unpaid');
  }

  /**
   * Release crypto to buyer
   * POST /api/v5/p2p/order/release-crypto
   * OKX uses verificationType="2" — NO TOTP/2FA code needed
   */
  async releaseCrypto(orderId: string): Promise<void> {
    await this.p2pPost('/api/v5/p2p/order/release-crypto', {
      orderId,
      verificationType: '2',
    });
    log.info({ orderId }, 'Crypto released');
  }

  /**
   * Cancel an order
   * POST /api/v5/p2p/order/cancel
   */
  async cancelOrder(orderId: string): Promise<void> {
    await this.p2pPost('/api/v5/p2p/order/cancel', {
      orderId,
      verificationType: '2',
    });
    log.info({ orderId }, 'Order cancelled');
  }

  /**
   * Get unreleased orders (useful for stale check)
   * GET /api/v5/p2p/order/unreleased-orders
   */
  async getUnreleasedOrders(): Promise<OkxOrderData[]> {
    try {
      const result = await this.p2pGet<OkxOrderData[]>('/api/v5/p2p/order/unreleased-orders');
      return result || [];
    } catch (error: any) {
      log.warn({ error: error.message }, 'getUnreleasedOrders failed');
      return [];
    }
  }

  /**
   * Get pending orders for a specific ad
   * GET /api/v5/p2p/order/pending-order
   */
  async getPendingOrders(adId: string): Promise<OkxOrderData[]> {
    try {
      const result = await this.p2pGet<OkxOrderData[]>('/api/v5/p2p/order/pending-order', { adId });
      return result || [];
    } catch (error: any) {
      log.warn({ error: error.message, adId }, 'getPendingOrders failed');
      return [];
    }
  }

  // ==================== P2P: USER INFO ====================

  /**
   * Get own user info
   * GET /api/v5/p2p/user/basic-info
   */
  async getUserInfo(): Promise<OkxUserInfo | null> {
    try {
      const result = await this.p2pGet<OkxUserInfo>('/api/v5/p2p/user/basic-info');
      return result;
    } catch (error: any) {
      log.error({ error: error.message }, 'getUserInfo failed');
      return null;
    }
  }

  /**
   * Get P2P crypto balance
   * GET /api/v5/p2p/user/balance
   */
  async getP2PBalance(currency: string): Promise<OkxBalanceInfo | null> {
    try {
      const result = await this.p2pGet<OkxBalanceInfo>('/api/v5/p2p/user/balance', { currency });
      return result;
    } catch (error: any) {
      log.warn({ error: error.message, currency }, 'getP2PBalance failed');
      return null;
    }
  }

  /**
   * Get payment methods
   * GET /api/v5/p2p/payment-method/list
   */
  async getPaymentMethods(): Promise<OkxPaymentMethod[]> {
    try {
      const result = await this.p2pGet<OkxPaymentMethod[]>('/api/v5/p2p/payment-method/list');
      return result || [];
    } catch (error: any) {
      log.warn({ error: error.message }, 'getPaymentMethods failed');
      return [];
    }
  }

  // ==================== SPOT/TRADING API ====================

  /**
   * Get trading account balance
   * GET /api/v5/account/balance
   */
  async getSpotBalance(ccy?: string): Promise<Array<{ ccy: string; availBal: string; frozenBal: string }>> {
    try {
      const params: Record<string, any> = {};
      if (ccy) params.ccy = ccy;
      const result = await this.spotGet<Array<{ details: Array<{ ccy: string; availBal: string; frozenBal: string }> }>>(
        '/api/v5/account/balance',
        params
      );
      return result?.[0]?.details || [];
    } catch (error: any) {
      log.error({ error: error.message, ccy }, 'getSpotBalance failed');
      return [];
    }
  }

  /**
   * Get funding account balance
   * GET /api/v5/asset/balances
   */
  async getFundingBalance(ccy?: string): Promise<Array<{ ccy: string; availBal: string; frozenBal: string }>> {
    try {
      const params: Record<string, any> = {};
      if (ccy) params.ccy = ccy;
      const result = await this.spotGet<Array<{ ccy: string; availBal: string; frozenBal: string }>>(
        '/api/v5/asset/balances',
        params
      );
      return result || [];
    } catch (error: any) {
      log.error({ error: error.message, ccy }, 'getFundingBalance failed');
      return [];
    }
  }

  /**
   * Transfer between wallets (funding <-> trading)
   * POST /api/v5/asset/transfer
   * from/to: "6" = funding, "18" = trading
   */
  async transfer(params: OkxTransferParams): Promise<{ transId: string }> {
    const result = await this.spotPost<{ transId: string }>('/api/v5/asset/transfer', {
      ccy: params.ccy,
      amt: params.amt,
      from: params.from,
      to: params.to,
      type: params.type || '0',
    });
    log.info({ ccy: params.ccy, amt: params.amt, from: params.from, to: params.to }, 'Transfer completed');
    return result;
  }

  /**
   * Place a spot order
   * POST /api/v5/trade/order
   */
  async spotOrder(
    instId: string,
    side: 'buy' | 'sell',
    ordType: 'market' | 'limit',
    sz: string,
    px?: string
  ): Promise<OkxSpotOrderResult> {
    const body: Record<string, any> = {
      instId,
      tdMode: 'cash',
      side,
      ordType,
      sz,
    };
    if (px) body.px = px;

    const result = await this.spotPost<OkxSpotOrderResult[]>('/api/v5/trade/order', body);
    const order = Array.isArray(result) ? result[0] : result;

    if (order.sCode !== '0') {
      throw new Error(`OKX spot order failed: ${order.sCode} - ${order.sMsg}`);
    }

    log.info({ instId, side, ordType, sz, ordId: order.ordId }, 'Spot order placed');
    return order;
  }

  /**
   * Get spot order detail
   * GET /api/v5/trade/order
   */
  async getSpotOrder(instId: string, ordId: string): Promise<OkxSpotOrderDetail | null> {
    try {
      const result = await this.spotGet<OkxSpotOrderDetail[]>('/api/v5/trade/order', { instId, ordId });
      return result?.[0] || null;
    } catch (error: any) {
      log.warn({ error: error.message, instId, ordId }, 'getSpotOrder failed');
      return null;
    }
  }

  /**
   * Get instrument info (lot size, min size, etc.)
   * GET /api/v5/public/instruments
   */
  async getInstrument(instId: string): Promise<OkxInstrumentInfo | null> {
    try {
      // Public endpoint, no auth needed but using same client
      const result = await this.spotGet<OkxInstrumentInfo[]>('/api/v5/public/instruments', {
        instType: 'SPOT',
        instId,
      });
      return result?.[0] || null;
    } catch (error: any) {
      log.warn({ error: error.message, instId }, 'getInstrument failed');
      return null;
    }
  }

  /**
   * Get ticker price
   * GET /api/v5/market/ticker
   */
  async getTickerPrice(instId: string): Promise<string> {
    try {
      const result = await this.spotGet<Array<{ last: string }>>('/api/v5/market/ticker', { instId });
      return result?.[0]?.last || '0';
    } catch (error: any) {
      log.warn({ error: error.message, instId }, 'getTickerPrice failed');
      return '0';
    }
  }

  // ==================== CONNECTIVITY ====================

  /**
   * Test API connectivity by fetching user info
   */
  async ping(): Promise<boolean> {
    try {
      const info = await this.getUserInfo();
      return !!info;
    } catch {
      return false;
    }
  }
}

// ==================== COUNTERPARTY INFO TYPE ====================

interface OkxCounterpartyInfo {
  userId: string;
  nickName: string;
  realName: string;
  completedOrders: string;
  completionRate: string;
  kycLevel: number;
  registerTime: string;
}

// ==================== SINGLETON ====================

let clientInstance: OkxClient | null = null;

export function getOkxClient(): OkxClient {
  if (!clientInstance) {
    const apiKey = process.env.OKX_API_KEY;
    const apiSecret = process.env.OKX_API_SECRET;
    const passphrase = process.env.OKX_PASSPHRASE;
    const baseUrl = process.env.OKX_BASE_URL || 'https://www.okx.com';

    if (!apiKey || !apiSecret || !passphrase) {
      throw new Error('OKX_API_KEY, OKX_API_SECRET, and OKX_PASSPHRASE must be set');
    }

    clientInstance = new OkxClient(apiKey, apiSecret, passphrase, baseUrl);
  }
  return clientInstance;
}

// ==================== TEST SCRIPT ====================

// Run directly with: npx tsx src/exchanges/okx/okx-client.ts
if (process.argv[1]?.includes('okx-client')) {
  import('dotenv/config').then(async () => {
    try {
      const client = getOkxClient();
      console.log('Testing OKX API connection...');

      const info = await client.getUserInfo();
      if (info) {
        console.log('Connected! User info:', JSON.stringify(info, null, 2));
      } else {
        console.log('getUserInfo returned null — check credentials');
      }

      const balance = await client.getP2PBalance('USDT');
      console.log('USDT balance:', balance);
    } catch (error: any) {
      console.error('Connection failed:', error.message);
      process.exit(1);
    }
  });
}
