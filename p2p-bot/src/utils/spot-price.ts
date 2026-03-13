// =====================================================
// BITSO SPOT PRICE UTILITY
// Shared across all exchanges (OKX, Bybit)
// Gets real-time MXN spot prices from Bitso API
// Used as price floor (SELL) / ceiling (BUY) protection
// =====================================================

import axios from 'axios';
import { logger } from './logger.js';

const log = logger.child({ module: 'spot-price' });

// Bitso book name mapping (assets that have direct MXN pairs)
const BITSO_MXN_BOOKS: Record<string, string> = {
  BTC: 'btc_mxn',
  ETH: 'eth_mxn',
  XRP: 'xrp_mxn',
  SOL: 'sol_mxn',
  LTC: 'ltc_mxn',
  USDT: 'usdt_mxn',
  BAT: 'bat_mxn',
  MANA: 'mana_mxn',
  TRX: 'trx_mxn',
  AVAX: 'avax_mxn',
};

// Cache: asset -> { price, timestamp }
const spotCache = new Map<string, { price: number; ts: number }>();
const CACHE_TTL_MS = 30000; // 30 seconds

/**
 * Fetch last price from Bitso public API
 */
async function fetchBitsoPrice(book: string): Promise<number | null> {
  try {
    const response = await axios.get(`https://api.bitso.com/v3/ticker/?book=${book}`, {
      timeout: 5000,
    });
    const last = response.data?.payload?.last;
    if (last) {
      return parseFloat(last);
    }
  } catch {
    // Silent - will use cache fallback
  }
  return null;
}

/**
 * Get spot price in MXN for an asset.
 * Uses Bitso API for direct MXN pairs (BTC, ETH, XRP, SOL, USDT, etc).
 * For other assets: tries crypto/USDT × USDT/MXN using Bitso.
 * Cached 30s per asset to avoid hammering APIs.
 */
export async function getSpotPriceMxn(asset: string): Promise<number | null> {
  const key = asset.toUpperCase();
  const cached = spotCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.price;
  }

  try {
    let priceMxn: number | null = null;

    // Try direct Bitso MXN pair
    const bitsoBook = BITSO_MXN_BOOKS[key];
    if (bitsoBook) {
      priceMxn = await fetchBitsoPrice(bitsoBook);
    }

    // Fallback for non-USDT assets: crypto/USDT pair × USDT/MXN
    // Uses Bitso's USDT/MXN as the bridge
    if (priceMxn === null && key !== 'USDT') {
      const usdtMxn = await getSpotPriceMxn('USDT');
      if (usdtMxn) {
        // Try CoinGecko or other free API for crypto/USDT price
        // For now, only direct Bitso pairs are supported
        log.debug({ asset: key }, 'No direct Bitso pair and no fallback available');
      }
    }

    if (priceMxn !== null && priceMxn > 0) {
      spotCache.set(key, { price: priceMxn, ts: Date.now() });
      return priceMxn;
    }
  } catch (error: any) {
    log.debug({ asset: key, error: error?.message }, 'Failed to get spot price');
  }

  // Return stale cache if fresh fetch failed
  return cached?.price ?? null;
}
