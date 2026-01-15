import axios, { AxiosError } from 'axios';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.BINANCE_API_KEY!;
const API_SECRET = process.env.BINANCE_API_SECRET!;
const ADV_NO = process.env.BINANCE_ADV_NO!;
const BASE_URL = 'https://api.binance.com';

function generateSignature(queryString: string): string {
  return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}

function getTimestamp(): number {
  return Date.now();
}

async function signedRequest(
  method: 'GET' | 'POST',
  endpoint: string,
  params: Record<string, any> = {}
): Promise<any> {
  const timestamp = getTimestamp();
  const allParams = { ...params, timestamp };

  const queryString = Object.entries(allParams)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&');

  const signature = generateSignature(queryString);
  const signedQueryString = `${queryString}&signature=${signature}`;

  const headers = {
    'X-MBX-APIKEY': API_KEY,
    'Content-Type': 'application/x-www-form-urlencoded',
    'clientType': 'web',
  };

  try {
    let response;
    if (method === 'GET') {
      response = await axios.get(`${BASE_URL}${endpoint}?${signedQueryString}`, { headers });
    } else {
      response = await axios.post(`${BASE_URL}${endpoint}`, signedQueryString, { headers });
    }
    return { success: true, data: response.data, status: response.status };
  } catch (error) {
    const axiosError = error as AxiosError;
    return {
      success: false,
      status: axiosError.response?.status,
      data: axiosError.response?.data,
      message: axiosError.message
    };
  }
}

async function publicRequest(
  endpoint: string,
  body: Record<string, any> = {}
): Promise<any> {
  try {
    const response = await axios.post(endpoint, body, {
      headers: { 'Content-Type': 'application/json' }
    });
    return { success: true, data: response.data, status: response.status };
  } catch (error) {
    const axiosError = error as AxiosError;
    return {
      success: false,
      status: axiosError.response?.status,
      data: axiosError.response?.data,
      message: axiosError.message
    };
  }
}

// ========================================
// TEST FUNCTIONS
// ========================================

async function testGetOrderDetail() {
  console.log('\n📋 TEST: Get Order Detail');
  console.log('─'.repeat(50));

  // First get a real order number
  const ordersResult = await signedRequest('POST', '/sapi/v1/c2c/orderMatch/listOrders', {
    tradeType: 'SELL',
    page: 1,
    rows: 5
  });

  if (ordersResult.success && ordersResult.data?.data?.length > 0) {
    const orderNo = ordersResult.data.data[0].orderNumber;
    console.log(`  Using order: ${orderNo}`);

    // Try different parameter names
    const variants = [
      { adOrderNo: orderNo },
      { orderNo: orderNo },
      { orderNumber: orderNo },
      { advOrderNo: orderNo },
    ];

    for (const params of variants) {
      const result = await signedRequest('GET', '/sapi/v1/c2c/orderMatch/getOrderDetail', params);
      console.log(`  Params: ${JSON.stringify(params)}`);
      console.log(`  Status: ${result.status}, Success: ${result.success}`);
      if (result.data?.data || result.data?.code === '000000') {
        console.log(`  ✅ WORKS! Data:`, JSON.stringify(result.data).substring(0, 200));
        return { endpoint: 'getOrderDetail', params: Object.keys(params)[0], works: true };
      }
    }
  }
  console.log('  ❌ No working variant found');
  return { endpoint: 'getOrderDetail', works: false };
}

async function testReleaseOrder() {
  console.log('\n🔓 TEST: Release Order (READ-ONLY - not actually releasing)');
  console.log('─'.repeat(50));

  // We won't actually release, just test what parameters are expected
  const endpoints = [
    '/sapi/v1/c2c/orderMatch/releaseOrder',
    '/sapi/v1/c2c/orderMatch/releaseCoin',
    '/sapi/v1/c2c/order/release',
    '/sapi/v1/c2c/order/releaseCoin',
  ];

  // Use a fake order number to see what error we get (tells us the expected format)
  const fakeOrderNo = '12345678901234567890';

  for (const endpoint of endpoints) {
    const variants = [
      { orderNo: fakeOrderNo },
      { orderNumber: fakeOrderNo },
      { adOrderNo: fakeOrderNo },
      { advOrderNo: fakeOrderNo },
    ];

    for (const params of variants) {
      const result = await signedRequest('POST', endpoint, params);
      console.log(`  ${endpoint} + ${JSON.stringify(params)}`);
      console.log(`  Status: ${result.status}, Code: ${result.data?.code || result.data?.msg}`);

      // If we get "order not found" or similar, the endpoint works!
      const code = result.data?.code;
      const msg = result.data?.msg || result.data?.message || '';

      if (code === '000000' ||
          msg.includes('order') ||
          msg.includes('Order') ||
          code === '704001' ||  // Order not found type errors
          code === '704002' ||
          code === '704010' ||
          (result.status === 200 && code !== '-1102')) {
        console.log(`  ✅ Endpoint exists! Error: ${msg}`);
        return { endpoint, params: Object.keys(params)[0], works: true, note: msg };
      }
    }
  }
  console.log('  ❌ No release endpoint found');
  return { endpoint: 'releaseOrder', works: false };
}

