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

async function signedRequest(
  method: 'GET' | 'POST',
  endpoint: string,
  params: Record<string, any> = {}
): Promise<any> {
  const timestamp = Date.now();
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

async function signedJsonRequest(
  method: 'GET' | 'POST',
  endpoint: string,
  body: Record<string, any> = {}
): Promise<any> {
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = generateSignature(queryString);

  const headers = {
    'X-MBX-APIKEY': API_KEY,
    'Content-Type': 'application/json',
    'clientType': 'web',
  };

  try {
    const url = `${BASE_URL}${endpoint}?${queryString}&signature=${signature}`;
    let response;
    if (method === 'GET') {
      response = await axios.get(url, { headers });
    } else {
      response = await axios.post(url, body, { headers });
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

async function main() {
  console.log('🔧 DEEP TEST: Update Ad Price');
  console.log('═'.repeat(60));

  // First, get current ad info
  console.log('\n1️⃣ Getting current ad info...');
  let adsResult = await signedRequest('GET', '/sapi/v1/c2c/ads/list', {
    page: 1,
    rows: 10
  });

  // If GET fails, try POST with listWithPagination
  if (!adsResult.success || !adsResult.data?.data?.length) {
    console.log('  GET failed, trying POST listWithPagination...');
    adsResult = await signedRequest('POST', '/sapi/v1/c2c/ads/listWithPagination', {});
  }

  // Check different response structures
  let adsList = adsResult.data?.data || adsResult.data?.sellList || adsResult.data?.buyList || [];

  if (!adsResult.success || adsList.length === 0) {
    console.log('❌ Could not get ads');
    console.log('Response:', JSON.stringify(adsResult.data).substring(0, 500));
    return;
  }

  console.log(`  Found ${adsList.length} ads`);
  const myAd = adsList.find((ad: any) => ad.advNo === ADV_NO) || adsList[0];
  console.log('\n📊 Current Ad Info:');
  console.log(`  advNo: ${myAd.advNo}`);
  console.log(`  tradeType: ${myAd.tradeType}`);
  console.log(`  asset: ${myAd.asset}`);
  console.log(`  fiatUnit: ${myAd.fiatUnit}`);
  console.log(`  price: ${myAd.price}`);
  console.log(`  priceType: ${myAd.priceType}`);
  console.log(`  priceFloatingRatio: ${myAd.priceFloatingRatio}`);
  console.log(`  advStatus: ${myAd.advStatus}`);
  console.log(`  minSingleTransAmount: ${myAd.minSingleTransAmount}`);
  console.log(`  maxSingleTransAmount: ${myAd.maxSingleTransAmount}`);

  const currentPrice = parseFloat(myAd.price);
  const testPrice = (currentPrice + 0.01).toFixed(2); // Just a tiny change to test

  console.log(`\n2️⃣ Testing update endpoints with price: ${testPrice}`);
  console.log('─'.repeat(60));

  // Test different endpoint/param combinations
  const tests = [
    // Form-encoded variants
    {
      name: 'updatePrice form - advNo+price',
      endpoint: '/sapi/v1/c2c/ads/updatePrice',
      method: 'POST' as const,
      params: { advNo: myAd.advNo, price: testPrice },
      type: 'form'
    },
    {
      name: 'updatePrice form - full params',
      endpoint: '/sapi/v1/c2c/ads/updatePrice',
      method: 'POST' as const,
      params: {
        advNo: myAd.advNo,
        price: testPrice,
        asset: myAd.asset,
        fiatUnit: myAd.fiatUnit,
        tradeType: myAd.tradeType
      },
      type: 'form'
    },
    {
      name: 'update form - minimal',
      endpoint: '/sapi/v1/c2c/ads/update',
      method: 'POST' as const,
      params: { advNo: myAd.advNo, price: testPrice },
      type: 'form'
    },
    {
      name: 'update form - with priceType',
      endpoint: '/sapi/v1/c2c/ads/update',
      method: 'POST' as const,
      params: {
        advNo: myAd.advNo,
        price: testPrice,
        priceType: 1  // 1 = fixed price
      },
      type: 'form'
    },
    // JSON body variants
    {
      name: 'update JSON - minimal',
      endpoint: '/sapi/v1/c2c/ads/update',
      method: 'POST' as const,
      body: { advNo: myAd.advNo, price: testPrice },
      type: 'json'
    },
    {
      name: 'update JSON - full',
      endpoint: '/sapi/v1/c2c/ads/update',
      method: 'POST' as const,
      body: {
        advNo: myAd.advNo,
        price: testPrice,
        priceType: 1,
        asset: myAd.asset,
        fiatUnit: myAd.fiatUnit,
        tradeType: myAd.tradeType,
        minSingleTransAmount: myAd.minSingleTransAmount,
        maxSingleTransAmount: myAd.maxSingleTransAmount
      },
      type: 'json'
    },
    // v2 endpoints
    {
      name: 'v2 update form',
      endpoint: '/sapi/v2/c2c/ads/update',
      method: 'POST' as const,
      params: { advNo: myAd.advNo, price: testPrice },
      type: 'form'
    },
    // Alternative naming
    {
      name: 'modifyAd form',
      endpoint: '/sapi/v1/c2c/ads/modify',
      method: 'POST' as const,
      params: { advNo: myAd.advNo, price: testPrice },
      type: 'form'
    },
    {
      name: 'setPrice form',
      endpoint: '/sapi/v1/c2c/ads/setPrice',
      method: 'POST' as const,
      params: { advNo: myAd.advNo, price: testPrice },
      type: 'form'
    },
  ];

  const results: any[] = [];

  for (const test of tests) {
    console.log(`\n🧪 ${test.name}`);
    console.log(`   Endpoint: ${test.endpoint}`);

    let result;
    if (test.type === 'json') {
      console.log(`   Body: ${JSON.stringify(test.body)}`);
      result = await signedJsonRequest(test.method, test.endpoint, test.body);
    } else {
      console.log(`   Params: ${JSON.stringify(test.params)}`);
      result = await signedRequest(test.method, test.endpoint, test.params!);
    }

    console.log(`   Status: ${result.status}`);
    console.log(`   Response: ${JSON.stringify(result.data).substring(0, 200)}`);

    const code = result.data?.code;
    const msg = result.data?.msg || result.data?.message || '';

    if (code === '000000') {
      console.log(`   ✅ SUCCESS!`);
      results.push({ ...test, success: true, response: result.data });
    } else if (result.status === 200 && !msg.includes('error') && !msg.includes('Error')) {
      console.log(`   ⚠️ 200 OK but empty/unclear response`);
      results.push({ ...test, success: 'maybe', response: result.data });
    } else {
      console.log(`   ❌ Failed: ${msg}`);
      results.push({ ...test, success: false, error: msg });
    }
  }

  // Summary
  console.log('\n');
  console.log('═'.repeat(60));
  console.log('📊 RESULTS SUMMARY');
  console.log('═'.repeat(60));

  const successful = results.filter(r => r.success === true);
  const maybe = results.filter(r => r.success === 'maybe');
  const failed = results.filter(r => r.success === false);

  if (successful.length > 0) {
    console.log('\n✅ WORKING:');
    successful.forEach(r => console.log(`   - ${r.name}: ${r.endpoint}`));
  }

  if (maybe.length > 0) {
    console.log('\n⚠️ POSSIBLY WORKING (200 OK):');
    maybe.forEach(r => console.log(`   - ${r.name}: ${r.endpoint}`));
  }

  if (failed.length > 0) {
    console.log('\n❌ FAILED:');
    failed.forEach(r => console.log(`   - ${r.name}: ${r.error}`));
  }

  // Now test releaseOrder with a real completed order (read-only check)
  console.log('\n\n3️⃣ Testing releaseOrder endpoint format...');
  console.log('─'.repeat(60));

  // Get a PAID order if any exists
  const ordersResult = await signedRequest('POST', '/sapi/v1/c2c/orderMatch/listOrders', {
    tradeType: 'SELL',
    orderStatus: 2, // PAID
    page: 1,
    rows: 1
  });

  if (ordersResult.data?.data?.length > 0) {
    const paidOrder = ordersResult.data.data[0];
    console.log(`\n📋 Found PAID order: ${paidOrder.orderNumber}`);
    console.log(`   Status: ${paidOrder.orderStatus}`);
    console.log(`   Amount: ${paidOrder.amount} ${paidOrder.asset}`);
    console.log(`   ⚠️ NOT releasing - just checking endpoint format`);

    // Test what params the endpoint expects (without actually releasing)
    const releaseTests = [
      { orderNumber: paidOrder.orderNumber },
      { orderNo: paidOrder.orderNumber },
      { adOrderNo: paidOrder.orderNumber },
    ];

    for (const params of releaseTests) {
      // We'll use a FAKE order number to test the endpoint format safely
      const safeParams = { ...params };
      Object.keys(safeParams).forEach(k => {
        safeParams[k] = 'FAKE_' + safeParams[k]; // Modify to ensure we don't actually release
      });

      const result = await signedRequest('POST', '/sapi/v1/c2c/orderMatch/releaseOrder', safeParams);
      console.log(`\n   Params: ${JSON.stringify(Object.keys(params))}`);
      console.log(`   Status: ${result.status}`);
      console.log(`   Response: ${JSON.stringify(result.data).substring(0, 150)}`);

      // If we get "order not found" or similar, the param format is correct
      const msg = result.data?.msg || result.data?.message || '';
      if (msg.toLowerCase().includes('order') || result.data?.code === '704001') {
        console.log(`   ✅ Parameter format "${Object.keys(params)[0]}" is recognized!`);
      }
    }
  } else {
    console.log('   No PAID orders found to test with');
  }

  console.log('\n\n✨ Test complete!');
}

main().catch(console.error);
