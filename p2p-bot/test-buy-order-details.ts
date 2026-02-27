/**
 * TEST: Explore BUY order data from Binance API
 * Purpose: See what payment/bank details the API returns for BUY orders
 *
 * This script:
 * 1. Lists pending BUY orders (if any)
 * 2. Lists recent BUY order history
 * 3. Gets raw order detail for each to inspect payment fields
 *
 * Run: npx tsx test-buy-order-details.ts
 */

import 'dotenv/config';
import { getBinanceClient } from './src/services/binance-client.js';

async function main() {
  const client = getBinanceClient();

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║        EXPLORE BUY ORDER DATA - RAW API RESPONSE        ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // ===== 1. List pending BUY orders =====
  console.log('━'.repeat(60));
  console.log('1. PENDING BUY ORDERS (listOrders tradeType=BUY)');
  console.log('━'.repeat(60));

  try {
    // Use signedPost directly to get raw response
    const pendingResponse = await (client as any).signedPost(
      '/sapi/v1/c2c/orderMatch/listOrders',
      {
        tradeType: 'BUY',
        rows: 10,
        page: 1,
        orderStatusList: [1, 2, 3], // TRADING, BUYER_PAYED, APPEALING
      }
    );

    const pendingOrders = (pendingResponse as any)?.data || pendingResponse || [];
    console.log(`\nFound ${Array.isArray(pendingOrders) ? pendingOrders.length : 0} pending BUY orders\n`);

    if (Array.isArray(pendingOrders) && pendingOrders.length > 0) {
      for (const order of pendingOrders) {
        console.log(`--- Order ${order.orderNumber || order.adOrderNo} ---`);
        console.log(JSON.stringify(order, null, 2));
        console.log('');
      }
    }
  } catch (error: any) {
    console.log(`Error listing pending BUY orders: ${error.message}`);
  }

  // ===== 2. BUY order history =====
  console.log('\n' + '━'.repeat(60));
  console.log('2. RECENT BUY ORDER HISTORY');
  console.log('━'.repeat(60));

  let historyOrders: any[] = [];
  try {
    const historyResponse = await (client as any).signedGet(
      '/sapi/v1/c2c/orderMatch/listUserOrderHistory',
      {
        tradeType: 'BUY',
        rows: 5,
        page: 1,
      }
    );

    historyOrders = (historyResponse as any)?.data || historyResponse || [];
    console.log(`\nFound ${Array.isArray(historyOrders) ? historyOrders.length : 0} recent BUY orders\n`);

    if (Array.isArray(historyOrders) && historyOrders.length > 0) {
      for (const order of historyOrders) {
        console.log(`--- Order ${order.orderNumber || order.adOrderNo} ---`);
        console.log(JSON.stringify(order, null, 2));
        console.log('');
      }
    } else {
      console.log('No BUY order history found.');
      console.log('(Have you ever placed a BUY order on Binance P2P?)\n');
    }
  } catch (error: any) {
    console.log(`Error listing BUY history: ${error.message}`);
  }

  // ===== 3. Get detailed order info =====
  // Try to get detail for any order found above
  const allOrders = [...(Array.isArray(historyOrders) ? historyOrders : [])];

  if (allOrders.length > 0) {
    console.log('\n' + '━'.repeat(60));
    console.log('3. FULL ORDER DETAIL (getUserOrderDetail)');
    console.log('━'.repeat(60));

    // Get detail for the first order
    const orderNo = allOrders[0].orderNumber || allOrders[0].adOrderNo;
    console.log(`\nFetching detail for order: ${orderNo}\n`);

    try {
      // Get RAW response (not normalized) to see ALL fields
      const rawDetail = await (client as any).signedPost(
        '/sapi/v1/c2c/orderMatch/getUserOrderDetail',
        { adOrderNo: orderNo }
      );

      console.log('=== RAW ORDER DETAIL RESPONSE ===');
      console.log(JSON.stringify(rawDetail, null, 2));

      // Highlight payment-related fields
      console.log('\n=== PAYMENT-RELATED FIELDS ===');
      const raw = rawDetail as any;
      console.log(`payMethodName: ${raw.payMethodName || 'N/A'}`);
      console.log(`payMethods: ${JSON.stringify(raw.payMethods || raw.tradeMethodList || 'N/A', null, 2)}`);
      console.log(`sellerName: ${raw.sellerName || 'N/A'}`);
      console.log(`sellerNickname: ${raw.sellerNickname || 'N/A'}`);
      console.log(`buyerName: ${raw.buyerName || 'N/A'}`);
      console.log(`buyerNickname: ${raw.buyerNickname || 'N/A'}`);
      console.log(`makerPayMethodList: ${JSON.stringify(raw.makerPayMethodList || 'N/A', null, 2)}`);
      console.log(`takerPayMethodList: ${JSON.stringify(raw.takerPayMethodList || 'N/A', null, 2)}`);
      console.log(`payType: ${raw.payType || 'N/A'}`);
      console.log(`payAccount: ${raw.payAccount || 'N/A'}`);
      console.log(`payBank: ${raw.payBank || 'N/A'}`);
      console.log(`confirmPayEndTime: ${raw.confirmPayEndTime || 'N/A'}`);
      console.log(`notifyPayEndTime: ${raw.notifyPayEndTime || 'N/A'}`);

    } catch (error: any) {
      console.log(`Error getting order detail: ${error.message}`);
    }
  } else {
    console.log('\n⚠️  No BUY orders found to inspect.');
    console.log('To test this, place a small BUY order on Binance P2P and run again.\n');
  }

  // ===== 4. Also check SELL history for comparison =====
  console.log('\n' + '━'.repeat(60));
  console.log('4. COMPARISON: SELL ORDER DETAIL (to compare fields)');
  console.log('━'.repeat(60));

  try {
    const sellHistory = await (client as any).signedGet(
      '/sapi/v1/c2c/orderMatch/listUserOrderHistory',
      { tradeType: 'SELL', rows: 1, page: 1 }
    );

    const sellOrders = (sellHistory as any)?.data || sellHistory || [];
    if (Array.isArray(sellOrders) && sellOrders.length > 0) {
      const sellOrderNo = sellOrders[0].orderNumber || sellOrders[0].adOrderNo;
      console.log(`\nFetching SELL order detail for comparison: ${sellOrderNo}\n`);

      const rawSellDetail = await (client as any).signedPost(
        '/sapi/v1/c2c/orderMatch/getUserOrderDetail',
        { adOrderNo: sellOrderNo }
      );

      console.log('=== RAW SELL ORDER DETAIL (for comparison) ===');
      console.log(JSON.stringify(rawSellDetail, null, 2));
    }
  } catch (error: any) {
    console.log(`Error: ${error.message}`);
  }

  console.log('\n' + '━'.repeat(60));
  console.log('DONE');
  console.log('━'.repeat(60));
}

main().catch(console.error);
