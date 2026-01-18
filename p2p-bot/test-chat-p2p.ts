/**
 * Test P2P domain for chat API (p2p.binance.com)
 * This is where searchAds works, maybe chat too
 */

import 'dotenv/config';

const orderNo = process.argv[2] || '22846324542901170176';
const testMessage = 'Test - ignore';

async function testP2PEndpoint(
  endpoint: string,
  body: Record<string, any>
): Promise<void> {
  console.log(`\n📡 Testing: ${endpoint}`);
  console.log(`   Body: ${JSON.stringify(body)}`);

  try {
    const response = await fetch(`https://p2p.binance.com${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://p2p.binance.com',
        'Referer': 'https://p2p.binance.com/',
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`   Status: ${response.status}`);
    console.log(`   Response: ${text.substring(0, 500)}`);

    if (text.includes('000000') || text.includes('success')) {
      console.log('   ✅ POSSIBLE SUCCESS!');
    }
  } catch (error: any) {
    console.log(`   ❌ Error: ${error.message}`);
  }
}

async function main() {
  console.log(`\n🔍 Testing P2P Chat API with order: ${orderNo}\n`);
  console.log('='.repeat(60));

  // P2P API endpoints to try
  const endpoints = [
    '/bapi/c2c/v1/friendly/c2c/chat/sendMessage',
    '/bapi/c2c/v2/friendly/c2c/chat/sendMessage',
    '/bapi/c2c/v1/private/c2c/chat/sendMessage',
    '/bapi/c2c/v2/private/c2c/chat/sendMessage',
    '/bapi/c2c/v1/c2c/chat/sendMessage',
    '/bapi/c2c/v1/friendly/c2c/chat/message/send',
  ];

  const bodies = [
    { orderNo, content: testMessage, msgType: 'TEXT' },
    { orderNo, message: testMessage, msgType: 'TEXT' },
    { orderNumber: orderNo, content: testMessage, msgType: 'TEXT' },
  ];

  for (const endpoint of endpoints) {
    for (const body of bodies) {
      await testP2PEndpoint(endpoint, body);
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('\n📝 Si ninguno funciona, necesitas:');
  console.log('1. Abrir Binance P2P en browser');
  console.log('2. Abrir DevTools > Network');
  console.log('3. Enviar un mensaje manualmente');
  console.log('4. Copiar el request que se hace\n');
}

main().catch(console.error);
