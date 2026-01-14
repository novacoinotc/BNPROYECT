// =====================================================
// COMPREHENSIVE BINANCE P2P API TEST SUITE
// Tests ALL endpoints without destructive operations
// =====================================================

import 'dotenv/config';
import crypto from 'crypto';

const API_KEY = process.env.BINANCE_API_KEY!;
const API_SECRET = process.env.BINANCE_API_SECRET!;
const ADV_NO = process.env.BINANCE_ADV_NO || '';
const BASE_URL = 'https://api.binance.com';

// Test results tracking
const results: { endpoint: string; method: string; status: string; data?: any; error?: string }[] = [];

function sign(queryString: string): string {
  return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}

async function testEndpoint(
  name: string,
  endpoint: string,
  params: Record<string, any> = {},
  method: string = 'GET'
): Promise<any> {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const queryString = Object.entries(allParams)
    .filter(([_, v]) => v !== undefined && v !== null && (v as any) !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  const signature = sign(queryString);
  const url = `${BASE_URL}${endpoint}?${queryString}&signature=${signature}`;

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`📡 [${method}] ${name}`);
  console.log(`   Endpoint: ${endpoint}`);
  if (Object.keys(params).length > 0) {
    console.log(`   Params: ${JSON.stringify(params)}`);
  }

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': API_KEY,
        'Content-Type': 'application/json',
      },
    });

    const text = await response.text();
    let data: any = null;

    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      console.log(`   ❌ Error ${response.status}: ${JSON.stringify(data)}`);
      results.push({ endpoint, method, status: 'ERROR', error: JSON.stringify(data) });
      return null;
    }

    console.log(`   ✅ Success (${response.status})`);
    results.push({ endpoint, method, status: 'OK', data });
    return data;
  } catch (error) {
    const err = error as Error;
    console.log(`   ❌ Network Error: ${err.message}`);
    results.push({ endpoint, method, status: 'NETWORK_ERROR', error: err.message });
    return null;
  }
}

function logStructure(name: string, data: any) {
  if (!data) return;

  console.log(`\n   📦 ${name} Structure:`);

  if (Array.isArray(data)) {
    console.log(`      Type: Array (${data.length} items)`);
    if (data.length > 0) {
      console.log(`      First item fields:`);
      for (const [key, value] of Object.entries(data[0])) {
        const type = Array.isArray(value) ? `array[${(value as any[]).length}]` : typeof value;
        const preview = JSON.stringify(value)?.substring(0, 80);
        console.log(`         ${key}: (${type}) ${preview}${preview && preview.length >= 80 ? '...' : ''}`);
      }
    }
  } else if (typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      const type = Array.isArray(value) ? `array[${(value as any[]).length}]` : typeof value;
      const preview = JSON.stringify(value)?.substring(0, 80);
      console.log(`      ${key}: (${type}) ${preview}${preview && preview.length >= 80 ? '...' : ''}`);
    }
  }
}

// =====================================================
// TEST CATEGORIES
// =====================================================

async function testAccountEndpoints() {
  console.log('\n' + '═'.repeat(70));
  console.log('🔐 ACCOUNT & USER ENDPOINTS');
  console.log('═'.repeat(70));

  // Test account info
  const userInfo = await testEndpoint(
    'Get User Info',
    '/sapi/v1/c2c/user/userInfo',
    {},
    'GET'
  );
  logStructure('User Info', userInfo);

  // Test merchant status
  const merchantStatus = await testEndpoint(
    'Get Merchant Status',
    '/sapi/v1/c2c/user/merchantStatus',
    {},
    'GET'
  );
  logStructure('Merchant Status', merchantStatus);

  // Test user configuration
  const userConfig = await testEndpoint(
    'Get User Configuration',
    '/sapi/v1/c2c/user/userConfiguration',
    {},
    'GET'
  );
  logStructure('User Config', userConfig);
}

