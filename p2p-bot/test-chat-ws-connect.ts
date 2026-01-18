/**
 * Test WebSocket connection for Binance P2P Chat
 *
 * This script:
 * 1. Gets chat credentials from SAPI
 * 2. Connects to Binance Chat WebSocket
 * 3. Attempts to send a message
 */

import crypto from 'crypto';
import WebSocket from 'ws';
import 'dotenv/config';

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';

function sign(query: string): string {
  return crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

interface ChatCredentialResponse {
  code?: string;
  msg?: string;
  data?: {
    listenKey: string;
    listenToken: string;
    chatWssUrl?: string;
  };
}

/**
 * Get chat credentials from SAPI
 */
async function getChatCredentials(): Promise<ChatCredentialResponse> {
  const timestamp = Date.now();
  const query = `timestamp=${timestamp}`;
  const signature = sign(query);

  console.log('📡 Fetching chat credentials from SAPI...');

  const response = await fetch(
    `https://api.binance.com/sapi/v1/c2c/chat/retrieveChatCredential?${query}&signature=${signature}`,
    {
      headers: { 'X-MBX-APIKEY': API_KEY },
    }
  );

  const data = await response.json() as ChatCredentialResponse;
  console.log('Response:', JSON.stringify(data, null, 2));
  return data;
}

/**
 * Connect to WebSocket and send message
 */
async function connectAndSend(
  wssUrl: string,
  listenKey: string,
  listenToken: string,
  orderNo: string,
  message: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`\n🔌 Connecting to WebSocket: ${wssUrl}`);

    // Try different URL formats
    const urlsToTry = [
      wssUrl,
      `${wssUrl}?listenKey=${listenKey}`,
      `wss://chat.binance.com/chat?listenKey=${listenKey}`,
      `wss://stream.binance.com:9443/ws/${listenKey}`,
    ].filter(u => u); // Remove undefined

    let currentUrlIndex = 0;
    let ws: WebSocket | null = null;

    const tryConnect = () => {
      if (currentUrlIndex >= urlsToTry.length) {
        reject(new Error('All WebSocket URLs failed'));
        return;
      }

      const url = urlsToTry[currentUrlIndex];
      console.log(`\n🔄 Trying URL #${currentUrlIndex + 1}: ${url}`);

      ws = new WebSocket(url, {
        headers: {
          'Origin': 'https://p2p.binance.com',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      const timeout = setTimeout(() => {
        console.log('⏱️ Connection timeout, trying next URL...');
        ws?.close();
        currentUrlIndex++;
        tryConnect();
      }, 10000);

      ws.on('open', () => {
        clearTimeout(timeout);
        console.log('✅ WebSocket connected!');

        // Try authentication
        const authMessage = {
          method: 'SUBSCRIBE',
          params: [`chat@${orderNo}`],
          id: 1,
        };
        console.log('📤 Sending auth:', JSON.stringify(authMessage));
        ws!.send(JSON.stringify(authMessage));

        // Try sending message after a short delay
        setTimeout(() => {
          const chatMessage = {
            method: 'SEND_MESSAGE',
            params: {
              orderNo,
              content: message,
              msgType: 'TEXT',
            },
            id: 2,
          };
          console.log('📤 Sending message:', JSON.stringify(chatMessage));
          ws!.send(JSON.stringify(chatMessage));
        }, 2000);

        // Wait for response
        setTimeout(() => {
          console.log('\n⏱️ Closing connection after test...');
          ws!.close();
          resolve();
        }, 10000);
      });

      ws.on('message', (data) => {
        console.log('📥 Message received:', data.toString());
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        console.log(`❌ WebSocket error: ${error.message}`);
        currentUrlIndex++;
        tryConnect();
      });

      ws.on('close', (code, reason) => {
        console.log(`🔌 WebSocket closed: ${code} - ${reason}`);
      });
    };

    tryConnect();
  });
}

/**
 * Try direct P2P BAPI endpoints with signed request
 */
async function trySignedBapiEndpoint(orderNo: string, message: string): Promise<void> {
  console.log('\n📡 Trying signed BAPI endpoint...');

  const timestamp = Date.now();
  const body = {
    orderNo,
    content: message,
    msgType: 'TEXT',
  };

  const query = `timestamp=${timestamp}`;
  const signature = sign(query);

  const endpoints = [
    'https://api.binance.com/sapi/v1/c2c/chat/sendMessage',
    'https://api.binance.com/sapi/v2/c2c/chat/sendMessage',
  ];

  for (const endpoint of endpoints) {
    try {
      console.log(`\n🔄 Trying: ${endpoint}`);
      const response = await fetch(`${endpoint}?${query}&signature=${signature}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MBX-APIKEY': API_KEY,
        },
        body: JSON.stringify(body),
      });

      const text = await response.text();
      console.log(`  Status: ${response.status}`);
      console.log(`  Response: ${text}`);

      if (response.status === 200 && text.includes('000000')) {
        console.log('  ✅ SUCCESS!');
        return;
      }
    } catch (error: any) {
      console.log(`  ❌ Error: ${error.message}`);
    }
  }
}

/**
 * Try sending message via different message formats on WebSocket
 */
async function tryWebSocketMessageFormats(
  wssUrl: string,
  listenKey: string,
  orderNo: string,
  message: string
): Promise<void> {
  return new Promise((resolve) => {
    console.log(`\n🔌 Testing message formats on WebSocket...`);

    const url = `${wssUrl}?listenKey=${listenKey}`;
    console.log(`URL: ${url}`);

    const ws = new WebSocket(url, {
      headers: {
        'Origin': 'https://p2p.binance.com',
      },
    });

    ws.on('open', () => {
      console.log('✅ Connected!');

      // Try different message formats
      const messageFormats = [
        // Format 1: Binance User Data Stream style
        {
          e: 'chat_message',
          orderNo,
          content: message,
          msgType: 'TEXT',
        },
        // Format 2: Method-based
        {
          method: 'sendMessage',
          params: { orderNo, content: message, msgType: 'TEXT' },
          id: 1,
        },
        // Format 3: Action-based
        {
          action: 'sendMessage',
          data: { orderNo, content: message, msgType: 'TEXT' },
        },
        // Format 4: Simple
        {
          type: 'message',
          orderNo,
          content: message,
        },
      ];

      let index = 0;
      const sendNext = () => {
        if (index >= messageFormats.length) {
          setTimeout(() => {
            ws.close();
            resolve();
          }, 2000);
          return;
        }

        const msg = messageFormats[index];
        console.log(`\n📤 Format #${index + 1}:`, JSON.stringify(msg));
        ws.send(JSON.stringify(msg));
        index++;
        setTimeout(sendNext, 3000);
      };

      sendNext();
    });

    ws.on('message', (data) => {
      console.log('📥 Response:', data.toString());
    });

    ws.on('error', (error) => {
      console.log(`❌ Error: ${error.message}`);
      resolve();
    });

    ws.on('close', () => {
      console.log('🔌 Closed');
      resolve();
    });
  });
}

