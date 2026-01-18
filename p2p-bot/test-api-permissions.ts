// Test API with reduced permissions
import 'dotenv/config';
import crypto from 'crypto';

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';

function sign(query: string): string {
  return crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

async function testAPI() {
  console.log('Testing Binance C2C API with reduced permissions...\n');

  // 1. List ads
  console.log('1. Listing ALL ads...');
  const ts1 = Date.now();
  const query1 = `timestamp=${ts1}`;

  const listRes = await fetch(
    `https://api.binance.com/sapi/v1/c2c/ads/listWithPagination?${query1}&signature=${sign(query1)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MBX-APIKEY': API_KEY },
      body: JSON.stringify({ page: 1, rows: 50 }),
    }
  );

  const listData = await listRes.json() as any;

  if (!listData.data) {
    console.log('FAILED to list ads:', listData);
    return;
  }

  // Handle different response formats
  let allAds: any[] = [];
  if (Array.isArray(listData.data)) {
    allAds = listData.data;
  } else if (listData.data.sellList || listData.data.buyList) {
    allAds = [...(listData.data.sellList || []), ...(listData.data.buyList || [])];
  }

  console.log(`Total ads found: ${allAds.length}`);
  console.log('\nAll ads:');

  for (const ad of allAds) {
    // advStatus: 1=online, 2=?, 3=paused, 4=offline
    const statusMap: Record<number, string> = {
      1: 'ONLINE',
      2: 'pending',
      3: 'paused',
      4: 'offline'
    };
    const status = statusMap[ad.advStatus] || `status-${ad.advStatus}`;
    console.log(`  - ${ad.tradeType} ${ad.asset}/${ad.fiatUnit} @ ${ad.price} [${status}] (${ad.advNo.slice(-8)})`);
  }

  const activeAd = allAds.find((ad: any) => ad.advStatus === 1);

  if (!activeAd) {
    console.log('\n⚠️  No ONLINE ads found (advStatus=1)');
    console.log('Please activate an ad in Binance P2P first, then run this test again.');

    // Try to update a paused ad anyway to test permissions
    const pausedAd = allAds.find((ad: any) => ad.advStatus === 3);
    if (pausedAd) {
      console.log('\n2. Testing price update on PAUSED ad...');
      const currentPrice = parseFloat(pausedAd.price);
      const testPrice = Math.round(currentPrice * 100) / 100;

      const ts2 = Date.now();
      const query2 = `timestamp=${ts2}`;

      const updateRes = await fetch(
        `https://api.binance.com/sapi/v1/c2c/ads/update?${query2}&signature=${sign(query2)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-MBX-APIKEY': API_KEY },
          body: JSON.stringify({ advNo: pausedAd.advNo, price: testPrice }),
        }
      );

      const updateData = await updateRes.json() as any;
      console.log('Update response:', updateData);

      if (updateData.success === true || updateData.code === '000000') {
        console.log('\n✅ SUCCESS! API works with reduced permissions');
      } else {
        console.log('\n❌ FAILED:', updateData.message || updateData);
      }
    }
    return;
  }

  // 2. Update price on active ad
  console.log('\n2. Testing price update on ONLINE ad...');
  const currentPrice = parseFloat(activeAd.price);
  const testPrice = Math.round(currentPrice * 100) / 100;

  const ts2 = Date.now();
  const query2 = `timestamp=${ts2}`;

  const updateRes = await fetch(
    `https://api.binance.com/sapi/v1/c2c/ads/update?${query2}&signature=${sign(query2)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MBX-APIKEY': API_KEY },
      body: JSON.stringify({ advNo: activeAd.advNo, price: testPrice }),
    }
  );

  const updateData = await updateRes.json() as any;

  if (updateData.success === true || updateData.code === '000000') {
    console.log('✅ SUCCESS! API works with reduced permissions');
  } else {
    console.log('❌ FAILED:', updateData);
  }
}

testAPI().catch(console.error);
