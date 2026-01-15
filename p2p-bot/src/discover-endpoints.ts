// =====================================================
// BINANCE C2C API ENDPOINT DISCOVERY SCRIPT
// Tries multiple endpoint variations to find working ones
// =====================================================

import 'dotenv/config';
import crypto from 'crypto';

const API_KEY = process.env.BINANCE_API_KEY!;
const API_SECRET = process.env.BINANCE_API_SECRET!;
const BASE_URL = 'https://api.binance.com';
const P2P_BASE_URL = 'https://p2p.binance.com';

interface TestResult {
  endpoint: string;
  method: string;
  status: 'SUCCESS' | 'AUTH_ERROR' | 'NOT_FOUND' | 'API_ERROR' | 'NETWORK_ERROR';
  httpCode?: number;
  binanceCode?: string;
  message?: string;
  hasData?: boolean;
}

const results: TestResult[] = [];
const successfulEndpoints: TestResult[] = [];

function sign(queryString: string): string {
  return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}

async function testEndpoint(
  name: string,
  baseUrl: string,
  endpoint: string,
  method: 'GET' | 'POST' = 'GET',
  body?: any,
  queryParams?: Record<string, any>,
  requiresAuth: boolean = true
): Promise<TestResult> {
  const timestamp = Date.now();

  let url = `${baseUrl}${endpoint}`;
  let headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'clientType': 'web',
  };

  if (requiresAuth) {
    headers['X-MBX-APIKEY'] = API_KEY;

    const allParams = { ...queryParams, timestamp };
    const queryString = Object.entries(allParams)
      .filter(([_, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
    const signature = sign(queryString);
    url = `${url}?${queryString}&signature=${signature}`;
  }

  try {
    const options: RequestInit = {
      method,
      headers,
    };

    if (body && method === 'POST') {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const text = await response.text();

    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    const result: TestResult = {
      endpoint: `${method} ${endpoint}`,
      method,
      httpCode: response.status,
      binanceCode: data?.code?.toString(),
      message: data?.message || data?.msg,
      hasData: !!data?.data || (Array.isArray(data) && data.length > 0),
      status: 'API_ERROR',
    };

    if (response.ok && (!data.code || data.code === '000000' || data.code === 0)) {
      result.status = 'SUCCESS';
      console.log(`✅ ${name}: ${endpoint}`);
      successfulEndpoints.push(result);
    } else if (response.status === 401 || response.status === 403) {
      result.status = 'AUTH_ERROR';
      console.log(`🔐 ${name}: ${endpoint} - Auth Error`);
    } else if (response.status === 404) {
      result.status = 'NOT_FOUND';
      // Silent for 404s
    } else {
      result.status = 'API_ERROR';
      console.log(`⚠️ ${name}: ${endpoint} - ${data?.code}: ${data?.message || data?.msg}`);
    }

    results.push(result);
    return result;
  } catch (error) {
    const result: TestResult = {
      endpoint: `${method} ${endpoint}`,
      method,
      status: 'NETWORK_ERROR',
      message: String(error),
    };
    results.push(result);
    return result;
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('🔍 BINANCE C2C API ENDPOINT DISCOVERY');
  console.log('=====================================\n');

  if (!API_KEY || !API_SECRET) {
    console.error('❌ Missing API_KEY or API_SECRET');
    process.exit(1);
  }

  // ==================== ADS ENDPOINTS ====================
  console.log('\n📢 Testing ADS endpoints...\n');

  const adsEndpoints = [
    // Known/documented
    '/sapi/v1/c2c/ads/list',
    '/sapi/v1/c2c/ads/listWithPagination',
    '/sapi/v1/c2c/ads/search',
    '/sapi/v1/c2c/ads/getAd',
    '/sapi/v1/c2c/ads/detail',
    '/sapi/v1/c2c/ads/myAds',
    '/sapi/v1/c2c/ads/getMyAds',
    '/sapi/v1/c2c/ads/merchantAds',
    '/sapi/v1/c2c/ads/getMerchantAds',

    // Version variations
    '/sapi/v2/c2c/ads/list',
    '/sapi/v2/c2c/ads/listWithPagination',
    '/sapi/v3/c2c/ads/list',

    // Alternative paths
    '/sapi/v1/c2c/adv/list',
    '/sapi/v1/c2c/adv/listWithPagination',
    '/sapi/v1/c2c/adv/myAds',
    '/sapi/v1/c2c/advertisement/list',
    '/sapi/v1/c2c/merchant/ads',
    '/sapi/v1/c2c/merchant/adsList',
    '/sapi/v1/c2c/merchant/myAds',

    // Common patterns
    '/sapi/v1/p2p/ads/list',
    '/sapi/v1/p2p/ads/myAds',
    '/sapi/v1/fiat/ads/list',
    '/sapi/v1/fiat/c2c/ads',

    // OTC variations
    '/sapi/v1/otc/ads/list',
    '/sapi/v1/otc/merchant/ads',
  ];

  for (const endpoint of adsEndpoints) {
    // Try GET
    await testEndpoint('Ads GET', BASE_URL, endpoint, 'GET', undefined, { page: 1, rows: 10 });
    await delay(100);

    // Try POST
    await testEndpoint('Ads POST', BASE_URL, endpoint, 'POST', { page: 1, rows: 10 });
    await delay(100);
  }

  // ==================== ORDER ENDPOINTS ====================
  console.log('\n📋 Testing ORDER endpoints...\n');

  const orderEndpoints = [
    // Known/documented
    '/sapi/v1/c2c/orderMatch/listOrders',
    '/sapi/v1/c2c/orderMatch/listUserOrders',
    '/sapi/v1/c2c/orderMatch/getUserOrderDetail',
    '/sapi/v1/c2c/orderMatch/pendingOrders',
    '/sapi/v1/c2c/orderMatch/getPendingOrders',
    '/sapi/v1/c2c/orderMatch/getOrders',
    '/sapi/v1/c2c/orderMatch/history',
    '/sapi/v1/c2c/orderMatch/getOrderHistory',

    // Alternative naming
    '/sapi/v1/c2c/order/list',
    '/sapi/v1/c2c/order/pending',
    '/sapi/v1/c2c/order/history',
    '/sapi/v1/c2c/orders/list',
    '/sapi/v1/c2c/orders/pending',
    '/sapi/v1/c2c/orders/active',

    // Trade variations
    '/sapi/v1/c2c/trade/list',
    '/sapi/v1/c2c/trade/orders',
    '/sapi/v1/c2c/trade/pending',
    '/sapi/v1/c2c/trade/history',

    // Merchant variations
    '/sapi/v1/c2c/merchant/orders',
    '/sapi/v1/c2c/merchant/pendingOrders',
    '/sapi/v1/c2c/merchant/orderList',

    // P2P variations
    '/sapi/v1/p2p/order/list',
    '/sapi/v1/p2p/orders',
    '/sapi/v1/p2p/trade/list',

    // Version variations
    '/sapi/v2/c2c/orderMatch/listOrders',
    '/sapi/v2/c2c/order/list',
  ];

  for (const endpoint of orderEndpoints) {
    // Try GET
    await testEndpoint('Order GET', BASE_URL, endpoint, 'GET');
    await delay(100);

    // Try POST with order status filter
    await testEndpoint('Order POST', BASE_URL, endpoint, 'POST', { orderStatusList: [1, 2], page: 1, rows: 10 });
    await delay(100);
  }

  // ==================== MERCHANT INFO ENDPOINTS ====================
  console.log('\n👤 Testing MERCHANT endpoints...\n');

  const merchantEndpoints = [
    '/sapi/v1/c2c/merchant/info',
    '/sapi/v1/c2c/merchant/detail',
    '/sapi/v1/c2c/merchant/profile',
    '/sapi/v1/c2c/merchant/getInfo',
    '/sapi/v1/c2c/merchant/getMerchantInfo',
    '/sapi/v1/c2c/user/info',
    '/sapi/v1/c2c/user/merchant',
    '/sapi/v1/c2c/userInfo',
    '/sapi/v1/c2c/account/info',
    '/sapi/v1/c2c/account/merchant',
    '/sapi/v1/p2p/user/info',
    '/sapi/v1/p2p/merchant/info',
  ];

  for (const endpoint of merchantEndpoints) {
    await testEndpoint('Merchant GET', BASE_URL, endpoint, 'GET');
    await delay(100);
    await testEndpoint('Merchant POST', BASE_URL, endpoint, 'POST');
    await delay(100);
  }

  // ==================== CHAT ENDPOINTS ====================
  console.log('\n💬 Testing CHAT endpoints...\n');

  const chatEndpoints = [
    '/sapi/v1/c2c/chat/retrieveChatCredential',
    '/sapi/v1/c2c/chat/getCredential',
    '/sapi/v1/c2c/chat/credential',
    '/sapi/v1/c2c/chat/token',
    '/sapi/v1/c2c/chat/connect',
    '/sapi/v1/c2c/orderMatch/retrieveChatCredential',
    '/sapi/v1/c2c/im/credential',
    '/sapi/v1/c2c/message/credential',
  ];

  for (const endpoint of chatEndpoints) {
    await testEndpoint('Chat GET', BASE_URL, endpoint, 'GET');
    await delay(100);
    await testEndpoint('Chat POST', BASE_URL, endpoint, 'POST');
    await delay(100);
  }

  // ==================== RELEASE/ACTION ENDPOINTS ====================
  console.log('\n🚀 Testing ACTION endpoints...\n');

  const actionEndpoints = [
    // Don't actually call these - just check if they exist
    '/sapi/v1/c2c/orderMatch/releaseCoin',
    '/sapi/v1/c2c/orderMatch/release',
    '/sapi/v1/c2c/orderMatch/confirmRelease',
    '/sapi/v1/c2c/order/release',
    '/sapi/v1/c2c/trade/release',
    '/sapi/v1/c2c/orderMatch/markAsPaid',
    '/sapi/v1/c2c/orderMatch/confirmPayment',
    '/sapi/v1/c2c/order/confirmPaid',
  ];

  // Only test with GET (won't execute actions)
  for (const endpoint of actionEndpoints) {
    await testEndpoint('Action GET', BASE_URL, endpoint, 'GET');
    await delay(100);
  }

  // ==================== MARKET/PRICE ENDPOINTS ====================
  console.log('\n💰 Testing MARKET/PRICE endpoints...\n');

  const marketEndpoints = [
    '/sapi/v1/c2c/market/getIndexPrice',
    '/sapi/v1/c2c/market/indexPrice',
    '/sapi/v1/c2c/market/price',
    '/sapi/v1/c2c/market/referencePrice',
    '/sapi/v1/c2c/market/getReferencePrice',
    '/sapi/v1/c2c/price/index',
    '/sapi/v1/c2c/price/reference',
    '/sapi/v1/p2p/market/price',
    '/sapi/v1/fiat/price',
  ];

  for (const endpoint of marketEndpoints) {
    await testEndpoint('Market GET', BASE_URL, endpoint, 'GET', undefined, { asset: 'USDT', fiat: 'MXN' });
    await delay(100);
    await testEndpoint('Market POST', BASE_URL, endpoint, 'POST', { asset: 'USDT', fiat: 'MXN' });
    await delay(100);
  }

  // ==================== P2P.BINANCE.COM PUBLIC ENDPOINTS ====================
  console.log('\n🌐 Testing P2P.BINANCE.COM public endpoints...\n');

  const p2pPublicEndpoints = [
    '/bapi/c2c/v2/friendly/c2c/adv/search',
    '/bapi/c2c/v1/friendly/c2c/adv/search',
    '/bapi/c2c/v2/friendly/c2c/portal/config',
    '/bapi/c2c/v1/friendly/c2c/portal/config',
    '/bapi/c2c/v2/public/c2c/adv/search',
    '/bapi/c2c/v1/public/c2c/adv/search',
    '/bapi/c2c/v2/friendly/c2c/merchant/list',
    '/bapi/c2c/v1/private/c2c/adv/list',
  ];

  for (const endpoint of p2pPublicEndpoints) {
    await testEndpoint(
      'P2P Public',
      P2P_BASE_URL,
      endpoint,
      'POST',
      { asset: 'USDT', fiat: 'MXN', tradeType: 'SELL', page: 1, rows: 5 },
      undefined,
      false // No auth for public endpoints
    );
    await delay(100);
  }

  // ==================== SUMMARY ====================
  console.log('\n\n========================================');
  console.log('📊 DISCOVERY SUMMARY');
  console.log('========================================\n');

  console.log(`Total tested: ${results.length}`);
  console.log(`Successful: ${successfulEndpoints.length}`);
  console.log(`Auth errors: ${results.filter(r => r.status === 'AUTH_ERROR').length}`);
  console.log(`API errors: ${results.filter(r => r.status === 'API_ERROR').length}`);
  console.log(`Not found: ${results.filter(r => r.status === 'NOT_FOUND').length}`);

  if (successfulEndpoints.length > 0) {
    console.log('\n✅ WORKING ENDPOINTS:\n');
    for (const ep of successfulEndpoints) {
      console.log(`  ${ep.endpoint}`);
      if (ep.hasData) console.log(`    └─ Has data: true`);
    }
  }

  // Show interesting API errors (might be close to working)
  const interestingErrors = results.filter(r =>
    r.status === 'API_ERROR' &&
    r.binanceCode &&
    !['704017', '-1102', '-1121'].includes(r.binanceCode)
  );

  if (interestingErrors.length > 0) {
    console.log('\n⚠️ INTERESTING API ERRORS (might need different params):\n');
    for (const ep of interestingErrors.slice(0, 20)) {
      console.log(`  ${ep.endpoint}`);
      console.log(`    └─ ${ep.binanceCode}: ${ep.message}`);
    }
  }
}

main().catch(console.error);
