/**
 * Test auto-reply configuration endpoints
 *
 * Binance P2P has a built-in auto-reply feature (we saw it in chat messages)
 * Let's see if we can configure it via API
 */

import crypto from 'crypto';
import 'dotenv/config';

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';

function sign(query: string): string {
  return crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

async function testAutoReplyEndpoints(): Promise<void> {
  console.log('='.repeat(60));
  console.log('🔧 Testing Auto-Reply Configuration Endpoints');
  console.log('='.repeat(60));

  // SAPI endpoints to test
  const sapiEndpoints = [
    { method: 'GET', path: '/sapi/v1/c2c/chat/autoReply' },
    { method: 'GET', path: '/sapi/v1/c2c/chat/getAutoReply' },
    { method: 'GET', path: '/sapi/v1/c2c/merchant/autoReplyConfig' },
    { method: 'GET', path: '/sapi/v1/c2c/merchant/config' },
    { method: 'GET', path: '/sapi/v1/c2c/ads/autoReply' },
  ];

  for (const { method, path } of sapiEndpoints) {
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = sign(query);

    try {
      console.log(`\n${method} ${path}`);
      const response = await fetch(
        `https://api.binance.com${path}?${query}&signature=${signature}`,
        {
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-MBX-APIKEY': API_KEY,
          },
        }
      );

      const text = await response.text();
      console.log(`  Status: ${response.status}`);
      console.log(`  Response: ${text.substring(0, 300)}`);

      if (text.includes('autoReply') || text.includes('message')) {
        console.log('  ✅ FOUND AUTO-REPLY CONFIG!');
      }
    } catch (error: any) {
      console.log(`  ❌ Error: ${error.message}`);
    }
    await sleep(300);
  }

  // P2P BAPI endpoints
  console.log('\n' + '='.repeat(60));
  console.log('Testing P2P BAPI endpoints');
  console.log('='.repeat(60));

  const bapiEndpoints = [
    { method: 'GET', path: '/bapi/c2c/v1/friendly/c2c/chat/auto-reply/config' },
    { method: 'GET', path: '/bapi/c2c/v1/friendly/c2c/merchant/auto-reply' },
    { method: 'POST', path: '/bapi/c2c/v1/friendly/c2c/chat/auto-reply/get' },
    { method: 'POST', path: '/bapi/c2c/v1/friendly/c2c/user-center/get-reply-config' },
  ];

  for (const { method, path } of bapiEndpoints) {
    try {
      console.log(`\n${method} ${path}`);
      const response = await fetch(`https://p2p.binance.com${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-MBX-APIKEY': API_KEY,
          'Origin': 'https://p2p.binance.com',
          'Referer': 'https://p2p.binance.com/',
        },
        body: method === 'POST' ? JSON.stringify({}) : undefined,
      });

      const text = await response.text();
      console.log(`  Status: ${response.status}`);
      console.log(`  Response: ${text.substring(0, 300)}`);
    } catch (error: any) {
      console.log(`  ❌ Error: ${error.message}`);
    }
    await sleep(300);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  await testAutoReplyEndpoints();

  console.log('\n' + '='.repeat(60));
  console.log('📋 RECOMMENDATION');
  console.log('='.repeat(60));
  console.log(`
Binance P2P has a built-in Auto-Reply feature that sends automatic
messages when orders are created.

To configure your thank you message:
1. Go to Binance P2P → User Center → Settings
2. Look for "Auto Reply" or "Quick Messages"
3. Configure your greeting/thank you message

The message we saw in chat history was:
"✨ ¡Hola! Gracias por elegir QuantumCash..."

This is the proper way to send automatic messages in Binance P2P.
`);
}

main().catch(console.error);
