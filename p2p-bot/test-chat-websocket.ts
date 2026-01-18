/**
 * Test WebSocket chat with credentials
 */

import crypto from 'crypto';
import 'dotenv/config';

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';

function sign(query: string): string {
  return crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

interface ChatCreds {
  code?: string;
  data?: {
    listenKey: string;
    listenToken: string;
    chatWssUrl?: string;
  };
}

async function getChatCredentials(): Promise<ChatCreds> {
  const timestamp = Date.now();
  const query = `timestamp=${timestamp}`;
  const signature = sign(query);

  const response = await fetch(
    `https://api.binance.com/sapi/v1/c2c/chat/retrieveChatCredential?${query}&signature=${signature}`,
    {
      headers: { 'X-MBX-APIKEY': API_KEY },
    }
  );

  const data = await response.json() as ChatCreds;
  console.log('Chat Credentials Response:', JSON.stringify(data, null, 2));
  return data;
}

async function testPrivateEndpointWithToken(
  listenKey: string,
  listenToken: string,
  orderNo: string,
  message: string
) {
  console.log('\n📡 Testing private endpoint with chat tokens...');

  const endpoints = [
    '/bapi/c2c/v1/private/c2c/chat/sendMessage',
    '/bapi/c2c/v2/private/c2c/chat/sendMessage',
  ];

  const headerVariants: Record<string, string>[] = [
    // Try with listenKey as Bearer token
    {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${listenToken}`,
      'x-listen-key': listenKey,
    },
    // Try with different header names
    {
      'Content-Type': 'application/json',
      'listenKey': listenKey,
      'listenToken': listenToken,
    },
    // Try with csrftoken style
    {
      'Content-Type': 'application/json',
      'x-csrf-token': listenToken,
      'x-listen-key': listenKey,
    },
    // Try API key style
    {
      'Content-Type': 'application/json',
      'X-MBX-APIKEY': API_KEY,
      'x-listen-key': listenKey,
    },
  ];

  const body = { orderNo, content: message, msgType: 'TEXT' };

  for (const endpoint of endpoints) {
    for (let i = 0; i < headerVariants.length; i++) {
      try {
        const response = await fetch(`https://p2p.binance.com${endpoint}`, {
          method: 'POST',
          headers: headerVariants[i],
          body: JSON.stringify(body),
        });

        const text = await response.text();
        console.log(`\n${endpoint} with headers variant ${i + 1}:`);
        console.log(`  Status: ${response.status}`);
        console.log(`  Response: ${text.substring(0, 200)}`);

        if (response.status === 200 || text.includes('000000')) {
          console.log('  ✅ POSSIBLE SUCCESS!');
        }
      } catch (error: any) {
        console.log(`  ❌ Error: ${error.message}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

async function main() {
  const orderNo = process.argv[2] || '22846324542901170176';

  console.log('🔑 Getting chat credentials...\n');

  try {
    const creds = await getChatCredentials();

    if (creds.data?.listenKey && creds.data?.listenToken) {
      console.log('\n✅ Got credentials!');
      console.log(`  listenKey: ${creds.data.listenKey.substring(0, 20)}...`);
      console.log(`  chatWssUrl: ${creds.data.chatWssUrl || 'N/A'}`);

      await testPrivateEndpointWithToken(
        creds.data.listenKey,
        creds.data.listenToken,
        orderNo,
        'Test message - please ignore'
      );
    } else {
      console.log('\n❌ Could not get chat credentials');
      console.log('Response:', JSON.stringify(creds, null, 2));
    }
  } catch (error) {
    console.log('❌ Error:', error);
  }
}

main().catch(console.error);
