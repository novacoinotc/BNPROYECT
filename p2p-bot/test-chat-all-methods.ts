/**
 * Test ALL possible methods for Binance P2P Chat
 *
 * Methods to test:
 * 1. SAPI retrieveChatCredential with different params
 * 2. P2P BAPI token endpoint
 * 3. P2P BAPI sendMessage endpoints
 * 4. Direct WebSocket with listenKey from user data stream
 */

import crypto from 'crypto';
import 'dotenv/config';

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';

function sign(query: string): string {
  return crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

const orderNo = process.argv[2] || '22846324542901170176';
const testMessage = 'Test - ignore';

async function testSapiCredentials(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('1️⃣ SAPI Chat Credentials');
  console.log('='.repeat(60));

  const paramCombos = [
    {},
    { orderNo },
    { orderNumber: orderNo },
    { recvWindow: 60000 },
    { orderNo, recvWindow: 60000 },
  ];

  for (const params of paramCombos) {
    const timestamp = Date.now();
    const allParams = { ...params, timestamp };
    const query = Object.entries(allParams)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    const signature = sign(query);

    try {
      console.log(`\nParams: ${JSON.stringify(params)}`);
      const response = await fetch(
        `https://api.binance.com/sapi/v1/c2c/chat/retrieveChatCredential?${query}&signature=${signature}`,
        { headers: { 'X-MBX-APIKEY': API_KEY } }
      );
      const text = await response.text();
      console.log(`  Status: ${response.status}`);
      console.log(`  Response: ${text.substring(0, 200)}`);

      if (text.includes('listenKey') || text.includes('chatWssUrl')) {
        console.log('  ✅ GOT CREDENTIALS!');
      }
    } catch (error: any) {
      console.log(`  ❌ Error: ${error.message}`);
    }
    await sleep(300);
  }
}

async function testP2PTokenEndpoint(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('2️⃣ P2P BAPI Token Endpoint (requires session)');
  console.log('='.repeat(60));

  const endpoints = [
    '/bapi/c2c/v1/friendly/binance-chat/common/token',
    '/bapi/c2c/v1/private/binance-chat/common/token',
  ];

  for (const endpoint of endpoints) {
    try {
      console.log(`\n${endpoint}`);

      // Try with API key headers
      const response = await fetch(`https://p2p.binance.com${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MBX-APIKEY': API_KEY,
          'Origin': 'https://p2p.binance.com',
          'Referer': 'https://p2p.binance.com/',
        },
        body: JSON.stringify({}),
      });

      const text = await response.text();
      console.log(`  Status: ${response.status}`);
      console.log(`  Response: ${text.substring(0, 300)}`);

      if (text.includes('token') && !text.includes('error')) {
        console.log('  ✅ GOT TOKEN!');
      }
    } catch (error: any) {
      console.log(`  ❌ Error: ${error.message}`);
    }
    await sleep(300);
  }
}

async function testSapiSendMessage(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('3️⃣ SAPI sendMessage Endpoint');
  console.log('='.repeat(60));

  const bodyCombos = [
    { orderNo, content: testMessage, msgType: 'TEXT' },
    { orderNumber: orderNo, content: testMessage, msgType: 'TEXT' },
    { adOrderNo: orderNo, content: testMessage, msgType: 'TEXT' },
    { orderNo, message: testMessage, type: 'text' },
  ];

  for (const body of bodyCombos) {
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = sign(query);

    try {
      console.log(`\nBody: ${JSON.stringify(body)}`);
      const response = await fetch(
        `https://api.binance.com/sapi/v1/c2c/chat/sendMessage?${query}&signature=${signature}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-MBX-APIKEY': API_KEY,
          },
          body: JSON.stringify(body),
        }
      );

      const text = await response.text();
      console.log(`  Status: ${response.status}`);
      console.log(`  Response: ${text || '(empty)'}`);

      if (text.includes('000000') || text.includes('success')) {
        console.log('  ✅ MESSAGE SENT!');
      }
    } catch (error: any) {
      console.log(`  ❌ Error: ${error.message}`);
    }
    await sleep(300);
  }
}