async function testUpdateAd() {
  console.log('\n💰 TEST: Update Ad Price');
  console.log('─'.repeat(50));

  if (!ADV_NO) {
    console.log('  ⚠️ No ADV_NO configured');
    return { endpoint: 'updateAd', works: false };
  }

  const endpoints = [
    '/sapi/v1/c2c/ads/update',
    '/sapi/v1/c2c/ads/updatePrice',
    '/sapi/v1/c2c/advertisement/update',
    '/sapi/v1/c2c/adv/update',
    '/sapi/v1/c2c/ads/modify',
  ];

  for (const endpoint of endpoints) {
    // Try with just advNo first to see what other params are required
    const testParams = [
      { advNo: ADV_NO },
      { adNo: ADV_NO },
      { advertisementNo: ADV_NO },
      { advNo: ADV_NO, price: '20.50' },
      { advNo: ADV_NO, newPrice: '20.50' },
    ];

    for (const params of testParams) {
      const result = await signedRequest('POST', endpoint, params);
      console.log(`  ${endpoint}`);
      console.log(`  Params: ${JSON.stringify(params)}`);
      console.log(`  Status: ${result.status}, Response: ${JSON.stringify(result.data).substring(0, 150)}`);

      const code = result.data?.code;
      const msg = result.data?.msg || result.data?.message || '';

      // Check if endpoint recognizes the request (even with errors about other params)
      if (code === '000000' ||
          msg.includes('price') ||
          msg.includes('Price') ||
          msg.includes('advNo') ||
          msg.includes('parameter') ||
          (result.status === 200 && !msg.includes('not supported'))) {
        console.log(`  ✅ Endpoint found! Response: ${msg}`);
        return { endpoint, works: true, note: msg, params };
      }
    }
  }
  console.log('  ❌ No update endpoint found');
  return { endpoint: 'updateAd', works: false };
}

async function testEnableDisableAd() {
  console.log('\n🔄 TEST: Enable/Disable Ad');
  console.log('─'.repeat(50));

  if (!ADV_NO) {
    console.log('  ⚠️ No ADV_NO configured');
    return { endpoint: 'enableDisable', works: false };
  }

  const operations = [
    { endpoint: '/sapi/v1/c2c/ads/updateStatus', params: { advNo: ADV_NO, status: 1 } },
    { endpoint: '/sapi/v1/c2c/ads/updateStatus', params: { advNo: ADV_NO, advStatus: 1 } },
    { endpoint: '/sapi/v1/c2c/ads/enable', params: { advNo: ADV_NO } },
    { endpoint: '/sapi/v1/c2c/ads/disable', params: { advNo: ADV_NO } },
    { endpoint: '/sapi/v1/c2c/ads/publish', params: { advNo: ADV_NO } },
    { endpoint: '/sapi/v1/c2c/ads/unpublish', params: { advNo: ADV_NO } },
    { endpoint: '/sapi/v1/c2c/advertisement/updateStatus', params: { advNo: ADV_NO, status: 1 } },
  ];

  for (const op of operations) {
    const result = await signedRequest('POST', op.endpoint, op.params);
    console.log(`  ${op.endpoint}`);
    console.log(`  Status: ${result.status}, Response: ${JSON.stringify(result.data).substring(0, 150)}`);

    const code = result.data?.code;
    const msg = result.data?.msg || result.data?.message || '';

    if (code === '000000' ||
        msg.includes('advNo') ||
        msg.includes('status') ||
        (result.status === 200 && code && code !== '-1102' && !msg.includes('not supported'))) {
      console.log(`  ✅ Endpoint works! Response: ${msg}`);
      return { endpoint: op.endpoint, works: true, note: msg };
    }
  }
  console.log('  ❌ No enable/disable endpoint found');
  return { endpoint: 'enableDisable', works: false };
}