async function testOrderEndpoints() {
  console.log('\n' + '═'.repeat(70));
  console.log('📋 ORDER ENDPOINTS');
  console.log('═'.repeat(70));

  // List orders - different methods
  const orderHistory = await testEndpoint(
    'List User Order History (GET)',
    '/sapi/v1/c2c/orderMatch/listUserOrderHistory',
    { tradeType: 'SELL', rows: 10 },
    'GET'
  );

  if (orderHistory?.data) {
    logStructure('Order History', orderHistory.data);

    // Save first order for detail tests
    if (orderHistory.data.length > 0) {
      const firstOrder = orderHistory.data[0];
      console.log('\n   📝 First Order Full Data:');
      console.log(JSON.stringify(firstOrder, null, 2));

      // Test order detail
      const orderNo = firstOrder.orderNumber || firstOrder.orderNo || firstOrder.advOrderNumber;
      if (orderNo) {
        const orderDetail = await testEndpoint(
          'Get Order Detail (GET)',
          '/sapi/v1/c2c/orderMatch/getUserOrderDetail',
          { orderNo },
          'GET'
        );
        if (orderDetail) {
          console.log('\n   📝 Order Detail Full Data:');
          console.log(JSON.stringify(orderDetail, null, 2));
        }

        // Try POST method too
        await testEndpoint(
          'Get Order Detail (POST)',
          '/sapi/v1/c2c/orderMatch/getUserOrderDetail',
          { orderNo },
          'POST'
        );
      }
    }
  }

  // Try POST method for order list
  await testEndpoint(
    'List User Order History (POST)',
    '/sapi/v1/c2c/orderMatch/listUserOrderHistory',
    { tradeType: 'SELL', rows: 5 },
    'POST'
  );

  // List orders endpoint
  await testEndpoint(
    'List Orders (GET)',
    '/sapi/v1/c2c/orderMatch/listOrders',
    { page: 1, rows: 10 },
    'GET'
  );

  await testEndpoint(
    'List Orders (POST)',
    '/sapi/v1/c2c/orderMatch/listOrders',
    { page: 1, rows: 10 },
    'POST'
  );

  // Pending orders
  await testEndpoint(
    'Get Pending Orders',
    '/sapi/v1/c2c/orderMatch/listPendingOrders',
    { rows: 10 },
    'GET'
  );

  // Order count
  await testEndpoint(
    'Get Order Count',
    '/sapi/v1/c2c/orderMatch/getOrderCount',
    {},
    'GET'
  );
}

async function testAdEndpoints() {
  console.log('\n' + '═'.repeat(70));
  console.log('📢 ADVERTISEMENT ENDPOINTS');
  console.log('═'.repeat(70));

  // List my ads
  const myAds = await testEndpoint(
    'List My Ads (GET)',
    '/sapi/v1/c2c/ads/list',
    { page: 1, rows: 10 },
    'GET'
  );
  logStructure('My Ads', myAds?.data);

  await testEndpoint(
    'List My Ads (POST)',
    '/sapi/v1/c2c/ads/list',
    { page: 1, rows: 10 },
    'POST'
  );

  // List with pagination
  await testEndpoint(
    'List Ads With Pagination (GET)',
    '/sapi/v1/c2c/ads/listWithPagination',
    { page: 1, rows: 10 },
    'GET'
  );

  await testEndpoint(
    'List Ads With Pagination (POST)',
    '/sapi/v1/c2c/ads/listWithPagination',
    { page: 1, rows: 10 },
    'POST'
  );

  // Get ad detail if we have ADV_NO
  if (ADV_NO) {
    const adDetail = await testEndpoint(
      'Get Ad Detail V2 (GET)',
      '/sapi/v1/c2c/ads/getDetailV2',
      { advNos: ADV_NO },
      'GET'
    );
    if (adDetail) {
      console.log('\n   📝 Ad Detail Full Data:');
      console.log(JSON.stringify(adDetail, null, 2));
    }

    await testEndpoint(
      'Get Ad Detail V2 (POST)',
      '/sapi/v1/c2c/ads/getDetailV2',
      { advNos: ADV_NO },
      'POST'
    );

    await testEndpoint(
      'Get Ad Detail (GET)',
      '/sapi/v1/c2c/ads/getDetail',
      { advNo: ADV_NO },
      'GET'
    );
  }

  // Search competitor ads
  await testEndpoint(
    'Search Ads (GET)',
    '/sapi/v1/c2c/ads/search',
    { asset: 'USDT', fiat: 'MXN', tradeType: 'SELL', page: 1, rows: 5 },
    'GET'
  );

  const searchAdsPost = await testEndpoint(
    'Search Ads (POST)',
    '/sapi/v1/c2c/ads/search',
    { asset: 'USDT', fiat: 'MXN', tradeType: 'SELL', page: 1, rows: 5 },
    'POST'
  );
  logStructure('Search Ads', searchAdsPost?.data);

  // Get reference price
  await testEndpoint(
    'Get Reference Price (GET)',
    '/sapi/v1/c2c/ads/getReferencePrice',
    { asset: 'USDT', fiat: 'MXN', tradeType: 'SELL' },
    'GET'
  );

  const refPrice = await testEndpoint(
    'Get Reference Price (POST)',
    '/sapi/v1/c2c/ads/getReferencePrice',
    { asset: 'USDT', fiat: 'MXN', tradeType: 'SELL' },
    'POST'
  );
  logStructure('Reference Price', refPrice);

  // Ad configuration
  await testEndpoint(
    'Get Ad Configuration',
    '/sapi/v1/c2c/ads/getAdConfiguration',
    {},
    'GET'
  );

  // Payment methods
  await testEndpoint(
    'Get Payment Methods',
    '/sapi/v1/c2c/ads/getPaymentMethods',
    {},
    'GET'
  );
}

