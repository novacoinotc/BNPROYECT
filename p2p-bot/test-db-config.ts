/**
 * TEST: Database Configuration Loading
 * Verifies that the BotConfig and per-asset positioningConfigs
 * are being loaded correctly from the database.
 *
 * Run: npx tsx test-db-config.ts
 */

import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

// Per-asset positioning configuration
interface AssetPositioningConfig {
  enabled: boolean;
  mode: 'smart' | 'follow';
  followTarget: string | null;
  matchPrice: boolean;
  undercutCents: number;
}

type PositioningConfigsMap = Record<string, AssetPositioningConfig>;

interface BotConfig {
  releaseEnabled: boolean;
  positioningEnabled: boolean;
  positioningMode: string;
  followTargetNickName: string | null;
  followTargetUserNo: string | null;
  sellMode: string;
  sellFollowTarget: string | null;
  buyMode: string;
  buyFollowTarget: string | null;
  positioningConfigs: PositioningConfigsMap;
  smartMinUserGrade: number;
  smartMinFinishRate: number;
  smartMinOrderCount: number;
  smartMinPositiveRate: number;
  smartRequireOnline: boolean;
  smartMinSurplus: number;
  undercutCents: number;
  matchPrice: boolean;
  autoMessageEnabled: boolean;
  autoMessageText: string | null;
}

const ASSETS = ['USDT', 'BTC', 'ETH', 'BNB', 'USDC'];
const TRADE_TYPES = ['SELL', 'BUY'] as const;