async function testPublicSearch() {
  console.log('\n🔍 TEST: Public P2P Search (No Auth)');
  console.log('─'.repeat(50));

  const endpoints = [
    'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
    'https://p2p.binance.com/bapi/c2c/v2/public/c2c/adv/search',
  ];

  const searchBody = {
    asset: 'USDT',
    fiat: 'MXN',
    tradeType: 'SELL',
    page: 1,
    rows: 5,
    publisherType: null,
  };

  for (const endpoint of endpoints) {
    const result = await publicRequest(endpoint, searchBody);
    console.log(`  ${endpoint}`);
    console.log(`  Status: ${result.status}, Success: ${result.success}`);

    if (result.success && result.data?.data?.length > 0) {
      const ads = result.data.data;
      console.log(`  ✅ WORKS! Found ${ads.length} ads`);
      console.log(`  Sample: Price ${ads[0].adv?.price} MXN by ${ads[0].advertiser?.nickName}`);
      return { endpoint, works: true, sampleData: ads.slice(0, 2) };
    }
  }
  console.log('  ❌ Public search not working');
  return { endpoint: 'publicSearch', works: false };
}

async function testChatCredentials() {
  console.log('\n💬 TEST: Chat Credentials');
  console.log('─'.repeat(50));

  const result = await signedRequest('GET', '/sapi/v1/c2c/chat/retrieveChatCredential', {});
  console.log(`  Status: ${result.status}, Success: ${result.success}`);

  if (result.success && result.data) {
    console.log(`  Response: ${JSON.stringify(result.data).substring(0, 200)}`);
    if (result.data.code === '000000' || result.data.data) {
      console.log(`  ✅ WORKS!`);
      return { endpoint: '/sapi/v1/c2c/chat/retrieveChatCredential', works: true, data: result.data };
    }
  }
  console.log('  ❌ Chat credentials not working');
  return { endpoint: 'chatCredentials', works: false };
}

async function testSendChatMessage() {
  console.log('\n📨 TEST: Send Chat Message (checking endpoint only)');
  console.log('─'.repeat(50));

  const endpoints = [
    '/sapi/v1/c2c/chat/sendMessage',
    '/sapi/v1/c2c/chat/message/send',
    '/sapi/v1/c2c/message/send',
  ];

  // Use fake data to see what error we get
  for (const endpoint of endpoints) {
    const params = { orderNo: '12345', message: 'test' };
    const result = await signedRequest('POST', endpoint, params);
    console.log(`  ${endpoint}`);
    console.log(`  Status: ${result.status}, Response: ${JSON.stringify(result.data).substring(0, 150)}`);

    const code = result.data?.code;
    const msg = result.data?.msg || result.data?.message || '';

    if (msg.includes('order') || msg.includes('Order') || code === '704001') {
      console.log(`  ✅ Endpoint exists!`);
      return { endpoint, works: true, note: msg };
    }
  }
  console.log('  ❌ No chat send endpoint found');
  return { endpoint: 'sendMessage', works: false };
}

async function testPendingOrders() {
  console.log('\n⏳ TEST: Pending Orders');
  console.log('─'.repeat(50));

  const result = await signedRequest('GET', '/sapi/v1/c2c/orderMatch/pendingOrders', {});
  console.log(`  Status: ${result.status}, Success: ${result.success}`);
  console.log(`  Response: ${JSON.stringify(result.data).substring(0, 200)}`);

  if (result.success) {
    console.log(`  ✅ WORKS!`);
    return { endpoint: '/sapi/v1/c2c/orderMatch/pendingOrders', works: true, data: result.data };
  }
  return { endpoint: 'pendingOrders', works: false };
}

// ========================================
// MAIN
// ========================================

async function main() {
  console.log('🧪 TESTING USEFUL ENDPOINTS FOR P2P BOT');
  console.log('═'.repeat(50));
  console.log(`ADV_NO: ${ADV_NO}`);

  const results: any[] = [];

  // Test all endpoints
  results.push(await testPublicSearch());
  results.push(await testPendingOrders());
  results.push(await testGetOrderDetail());
  results.push(await testChatCredentials());
  results.push(await testUpdateAd());
  results.push(await testEnableDisableAd());
  results.push(await testReleaseOrder());
  results.push(await testSendChatMessage());

  // Summary
  console.log('\n');
  console.log('═'.repeat(50));
  console.log('📊 SUMMARY OF WORKING ENDPOINTS');
  console.log('═'.repeat(50));

  const working = results.filter(r => r.works);
  const notWorking = results.filter(r => !r.works);

  console.log('\n✅ WORKING:');
  working.forEach(r => {
    console.log(`  - ${r.endpoint}${r.note ? ` (${r.note})` : ''}`);
  });

  console.log('\n❌ NOT WORKING:');
  notWorking.forEach(r => {
    console.log(`  - ${r.endpoint}`);
  });

  console.log('\n');

  // Save results
  const fs = await import('fs');
  fs.writeFileSync(
    'docs/useful-endpoints-test-results.json',
    JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2)
  );
  console.log('📁 Results saved to docs/useful-endpoints-test-results.json');
}

main().catch(console.error);