async function main() {
  const orderNo = process.argv[2] || '22846324542901170176';
  const testMessage = 'Gracias por tu confianza, quedamos al pendiente de futuras ordenes.';

  console.log('='.repeat(70));
  console.log('🔧 Binance P2P Chat WebSocket Test');
  console.log('='.repeat(70));
  console.log(`Order: ${orderNo}`);
  console.log(`Message: ${testMessage}`);
  console.log('='.repeat(70));

  try {
    // Step 1: Get credentials
    const creds = await getChatCredentials();

    if (creds.data?.listenKey) {
      console.log('\n✅ Got credentials:');
      console.log(`  listenKey: ${creds.data.listenKey.substring(0, 30)}...`);
      console.log(`  listenToken: ${creds.data.listenToken?.substring(0, 30) || 'N/A'}...`);
      console.log(`  chatWssUrl: ${creds.data.chatWssUrl || 'N/A'}`);

      // Step 2: Try WebSocket connection
      if (creds.data.chatWssUrl) {
        await tryWebSocketMessageFormats(
          creds.data.chatWssUrl,
          creds.data.listenKey,
          orderNo,
          testMessage
        );
      } else {
        console.log('\n⚠️ No chatWssUrl provided in credentials');

        // Try common WebSocket URLs
        const commonUrls = [
          'wss://stream.binance.com:9443/ws',
          'wss://chat.binance.com/ws',
          'wss://p2p.binance.com/bapi/c2c/v1/ws',
        ];

        for (const url of commonUrls) {
          try {
            await connectAndSend(
              url,
              creds.data.listenKey,
              creds.data.listenToken,
              orderNo,
              testMessage
            );
          } catch (e) {
            console.log(`Failed: ${url}`);
          }
        }
      }
    } else {
      console.log('\n❌ Failed to get chat credentials');
      console.log('Response:', JSON.stringify(creds, null, 2));
    }

    // Step 3: Also try signed BAPI endpoint
    await trySignedBapiEndpoint(orderNo, testMessage);

  } catch (error) {
    console.log('❌ Error:', error);
  }

  console.log('\n' + '='.repeat(70));
  console.log('Test complete');
  console.log('='.repeat(70));
}

main().catch(console.error);
