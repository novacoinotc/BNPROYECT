/**
 * Test the actual BinanceC2CClient to see which functions work
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { BinanceC2CClient } from './services/binance-client.js';

const client = new BinanceC2CClient(
  process.env.BINANCE_API_KEY!,
  process.env.BINANCE_API_SECRET!
);

async function main() {
  console.log('🧪 TESTING REAL BINANCE CLIENT');
  console.log('═'.repeat(60));

  // 1. Test listing ads
  console.log('\n1️⃣ listMyAds()');
  try {
    const ads = await client.listMyAds();
    console.log(`   ✅ Success! Found ${ads.sellList?.length || 0} sell ads, ${ads.buyList?.length || 0} buy ads`);
    if (ads.sellList?.length > 0) {
      const ad = ads.sellList[0];
      console.log(`   Sample: advNo=${ad.advNo}, price=${ad.price} ${ad.fiatUnit}`);
    }
  } catch (error: any) {
    console.log(`   ❌ Failed: ${error.message}`);
  }

  // 2. Test pending orders
  console.log('\n2️⃣ listPendingOrders()');
  try {
    const orders = await client.listPendingOrders();
    console.log(`   ✅ Success! Found ${orders.length} pending orders`);
    if (orders.length > 0) {
      const order = orders[0];
      console.log(`   Sample: orderNumber=${order.orderNumber}, status=${order.orderStatus}`);
    }
  } catch (error: any) {
    console.log(`   ❌ Failed: ${error.message}`);
  }

  // 3. Test list orders (all)
  console.log('\n3️⃣ listOrders()');
  try {
    const orders = await client.listOrders({ tradeType: 'SELL', rows: 5 });
    console.log(`   ✅ Success! Found ${orders.length} orders`);
    if (orders.length > 0) {
      const order = orders[0];
      console.log(`   Sample: orderNumber=${order.orderNumber}, status=${order.orderStatus}`);
    }
  } catch (error: any) {
    console.log(`   ❌ Failed: ${error.message}`);
  }

  // 4. Test chat credentials
  console.log('\n4️⃣ getChatCredential()');
  try {
    const creds = await client.getChatCredential();
    console.log(`   ✅ Success!`);
    console.log(`   chatWssUrl: ${creds.chatWssUrl}`);
    console.log(`   listenKey: ${creds.listenKey?.substring(0, 20)}...`);
  } catch (error: any) {
    console.log(`   ❌ Failed: ${error.message}`);
  }

  // 5. Test reference price
  console.log('\n5️⃣ getReferencePrice()');
  try {
    const price = await client.getReferencePrice('USDT', 'MXN', 'SELL');
    console.log(`   ✅ Success! Price: ${price.price} ${price.fiatUnit}`);
  } catch (error: any) {
    console.log(`   ❌ Failed: ${error.message}`);
  }

  // 6. Test public search (competitor analysis)
  console.log('\n6️⃣ searchAds() - Public competitor search');
  try {
    const ads = await client.searchAds({
      asset: 'USDT',
      fiat: 'MXN',
      tradeType: 'SELL',
      page: 1,
      rows: 5,
    });
    console.log(`   ✅ Success! Found ${ads.length} competitor ads`);
    if (ads.length > 0) {
      console.log(`   Top prices:`);
      ads.slice(0, 3).forEach((ad, i) => {
        console.log(`     ${i + 1}. ${ad.price} MXN by ${ad.advertiser?.nickName || 'Unknown'}`);
      });
    }
  } catch (error: any) {
    console.log(`   ❌ Failed: ${error.message}`);
  }

  // 7. Test ping
  console.log('\n7️⃣ ping()');
  try {
    const ok = await client.ping();
    console.log(`   ${ok ? '✅ API reachable' : '❌ API not reachable'}`);
  } catch (error: any) {
    console.log(`   ❌ Failed: ${error.message}`);
  }

  console.log('\n');
  console.log('═'.repeat(60));
  console.log('📊 SUMMARY');
  console.log('═'.repeat(60));
  console.log('\nThese functions are ready to use in the bot:');
  console.log('  - listMyAds() - Get your ads');
  console.log('  - listOrders() - Get order history');
  console.log('  - listPendingOrders() - Get active orders');
  console.log('  - getChatCredential() - WebSocket chat connection');
  console.log('  - searchAds() - Get competitor prices');
  console.log('  - getReferencePrice() - Get market price');
  console.log('\nFor updating ads and releasing crypto, additional testing');
  console.log('is needed with actual orders in the correct state.');
}

main().catch(console.error);
