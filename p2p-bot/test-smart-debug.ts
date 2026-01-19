/**
 * Debug script to understand why Smart mode returns "0 calificados"
 * for BNB when there are clearly qualified competitors on Binance
 */

import 'dotenv/config';

const API_KEY = process.env.BINANCE_API_KEY || '';

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

async function main() {
  console.log('='.repeat(70));
  console.log('🔍 DEBUG: Smart Mode Analysis for BNB/MXN');
  console.log('='.repeat(70));

  // For BUY ad, we search with SELL to find other buyers (competitors)
  console.log('\n📊 Searching for BNB buyers (tradeType=SELL to see BUY ads)...\n');

  const ads = await searchAds('BNB', 'MXN', 'SELL');

  if (ads.length === 0) {
    console.log('❌ No ads returned from API!');
    return;
  }

  console.log(`Found ${ads.length} ads. Analyzing each:\n`);
  console.log('─'.repeat(70));

  // Config from dashboard
  const minMonthOrderCount = 10;
  const minSurplusAmount = 1; // Fiat value threshold

  let qualifiedCount = 0;

  for (const ad of ads) {
    const price = parseFloat(ad.adv.price);
    const surplusAmount = parseFloat(ad.adv.surplusAmount);
    const fiatValue = price * surplusAmount;
    const monthOrders = ad.advertiser.monthOrderCount ?? 0;

    const passesOrders = monthOrders >= minMonthOrderCount;
    const passesSurplus = fiatValue >= minSurplusAmount;
    const qualified = passesOrders && passesSurplus;

    if (qualified) qualifiedCount++;

    console.log(`${qualified ? '✅' : '❌'} ${ad.advertiser.nickName}`);
    console.log(`   Price: $${price.toFixed(2)} MXN`);
    console.log(`   Available: ${surplusAmount.toFixed(4)} BNB (≈ $${fiatValue.toFixed(2)} MXN)`);
    console.log(`   Month Orders: ${monthOrders} ${passesOrders ? '✓' : `✗ (need ≥${minMonthOrderCount})`}`);
    console.log(`   Fiat Value: $${fiatValue.toFixed(2)} ${passesSurplus ? '✓' : `✗ (need ≥${minSurplusAmount})`}`);
    console.log('');
  }

  console.log('─'.repeat(70));
  console.log(`\n📈 RESULT: ${qualifiedCount} of ${ads.length} ads pass filters\n`);

  if (qualifiedCount === 0) {
    console.log('⚠️  PROBLEM IDENTIFIED: No qualified ads!');
    console.log('');
    console.log('Possible causes:');
    console.log('1. monthOrderCount is returning 0 or undefined from API');
    console.log('2. The API field name might be different');
    console.log('');
    console.log('RAW DATA for first ad:');
    console.log(JSON.stringify(ads[0], null, 2));
  }
}

main().catch(console.error);
