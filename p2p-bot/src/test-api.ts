// =====================================================
// API TEST SCRIPT
// Tests Binance P2P API endpoints and logs data structures
// =====================================================

import 'dotenv/config';
import crypto from 'crypto';

const API_KEY = process.env.BINANCE_API_KEY!;
const API_SECRET = process.env.BINANCE_API_SECRET!;
const BASE_URL = 'https://api.binance.com';

// Generate HMAC signature
function sign(queryString: string): string {
  return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}

// Make authenticated request
async function request(endpoint: string, params: Record<string, any> = {}, method: string = 'POST'): Promise<any> {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const queryString = Object.entries(allParams)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const signature = sign(queryString);

  const url = `${BASE_URL}${endpoint}?${queryString}&signature=${signature}`;

  console.log(`\n📡 ${method} ${endpoint}`);
  console.log(`   Params:`, JSON.stringify(params, null, 2));

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': API_KEY,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();

    if (!response.ok) {
      console.log(`   ❌ Error ${response.status}:`, JSON.stringify(data, null, 2));
      return null;
    }

    console.log(`   ✅ Success`);
    return data;
  } catch (error) {
    console.log(`   ❌ Network error:`, (error as Error).message);
    return null;
  }
}

// ==================== TESTS ====================

async function testGetOrders() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST: Get P2P Orders (c2cOrderMatch/listUserOrderHistory)');
  console.log('='.repeat(60));

  const data = await request('/sapi/v1/c2c/orderMatch/listUserOrderHistory', {
    tradeType: 'SELL',
    rows: 5,
  });

  if (data && data.data && data.data.length > 0) {
    console.log('\n📦 First order structure:');
    console.log(JSON.stringify(data.data[0], null, 2));

    console.log('\n📋 All order fields:');
    const order = data.data[0];
    for (const [key, value] of Object.entries(order)) {
      console.log(`   ${key}: ${typeof value} = ${JSON.stringify(value)}`);
    }
  } else {
    console.log('   No orders found or error in response');
    if (data) {
      console.log('   Response:', JSON.stringify(data, null, 2));
    }
  }

  return data;
}

async function testGetAds() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST: Get My Ads (c2c/ads/getDetailV2)');
  console.log('='.repeat(60));

  // First try to list ads
  const listData = await request('/sapi/v1/c2c/ads/getDetailV2', {
    advNos: process.env.BINANCE_ADV_NO || '',
  });

  if (listData) {
    console.log('\n📦 Ad structure:');
    console.log(JSON.stringify(listData, null, 2));
  }

  return listData;
}

async function testGetOrderDetail() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST: Get Order Detail');
  console.log('='.repeat(60));

  // First get an order number
  const orders = await request('/sapi/v1/c2c/orderMatch/listUserOrderHistory', {
    tradeType: 'SELL',
    rows: 1,
  });

  if (orders && orders.data && orders.data.length > 0) {
    const orderNo = orders.data[0].orderNumber || orders.data[0].orderNo;
    console.log(`\n   Using order: ${orderNo}`);

    const detail = await request('/sapi/v1/c2c/orderMatch/getUserOrderDetail', {
      orderNo,
    });

    if (detail) {
      console.log('\n📦 Order detail structure:');
      console.log(JSON.stringify(detail, null, 2));
    }

    return detail;
  }

  return null;
}

async function testMarketPrice() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST: Get Market Price');
  console.log('='.repeat(60));

  // Try public endpoint for reference price
  try {
    const response = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=USDTMXN');
    const data = await response.json();
    console.log('\n📦 Spot price (USDTMXN):');
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.log('   Spot price not available for this pair');
  }

  // Try P2P market data
  const p2pData = await request('/sapi/v1/c2c/ads/search', {
    asset: 'USDT',
    fiat: 'MXN',
    tradeType: 'SELL',
    rows: 5,
  });

  if (p2pData) {
    console.log('\n📦 P2P market search result:');
    console.log(JSON.stringify(p2pData, null, 2));
  }

  return p2pData;
}

async function testAccountInfo() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST: Get Account Info');
  console.log('='.repeat(60));

  const data = await request('/sapi/v1/c2c/user/userInfo', {}, 'GET');

  if (data) {
    console.log('\n📦 User info:');
    console.log(JSON.stringify(data, null, 2));
  }

  return data;
}

// ==================== MAIN ====================

async function main() {
  console.log('🚀 Binance P2P API Test Script');
  console.log('================================');
  console.log(`API Key: ${API_KEY?.substring(0, 10)}...`);
  console.log(`ADV NO: ${process.env.BINANCE_ADV_NO || 'Not set'}`);

  if (!API_KEY || !API_SECRET) {
    console.error('❌ Missing API credentials!');
    process.exit(1);
  }

  // Run all tests
  await testGetOrders();
  await testGetOrderDetail();
  await testGetAds();
  await testMarketPrice();
  await testAccountInfo();

  console.log('\n' + '='.repeat(60));
  console.log('✅ All tests completed!');
  console.log('='.repeat(60));
}

main().catch(console.error);
