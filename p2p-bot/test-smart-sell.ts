/**
 * TEST: Smart Mode for SELL ads
 * Verifies that Smart mode correctly identifies qualified competitors
 * and calculates the target price for SELL ads.
 *
 * Run: npx tsx test-smart-sell.ts
 */

import 'dotenv/config';

interface AdData {
  adv: {
    advNo: string;
    price: string;
    surplusAmount: string;
    tradeType: string;
    asset: string;
  };
  advertiser: {
    nickName: string;
    monthOrderCount?: number;
    monthFinishRate?: number;
    positiveRate?: number;
    userGrade?: number;
  };
}

const MY_NICKNAME = process.env.BINANCE_MY_NICKNAME || 'QuantumCash';
const ASSETS_TO_TEST = ['USDT', 'BTC', 'ETH', 'BNB', 'USDC'];
const FIAT = 'MXN';

// Config (from database defaults)
const MIN_MONTH_ORDER_COUNT = 10;
const MIN_SURPLUS_FIAT_VALUE = 1; // Changed to 1 since we calculate fiat value
const UNDERCUT_CENTS = 1;
const MATCH_PRICE = false;

async function searchAds(asset: string, fiat: string, tradeType: 'BUY' | 'SELL'): Promise<AdData[]> {
  const body = {
    fiat,
    page: 1,
    rows: 20,
    tradeType,
    asset,
    countries: [],
    proMerchantAds: false,
    shieldMerchantAds: false,
    filterType: 'all',
    periods: [],
    additionalKycVerifyFilter: 0,
    payTypes: [],
  };

  const response = await fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': 'https://p2p.binance.com',
      'Referer': 'https://p2p.binance.com/',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json() as { code?: string; data?: AdData[] };
  return data.data || [];
}

function passesFilters(ad: AdData): boolean {
  const monthOrders = ad.advertiser.monthOrderCount ?? 0;
  const price = parseFloat(ad.adv.price);
  const surplusAmount = parseFloat(ad.adv.surplusAmount);
  const fiatValue = price * surplusAmount;

  // Filter 1: Minimum orders
  if (monthOrders < MIN_MONTH_ORDER_COUNT) return false;

  // Filter 2: Minimum fiat value available
  if (fiatValue < MIN_SURPLUS_FIAT_VALUE) return false;

  return true;
}