function getPositioningConfigForAd(
  config: BotConfig,
  tradeType: 'SELL' | 'BUY',
  asset: string
): AssetPositioningConfig {
  // Check per-asset config first (e.g., "SELL:USDT")
  const key = `${tradeType}:${asset}`;
  if (config.positioningConfigs[key]) {
    const assetConfig = config.positioningConfigs[key];
    return {
      enabled: assetConfig.enabled !== false,
      mode: assetConfig.mode || 'smart',
      followTarget: assetConfig.followTarget || null,
      matchPrice: assetConfig.matchPrice ?? config.matchPrice ?? false,
      undercutCents: assetConfig.undercutCents ?? config.undercutCents ?? 1,
    };
  }

  // Fallback to trade type defaults
  if (tradeType === 'SELL') {
    return {
      enabled: true,
      mode: (config.sellMode as 'smart' | 'follow') || 'smart',
      followTarget: config.sellFollowTarget,
      matchPrice: config.matchPrice ?? false,
      undercutCents: config.undercutCents ?? 1,
    };
  } else {
    return {
      enabled: true,
      mode: (config.buyMode as 'smart' | 'follow') || 'smart',
      followTarget: config.buyFollowTarget,
      matchPrice: config.matchPrice ?? false,
      undercutCents: config.undercutCents ?? 1,
    };
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         DATABASE CONFIG LOADING - COMPREHENSIVE TEST       ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    // 1. Load raw config from database
    console.log('1. LOADING RAW CONFIG FROM DATABASE...\n');
    const result = await pool.query(`SELECT * FROM "BotConfig" WHERE id = 'main'`);

    if (result.rows.length === 0) {
      console.log('❌ No BotConfig found in database!');
      return;
    }

    const row = result.rows[0];

    // Show raw positioningConfigs
    console.log('RAW positioningConfigs from DB:');
    console.log(JSON.stringify(row.positioningConfigs, null, 2));

    // 2. Parse config like the application does
    console.log('\n2. PARSING CONFIG (mimicking getBotConfig)...\n');

    let positioningConfigs: PositioningConfigsMap = {};
    if (row?.positioningConfigs) {
      try {
        positioningConfigs = typeof row.positioningConfigs === 'string'
          ? JSON.parse(row.positioningConfigs)
          : row.positioningConfigs;
      } catch {
        positioningConfigs = {};
      }
    }

    const config: BotConfig = {
      releaseEnabled: row?.releaseEnabled ?? true,
      positioningEnabled: row?.positioningEnabled ?? false,
      positioningMode: row?.positioningMode ?? 'smart',
      followTargetNickName: row?.followTargetNickName ?? null,
      followTargetUserNo: row?.followTargetUserNo ?? null,
      sellMode: row?.sellMode ?? row?.positioningMode ?? 'smart',
      sellFollowTarget: row?.sellFollowTarget ?? row?.followTargetNickName ?? null,
      buyMode: row?.buyMode ?? row?.positioningMode ?? 'smart',
      buyFollowTarget: row?.buyFollowTarget ?? row?.followTargetNickName ?? null,
      positioningConfigs,
      smartMinUserGrade: row?.smartMinUserGrade ?? 2,
      smartMinFinishRate: row?.smartMinFinishRate ?? 0.90,
      smartMinOrderCount: row?.smartMinOrderCount ?? 10,
      smartMinPositiveRate: row?.smartMinPositiveRate ?? 0.95,
      smartRequireOnline: row?.smartRequireOnline ?? true,
      smartMinSurplus: row?.smartMinSurplus ?? 100,
      undercutCents: row?.undercutCents ?? 1,
      matchPrice: row?.matchPrice ?? false,
      autoMessageEnabled: row?.autoMessageEnabled ?? false,
      autoMessageText: row?.autoMessageText ?? null,
    };

    // 3. Show global defaults
    console.log('GLOBAL DEFAULTS:');
    console.log(`  positioningEnabled: ${config.positioningEnabled}`);
    console.log(`  sellMode: ${config.sellMode}`);
    console.log(`  sellFollowTarget: ${config.sellFollowTarget}`);
    console.log(`  buyMode: ${config.buyMode}`);
    console.log(`  buyFollowTarget: ${config.buyFollowTarget}`);
    console.log(`  matchPrice: ${config.matchPrice}`);
    console.log(`  undercutCents: ${config.undercutCents}`);
    console.log(`  smartMinOrderCount: ${config.smartMinOrderCount}`);
    console.log(`  smartMinSurplus: ${config.smartMinSurplus}`);

    // 4. Show per-asset configs
    console.log('\n3. PER-ASSET POSITIONING CONFIGS:\n');
    console.log('Keys in positioningConfigs:', Object.keys(positioningConfigs));

    if (Object.keys(positioningConfigs).length === 0) {
      console.log('⚠️  No per-asset configs found! Will use global defaults for all assets.');
    } else {
      for (const [key, cfg] of Object.entries(positioningConfigs)) {
        console.log(`\n  ${key}:`);
        console.log(`    enabled: ${cfg.enabled}`);
        console.log(`    mode: ${cfg.mode}`);
        console.log(`    followTarget: ${cfg.followTarget || '(none)'}`);
        console.log(`    matchPrice: ${cfg.matchPrice}`);
        console.log(`    undercutCents: ${cfg.undercutCents}`);
      }
    }

    // 5. Show effective config for each asset/trade type
    console.log('\n4. EFFECTIVE CONFIG FOR EACH AD:\n');
    console.log('(This is what the bot actually uses when updating each ad)\n');

    console.log('┌─────────┬──────────┬───────────────────────────────────────────────────────────┐');
    console.log('│ Asset   │ Type     │ Config                                                    │');
    console.log('├─────────┼──────────┼───────────────────────────────────────────────────────────┤');

    for (const asset of ASSETS) {
      for (const tradeType of TRADE_TYPES) {
        const effectiveConfig = getPositioningConfigForAd(config, tradeType, asset);
        const key = `${tradeType}:${asset}`;
        const hasPerAsset = !!positioningConfigs[key];

        const enabledStr = effectiveConfig.enabled ? '✓' : '✗';
        const modeStr = effectiveConfig.mode.padEnd(6);
        const targetStr = effectiveConfig.followTarget ? effectiveConfig.followTarget.substring(0, 20).padEnd(20) : '(none)'.padEnd(20);
        const priceStr = effectiveConfig.matchPrice ? 'match' : `-$${(effectiveConfig.undercutCents / 100).toFixed(2)}`;
        const sourceStr = hasPerAsset ? '[per-asset]' : '[default]';

        console.log(`│ ${asset.padEnd(7)} │ ${tradeType.padEnd(8)} │ ${enabledStr} ${modeStr} → ${targetStr} ${priceStr.padEnd(6)} ${sourceStr} │`);
      }
    }

    console.log('└─────────┴──────────┴───────────────────────────────────────────────────────────┘');

    // 6. Identify potential issues
    console.log('\n5. POTENTIAL ISSUES:\n');

    let issuesFound = 0;

    // Check for Follow mode without target
    for (const asset of ASSETS) {
      for (const tradeType of TRADE_TYPES) {
        const cfg = getPositioningConfigForAd(config, tradeType, asset);
        if (cfg.mode === 'follow' && !cfg.followTarget) {
          console.log(`⚠️  ${tradeType}:${asset} - Follow mode but NO followTarget set!`);
          console.log(`   This will cause Follow to fail and fallback to Smart mode.`);
          issuesFound++;
        }
      }
    }

    // Check if positioningConfigs are being used
    if (Object.keys(positioningConfigs).length > 0) {
      for (const key of Object.keys(positioningConfigs)) {
        const [tradeType, asset] = key.split(':');
        if (!ASSETS.includes(asset)) {
          console.log(`⚠️  Unknown asset in positioningConfigs: ${key}`);
          issuesFound++;
        }
        if (!['SELL', 'BUY'].includes(tradeType)) {
          console.log(`⚠️  Unknown tradeType in positioningConfigs: ${key}`);
          issuesFound++;
        }
      }
    }

    // Check for mismatched follow targets
    for (const asset of ASSETS) {
      const sellCfg = getPositioningConfigForAd(config, 'SELL', asset);
      const buyCfg = getPositioningConfigForAd(config, 'BUY', asset);

      if (sellCfg.mode === 'follow' && buyCfg.mode === 'follow') {
        if (sellCfg.followTarget === buyCfg.followTarget && sellCfg.followTarget) {
          console.log(`ℹ️  ${asset} - Both SELL and BUY follow the same target: ${sellCfg.followTarget}`);
          console.log(`   This is unusual - typically SELL and BUY would follow different competitors.`);
        }
      }
    }

    if (issuesFound === 0) {
      console.log('✅ No obvious configuration issues found!');
    }

    // 7. Summary
    console.log('\n6. SUMMARY:\n');
    const followSellCount = ASSETS.filter(a => getPositioningConfigForAd(config, 'SELL', a).mode === 'follow').length;
    const smartSellCount = ASSETS.filter(a => getPositioningConfigForAd(config, 'SELL', a).mode === 'smart').length;
    const followBuyCount = ASSETS.filter(a => getPositioningConfigForAd(config, 'BUY', a).mode === 'follow').length;
    const smartBuyCount = ASSETS.filter(a => getPositioningConfigForAd(config, 'BUY', a).mode === 'smart').length;

    console.log(`  SELL ads: ${followSellCount} follow, ${smartSellCount} smart`);
    console.log(`  BUY ads: ${followBuyCount} follow, ${smartBuyCount} smart`);

  } catch (error: any) {
    console.error('❌ Error:', error.message);
  } finally {
    await pool.end();
  }

  console.log('\n' + '='.repeat(60));
  console.log('TEST COMPLETE');
  console.log('='.repeat(60) + '\n');
}

main().catch(console.error);
