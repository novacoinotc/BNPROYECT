/**
 * Test sending P2P chat message using the token from friendly endpoint
 *
 * We discovered:
 * - /bapi/c2c/v1/friendly/binance-chat/common/token returns a valid token
 * - Let's try using this token with different endpoints
 */

import crypto from 'crypto';
import WebSocket from 'ws';
import 'dotenv/config';

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';

function sign(query: string): string {
  return crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

interface TokenResponse {
  code: string;
  data?: {
    uid: number;
    token: string;
    lastSeqNo2?: string;
  };
  success?: boolean;
}

const orderNo = process.argv[2] || '22846324542901170176';
const testMessage = 'Gracias por tu confianza, quedamos al pendiente de futuras ordenes.';

/**
 * Get chat token from friendly endpoint
 */
async function getChatToken(): Promise<TokenResponse> {
  console.log('📡 Getting chat token from P2P friendly endpoint...');

  const response = await fetch(
    'https://p2p.binance.com/bapi/c2c/v1/friendly/binance-chat/common/token',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MBX-APIKEY': API_KEY,
        'Origin': 'https://p2p.binance.com',
        'Referer': 'https://p2p.binance.com/',
      },
      body: JSON.stringify({}),
    }
  );

  const data = await response.json() as TokenResponse;
  console.log('Token response:', JSON.stringify(data, null, 2));
  return data;
}

/**
 * Try sending message with token in different ways
 */
async function sendWithToken(token: string, uid: number): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('Testing message sending with token');
  console.log('='.repeat(60));

  // 1. Try the private endpoint with token in header
  const endpoints = [
    '/bapi/c2c/v1/private/c2c/chat/sendMessage',
    '/bapi/c2c/v1/friendly/c2c/chat/message/send',
    '/bapi/c2c/v1/friendly/binance-chat/message/send',
  ];

  const headerVariants = [
    {
      'Content-Type': 'application/json',
      'X-MBX-APIKEY': API_KEY,
      'Authorization': `Bearer ${token}`,
      'x-chat-token': token,
    },
    {
      'Content-Type': 'application/json',
      'X-MBX-APIKEY': API_KEY,
      'x-trace-id': crypto.randomUUID(),
      'x-ui-request-trace': crypto.randomUUID(),
      'chat-token': token,
    },
    {
      'Content-Type': 'application/json',
      'X-MBX-APIKEY': API_KEY,
      'token': token,
    },
  ];

  const body = {
    orderNo,
    content: testMessage,
    msgType: 'TEXT',
    uid,
  };

  for (const endpoint of endpoints) {
    for (let i = 0; i < headerVariants.length; i++) {
      try {
        console.log(`\n${endpoint} (headers variant ${i + 1}):`);

        const response = await fetch(`https://p2p.binance.com${endpoint}`, {
          method: 'POST',
          headers: headerVariants[i] as any,
          body: JSON.stringify(body),
        });

        const text = await response.text();
        console.log(`  Status: ${response.status}`);
        console.log(`  Response: ${text.substring(0, 200)}`);

        if (text.includes('000000') || (response.status === 200 && text.includes('success'))) {
          console.log('  ✅ POSSIBLE SUCCESS!');
        }
      } catch (error: any) {
        console.log(`  ❌ Error: ${error.message}`);
      }
      await sleep(300);
    }
  }
}

/**
 * Try WebSocket with the token
 */
