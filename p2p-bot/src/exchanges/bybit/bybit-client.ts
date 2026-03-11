// =====================================================
// BYBIT P2P API CLIENT
// Handles Bybit-specific authentication, signing, and API requests
// ZERO dependency on Binance or OKX code
// =====================================================

import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { logger } from '../../utils/logger.js';
import {
  BybitApiResponse,
  BybitV5Response,
  BybitMarketplaceAd,
  BybitMyAd,
  BybitOrderData,
  BybitUserInfo,
  BybitCoinBalance,
  BybitCreateAdParams,
  BybitUpdateAdParams,
  BybitAdMutationResult,
  BybitOrderStatus,
  BybitOrderDetail,
} from './bybit-types.js';

const log = logger.child({ module: 'bybit-client' });

// ==================== BYBIT CLIENT ====================

export class BybitClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly recvWindow: string;
  private readonly client: AxiosInstance;

  constructor(
    apiKey: string,
    apiSecret: string,
    baseUrl: string = 'https://api.bybit.com',
    recvWindow: string = '5000'
  ) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.recvWindow = recvWindow;

    // Setup proxy if configured (needed for regions where Bybit blocks IPs, e.g. US)
    const proxyUrl = process.env.BYBIT_PROXY_URL || process.env.PROXY_URL;
    const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
    if (proxyAgent) {
      log.info({ proxy: proxyUrl?.replace(/:[^:@]+@/, ':***@') }, 'Using proxy for Bybit API');
    }

    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
      ...(proxyAgent && { httpsAgent: proxyAgent, proxy: false }),
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    this.client.interceptors.request.use((config) => {
      log.debug({ method: config.method, url: config.url }, 'Request');
      return config;
    });

    this.client.interceptors.response.use(
      (response) => {
        log.debug({ status: response.status }, 'Response');
        return response;
      },
      (error) => {
        log.error({
          status: error.response?.status,
          data: JSON.stringify(error.response?.data),
          message: error.message,
          url: error.config?.url,
        }, 'API Error');
        throw error;
      }
    );
  }

  // ==================== BYBIT SIGNATURE ====================

  /**
   * Generate Bybit HMAC-SHA256 signature
   * Sign: HMAC_SHA256(timestamp + apiKey + recvWindow + payload)
   * payload = queryString (GET) or JSON body (POST)
   */
  private sign(timestamp: string, payload: string): string {
    const prehash = timestamp + this.apiKey + this.recvWindow + payload;
    return crypto.createHmac('sha256', this.apiSecret).update(prehash).digest('hex');
  }

  /**
   * Build auth headers for Bybit API
   */
  private getAuthHeaders(payload: string): Record<string, string> {
    const timestamp = Date.now().toString();
    const signature = this.sign(timestamp, payload);

    return {
      'X-BAPI-API-KEY': this.apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-SIGN': signature,
      'X-BAPI-RECV-WINDOW': this.recvWindow,
      'Content-Type': 'application/json',
    };
  }

  // ==================== REQUEST HELPERS ====================

  /**
   * Signed GET request
   */
  private async get<T>(endpoint: string, params: Record<string, any> = {}): Promise<T> {
    const queryParts = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
    const queryString = queryParts.join('&');
    const headers = this.getAuthHeaders(queryString);
    const url = queryString ? `${endpoint}?${queryString}` : endpoint;

    const response = await this.client.get(url, { headers });

    const data = response.data;
    const code = data.retCode ?? data.ret_code ?? -1;
    if (code !== 0) {
      const msg = data.retMsg ?? data.ret_msg ?? 'Unknown error';
      throw new Error(`Bybit API error: ${code} - ${msg}`);
    }

    return data.result;
  }

  /**
   * Signed POST request
   */
  private async post<T>(endpoint: string, body: Record<string, any> = {}): Promise<T> {
    const bodyStr = JSON.stringify(body);
    const headers = this.getAuthHeaders(bodyStr);

    const response = await this.client.post(endpoint, body, { headers });

    const data = response.data;
    const code = data.retCode ?? data.ret_code ?? -1;
    if (code !== 0) {
      const msg = data.retMsg ?? data.ret_msg ?? 'Unknown error';
      throw new Error(`Bybit API error: ${code} - ${msg}`);
    }

    return data.result;
  }

  // ==================== P2P: ADS MANAGEMENT ====================

  /**
   * Get marketplace ads (competitor analysis)
   * POST /v5/p2p/item/online
   */
  async searchAds(
    tokenId: string,
    currencyId: string,
    side: '0' | '1',
    page: number = 1,
    size: number = 20
  ): Promise<{ count: number; items: BybitMarketplaceAd[] }> {
    try {
      const result = await this.post<{ count: number; items: BybitMarketplaceAd[] }>(
        '/v5/p2p/item/online',
        { tokenId, currencyId, side, page: String(page), size: String(size) }
      );
      return result || { count: 0, items: [] };
    } catch (error: any) {
      log.error({ error: error.message, tokenId, currencyId, side }, 'searchAds failed');
      return { count: 0, items: [] };
    }
  }

  /**
   * Get own ads
   * POST /v5/p2p/item/personal/list
   */
  async getMyAds(filters: {
    itemId?: string;
    status?: string;    // '1'=sold out, '2'=available
    side?: string;      // '0'=buy, '1'=sell
    tokenId?: string;
    currencyId?: string;
    page?: number;
    size?: number;
  } = {}): Promise<{ count: number; items: BybitMyAd[] }> {
    try {
      const body: Record<string, any> = {};
      if (filters.itemId) body.itemId = filters.itemId;
      if (filters.status) body.status = filters.status;
      if (filters.side) body.side = filters.side;
      if (filters.tokenId) body.tokenId = filters.tokenId;
      if (filters.currencyId) body.currencyId = filters.currencyId;
      if (filters.page) body.page = String(filters.page);
      if (filters.size) body.size = String(filters.size);

      const result = await this.post<{ count: number; items: BybitMyAd[] }>(
        '/v5/p2p/item/personal/list',
        body
      );
      return result || { count: 0, items: [] };
    } catch (error: any) {
      log.error({ error: error.message }, 'getMyAds failed');
      return { count: 0, items: [] };
    }
  }

  /**
   * Get ad detail
   * POST /v5/p2p/item/info
   */
  async getAdDetail(itemId: string): Promise<BybitMyAd | null> {
    try {
      const result = await this.post<BybitMyAd>('/v5/p2p/item/info', { itemId });
      return result;
    } catch (error: any) {
      log.error({ error: error.message, itemId }, 'getAdDetail failed');
      return null;
    }
  }

  /**
   * Create a new ad
   * POST /v5/p2p/item/create
   */
  async createAd(params: BybitCreateAdParams): Promise<BybitAdMutationResult> {
    const result = await this.post<BybitAdMutationResult>('/v5/p2p/item/create', params);
    log.info({ itemId: result.itemId, side: params.side, price: params.price }, 'Ad created');
    return result;
  }

  /**
   * Update an ad
   * POST /v5/p2p/item/update
   * actionType: 'MODIFY' to edit, 'ACTIVE' to re-online
   */
  async updateAd(params: BybitUpdateAdParams): Promise<BybitAdMutationResult> {
    const result = await this.post<BybitAdMutationResult>('/v5/p2p/item/update', params);
    log.info({ id: params.id, price: params.price, action: params.actionType }, 'Ad updated');
    return result;
  }

  /**
   * Cancel/remove an ad
   * POST /v5/p2p/item/cancel
   */
  async cancelAd(itemId: string): Promise<void> {
    await this.post('/v5/p2p/item/cancel', { itemId });
    log.info({ itemId }, 'Ad cancelled');
  }

  // ==================== P2P: ORDER MANAGEMENT ====================

  /**
   * List all orders (history)
   * POST /v5/p2p/order/simplifyList
   */
  async listOrders(filters: {
    page: number;
    size: number;
    status?: BybitOrderStatus;
    beginTime?: string;
    endTime?: string;
    tokenId?: string;
    side?: number;       // 0=buy, 1=sell
  }): Promise<{ count: number; items: BybitOrderData[] }> {
    try {
      const result = await this.post<{ count: number; items: BybitOrderData[] }>(
        '/v5/p2p/order/simplifyList',
        filters
      );
      return result || { count: 0, items: [] };
    } catch (error: any) {
      log.error({ error: error.message, filters }, 'listOrders failed');
      return { count: 0, items: [] };
    }
  }

  /**
   * List pending orders only
   * POST /v5/p2p/order/pending/simplifyList
   */
  async listPendingOrders(filters: {
    page?: number;
    size?: number;
    tokenId?: string;
    side?: number;
  } = {}): Promise<{ count: number; items: BybitOrderData[] }> {
    try {
      const result = await this.post<{ count: number; items: BybitOrderData[] }>(
        '/v5/p2p/order/pending/simplifyList',
        { page: 1, size: 30, ...filters }
      );
      return result || { count: 0, items: [] };
    } catch (error: any) {
      log.error({ error: error.message }, 'listPendingOrders failed');
      return { count: 0, items: [] };
    }
  }

  /**
   * Get full order detail
   * POST /v5/p2p/order/info
   */
  async getOrderDetail(orderId: string): Promise<BybitOrderDetail | null> {
    try {
      const result = await this.post<BybitOrderDetail>('/v5/p2p/order/info', { orderId });
      return result;
    } catch (error: any) {
      log.error({ error: error.message, orderId }, 'getOrderDetail failed');
      return null;
    }
  }

  /**
   * Release crypto to buyer (seller action)
   * POST /v5/p2p/order/finish
   */
  async releaseCrypto(orderId: string): Promise<void> {
    await this.post('/v5/p2p/order/finish', { orderId });
    log.info({ orderId }, 'Crypto released');
  }

  /**
   * Mark order as paid (buyer action)
   * POST /v5/p2p/order/pay
   */
  async markOrderPaid(orderId: string, paymentType: string, paymentId: string): Promise<void> {
    await this.post('/v5/p2p/order/pay', { orderId, paymentType, paymentId });
    log.info({ orderId, paymentType }, 'Order marked as paid');
  }

  // ==================== P2P: CHAT ====================

  /**
   * Send chat message in order
   * POST /v5/p2p/order/message/send
   */
  async sendChatMessage(orderId: string, message: string, contentType: number = 1): Promise<void> {
    try {
      await this.post('/v5/p2p/order/message/send', {
        orderId,
        message,
        contentType,  // 1=text
      });
    } catch (error: any) {
      log.error({ error: error.message, orderId }, 'sendChatMessage failed');
    }
  }

  /**
   * Get chat messages for order
   * POST /v5/p2p/order/message/listpage
   */
  async getChatMessages(orderId: string, page: number = 1, size: number = 50): Promise<any[]> {
    try {
      const result = await this.post<{ items: any[] }>(
        '/v5/p2p/order/message/listpage',
        { orderId, page: String(page), size: String(size) }
      );
      return result?.items || [];
    } catch (error: any) {
      log.error({ error: error.message, orderId }, 'getChatMessages failed');
      return [];
    }
  }

  // ==================== P2P: USER INFO ====================

  /**
   * Get own user info
   * POST /v5/p2p/user/personal/info
   */
  async getUserInfo(): Promise<BybitUserInfo | null> {
    try {
      const result = await this.post<BybitUserInfo>('/v5/p2p/user/personal/info', {});
      return result;
    } catch (error: any) {
      log.error({ error: error.message }, 'getUserInfo failed');
      return null;
    }
  }

  // ==================== BALANCE ====================

  /**
   * Get coin balance
   * GET /v5/asset/transfer/query-account-coins-balance
   */
  async getCoinBalance(
    accountType: string = 'FUND',
    coin?: string
  ): Promise<BybitCoinBalance[]> {
    try {
      const params: Record<string, any> = { accountType };
      if (coin) params.coin = coin;

      const result = await this.get<{ balance: BybitCoinBalance[] }>(
        '/v5/asset/transfer/query-account-coins-balance',
        params
      );
      return result?.balance || [];
    } catch (error: any) {
      log.error({ error: error.message, accountType, coin }, 'getCoinBalance failed');
      return [];
    }
  }

  // ==================== ASSET TRANSFER ====================

  /**
   * Internal transfer between accounts (FUND ↔ UNIFIED/SPOT)
   * POST /v5/asset/transfer/inter-transfer
   */
  async interTransfer(params: {
    coin: string;
    amount: string;
    fromAccountType: string;   // FUND, UNIFIED, SPOT, CONTRACT
    toAccountType: string;
  }): Promise<{ transferId: string; status: string }> {
    const transferId = crypto.randomUUID();
    const result = await this.post<{ transferId: string; status: string }>(
      '/v5/asset/transfer/inter-transfer',
      {
        transferId,
        coin: params.coin,
        amount: params.amount,
        fromAccountType: params.fromAccountType,
        toAccountType: params.toAccountType,
      }
    );
    log.info({
      coin: params.coin,
      amount: params.amount,
      from: params.fromAccountType,
      to: params.toAccountType,
    }, 'Transfer completed');
    return result;
  }

  // ==================== SPOT TRADING ====================

  /**
   * Place spot order
   * POST /v5/order/create
   */
  async spotOrder(
    symbol: string,
    side: 'Buy' | 'Sell',
    orderType: 'Market' | 'Limit',
    qty: string,
    price?: string
  ): Promise<{ orderId: string; orderLinkId: string }> {
    const body: Record<string, any> = {
      category: 'spot',
      symbol,
      side,
      orderType,
      qty,
    };
    if (price) body.price = price;

    const result = await this.post<{ orderId: string; orderLinkId: string }>(
      '/v5/order/create',
      body
    );
    log.info({ symbol, side, orderType, qty, orderId: result.orderId }, 'Spot order placed');
    return result;
  }

  /**
   * Get spot order detail
   * GET /v5/order/realtime
   */
  async getSpotOrder(symbol: string, orderId: string): Promise<any | null> {
    try {
      const result = await this.get<{ list: any[] }>(
        '/v5/order/realtime',
        { category: 'spot', symbol, orderId }
      );
      return result?.list?.[0] || null;
    } catch (error: any) {
      log.error({ error: error.message, symbol, orderId }, 'getSpotOrder failed');
      return null;
    }
  }

  /**
   * Get ticker price
   * GET /v5/market/tickers
   */
  async getTickerPrice(symbol: string): Promise<string> {
    const result = await this.get<{ list: Array<{ lastPrice: string }> }>(
      '/v5/market/tickers',
      { category: 'spot', symbol }
    );
    return result?.list?.[0]?.lastPrice || '0';
  }

  /**
   * Get instrument info (lot size, min size)
   * GET /v5/market/instruments-info
   */
  async getInstrumentInfo(symbol: string): Promise<{
    basePrecision: string;
    minOrderQty: string;
    basePrecisionStep: string;
  } | null> {
    try {
      const result = await this.get<{ list: any[] }>(
        '/v5/market/instruments-info',
        { category: 'spot', symbol }
      );
      const info = result?.list?.[0];
      if (!info) return null;
      return {
        basePrecision: info.lotSizeFilter?.basePrecision || '0.000001',
        minOrderQty: info.lotSizeFilter?.minOrderQty || '0',
        basePrecisionStep: info.lotSizeFilter?.basePrecision || '0.000001',
      };
    } catch (error: any) {
      log.error({ error: error.message, symbol }, 'getInstrumentInfo failed');
      return null;
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

// ==================== SINGLETON ====================

let clientInstance: BybitClient | null = null;

export function getBybitClient(): BybitClient {
  if (!clientInstance) {
    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    const baseUrl = process.env.BYBIT_BASE_URL || 'https://api.bybit.com';

    if (!apiKey || !apiSecret) {
      throw new Error('BYBIT_API_KEY and BYBIT_API_SECRET must be set');
    }

    clientInstance = new BybitClient(apiKey, apiSecret, baseUrl);
  }
  return clientInstance;
}

// ==================== TEST SCRIPT ====================

if (process.argv[1]?.includes('bybit-client')) {
  import('dotenv/config').then(async () => {
    try {
      const client = getBybitClient();
      console.log('Testing Bybit API connection...');

      const info = await client.getUserInfo();
      if (info) {
        console.log('Connected! User:', JSON.stringify(info, null, 2));
      } else {
        console.log('getUserInfo returned null — check credentials');
      }

      const balance = await client.getCoinBalance('FUND', 'USDT');
      console.log('USDT balance:', balance);
    } catch (error: any) {
      console.error('Connection failed:', error.message);
      process.exit(1);
    }
  });
}