async function testChatEndpoints() {
  console.log('\n' + '═'.repeat(70));
  console.log('💬 CHAT ENDPOINTS');
  console.log('═'.repeat(70));

  // Get chat credential
  const chatCred = await testEndpoint(
    'Get Chat Credential (GET)',
    '/sapi/v1/c2c/chat/retrieveChatCredential',
    {},
    'GET'
  );
  if (chatCred) {
    console.log('\n   📝 Chat Credential Full Data:');
    console.log(JSON.stringify(chatCred, null, 2));
  }

  await testEndpoint(
    'Get Chat Credential (POST)',
    '/sapi/v1/c2c/chat/retrieveChatCredential',
    {},
    'POST'
  );

  // Get order number for chat test
  const orders = await testEndpoint(
    'Get Order for Chat Test',
    '/sapi/v1/c2c/orderMatch/listUserOrderHistory',
    { tradeType: 'SELL', rows: 1 },
    'GET'
  );

  if (orders?.data?.[0]) {
    const orderNo = orders.data[0].orderNumber || orders.data[0].orderNo;
    if (orderNo) {
      // Get chat messages
      const messages = await testEndpoint(
        'Get Chat Messages (GET)',
        '/sapi/v1/c2c/chat/retrieveChatMessagesWithPagination',
        { orderNo, page: 1, rows: 50 },
        'GET'
      );
      logStructure('Chat Messages', messages?.data);

      await testEndpoint(
        'Get Chat Messages (POST)',
        '/sapi/v1/c2c/chat/retrieveChatMessagesWithPagination',
        { orderNo, page: 1, rows: 50 },
        'POST'
      );
    }
  }
}

async function testPriceEndpoints() {
  console.log('\n' + '═'.repeat(70));
  console.log('💰 PRICE & MARKET ENDPOINTS');
  console.log('═'.repeat(70));

  // Spot price (public)
  try {
    const spotResponse = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=USDTMXN');
    const spotData = await spotResponse.json() as { price?: string; symbol?: string };
    console.log(`\n${'─'.repeat(70)}`);
    console.log('📡 [PUBLIC] Spot Price USDT/MXN');
    console.log(`   ✅ Price: ${spotData.price || 'N/A'}`);
    results.push({ endpoint: '/api/v3/ticker/price', method: 'GET', status: 'OK', data: spotData });
  } catch (e) {
    console.log('   ❌ Failed to get spot price');
  }

  // C2C index price
  await testEndpoint(
    'Get C2C Index Price (GET)',
    '/sapi/v1/c2c/market/getIndexPrice',
    { asset: 'USDT', fiat: 'MXN' },
    'GET'
  );

  await testEndpoint(
    'Get C2C Index Price (POST)',
    '/sapi/v1/c2c/market/getIndexPrice',
    { asset: 'USDT', fiat: 'MXN' },
    'POST'
  );

  // Market depth
  await testEndpoint(
    'Get Market Depth',
    '/sapi/v1/c2c/market/getDepth',
    { asset: 'USDT', fiat: 'MXN' },
    'GET'
  );
}

