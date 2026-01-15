// =====================================================
// BINANCE C2C API CLIENT
// Handles authentication, signing, and API requests
// =====================================================

import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import CryptoJS from 'crypto-js';
import { logger } from '../utils/logger.js';
import {
  BinanceApiResponse,
  SearchAdsRequest,
  UpdateAdRequest,
  ListOrdersRequest,
  OrderDetailRequest,
  ReleaseCoinRequest,
  MarkOrderAsPaidRequest,
  ChatMessagesRequest,
  AdData,
  OrderData,
  ChatCredential,
  ChatMessage,
  MerchantAdsDetail,
  ReferencePrice,
  UserStats,
  TradeType,
} from '../types/binance.js';

export class BinanceC2CClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly client: AxiosInstance;

  constructor(apiKey: string, apiSecret: string, baseUrl: string = 'https://api.binance.com') {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = baseUrl;

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'X-MBX-APIKEY': this.apiKey,
        'clientType': 'web',  // Required by Binance C2C API
      },
    });

    // Request interceptor for logging
    this.client.interceptors.request.use((config) => {
      logger.debug({
        method: config.method,
        url: config.url,
        params: config.params
      }, 'API Request');
      return config;
    });

    // Response interceptor for logging
    this.client.interceptors.response.use(
      (response) => {
        logger.debug({
          status: response.status,
          data: response.data
        }, 'API Response');
        return response;
      },
      (error) => {
        logger.error({
          error: error.response?.data || error.message
        }, 'API Error');
        throw error;
      }
    );
  }

  // ==================== SIGNATURE ====================

  /**
   * Generate HMAC SHA256 signature
   * IMPORTANT: signature must be the LAST query parameter
   */
  private generateSignature(queryString: string): string {
    return CryptoJS.HmacSHA256(queryString, this.apiSecret).toString(CryptoJS.enc.Hex);
  }

  /**
   * Build signed query string with timestamp
   */
  private buildSignedParams(params: Record<string, any> = {}): string {
    const timestamp = Date.now();
    const allParams = { ...params, timestamp };

    // Build query string (without signature)
    const queryString = Object.entries(allParams)
      .filter(([_, value]) => value !== undefined && value !== null)
      .map(([key, value]) => {
        if (Array.isArray(value)) {
          return value.map(v => `${key}=${encodeURIComponent(v)}`).join('&');
        }
        return `${key}=${encodeURIComponent(value)}`;
      })
      .join('&');

    // Generate signature
    const signature = this.generateSignature(queryString);

    // Signature MUST be last parameter
    return `${queryString}&signature=${signature}`;
  }

  /**
   * Make signed GET request
   */
  private async signedGet<T>(endpoint: string, params: Record<string, any> = {}): Promise<T> {
    const signedParams = this.buildSignedParams(params);
    const response = await this.client.get<BinanceApiResponse<T>>(
      `${endpoint}?${signedParams}`
    );
    return response.data.data;
  }

  /**
   * Make signed POST request
   */
  private async signedPost<T>(
    endpoint: string,
    body: Record<string, any> = {},
    params: Record<string, any> = {}
  ): Promise<T> {
    const signedParams = this.buildSignedParams(params);
    const response = await this.client.post<BinanceApiResponse<T>>(
      `${endpoint}?${signedParams}`,
      body
    );
    return response.data.data;
  }

  // ==================== ADS MANAGEMENT ====================

  /**
   * Search competitor ads
   * Note: SAPI /search endpoint returns errors - using public P2P API instead
   */
  async searchAds(request: SearchAdsRequest): Promise<AdData[]> {
    try {
      // Try the public P2P API endpoint (no auth required)
      const response = await fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          asset: request.asset,
          fiat: request.fiat,
          tradeType: request.tradeType,
          page: request.page || 1,
          rows: request.rows || 10,
          payTypes: request.payTypes || [],
          publisherType: request.publisherType || null,
          transAmount: request.transAmount || null,
        }),
      });

      const data = await response.json() as { success?: boolean; data?: AdData[] };
      if (data.success && data.data) {
        return data.data;
      }
      logger.warn({ response: data }, 'Search ads returned no data');
      return [];
    } catch (error) {
      logger.warn({ error }, 'Failed to search competitor ads');
      return [];
    }
  }

  /**
   * Get reference price for asset/fiat pair
   * Uses market index price endpoint (tested and working)
   * Fallback: /sapi/v1/c2c/market/getIndexPrice
   */
  async getReferencePrice(
    asset: string,
    fiat: string,
    tradeType: TradeType
  ): Promise<ReferencePrice> {
    try {
      // Primary: Try market index price which works
      const response = await this.signedGet<{ indexPrice: string }>(
        '/sapi/v1/c2c/market/getIndexPrice',
        { asset, fiat }
      );
      return {
        price: (response as any)?.indexPrice || '0',
        fiatUnit: fiat,
        asset,
        tradeType,
      };
    } catch (error) {
      logger.warn({ asset, fiat, error }, 'Failed to get reference price');
      // Return a fallback
      return {
        price: '0',
        fiatUnit: fiat,
        asset,
        tradeType,
      };
    }
  }

  /**
   * List my ads with pagination
   * Tries GET first, then POST as fallback
   * Some Binance API versions prefer different methods
   */
  async listMyAds(page: number = 1, rows: number = 10): Promise<MerchantAdsDetail> {
    // Try GET method first (works on some API versions)
    try {
      const response = await this.signedGet<MerchantAdsDetail>(
        '/sapi/v1/c2c/ads/listWithPagination',
        { page, rows }
      );
      if (response) {
        logger.debug('listMyAds: GET method succeeded');
        return response;
      }
    } catch (getError: any) {
      const errorCode = getError?.response?.data?.code;
      logger.debug({ errorCode, error: getError?.message }, 'listMyAds: GET failed, trying POST');
    }

    // Try POST method as fallback
    try {
      const response = await this.signedPost<MerchantAdsDetail>(
        '/sapi/v1/c2c/ads/listWithPagination',
        { page, rows }
      );
      if (response) {
        logger.debug('listMyAds: POST method succeeded');
        return response;
      }
    } catch (postError: any) {
      const errorCode = postError?.response?.data?.code;
      logger.warn({ errorCode, error: postError?.message }, 'listMyAds: POST also failed');
    }

    // Return empty structure if both fail
    logger.warn('listMyAds: Both GET and POST failed, returning empty structure');
    return {
      sellList: [],
      buyList: [],
      merchant: {} as any,
    };
  }

  /**
   * Update ad price and settings
   * POST /sapi/v1/c2c/ads/update
   */
  async updateAd(request: UpdateAdRequest): Promise<boolean> {
    await this.signedPost<void>(
      '/sapi/v1/c2c/ads/update',
      request
    );
    return true;
  }

  /**
   * Enable/disable ad
   * POST /sapi/v1/c2c/ads/updateStatus
   */
  async updateAdStatus(advNo: string, enable: boolean): Promise<boolean> {
    await this.signedPost<void>(
      '/sapi/v1/c2c/ads/updateStatus',
      { advNo, advStatus: enable ? 1 : 0 }
    );
    return true;
  }

  // ==================== ORDER MANAGEMENT ====================

  /**
   * List orders with filters
   * POST /sapi/v1/c2c/orderMatch/listOrders (per SAPI v7.4 docs)
   */
  async listOrders(request: ListOrdersRequest = {}): Promise<OrderData[]> {
    const body: Record<string, any> = {
      tradeType: request.tradeType || 'SELL',
      rows: request.rows || 20,
      page: request.page || 1,
    };

    // Add optional filters
    if (request.orderStatus) {
      body.orderStatusList = [request.orderStatus];
    }
    if (request.asset) {
      body.asset = request.asset;
    }
    if (request.startTimestamp) {
      body.startDate = request.startTimestamp;
    }
    if (request.endTimestamp) {
      body.endDate = request.endTimestamp;
    }

    const response = await this.signedPost<{ data: OrderData[] }>(
      '/sapi/v1/c2c/orderMatch/listOrders',
      body
    );
    // API returns { data: [...] } or array directly
    return (response as any)?.data || response || [];
  }

  /**
   * List pending/active orders (orders in status 1, 2, or 3)
   * POST /sapi/v1/c2c/orderMatch/listOrders with status filter
   */
  async listPendingOrders(rows: number = 20): Promise<OrderData[]> {
    const body = {
      tradeType: 'SELL',
      rows,
      page: 1,
      // Status 1=PENDING, 2=PAID, 3=APPEALING (active orders)
      orderStatusList: [1, 2, 3],
    };

    const response = await this.signedPost<{ data: OrderData[] }>(
      '/sapi/v1/c2c/orderMatch/listOrders',
      body
    );
    return (response as any)?.data || response || [];
  }

  /**
   * Get order history (completed/cancelled orders)
   * GET /sapi/v1/c2c/orderMatch/listUserOrderHistory
   */
  async listOrderHistory(request: ListOrdersRequest = {}): Promise<OrderData[]> {
    const response = await this.signedGet<{ data: OrderData[] }>(
      '/sapi/v1/c2c/orderMatch/listUserOrderHistory',
      {
        tradeType: request.tradeType || 'SELL',
        rows: request.rows || 20,
        page: request.page || 1,
        startTimestamp: request.startTimestamp,
        endTimestamp: request.endTimestamp,
      }
    );
    return (response as any)?.data || response || [];
  }

  /**
   * Get order detail
   * POST /sapi/v1/c2c/orderMatch/getUserOrderDetail
   * Note: API expects 'adOrderNo' not 'orderNumber' (per SAPI v7.4 docs)
   */
  async getOrderDetail(orderNumber: string): Promise<OrderData> {
    const response = await this.signedPost<OrderData>(
      '/sapi/v1/c2c/orderMatch/getUserOrderDetail',
      { adOrderNo: orderNumber }
    );
    return response;
  }

  /**
   * Get user statistics
   * GET /sapi/v1/c2c/orderMatch/getUserStats
   */
  async getUserStats(userNo: string): Promise<UserStats> {
    const response = await this.signedGet<UserStats>(
      '/sapi/v1/c2c/orderMatch/getUserStats',
      { userNo }
    );
    return response;
  }

  /**
   * Release crypto to buyer (requires 2FA)
   * POST /sapi/v1/c2c/orderMatch/releaseCoin
   *
   * IMPORTANT: This requires 2FA verification
   */
  async releaseCoin(request: ReleaseCoinRequest): Promise<boolean> {
    await this.signedPost<void>(
      '/sapi/v1/c2c/orderMatch/releaseCoin',
      request
    );
    logger.info({ orderNumber: request.orderNumber }, 'Crypto released successfully');
    return true;
  }

  /**
   * Mark order as paid (for buyer side)
   * POST /sapi/v1/c2c/orderMatch/markOrderAsPaid
   */
  async markOrderAsPaid(request: MarkOrderAsPaidRequest): Promise<boolean> {
    await this.signedPost<void>(
      '/sapi/v1/c2c/orderMatch/markOrderAsPaid',
      request
    );
    return true;
  }

  /**
   * Cancel order
   * POST /sapi/v1/c2c/orderMatch/cancelOrder
   */
  async cancelOrder(orderNumber: string): Promise<boolean> {
    await this.signedPost<void>(
      '/sapi/v1/c2c/orderMatch/cancelOrder',
      { orderNumber }
    );
    logger.info({ orderNumber }, 'Order cancelled');
    return true;
  }

  // ==================== CHAT ====================

  /**
   * Get WebSocket credentials for chat
   * GET /sapi/v1/c2c/chat/retrieveChatCredential
   */
  async getChatCredential(): Promise<ChatCredential> {
    const response = await this.signedGet<ChatCredential>(
      '/sapi/v1/c2c/chat/retrieveChatCredential'
    );
    return response;
  }

  /**
   * Get chat messages for an order
   * GET /sapi/v1/c2c/chat/retrieveChatMessagesWithPagination (tested and working)
   */
  async getChatMessages(request: ChatMessagesRequest): Promise<ChatMessage[]> {
    const response = await this.signedGet<{ data: ChatMessage[] }>(
      '/sapi/v1/c2c/chat/retrieveChatMessagesWithPagination',
      {
        orderNo: request.orderNo,
        page: request.page || 1,
        rows: request.rows || 50,
      }
    );
    // API returns { data: [...] }
    return (response as any)?.data || response || [];
  }

  /**
   * Send chat message
   * POST /sapi/v1/c2c/chat/sendMessage
   */
  async sendChatMessage(orderNo: string, content: string): Promise<boolean> {
    await this.signedPost<void>(
      '/sapi/v1/c2c/chat/sendMessage',
      { orderNo, content, type: 'text' }
    );
    return true;
  }

  /**
   * Get pre-signed URL for uploading images to chat
   * POST /sapi/v1/c2c/chat/image/pre-signed-url
   */
  async getImageUploadUrl(orderNo: string): Promise<{ uploadUrl: string; imageUrl: string }> {
    const response = await this.signedPost<{ uploadUrl: string; imageUrl: string }>(
      '/sapi/v1/c2c/chat/image/pre-signed-url',
      { orderNo }
    );
    return response;
  }

  // ==================== UTILITY METHODS ====================

  /**
   * Check API connectivity
   */
  async ping(): Promise<boolean> {
    try {
      await this.client.get('/api/v3/ping');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get server time (for timestamp sync)
   */
  async getServerTime(): Promise<number> {
    const response = await this.client.get<{ serverTime: number }>('/api/v3/time');
    return response.data.serverTime;
  }
}

// Singleton instance
let clientInstance: BinanceC2CClient | null = null;

export function getBinanceClient(): BinanceC2CClient {
  if (!clientInstance) {
    const apiKey = process.env.BINANCE_API_KEY;
    const apiSecret = process.env.BINANCE_API_SECRET;
    const baseUrl = process.env.BINANCE_SAPI_URL || 'https://api.binance.com';

    if (!apiKey || !apiSecret) {
      throw new Error('BINANCE_API_KEY and BINANCE_API_SECRET must be set');
    }

    clientInstance = new BinanceC2CClient(apiKey, apiSecret, baseUrl);
  }
  return clientInstance;
}
