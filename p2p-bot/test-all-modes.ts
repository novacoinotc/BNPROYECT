/**
 * COMPREHENSIVE TEST: All Assets, All Modes, All Trade Types
 *
 * Tests every combination of:
 * - Assets: USDT, BTC, ETH, USDC, BNB
 * - Trade Types: SELL, BUY
 * - Modes: Smart, Follow
 *
 * Verifies that Smart filters work correctly regardless of asset price/decimals
 *
 * Run: npx tsx test-all-modes.ts
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

// Configuration
const MY_NICKNAME = process.env.BINANCE_MY_NICKNAME || 'QuantumCash';
const ASSETS = ['USDT', 'BTC', 'ETH', 'USDC', 'BNB'];
const TRADE_TYPES = ['SELL', 'BUY'] as const;
const FIAT = 'MXN';

// Smart filters from dashboard
const MIN_MONTH_ORDER_COUNT = 10;
const MIN_SURPLUS_FIAT_VALUE = 100; // Fiat value (price × amount)

// Test results tracking
interface TestResult {
  asset: string;
  tradeType: 'SELL' | 'BUY';
  mode: 'smart' | 'follow';
  success: boolean;
  targetPrice: number | null;
  details: string;
  warning?: string;
}

const results: TestResult[] = [];

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

  try {
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
  } catch (error: any) {
    console.error(`API Error for ${asset}/${tradeType}: ${error.message}`);
    return [];
  }
}

function passesSmartFilters(ad: AdData): { passes: boolean; reason?: string } {
  const monthOrders = ad.advertiser.monthOrderCount ?? 0;
  const price = parseFloat(ad.adv.price);
  const surplusAmount = parseFloat(ad.adv.surplusAmount);
  const fiatValue = price * surplusAmount;

  // Filter 1: Minimum orders
  if (monthOrders < MIN_MONTH_ORDER_COUNT) {
    return { passes: false, reason: `orders=${monthOrders} < ${MIN_MONTH_ORDER_COUNT}` };
  }

  // Filter 2: Minimum fiat value available
  if (fiatValue < MIN_SURPLUS_FIAT_VALUE) {
    return { passes: false, reason: `fiatValue=${fiatValue.toFixed(2)} < ${MIN_SURPLUS_FIAT_VALUE}` };
  }

  return { passes: true };
}

async function testSmartMode(asset: string, tradeType: 'SELL' | 'BUY'): Promise<TestResult> {
  // For SELL ad, search BUY to find other sellers
  // For BUY ad, search SELL to find other buyers
  const searchType = tradeType === 'SELL' ? 'BUY' : 'SELL';

  const ads = await searchAds(asset, FIAT, searchType);

  if (ads.length === 0) {
    return {
      asset,
      tradeType,
      mode: 'smart',
      success: false,
      targetPrice: null,
      details: 'No ads found from API',
    };
  }

  // Filter out own ads and apply quality filters
  const qualifiedAds = ads.filter(ad => {
    if (ad.advertiser.nickName === MY_NICKNAME) return false;
    return passesSmartFilters(ad).passes;
  });

  if (qualifiedAds.length === 0) {
    // Check why no qualified ads
    const ownAds = ads.filter(ad => ad.advertiser.nickName === MY_NICKNAME);
    const failedFilters = ads.filter(ad =>
      ad.advertiser.nickName !== MY_NICKNAME && !passesSmartFilters(ad).passes
    );

    return {
      asset,
      tradeType,
      mode: 'smart',
      success: false,
      targetPrice: null,
      details: `0 qualified (${ownAds.length} own, ${failedFilters.length} failed filters)`,
      warning: failedFilters.length > 0 ? `First failed: ${failedFilters[0]?.advertiser.nickName} - ${passesSmartFilters(failedFilters[0]).reason}` : undefined,
    };
  }

  // Sort by price
  qualifiedAds.sort((a, b) => {
    const priceA = parseFloat(a.adv.price);
    const priceB = parseFloat(b.adv.price);
    // SELL: lowest first, BUY: highest first
    return tradeType === 'SELL' ? priceA - priceB : priceB - priceA;
  });

  const bestPrice = parseFloat(qualifiedAds[0].adv.price);

  // Calculate target (undercut for SELL, overcut for BUY)
  const undercutValue = 1 / 100; // 1 centavo
  const targetPrice = tradeType === 'SELL'
    ? Math.round((bestPrice - undercutValue) * 100) / 100
    : Math.round((bestPrice + undercutValue) * 100) / 100;

  return {
    asset,
    tradeType,
    mode: 'smart',
    success: true,
    targetPrice,
    details: `${qualifiedAds.length} qualified, best=${qualifiedAds[0].advertiser.nickName}@${bestPrice.toFixed(2)}`,
  };
}

async function testFollowMode(asset: string, tradeType: 'SELL' | 'BUY', targetNickName: string): Promise<TestResult> {
  const searchType = tradeType === 'SELL' ? 'BUY' : 'SELL';

  // Search up to 3 pages
  for (let page = 1; page <= 3; page++) {
    const ads = await searchAds(asset, FIAT, searchType, page);

    if (ads.length === 0) break;

    const found = ads.find(ad =>
      ad.advertiser.nickName.toLowerCase() === targetNickName.toLowerCase()
    );

    if (found) {
      const targetPrice = parseFloat(found.adv.price);
      // For this test, we use matchPrice=true (exact match)
      return {
        asset,
        tradeType,
        mode: 'follow',
        success: true,
        targetPrice: Math.round(targetPrice * 100) / 100,
        details: `Found ${found.advertiser.nickName} on page ${page} @ ${targetPrice.toFixed(2)}`,
      };
    }

    await new Promise(r => setTimeout(r, 200));
  }

  return {
    asset,
    tradeType,
    mode: 'follow',
    success: false,
    targetPrice: null,
    details: `Target "${targetNickName}" not found in 3 pages`,
  };
}

async function findBestTarget(asset: string, tradeType: 'SELL' | 'BUY'): Promise<string | null> {
  const searchType = tradeType === 'SELL' ? 'BUY' : 'SELL';
  const ads = await searchAds(asset, FIAT, searchType);

  // Find first qualified competitor that's not us
  for (const ad of ads) {
    if (ad.advertiser.nickName !== MY_NICKNAME && passesSmartFilters(ad).passes) {
      return ad.advertiser.nickName;
    }
  }

  // Fallback to any ad that's not us
  for (const ad of ads) {
    if (ad.advertiser.nickName !== MY_NICKNAME) {
      return ad.advertiser.nickName;
    }
  }

  return null;
}

async function runAllTests() {
  console.log('╔════════════════════════════════════════════════════════════════════════════╗');
  console.log('║         COMPREHENSIVE TEST: ALL ASSETS × ALL MODES × ALL TRADE TYPES      ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════╝\n');

  console.log('Configuration:');
  console.log(`  MY_NICKNAME: ${MY_NICKNAME}`);
  console.log(`  MIN_MONTH_ORDER_COUNT: ${MIN_MONTH_ORDER_COUNT}`);
  console.log(`  MIN_SURPLUS_FIAT_VALUE: ${MIN_SURPLUS_FIAT_VALUE} MXN`);
  console.log(`  FIAT: ${FIAT}`);
  console.log(`  ASSETS: ${ASSETS.join(', ')}`);
  console.log();

  // Test each asset
  for (const asset of ASSETS) {
    console.log(`\n${'═'.repeat(76)}`);
    console.log(`  ${asset}/${FIAT}`);
    console.log(`${'═'.repeat(76)}`);

    for (const tradeType of TRADE_TYPES) {
      console.log(`\n  ┌─ ${tradeType} ─────────────────────────────────────────────────────────────────┐`);

      // 1. Test Smart Mode
      console.log(`  │ SMART MODE:`);
      const smartResult = await testSmartMode(asset, tradeType);
      results.push(smartResult);

      if (smartResult.success) {
        console.log(`  │   ✅ SUCCESS - Target: $${smartResult.targetPrice?.toFixed(2)}`);
        console.log(`  │      ${smartResult.details}`);
      } else {
        console.log(`  │   ❌ FAILED - ${smartResult.details}`);
        if (smartResult.warning) {
          console.log(`  │      ⚠️ ${smartResult.warning}`);
        }
      }

      await new Promise(r => setTimeout(r, 300));

      // 2. Test Follow Mode with a real target
      console.log(`  │`);
      console.log(`  │ FOLLOW MODE:`);

      // Find a real target from the market
      const target = await findBestTarget(asset, tradeType);

      if (target) {
        const followResult = await testFollowMode(asset, tradeType, target);
        results.push(followResult);

        if (followResult.success) {
          console.log(`  │   ✅ SUCCESS - Following "${target}" @ $${followResult.targetPrice?.toFixed(2)}`);
          console.log(`  │      ${followResult.details}`);
        } else {
          console.log(`  │   ❌ FAILED - ${followResult.details}`);
        }
      } else {
        console.log(`  │   ⚠️ SKIPPED - No valid target found in market`);
        results.push({
          asset,
          tradeType,
          mode: 'follow',
          success: false,
          targetPrice: null,
          details: 'No valid target in market',
        });
      }

      console.log(`  └${'─'.repeat(74)}┘`);
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Summary
  console.log(`\n\n${'═'.repeat(76)}`);
  console.log('  SUMMARY');
  console.log(`${'═'.repeat(76)}\n`);

  const smartResults = results.filter(r => r.mode === 'smart');
  const followResults = results.filter(r => r.mode === 'follow');

  const smartSuccess = smartResults.filter(r => r.success).length;
  const followSuccess = followResults.filter(r => r.success).length;

  console.log(`  SMART MODE:  ${smartSuccess}/${smartResults.length} passed`);
  console.log(`  FOLLOW MODE: ${followSuccess}/${followResults.length} passed`);
  console.log();

  // Detailed table
  console.log('  ┌─────────┬──────────┬────────────────────┬────────────────────┐');
  console.log('  │ Asset   │ Type     │ Smart              │ Follow             │');
  console.log('  ├─────────┼──────────┼────────────────────┼────────────────────┤');

  for (const asset of ASSETS) {
    for (const tradeType of TRADE_TYPES) {
      const smart = results.find(r => r.asset === asset && r.tradeType === tradeType && r.mode === 'smart');
      const follow = results.find(r => r.asset === asset && r.tradeType === tradeType && r.mode === 'follow');

      const smartStr = smart?.success
        ? `✅ $${smart.targetPrice?.toFixed(2)}`.padEnd(18)
        : `❌ Failed`.padEnd(18);
      const followStr = follow?.success
        ? `✅ $${follow.targetPrice?.toFixed(2)}`.padEnd(18)
        : `❌ Failed`.padEnd(18);

      console.log(`  │ ${asset.padEnd(7)} │ ${tradeType.padEnd(8)} │ ${smartStr} │ ${followStr} │`);
    }
  }

  console.log('  └─────────┴──────────┴────────────────────┴────────────────────┘');

  // Failed tests details
  const failed = results.filter(r => !r.success);
  if (failed.length > 0) {
    console.log('\n  FAILED TESTS DETAILS:');
    for (const f of failed) {
      console.log(`  - ${f.asset} ${f.tradeType} ${f.mode}: ${f.details}`);
    }
  }

  // Check for potential issues
  console.log('\n  POTENTIAL ISSUES:');
  let issuesFound = 0;

  // Check Smart mode failures
  const smartFailed = smartResults.filter(r => !r.success);
  if (smartFailed.length > 0) {
    console.log(`  ⚠️ Smart mode failed for ${smartFailed.length} combinations`);
    for (const f of smartFailed) {
      console.log(`     - ${f.asset} ${f.tradeType}: ${f.details}`);
    }
    issuesFound++;
  }

  // Check for price calculation issues (negative or unrealistic)
  const priceIssues = results.filter(r =>
    r.targetPrice !== null && (r.targetPrice <= 0 || r.targetPrice > 10000000)
  );
  if (priceIssues.length > 0) {
    console.log(`  ⚠️ Unusual target prices detected:`);
    for (const p of priceIssues) {
      console.log(`     - ${p.asset} ${p.tradeType} ${p.mode}: $${p.targetPrice?.toFixed(2)}`);
    }
    issuesFound++;
  }

  if (issuesFound === 0) {
    console.log('  ✅ No issues detected!');
  }

  console.log(`\n${'═'.repeat(76)}`);
  console.log('  TEST COMPLETE');
  console.log(`${'═'.repeat(76)}\n`);
}

runAllTests().catch(console.error);