async function tryWebSocketWithToken(token: string): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('Testing WebSocket with token');
  console.log('='.repeat(60));

  // Common Binance WebSocket URLs
  const wsUrls = [
    `wss://nbstream.binance.com/chat/stream?token=${token}`,
    `wss://stream.binance.com:9443/chat/stream?token=${token}`,
    `wss://p2p.binance.com/bapi/c2c/v1/ws/chat?token=${token}`,
    `wss://chat.binance.com/ws?token=${token}`,
  ];

  for (const wsUrl of wsUrls) {
    await new Promise<void>((resolve) => {
      console.log(`\n🔌 Trying: ${wsUrl}`);

      const ws = new WebSocket(wsUrl, {
        headers: {
          'Origin': 'https://p2p.binance.com',
          'X-MBX-APIKEY': API_KEY,
        },
      });

      const timeout = setTimeout(() => {
        console.log('  ⏱️ Timeout');
        ws.close();
        resolve();
      }, 5000);

      ws.on('open', () => {
        console.log('  ✅ Connected!');

        // Try subscribing to chat
        ws.send(JSON.stringify({
          method: 'SUBSCRIBE',
          params: [`chat@${orderNo}`],
          id: 1,
        }));

        // Try sending message
        setTimeout(() => {
          ws.send(JSON.stringify({
            method: 'SEND',
            params: {
              orderNo,
              content: testMessage,
              msgType: 'TEXT',
            },
            id: 2,
          }));
        }, 1000);
      });

      ws.on('message', (data) => {
        console.log('  📥:', data.toString().substring(0, 200));
      });

      ws.on('error', (err) => {
        console.log(`  ❌ Error: ${err.message}`);
        clearTimeout(timeout);
        resolve();
      });

      ws.on('close', (code) => {
        console.log(`  🔌 Closed (${code})`);
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

/**
 * Try the SAPI sendMessage with the token
 */
async function trySapiWithToken(token: string): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('Testing SAPI sendMessage with token');
  console.log('='.repeat(60));

  const timestamp = Date.now();
  const query = `timestamp=${timestamp}`;
  const signature = sign(query);

  const headers = {
    'Content-Type': 'application/json',
    'X-MBX-APIKEY': API_KEY,
    'Authorization': `Bearer ${token}`,
  };

  const body = {
    orderNo,
    content: testMessage,
    msgType: 'TEXT',
  };

  try {
    const response = await fetch(
      `https://api.binance.com/sapi/v1/c2c/chat/sendMessage?${query}&signature=${signature}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }
    );

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text || '(empty)'}`);
  } catch (error: any) {
    console.log(`❌ Error: ${error.message}`);
  }
}

/**
 * Get SAPI chat messages to compare with what we send
 */
async function getChatMessages(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('Current chat messages (to verify if message was sent)');
  console.log('='.repeat(60));

  const timestamp = Date.now();
  const params = { orderNo, page: 1, rows: 5 };
  const query = Object.entries({ ...params, timestamp })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const signature = sign(query);

  try {
    const response = await fetch(
      `https://api.binance.com/sapi/v1/c2c/chat/retrieveChatMessagesWithPagination?${query}&signature=${signature}`,
      { headers: { 'X-MBX-APIKEY': API_KEY } }
    );

    const data = await response.json() as any;

    if (data.data && Array.isArray(data.data)) {
      console.log(`Found ${data.data.length} messages:`);
      for (const msg of data.data.slice(0, 5)) {
        console.log(`  - [${msg.type}] ${msg.content?.substring(0, 50) || '(no content)'}...`);
      }
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
  console.log('🔧 Chat with Token Test');
  console.log('='.repeat(60));
  console.log(`Order: ${orderNo}`);
  console.log(`Message: ${testMessage}`);
  console.log('='.repeat(60));

  try {
    // Get messages before
    await getChatMessages();

    // Get token
    const tokenResponse = await getChatToken();

    if (tokenResponse.code === '000000' && tokenResponse.data?.token) {
      const { token, uid } = tokenResponse.data;
      console.log(`\n✅ Got token: ${token}`);
      console.log(`✅ User ID: ${uid}`);

      // Try different methods
      await sendWithToken(token, uid);
      await trySapiWithToken(token);
      await tryWebSocketWithToken(token);

      // Get messages after
      console.log('\n⏳ Waiting 3s before checking messages...');
      await sleep(3000);
      await getChatMessages();
    } else {
      console.log('❌ Failed to get token');
    }
  } catch (error) {
    console.log('❌ Error:', error);
  }
}

main().catch(console.error);
