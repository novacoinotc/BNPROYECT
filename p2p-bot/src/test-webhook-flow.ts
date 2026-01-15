/**
 * Test: Full Webhook → Order Matching → Verification Flow
 *
 * Este script simula el flujo completo:
 * 1. Crea una orden de prueba en la DB
 * 2. Simula un pago bancario via webhook
 * 3. Verifica que el matching funcione correctamente
 * 4. Muestra los pasos de verificación registrados
 */
import * as dotenv from 'dotenv';
dotenv.config();

import * as db from './services/database-pg.js';
import { VerificationStatus, BankWebhookPayload } from './types/binance.js';

// Test data - use string status 'BUYER_PAYED' which maps to 'PAID' in DB
const TEST_ORDER = {
  orderNumber: 'TEST-' + Date.now(),
  advNo: process.env.BINANCE_ADV_NO || 'TEST-ADV-123',
  tradeType: 'SELL',
  asset: 'USDT',
  fiatUnit: 'MXN',
  unitPrice: '20.50',
  totalPrice: '2050.00', // 100 USDT * 20.50
  amount: '100.00',
  orderStatus: 'BUYER_PAYED', // String status - maps to 'PAID' in DB
  buyerNickName: 'Juan Pérez García',
  buyerRealName: 'JUAN PEREZ GARCIA', // Nombre real para matching
  sellerNickName: 'MerchantBot',
  createTime: Date.now(),
  counterPartNickName: 'Juan Pérez García', // Required for saveOrder
};

const TEST_PAYMENT: BankWebhookPayload = {
  transactionId: 'SPEI-' + Date.now(),
  amount: 2050.00, // Mismo monto que la orden
  currency: 'MXN',
  senderName: 'JUAN PEREZ GARCIA', // Nombre que viene del banco
  senderAccount: '123456789012345678',
  receiverAccount: '987654321098765432',
  concept: 'Pago USDT',
  timestamp: new Date().toISOString(),
  bankReference: 'REF' + Date.now(),
  status: 'completed',
};