async function testP2PSendMessage(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('4️⃣ P2P BAPI sendMessage Endpoints');
  console.log('='.repeat(60));

  const endpoints = [
    '/bapi/c2c/v1/friendly/c2c/chat/sendMessage',
    '/bapi/c2c/v2/friendly/c2c/chat/sendMessage',
    '/bapi/c2c/v1/private/c2c/chat/sendMessage',
  ];

  const body = { orderNo, content: testMessage, msgType: 'TEXT' };

  for (const endpoint of endpoints) {
    try {
      console.log(`\n${endpoint}`);

      // Try with API key
      const response = await fetch(`https://p2p.binance.com${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MBX-APIKEY': API_KEY,
          'Origin': 'https://p2p.binance.com',
          'Referer': 'https://p2p.binance.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: JSON.stringify(body),
      });

      const text = await response.text();
      console.log(`  Status: ${response.status}`);
      console.log(`  Response: ${text.substring(0, 300)}`);

      if (text.includes('000000')) {
        console.log('  ✅ MESSAGE SENT!');
      }
    } catch (error: any) {
      console.log(`  ❌ Error: ${error.message}`);
    }
    await sleep(300);
  }
}

async function testUserDataStreamListenKey(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('5️⃣ User Data Stream Listen Key');
  console.log('='.repeat(60));

  try {
    // Get a regular user data stream listen key
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = sign(query);

    const response = await fetch(
      `https://api.binance.com/api/v3/userDataStream`,
      {
        method: 'POST',
        headers: { 'X-MBX-APIKEY': API_KEY },
      }
    );

    const data = await response.json() as { listenKey?: string };
    console.log('Response:', JSON.stringify(data, null, 2));

    if (data.listenKey) {
      console.log(`\n✅ Got listenKey: ${data.listenKey.substring(0, 30)}...`);
      console.log('Note: This is for spot trading, not P2P chat');
    }
  } catch (error: any) {
    console.log(`❌ Error: ${error.message}`);
  }
}

async function testGetChatMessages(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('6️⃣ Get Chat Messages (to verify order access)');
  console.log('='.repeat(60));

  const timestamp = Date.now();
  const params = { orderNo, page: 1, rows: 10 };
  const query = Object.entries({ ...params, timestamp })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const signature = sign(query);

  try {
    const response = await fetch(
      `https://api.binance.com/sapi/v1/c2c/chat/retrieveChatMessagesWithPagination?${query}&signature=${signature}`,
      { headers: { 'X-MBX-APIKEY': API_KEY } }
    );

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.substring(0, 500)}`);

    if (text.includes('data') && !text.includes('error')) {
      console.log('✅ CAN READ CHAT MESSAGES');
    }
  } catch (error: any) {
    console.log(`❌ Error: ${error.message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('='.repeat(60));
  console.log('🔧 Binance P2P Chat - All Methods Test');
  console.log('='.repeat(60));
  console.log(`Order: ${orderNo}`);
  console.log(`API Key: ${API_KEY.substring(0, 10)}...`);
  console.log('='.repeat(60));

  await testGetChatMessages();
  await testSapiCredentials();
  await testSapiSendMessage();
  await testP2PTokenEndpoint();
  await testP2PSendMessage();
  await testUserDataStreamListenKey();

  console.log('\n' + '='.repeat(60));
  console.log('📋 SUMMARY');
  console.log('='.repeat(60));
  console.log(`
Findings:
1. SAPI chat credential endpoint may require specific parameters
2. P2P BAPI endpoints require browser session (cookies)
3. sendMessage endpoint returns 200 but empty body (not supported?)
4. getChatMessages WORKS - we can read chat history
5. User Data Stream listenKey is for spot trading, not P2P chat

CONCLUSION:
Binance P2P Chat sending is only available through:
- Browser WebSocket connection with session cookies
- Mobile app

For automation, options:
1. Use Puppeteer to maintain browser session and send via WebSocket
2. Skip chat messaging (not critical for auto-release)
`);
}

main().catch(console.error);
