/**
 * Test script to discover correct parameters for Binance P2P Chat sendMessage API
 * Run with: npx ts-node test-chat-api.ts <orderNo>
 */

import crypto from 'crypto';
import 'dotenv/config';

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';
const BASE_URL = 'https://api.binance.com';

function sign(query: string): string {
  return crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

async function testEndpoint(
  endpoint: string,
  body: Record<string, any>,
  method: 'POST' | 'GET' = 'POST'
): Promise<{ success: boolean; response: any; error?: string }> {
  const timestamp = Date.now();
  const query = `timestamp=${timestamp}`;
  const signature = sign(query);
  const url = `${BASE_URL}${endpoint}?${query}&signature=${signature}`;

  try {
    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-MBX-APIKEY': API_KEY,
      },
    };

    if (method === 'POST') {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    return {
      success: response.ok && (data?.success === true || data?.code === '000000' || data?.data),
      response: data,
    };
  } catch (error: any) {
    return {
      success: false,
      response: null,
      error: error.message,
    };
  }
}

async function main() {
  const orderNo = process.argv[2];

  if (!orderNo) {
    console.log('Usage: npx ts-node test-chat-api.ts <orderNo>');
    console.log('Example: npx ts-node test-chat-api.ts 22846324542901170176');
    process.exit(1);
  }

  console.log(`\n🔍 Testing Binance Chat API with order: ${orderNo}\n`);
  console.log('='.repeat(60));

  const testMessage = 'Test message - please ignore';

  // Different endpoints to try
  const endpoints = [
    '/sapi/v1/c2c/chat/sendMessage',
    '/sapi/v2/c2c/chat/sendMessage',
    '/sapi/v1/c2c/chat/message/send',
    '/sapi/v1/c2c/orderMatch/sendChatMessage',
  ];

  // Different parameter combinations
  const paramVariants = [
    // Variant 1: orderNo + content
    { orderNo, content: testMessage, msgType: 'TEXT' },
    { orderNo, content: testMessage, msgType: 'text' },
    { orderNo, content: testMessage, type: 'TEXT' },
    { orderNo, content: testMessage },

    // Variant 2: orderNumber + content
    { orderNumber: orderNo, content: testMessage, msgType: 'TEXT' },
    { orderNumber: orderNo, content: testMessage, msgType: 'text' },
    { orderNumber: orderNo, content: testMessage },

    // Variant 3: adOrderNo + content
    { adOrderNo: orderNo, content: testMessage, msgType: 'TEXT' },
    { adOrderNo: orderNo, content: testMessage },

    // Variant 4: orderNo + message
    { orderNo, message: testMessage, msgType: 'TEXT' },
    { orderNo, message: testMessage, msgType: 'text' },
    { orderNo, message: testMessage },

    // Variant 5: orderNumber + message
    { orderNumber: orderNo, message: testMessage, msgType: 'TEXT' },
    { orderNumber: orderNo, message: testMessage },

    // Variant 6: orderNo + text
    { orderNo, text: testMessage, msgType: 'TEXT' },
    { orderNo, text: testMessage },

    // Variant 7: orderNo + msg
    { orderNo, msg: testMessage, msgType: 'TEXT' },
    { orderNo, msg: testMessage },

    // Variant 8: with clientMsgId
    { orderNo, content: testMessage, msgType: 'TEXT', clientMsgId: `test_${Date.now()}` },
    { orderNo, message: testMessage, clientMsgId: `test_${Date.now()}` },

    // Variant 9: with uuid
    { orderNo, content: testMessage, msgType: 'TEXT', uuid: `test_${Date.now()}` },

    // Variant 10: nested structure
    { orderNo, data: { content: testMessage, msgType: 'TEXT' } },
    { message: { orderNo, content: testMessage, type: 'TEXT' } },
  ];

  let foundWorking = false;

  for (const endpoint of endpoints) {
    console.log(`\n📡 Testing endpoint: ${endpoint}`);
    console.log('-'.repeat(60));

    for (let i = 0; i < paramVariants.length; i++) {
      const params = paramVariants[i];
      const result = await testEndpoint(endpoint, params);

      const status = result.success ? '✅' : '❌';
      const responseCode = result.response?.code || result.response?.msg || 'no code';

      console.log(`${status} Variant ${i + 1}: ${JSON.stringify(Object.keys(params))} → ${responseCode}`);

      if (result.success) {
        console.log('\n🎉 FOUND WORKING COMBINATION!');
        console.log('Endpoint:', endpoint);
        console.log('Parameters:', JSON.stringify(params, null, 2));
        console.log('Response:', JSON.stringify(result.response, null, 2));
        foundWorking = true;
        break;
      }

      // Log detailed error for debugging
      if (result.response?.code && result.response.code !== '000000') {
        console.log(`   Response: ${JSON.stringify(result.response)}`);
      }

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    }

    if (foundWorking) break;
  }

  if (!foundWorking) {
    console.log('\n❌ No working combination found.');
    console.log('\nPossible reasons:');
    console.log('1. The SAPI chat endpoint might not support sending messages');
    console.log('2. Messages might only be sendable via WebSocket');
    console.log('3. Special authentication might be required');
    console.log('\nNext steps:');
    console.log('- Check browser network tab when sending a message on Binance P2P');
    console.log('- The API might use a different domain (p2p.binance.com)');
  }

  console.log('\n' + '='.repeat(60));
}

main().catch(console.error);
