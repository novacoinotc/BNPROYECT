// =====================================================
// BINANCE C2C API EXTENDED ENDPOINT DISCOVERY
// Tests 500+ endpoint variations to find all working ones
// Saves results to JSON for future reference
// =====================================================

import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

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
  responsePreview?: string;
}

const allResults: TestResult[] = [];
const successfulEndpoints: TestResult[] = [];
let testedCount = 0;

function sign(queryString: string): string {
  return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}

async function testEndpoint(
  category: string,
  baseUrl: string,
  endpoint: string,
  method: 'GET' | 'POST' = 'GET',
  body?: any,
  queryParams?: Record<string, any>,
  requiresAuth: boolean = true
): Promise<TestResult> {
  testedCount++;
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
    const options: RequestInit = { method, headers };
    if (body && method === 'POST') {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const text = await response.text();

    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.substring(0, 200) };
    }

    const result: TestResult = {
      endpoint: `${method} ${endpoint}`,
      method,
      httpCode: response.status,
      binanceCode: data?.code?.toString(),
      message: data?.message || data?.msg,
      hasData: !!data?.data || (Array.isArray(data) && data.length > 0),
      status: 'API_ERROR',
      responsePreview: JSON.stringify(data).substring(0, 300),
    };

    if (response.ok && (!data.code || data.code === '000000' || data.code === 0)) {
      result.status = 'SUCCESS';
      successfulEndpoints.push(result);
      process.stdout.write(`✅`);
    } else if (response.status === 401 || response.status === 403) {
      result.status = 'AUTH_ERROR';
      process.stdout.write(`🔐`);
    } else if (response.status === 404) {
      result.status = 'NOT_FOUND';
      process.stdout.write(`.`);
    } else {
      result.status = 'API_ERROR';
      process.stdout.write(`⚠️`);
    }

    allResults.push(result);
    return result;
  } catch (error) {
    const result: TestResult = {
      endpoint: `${method} ${endpoint}`,
      method,
      status: 'NETWORK_ERROR',
      message: String(error),
    };
    allResults.push(result);
    process.stdout.write(`❌`);
    return result;
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Generate all endpoint variations
function generateEndpoints(): { category: string; endpoints: string[] }[] {
  const categories: { category: string; endpoints: string[] }[] = [];

  // API versions
  const versions = ['v1', 'v2', 'v3'];

  // Base paths
  const basePaths = [
    '/sapi/{v}/c2c',
    '/sapi/{v}/p2p',
    '/sapi/{v}/fiat',
    '/sapi/{v}/otc',
    '/api/{v}/c2c',
    '/api/{v}/p2p',
  ];

  // ==================== ADS ENDPOINTS ====================
  const adsEndpoints: string[] = [];
  const adsSuffixes = [
    'ads/list',
    'ads/listWithPagination',
    'ads/search',
    'ads/getAd',
    'ads/detail',
    'ads/myAds',
    'ads/getMyAds',
    'ads/merchantAds',
    'ads/getMerchantAds',
    'ads/create',
    'ads/update',
    'ads/updateStatus',
    'ads/delete',
    'ads/enable',
    'ads/disable',
    'ads/publish',
    'ads/unpublish',
    'ads/info',
    'ads/config',
    'adv/list',
    'adv/listWithPagination',
    'adv/myAds',
    'adv/search',
    'adv/detail',
    'advertisement/list',
    'advertisement/create',
    'advertisement/update',
    'merchant/ads',
    'merchant/adsList',
    'merchant/myAds',
    'merchant/advertisement',
  ];

  for (const basePath of basePaths) {
    for (const version of versions) {
      for (const suffix of adsSuffixes) {
        adsEndpoints.push(basePath.replace('{v}', version) + '/' + suffix);
      }
    }
  }
  categories.push({ category: 'ADS', endpoints: adsEndpoints });

  // ==================== ORDER ENDPOINTS ====================
  const orderEndpoints: string[] = [];
  const orderSuffixes = [
    'orderMatch/listOrders',
    'orderMatch/listUserOrders',
    'orderMatch/getUserOrderDetail',
    'orderMatch/pendingOrders',
    'orderMatch/getPendingOrders',
    'orderMatch/getOrders',
    'orderMatch/history',
    'orderMatch/getOrderHistory',
    'orderMatch/releaseCoin',
    'orderMatch/release',
    'orderMatch/confirmRelease',
    'orderMatch/markAsPaid',
    'orderMatch/confirmPayment',
    'orderMatch/cancel',
    'orderMatch/appeal',
    'orderMatch/getAppeal',
    'orderMatch/detail',
    'orderMatch/getDetail',
    'order/list',
    'order/pending',
    'order/history',
    'order/detail',
    'order/create',
    'order/cancel',
    'order/release',
    'order/confirmPaid',
    'order/appeal',
    'orders/list',
    'orders/pending',
    'orders/active',
    'orders/history',
    'orders/completed',
    'orders/cancelled',
    'trade/list',
    'trade/orders',
    'trade/pending',
    'trade/history',
    'trade/release',
    'trade/cancel',
    'merchant/orders',
    'merchant/pendingOrders',
    'merchant/orderList',
    'merchant/orderHistory',
  ];

  for (const basePath of basePaths) {
    for (const version of versions) {
      for (const suffix of orderSuffixes) {
        orderEndpoints.push(basePath.replace('{v}', version) + '/' + suffix);
      }
    }
  }
  categories.push({ category: 'ORDERS', endpoints: orderEndpoints });

  // ==================== MERCHANT ENDPOINTS ====================
  const merchantEndpoints: string[] = [];
  const merchantSuffixes = [
    'merchant/info',
    'merchant/detail',
    'merchant/profile',
    'merchant/getInfo',
    'merchant/getMerchantInfo',
    'merchant/stats',
    'merchant/statistics',
    'merchant/rating',
    'merchant/reviews',
    'merchant/feedback',
    'merchant/settings',
    'merchant/config',
    'merchant/verification',
    'merchant/status',
    'merchant/level',
    'user/info',
    'user/merchant',
    'user/profile',
    'user/stats',
    'user/verification',
    'userInfo',
    'account/info',
    'account/merchant',
    'account/status',
    'account/balance',
  ];

  for (const basePath of basePaths) {
    for (const version of versions) {
      for (const suffix of merchantSuffixes) {
        merchantEndpoints.push(basePath.replace('{v}', version) + '/' + suffix);
      }
    }
  }
  categories.push({ category: 'MERCHANT', endpoints: merchantEndpoints });

  // ==================== CHAT ENDPOINTS ====================
  const chatEndpoints: string[] = [];
  const chatSuffixes = [
    'chat/retrieveChatCredential',
    'chat/getCredential',
    'chat/credential',
    'chat/token',
    'chat/connect',
    'chat/messages',
    'chat/getMessages',
    'chat/sendMessage',
    'chat/history',
    'chat/unread',
    'orderMatch/retrieveChatCredential',
    'im/credential',
    'im/token',
    'im/connect',
    'message/credential',
    'message/send',
    'message/list',
  ];

  for (const basePath of basePaths) {
    for (const version of versions) {
      for (const suffix of chatSuffixes) {
        chatEndpoints.push(basePath.replace('{v}', version) + '/' + suffix);
      }
    }
  }
  categories.push({ category: 'CHAT', endpoints: chatEndpoints });

  // ==================== MARKET/PRICE ENDPOINTS ====================
  const marketEndpoints: string[] = [];
  const marketSuffixes = [
    'market/getIndexPrice',
    'market/indexPrice',
    'market/price',
    'market/referencePrice',
    'market/getReferencePrice',
    'market/ticker',
    'market/depth',
    'market/trades',
    'market/klines',
    'market/stats',
    'price/index',
    'price/reference',
    'price/current',
    'price/history',
    'quote/price',
    'quote/index',
    'rate/exchange',
    'rate/fiat',
  ];

  for (const basePath of basePaths) {
    for (const version of versions) {
      for (const suffix of marketSuffixes) {
        marketEndpoints.push(basePath.replace('{v}', version) + '/' + suffix);
      }
    }
  }
  categories.push({ category: 'MARKET', endpoints: marketEndpoints });

  // ==================== PAYMENT ENDPOINTS ====================
  const paymentEndpoints: string[] = [];
  const paymentSuffixes = [
    'payment/methods',
    'payment/list',
    'payment/add',
    'payment/update',
    'payment/delete',
    'payment/getPayMethods',
    'payment/userPayMethods',
    'payMethod/list',
    'payMethod/add',
    'payMethod/update',
    'payMethod/delete',
    'tradeMethod/list',
    'tradeMethod/add',
  ];

  for (const basePath of basePaths) {
    for (const version of versions) {
      for (const suffix of paymentSuffixes) {
        paymentEndpoints.push(basePath.replace('{v}', version) + '/' + suffix);
      }
    }
  }
  categories.push({ category: 'PAYMENT', endpoints: paymentEndpoints });

  // ==================== ASSET/WALLET ENDPOINTS ====================
  const assetEndpoints: string[] = [];
  const assetSuffixes = [
    'asset/balance',
    'asset/list',
    'asset/available',
    'asset/frozen',
    'wallet/balance',
    'wallet/available',
    'balance/c2c',
    'balance/available',
    'balance/frozen',
    'fundingWallet',
    'spot/balance',
  ];

  for (const basePath of basePaths) {
    for (const version of versions) {
      for (const suffix of assetSuffixes) {
        assetEndpoints.push(basePath.replace('{v}', version) + '/' + suffix);
      }
    }
  }
  categories.push({ category: 'ASSET', endpoints: assetEndpoints });

  // ==================== CONFIG/SETTINGS ENDPOINTS ====================
  const configEndpoints: string[] = [];
  const configSuffixes = [
    'config/list',
    'config/get',
    'config/fiat',
    'config/asset',
    'config/tradeLimit',
    'config/payMethod',
    'settings/list',
    'settings/get',
    'settings/update',
    'portal/config',
    'system/config',
    'system/status',
  ];

  for (const basePath of basePaths) {
    for (const version of versions) {
      for (const suffix of configSuffixes) {
        configEndpoints.push(basePath.replace('{v}', version) + '/' + suffix);
      }
    }
  }
  categories.push({ category: 'CONFIG', endpoints: configEndpoints });

  // ==================== P2P.BINANCE.COM PUBLIC ENDPOINTS ====================
  const p2pPublicEndpoints = [
    '/bapi/c2c/v1/friendly/c2c/adv/search',
    '/bapi/c2c/v2/friendly/c2c/adv/search',
    '/bapi/c2c/v1/friendly/c2c/portal/config',
    '/bapi/c2c/v2/friendly/c2c/portal/config',
    '/bapi/c2c/v1/public/c2c/adv/search',
    '/bapi/c2c/v2/public/c2c/adv/search',
    '/bapi/c2c/v1/friendly/c2c/merchant/list',
    '/bapi/c2c/v2/friendly/c2c/merchant/list',
    '/bapi/c2c/v1/private/c2c/adv/list',
    '/bapi/c2c/v2/private/c2c/adv/list',
    '/bapi/c2c/v1/friendly/c2c/trade/list',
    '/bapi/c2c/v2/friendly/c2c/trade/list',
    '/bapi/c2c/v1/friendly/c2c/order/list',
    '/bapi/c2c/v2/friendly/c2c/order/list',
    '/bapi/c2c/v1/public/c2c/portal/config',
    '/bapi/c2c/v2/public/c2c/portal/config',
    '/bapi/c2c/v1/friendly/c2c/user/info',
    '/bapi/c2c/v2/friendly/c2c/user/info',
  ];
  categories.push({ category: 'P2P_PUBLIC', endpoints: p2pPublicEndpoints });

  return categories;
}

async function main() {
  console.log('🔍 BINANCE C2C API EXTENDED ENDPOINT DISCOVERY');
  console.log('================================================\n');

  if (!API_KEY || !API_SECRET) {
    console.error('❌ Missing API_KEY or API_SECRET');
    process.exit(1);
  }

  const categories = generateEndpoints();
  const totalEndpoints = categories.reduce((sum, cat) => sum + cat.endpoints.length * 2, 0); // *2 for GET and POST

  console.log(`📊 Total endpoints to test: ~${totalEndpoints}\n`);

  for (const category of categories) {
    console.log(`\n📂 Testing ${category.category} (${category.endpoints.length * 2} endpoints)...`);
    process.stdout.write('   ');

    for (const endpoint of category.endpoints) {
      const isP2P = endpoint.startsWith('/bapi');
      const baseUrl = isP2P ? P2P_BASE_URL : BASE_URL;

      // Test GET
      await testEndpoint(category.category, baseUrl, endpoint, 'GET', undefined, { page: 1, rows: 10 }, !isP2P);
      await delay(50);

      // Test POST
      const body = isP2P
        ? { asset: 'USDT', fiat: 'MXN', tradeType: 'SELL', page: 1, rows: 5 }
        : { page: 1, rows: 10 };
      await testEndpoint(category.category, baseUrl, endpoint, 'POST', body, {}, !isP2P);
      await delay(50);

      // Progress indicator every 20 tests
      if (testedCount % 40 === 0) {
        process.stdout.write(` [${testedCount}]`);
      }
    }
    console.log();
  }

  // ==================== SAVE RESULTS ====================
  console.log('\n\n========================================');
  console.log('💾 SAVING RESULTS');
  console.log('========================================\n');

  // Save all results to JSON
  const resultsPath = path.join(process.cwd(), 'docs', 'endpoint-discovery-results.json');
  const docsDir = path.dirname(resultsPath);
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  fs.writeFileSync(resultsPath, JSON.stringify({
    discoveredAt: new Date().toISOString(),
    totalTested: allResults.length,
    successful: successfulEndpoints.length,
    results: allResults,
  }, null, 2));
  console.log(`✅ All results saved to: ${resultsPath}`);

  // Save working endpoints to markdown
  const workingMdPath = path.join(docsDir, 'WORKING_ENDPOINTS.md');
  let mdContent = `# Binance C2C API - Working Endpoints

Discovered on: ${new Date().toISOString()}

## Summary
- **Total Tested:** ${allResults.length}
- **Successful:** ${successfulEndpoints.length}
- **Auth Errors:** ${allResults.filter(r => r.status === 'AUTH_ERROR').length}
- **API Errors:** ${allResults.filter(r => r.status === 'API_ERROR').length}
- **Not Found:** ${allResults.filter(r => r.status === 'NOT_FOUND').length}

## Working Endpoints by Category

`;

  // Group by category
  const groupedEndpoints: Record<string, TestResult[]> = {};
  for (const result of successfulEndpoints) {
    const category = result.endpoint.includes('/ads') || result.endpoint.includes('/adv') ? 'ADS' :
                     result.endpoint.includes('/order') || result.endpoint.includes('/trade') ? 'ORDERS' :
                     result.endpoint.includes('/merchant') || result.endpoint.includes('/user') ? 'MERCHANT' :
                     result.endpoint.includes('/chat') || result.endpoint.includes('/im') || result.endpoint.includes('/message') ? 'CHAT' :
                     result.endpoint.includes('/market') || result.endpoint.includes('/price') ? 'MARKET' :
                     result.endpoint.includes('/payment') || result.endpoint.includes('/payMethod') ? 'PAYMENT' :
                     result.endpoint.includes('/asset') || result.endpoint.includes('/balance') || result.endpoint.includes('/wallet') ? 'ASSET' :
                     result.endpoint.includes('/config') || result.endpoint.includes('/settings') ? 'CONFIG' :
                     result.endpoint.includes('/bapi') ? 'P2P_PUBLIC' : 'OTHER';

    if (!groupedEndpoints[category]) {
      groupedEndpoints[category] = [];
    }
    groupedEndpoints[category].push(result);
  }

  for (const [category, endpoints] of Object.entries(groupedEndpoints)) {
    mdContent += `### ${category}\n\n`;
    mdContent += `| Method | Endpoint | Has Data | Notes |\n`;
    mdContent += `|--------|----------|----------|-------|\n`;

    for (const ep of endpoints) {
      const [method, path] = ep.endpoint.split(' ');
      const hasData = ep.hasData ? '✅' : '-';
      const notes = ep.binanceCode ? `Code: ${ep.binanceCode}` : '';
      mdContent += `| ${method} | \`${path}\` | ${hasData} | ${notes} |\n`;
    }
    mdContent += '\n';
  }

  // Add recommended endpoints section
  mdContent += `## Recommended Endpoints for P2P Bot

### Ads Management
- **List my ads:** \`GET /sapi/v1/c2c/ads/list\`
- **Update ad:** \`POST /sapi/v1/c2c/ads/update\`
- **Enable/disable:** \`POST /sapi/v1/c2c/ads/updateStatus\`

### Order Management
- **Pending orders:** \`GET /sapi/v1/c2c/orderMatch/pendingOrders\`
- **List orders:** \`POST /sapi/v1/c2c/orderMatch/listOrders\`
- **Order detail:** \`POST /sapi/v1/c2c/orderMatch/getUserOrderDetail\`
- **Release coin:** \`POST /sapi/v1/c2c/orderMatch/releaseCoin\`

### Chat
- **Get credentials:** \`GET /sapi/v1/c2c/chat/retrieveChatCredential\`

### Market Data
- **Index price:** \`GET /sapi/v1/c2c/market/getIndexPrice\`

### Public (no auth)
- **Search ads:** \`POST https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search\`
`;

  fs.writeFileSync(workingMdPath, mdContent);
  console.log(`✅ Working endpoints saved to: ${workingMdPath}`);

  // ==================== SUMMARY ====================
  console.log('\n========================================');
  console.log('📊 DISCOVERY SUMMARY');
  console.log('========================================\n');

  console.log(`Total tested: ${allResults.length}`);
  console.log(`Successful: ${successfulEndpoints.length}`);
  console.log(`Auth errors: ${allResults.filter(r => r.status === 'AUTH_ERROR').length}`);
  console.log(`API errors: ${allResults.filter(r => r.status === 'API_ERROR').length}`);
  console.log(`Not found: ${allResults.filter(r => r.status === 'NOT_FOUND').length}`);

  console.log('\n✅ Files created:');
  console.log(`   - ${resultsPath}`);
  console.log(`   - ${workingMdPath}`);
}

main().catch(console.error);