async function testStatisticsEndpoints() {
  console.log('\n' + '═'.repeat(70));
  console.log('📊 STATISTICS ENDPOINTS');
  console.log('═'.repeat(70));

  // User stats
  await testEndpoint(
    'Get User Stats (GET)',
    '/sapi/v1/c2c/orderMatch/getUserStats',
    {},
    'GET'
  );

  // Trade history summary
  await testEndpoint(
    'Get Trade History Summary',
    '/sapi/v1/c2c/orderMatch/tradeHistorySummary',
    {},
    'GET'
  );

  // Daily stats
  await testEndpoint(
    'Get Daily Statistics',
    '/sapi/v1/c2c/orderMatch/dailyStats',
    {},
    'GET'
  );
}

async function testOtherEndpoints() {
  console.log('\n' + '═'.repeat(70));
  console.log('🔧 OTHER ENDPOINTS');
  console.log('═'.repeat(70));

  // Supported assets and fiats
  await testEndpoint(
    'Get Supported Coins',
    '/sapi/v1/c2c/ads/getSupportedCoins',
    {},
    'GET'
  );

  await testEndpoint(
    'Get Supported Fiats',
    '/sapi/v1/c2c/ads/getSupportedFiats',
    {},
    'GET'
  );

  await testEndpoint(
    'Get Supported Trade Sides',
    '/sapi/v1/c2c/ads/getSupportedTradeSides',
    {},
    'GET'
  );

  // Appeal endpoints (just info, no actions)
  await testEndpoint(
    'Get Appeal Reasons',
    '/sapi/v1/c2c/appeal/getAppealReasons',
    {},
    'GET'
  );

  // Notification settings
  await testEndpoint(
    'Get Notification Settings',
    '/sapi/v1/c2c/user/getNotificationSettings',
    {},
    'GET'
  );

  // Auto-reply settings
  await testEndpoint(
    'Get Auto Reply Settings',
    '/sapi/v1/c2c/chat/getAutoReplySettings',
    {},
    'GET'
  );
}

// =====================================================
// MAIN
// =====================================================

async function main() {
  console.log('═'.repeat(70));
  console.log('🚀 BINANCE P2P API COMPREHENSIVE TEST SUITE');
  console.log('═'.repeat(70));
  console.log(`API Key: ${API_KEY?.substring(0, 10)}...`);
  console.log(`ADV NO: ${ADV_NO || 'Not set'}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`⚠️  NO DESTRUCTIVE OPERATIONS WILL BE PERFORMED`);

  if (!API_KEY || !API_SECRET) {
    console.error('❌ Missing API credentials!');
    process.exit(1);
  }

  // Run all test categories
  await testAccountEndpoints();
  await testOrderEndpoints();
  await testAdEndpoints();
  await testChatEndpoints();
  await testPriceEndpoints();
  await testStatisticsEndpoints();
  await testOtherEndpoints();

  // Summary
  console.log('\n' + '═'.repeat(70));
  console.log('📊 TEST SUMMARY');
  console.log('═'.repeat(70));

  const successful = results.filter(r => r.status === 'OK');
  const failed = results.filter(r => r.status !== 'OK');

  console.log(`\n✅ Successful: ${successful.length}`);
  console.log(`❌ Failed: ${failed.length}`);
  console.log(`📝 Total: ${results.length}`);

  console.log('\n📋 Working Endpoints:');
  for (const r of successful) {
    console.log(`   ✅ [${r.method}] ${r.endpoint}`);
  }

  console.log('\n📋 Failed Endpoints:');
  for (const r of failed) {
    console.log(`   ❌ [${r.method}] ${r.endpoint} - ${r.error?.substring(0, 50)}`);
  }

  console.log('\n' + '═'.repeat(70));
  console.log('✅ ALL TESTS COMPLETED');
  console.log('═'.repeat(70));
}

main().catch(console.error);