async function runTest() {
  console.log('═'.repeat(70));
  console.log('🧪 TEST: WEBHOOK → ORDER MATCHING → VERIFICATION FLOW');
  console.log('═'.repeat(70));
  console.log();

  // Step 1: Create test order
  console.log('📝 STEP 1: Creating test order in database...');
  console.log('─'.repeat(50));

  try {
    await db.saveOrder(TEST_ORDER as any);
    console.log(`  ✅ Order created: ${TEST_ORDER.orderNumber}`);
    console.log(`     Amount: $${TEST_ORDER.totalPrice} MXN`);
    console.log(`     Buyer (nick): ${TEST_ORDER.buyerNickName}`);
    console.log(`     Buyer (real): ${TEST_ORDER.buyerRealName}`);
    console.log(`     Status: ${TEST_ORDER.orderStatus} → maps to 'PAID' in DB`);
  } catch (error: any) {
    console.log(`  ❌ Error creating order: ${error.message}`);
    return;
  }
  console.log();

  // Step 2: Add verification step - buyer marked paid
  console.log('📋 STEP 2: Adding initial verification step...');
  console.log('─'.repeat(50));

  try {
    await db.addVerificationStep(
      TEST_ORDER.orderNumber,
      VerificationStatus.BUYER_MARKED_PAID,
      'Comprador marcó como pagado - Esperando confirmación bancaria',
      {
        expectedAmount: TEST_ORDER.totalPrice,
        buyerName: TEST_ORDER.buyerNickName,
        timestamp: new Date().toISOString(),
      }
    );
    console.log('  ✅ Verification step added: BUYER_MARKED_PAID');
  } catch (error: any) {
    console.log(`  ❌ Error adding step: ${error.message}`);
  }
  console.log();

  // Step 3: Save bank payment (simulating webhook)
  console.log('💰 STEP 3: Simulating bank payment webhook...');
  console.log('─'.repeat(50));
  console.log(`  Transaction ID: ${TEST_PAYMENT.transactionId}`);
  console.log(`  Amount: $${TEST_PAYMENT.amount} MXN`);
  console.log(`  Sender: ${TEST_PAYMENT.senderName}`);

  try {
    await db.savePayment(TEST_PAYMENT);
    console.log('  ✅ Payment saved to database');
  } catch (error: any) {
    console.log(`  ❌ Error saving payment: ${error.message}`);
  }
  console.log();

  // Step 4: Find orders awaiting payment (bidirectional matching)
  console.log('🔍 STEP 4: Finding orders awaiting this payment...');
  console.log('─'.repeat(50));

  try {
    const awaitingOrders = await db.findOrdersAwaitingPayment(TEST_PAYMENT.amount, 1);
    console.log(`  Found ${awaitingOrders.length} order(s) awaiting payment of $${TEST_PAYMENT.amount}`);

    for (const order of awaitingOrders) {
      console.log();
      console.log(`  📦 Order: ${order.orderNumber}`);
      console.log(`     Expected: $${order.totalPrice}`);
      console.log(`     Buyer Nick: ${order.buyerNickName}`);
      console.log(`     Buyer Real: ${order.buyerRealName || '(not available)'}`);

      // Compare names
      const nameMatch = compareNames(TEST_PAYMENT.senderName, order.buyerRealName || order.buyerNickName);
      console.log(`     Name Match: ${(nameMatch * 100).toFixed(0)}%`);

      if (nameMatch > 0.3) {
        console.log('     ✅ MATCH FOUND!');
      }
    }
  } catch (error: any) {
    console.log(`  ❌ Error finding orders: ${error.message}`);
  }
  console.log();

  // Step 5: Match payment to order
  console.log('🔗 STEP 5: Matching payment to order...');
  console.log('─'.repeat(50));

  try {
    await db.matchPaymentToOrder(TEST_PAYMENT.transactionId, TEST_ORDER.orderNumber, 'BANK_WEBHOOK');
    console.log('  ✅ Payment matched to order');
  } catch (error: any) {
    console.log(`  ❌ Error matching: ${error.message}`);
  }
  console.log();

  // Step 6: Add verification steps
  console.log('📋 STEP 6: Adding verification steps...');
  console.log('─'.repeat(50));

  // Bank payment received
  await db.addVerificationStep(
    TEST_ORDER.orderNumber,
    VerificationStatus.BANK_PAYMENT_RECEIVED,
    `Pago bancario recibido de ${TEST_PAYMENT.senderName}`,
    {
      transactionId: TEST_PAYMENT.transactionId,
      receivedAmount: TEST_PAYMENT.amount,
      senderName: TEST_PAYMENT.senderName,
    }
  );
  console.log('  ✅ BANK_PAYMENT_RECEIVED');

  // Payment matched
  await db.addVerificationStep(
    TEST_ORDER.orderNumber,
    VerificationStatus.PAYMENT_MATCHED,
    'Pago vinculado a orden',
    {
      transactionId: TEST_PAYMENT.transactionId,
      matchType: 'test',
    }
  );
  console.log('  ✅ PAYMENT_MATCHED');

  // Amount verification
  const expectedAmount = parseFloat(TEST_ORDER.totalPrice);
  const amountDiff = Math.abs(TEST_PAYMENT.amount - expectedAmount);
  const amountMatches = amountDiff <= expectedAmount * 0.01;

  if (amountMatches) {
    await db.addVerificationStep(
      TEST_ORDER.orderNumber,
      VerificationStatus.AMOUNT_VERIFIED,
      `Monto verificado: $${TEST_PAYMENT.amount.toFixed(2)} ≈ $${expectedAmount.toFixed(2)}`,
      { receivedAmount: TEST_PAYMENT.amount, expectedAmount, difference: amountDiff }
    );
    console.log('  ✅ AMOUNT_VERIFIED');
  } else {
    await db.addVerificationStep(
      TEST_ORDER.orderNumber,
      VerificationStatus.AMOUNT_MISMATCH,
      `⚠️ Monto no coincide: $${TEST_PAYMENT.amount.toFixed(2)} vs $${expectedAmount.toFixed(2)}`,
      { receivedAmount: TEST_PAYMENT.amount, expectedAmount, difference: amountDiff }
    );
    console.log('  ⚠️ AMOUNT_MISMATCH');
  }

  // Name verification
  const nameMatch = compareNames(TEST_PAYMENT.senderName, TEST_ORDER.buyerRealName);
  const nameMatches = nameMatch > 0.3;

  if (nameMatches) {
    await db.addVerificationStep(
      TEST_ORDER.orderNumber,
      VerificationStatus.NAME_VERIFIED,
      `Nombre verificado: "${TEST_PAYMENT.senderName}" ≈ "${TEST_ORDER.buyerRealName}" (${(nameMatch * 100).toFixed(0)}%)`,
      { senderName: TEST_PAYMENT.senderName, buyerName: TEST_ORDER.buyerRealName, matchScore: nameMatch }
    );
    console.log('  ✅ NAME_VERIFIED');
  } else {
    await db.addVerificationStep(
      TEST_ORDER.orderNumber,
      VerificationStatus.NAME_MISMATCH,
      `⚠️ Nombre no coincide: "${TEST_PAYMENT.senderName}" vs "${TEST_ORDER.buyerRealName}" (${(nameMatch * 100).toFixed(0)}%)`,
      { senderName: TEST_PAYMENT.senderName, buyerName: TEST_ORDER.buyerRealName, matchScore: nameMatch }
    );
    console.log('  ⚠️ NAME_MISMATCH');
  }

  // Final verdict
  if (amountMatches && nameMatches) {
    await db.addVerificationStep(
      TEST_ORDER.orderNumber,
      VerificationStatus.READY_TO_RELEASE,
      '✅ VERIFICACIÓN COMPLETA - Todas las validaciones pasaron',
      { amountVerified: true, nameVerified: true, recommendation: 'RELEASE' }
    );
    console.log('  ✅ READY_TO_RELEASE');
  } else {
    await db.addVerificationStep(
      TEST_ORDER.orderNumber,
      VerificationStatus.MANUAL_REVIEW,
      `👤 REQUIERE REVISIÓN MANUAL - ${!amountMatches ? 'Monto no coincide' : ''} ${!nameMatches ? 'Nombre no coincide' : ''}`,
      { amountVerified: amountMatches, nameVerified: nameMatches, recommendation: 'MANUAL_REVIEW' }
    );
    console.log('  ⚠️ MANUAL_REVIEW required');
  }
  console.log();

  // Step 7: Show verification log
  console.log('📜 STEP 7: Verification log for this order...');
  console.log('─'.repeat(50));

  try {
    const steps = await db.getVerificationTimeline(TEST_ORDER.orderNumber);
    console.log(`  Total steps: ${steps.length}`);
    console.log();

    for (const step of steps) {
      const icon = step.status.includes('VERIFIED') || step.status === 'READY_TO_RELEASE' ? '✅' :
                   step.status.includes('MISMATCH') || step.status === 'MANUAL_REVIEW' ? '⚠️' : '📋';
      console.log(`  ${icon} ${step.status}`);
      console.log(`     ${step.message}`);
      console.log(`     Time: ${new Date(step.timestamp).toLocaleString()}`);
      console.log();
    }
  } catch (error: any) {
    console.log(`  ❌ Error getting steps: ${error.message}`);
  }

  // Summary
  console.log('═'.repeat(70));
  console.log('📊 TEST SUMMARY');
  console.log('═'.repeat(70));
  console.log(`  Order:        ${TEST_ORDER.orderNumber}`);
  console.log(`  Payment:      ${TEST_PAYMENT.transactionId}`);
  console.log(`  Amount Match: ${amountMatches ? '✅ YES' : '❌ NO'} ($${TEST_PAYMENT.amount} vs $${expectedAmount})`);
  console.log(`  Name Match:   ${nameMatches ? '✅ YES' : '❌ NO'} (${(nameMatch * 100).toFixed(0)}% similarity)`);
  console.log(`  Verdict:      ${amountMatches && nameMatches ? '✅ READY_TO_RELEASE' : '⚠️ MANUAL_REVIEW'}`);
  console.log('═'.repeat(70));

  // Cleanup info
  console.log();
  console.log('🧹 To clean up test data, run: npx prisma db push --force-reset');
  console.log();
}

// Name comparison function (same as in auto-release.ts)
function compareNames(name1: string, name2: string): number {
  if (!name1 || !name2) return 0;

  const normalize = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
  const n1 = normalize(name1);
  const n2 = normalize(name2);

  if (n1 === n2) return 1;

  // Check if one contains the other
  if (n1.includes(n2) || n2.includes(n1)) return 0.8;

  // Check word overlap
  const words1 = new Set(n1.split(/\s+/).filter(w => w.length > 2));
  const words2 = new Set(n2.split(/\s+/).filter(w => w.length > 2));

  let matches = 0;
  for (const word of words1) {
    if (words2.has(word)) matches++;
  }

  const totalWords = Math.max(words1.size, words2.size);
  return totalWords > 0 ? matches / totalWords : 0;
}

runTest().catch(console.error);
