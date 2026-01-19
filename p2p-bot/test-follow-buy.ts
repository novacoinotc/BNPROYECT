/**
 * TEST: Follow Mode for BUY ads
 * Verifies that Follow mode correctly finds a target competitor
 * and calculates the target price for BUY ads.
 *
 * Run: npx tsx test-follow-buy.ts
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

// Test targets - adjust these based on real competitors in the market
const TEST_TARGETS: Record<string, string> = {
  'USDT': '-Lady_Lee-', // Example target for BUY
  'BTC': '-Lady_Lee-',
  'ETH': '-Lady_Lee-',
  'BNB': '-Lady_Lee-',
  'USDC': '-Lady_Lee-',
};

const FIAT = 'MXN';
const UNDERCUT_CENTS = 1;
const MATCH_PRICE = false;

async function searchAds(asset: string, fiat: string, tradeType: 'BUY' | 'SELL', page: number = 1): Promise<AdData[]> {
  const body = {
    fiat,
    page,
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

async function findTarget(asset: string, targetNickName: string): Promise<AdData | null> {
  // Search multiple pages to find target
  // For BUY ad, search with tradeType=SELL to find other buyers
  for (let page = 1; page <= 3; page++) {
    const ads = await searchAds(asset, FIAT, 'SELL', page);

    if (ads.length === 0) break;

    // Find target by nickname (case insensitive)
    const found = ads.find(ad =>
      ad.advertiser.nickName.toLowerCase() === targetNickName.toLowerCase()
    );

    if (found) {
      return found;
    }

    console.log(`   Page ${page}: ${ads.length} ads, target not found`);
    await new Promise(r => setTimeout(r, 300)); // Rate limit
  }

  return null;
}

async function testFollowBuy(asset: string, targetNickName: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`FOLLOW BUY TEST: ${asset}/${FIAT}`);
  console.log(`Target: ${targetNickName}`);
  console.log(`${'='.repeat(60)}`);

  console.log(`\nSearching for target "${targetNickName}"...`);

  const targetAd = await findTarget(asset, targetNickName);

  if (!targetAd) {
    console.log(`\n❌ TARGET NOT FOUND: "${targetNickName}"`);
    console.log(`   This is why Follow mode falls back to Smart mode!`);
    console.log(`\n   Possible reasons:`);
    console.log(`   1. Target nickname is wrong or has typos`);
    console.log(`   2. Target's ad is offline`);
    console.log(`   3. Target doesn't have a BUY ad for ${asset}`);
    console.log(`   4. Target is beyond page 3 in the results`);

    // Show who IS in the market
    console.log(`\n   Top 5 buyers in ${asset}/${FIAT}:`);
    const topAds = await searchAds(asset, FIAT, 'SELL');
    for (let i = 0; i < Math.min(5, topAds.length); i++) {
      const ad = topAds[i];
      console.log(`      ${i + 1}. ${ad.advertiser.nickName} @ $${parseFloat(ad.adv.price).toFixed(2)}`);
    }
    return;
  }

  const targetPrice = parseFloat(targetAd.adv.price);
  console.log(`\n✅ TARGET FOUND:`);
  console.log(`   NickName: ${targetAd.advertiser.nickName}`);
  console.log(`   Price: $${targetPrice.toFixed(2)}`);
  console.log(`   Available: ${parseFloat(targetAd.adv.surplusAmount).toFixed(4)} ${asset}`);
  console.log(`   Orders: ${targetAd.advertiser.monthOrderCount}`);

  // Calculate our target price
  let ourTargetPrice: number;
  if (MATCH_PRICE) {
    ourTargetPrice = targetPrice;
  } else {
    // BUY ad: go HIGHER to attract sellers
    ourTargetPrice = targetPrice + (UNDERCUT_CENTS / 100);
  }
  ourTargetPrice = Math.round(ourTargetPrice * 100) / 100;

  console.log(`\n🎯 TARGET PRICE CALCULATION:`);
  console.log(`   Target's price: $${targetPrice.toFixed(2)}`);
  console.log(`   Strategy: ${MATCH_PRICE ? 'Match exactly' : `Overcut by +$${(UNDERCUT_CENTS / 100).toFixed(2)}`}`);
  console.log(`   ➡️  Our target price: $${ourTargetPrice.toFixed(2)}`);
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║            FOLLOW MODE BUY - COMPREHENSIVE TEST            ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`\nConfig:`);
  console.log(`  UNDERCUT_CENTS: ${UNDERCUT_CENTS} (means +$0.01 for BUY)`);
  console.log(`  MATCH_PRICE: ${MATCH_PRICE}`);
  console.log(`\nTest Targets:`);
  for (const [asset, target] of Object.entries(TEST_TARGETS)) {
    console.log(`  ${asset}: ${target}`);
  }

  for (const [asset, target] of Object.entries(TEST_TARGETS)) {
    await testFollowBuy(asset, target);
    await new Promise(r => setTimeout(r, 500)); // Rate limit
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('TEST COMPLETE');
  console.log(`${'='.repeat(60)}\n`);
}

main().catch(console.error);