async function testSmartSell(asset: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SMART SELL TEST: ${asset}/${FIAT}`);
  console.log(`${'='.repeat(60)}`);

  // For SELL ad, we search with tradeType=BUY to find other sellers
  // (From client perspective: "I want to buy" shows SELL ads from sellers)
  console.log(`\nSearching with tradeType=BUY (finds SELL ads from other sellers)...`);

  const ads = await searchAds(asset, FIAT, 'BUY');

  if (ads.length === 0) {
    console.log(`❌ No ads found for ${asset}/${FIAT}`);
    return;
  }

  console.log(`Found ${ads.length} ads total\n`);

  // Filter out our own ads and apply quality filters
  const qualifiedAds: AdData[] = [];
  const excludedOwn: AdData[] = [];
  const excludedFilters: AdData[] = [];

  for (const ad of ads) {
    // Check if it's our own ad
    if (ad.advertiser.nickName === MY_NICKNAME) {
      excludedOwn.push(ad);
      continue;
    }

    // Apply quality filters
    if (passesFilters(ad)) {
      qualifiedAds.push(ad);
    } else {
      excludedFilters.push(ad);
    }
  }

  console.log(`Results:`);
  console.log(`  ✅ Qualified competitors: ${qualifiedAds.length}`);
  console.log(`  🚫 Excluded (our ads): ${excludedOwn.length}`);
  console.log(`  ❌ Excluded (filters): ${excludedFilters.length}`);

  // Show our own ads if found
  if (excludedOwn.length > 0) {
    console.log(`\n📍 OUR ADS FOUND:`);
    for (const ad of excludedOwn) {
      console.log(`   ${ad.advertiser.nickName} @ $${parseFloat(ad.adv.price).toFixed(2)}`);
    }
  }

  // Show qualified competitors
  if (qualifiedAds.length > 0) {
    // Sort by price (SELL ads: lowest first since we want to beat them by going lower)
    qualifiedAds.sort((a, b) => parseFloat(a.adv.price) - parseFloat(b.adv.price));

    console.log(`\n✅ QUALIFIED COMPETITORS (sorted by price):`);
    for (let i = 0; i < Math.min(5, qualifiedAds.length); i++) {
      const ad = qualifiedAds[i];
      const price = parseFloat(ad.adv.price);
      const surplus = parseFloat(ad.adv.surplusAmount);
      const fiatValue = price * surplus;
      console.log(`   #${i + 1} ${ad.advertiser.nickName}`);
      console.log(`      Price: $${price.toFixed(2)} | Orders: ${ad.advertiser.monthOrderCount} | FiatValue: $${fiatValue.toFixed(2)}`);
    }

    // Calculate target price
    const bestPrice = parseFloat(qualifiedAds[0].adv.price);
    let targetPrice: number;

    if (MATCH_PRICE) {
      targetPrice = bestPrice;
    } else {
      // SELL ad: go LOWER to attract buyers
      targetPrice = bestPrice - (UNDERCUT_CENTS / 100);
    }
    targetPrice = Math.round(targetPrice * 100) / 100;

    console.log(`\n🎯 TARGET PRICE CALCULATION:`);
    console.log(`   Best competitor: $${bestPrice.toFixed(2)}`);
    console.log(`   Strategy: ${MATCH_PRICE ? 'Match' : `Undercut by $${(UNDERCUT_CENTS / 100).toFixed(2)}`}`);
    console.log(`   ➡️  Target price: $${targetPrice.toFixed(2)}`);

    // Compare with our current price
    if (excludedOwn.length > 0) {
      const ourPrice = parseFloat(excludedOwn[0].adv.price);
      const diff = Math.abs(ourPrice - targetPrice);
      console.log(`\n📊 COMPARISON WITH OUR CURRENT PRICE:`);
      console.log(`   Our price: $${ourPrice.toFixed(2)}`);
      console.log(`   Target: $${targetPrice.toFixed(2)}`);
      console.log(`   Difference: $${diff.toFixed(2)}`);
      if (diff < 0.01) {
        console.log(`   ✓ No update needed (diff < $0.01)`);
      } else {
        console.log(`   ⚠️ UPDATE NEEDED`);
      }
    }
  } else {
    console.log(`\n⚠️ NO QUALIFIED COMPETITORS - would use best available price`);
    if (ads.length > 0) {
      const bestPrice = parseFloat(ads[0].adv.price);
      console.log(`   Best available: $${bestPrice.toFixed(2)}`);
    }
  }

  // Show why ads were excluded
  if (excludedFilters.length > 0) {
    console.log(`\n❌ EXCLUDED BY FILTERS (first 3):`);
    for (let i = 0; i < Math.min(3, excludedFilters.length); i++) {
      const ad = excludedFilters[i];
      const price = parseFloat(ad.adv.price);
      const surplus = parseFloat(ad.adv.surplusAmount);
      const fiatValue = price * surplus;
      const orders = ad.advertiser.monthOrderCount ?? 0;

      const reasons: string[] = [];
      if (orders < MIN_MONTH_ORDER_COUNT) reasons.push(`orders=${orders} < ${MIN_MONTH_ORDER_COUNT}`);
      if (fiatValue < MIN_SURPLUS_FIAT_VALUE) reasons.push(`fiatValue=${fiatValue.toFixed(2)} < ${MIN_SURPLUS_FIAT_VALUE}`);

      console.log(`   ${ad.advertiser.nickName} @ $${price.toFixed(2)}: ${reasons.join(', ')}`);
    }
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           SMART MODE SELL - COMPREHENSIVE TEST             ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`\nConfig:`);
  console.log(`  MY_NICKNAME: ${MY_NICKNAME}`);
  console.log(`  MIN_MONTH_ORDER_COUNT: ${MIN_MONTH_ORDER_COUNT}`);
  console.log(`  MIN_SURPLUS_FIAT_VALUE: ${MIN_SURPLUS_FIAT_VALUE}`);
  console.log(`  UNDERCUT_CENTS: ${UNDERCUT_CENTS}`);
  console.log(`  MATCH_PRICE: ${MATCH_PRICE}`);

  for (const asset of ASSETS_TO_TEST) {
    await testSmartSell(asset);
    await new Promise(r => setTimeout(r, 500)); // Rate limit
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('TEST COMPLETE');
  console.log(`${'='.repeat(60)}\n`);
}

main().catch(console.error);
