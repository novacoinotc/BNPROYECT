// =====================================================
// BYBIT AD MANAGER
// High-level ad operations: price updates, ad management
// ZERO dependency on Binance or OKX code
// =====================================================

import { logger } from '../../utils/logger.js';
import { BybitClient } from './bybit-client.js';
import { BybitMyAd } from './bybit-types.js';

const log = logger.child({ module: 'bybit-ad-manager' });

export class BybitAdManager {
  constructor(private readonly client: BybitClient) {}

  /**
   * Get active SELL ad for USDT/MXN (or specified pair)
   */
  async getActiveSellAd(tokenId: string = 'USDT', currencyId: string = 'MXN'): Promise<BybitMyAd | null> {
    const { items } = await this.client.getMyAds({
      side: '1',        // sell
      tokenId,
      currencyId,
      status: '2',      // available
    });

    // Find first online ad
    const ad = items.find(a => a.status === 10);
    if (!ad) {
      log.warn({ tokenId, currencyId }, 'No active SELL ad found');
      return null;
    }
    return ad;
  }

  /**
   * Update ad price
   * Bybit requires sending ALL fields on update (not just price)
   * So we fetch the current ad, change the price, and send the full update
   */
  async updateAdPrice(adId: string, newPrice: string): Promise<boolean> {
    try {
      // Get current ad to preserve all fields
      const ad = await this.client.getAdDetail(adId);
      if (!ad) {
        log.error({ adId }, 'Cannot update price - ad not found');
        return false;
      }

      const oldPrice = ad.price;

      // CRITICAL: Bybit requires paymentTerms[].id, NOT payments[] (type IDs)
      const paymentIds = ad.paymentTerms?.map(pt => String(pt.id)) || ad.payments || [];

      // CRITICAL: tradingPreferenceSet values must be strings
      const tps: Record<string, string> = {};
      if (ad.tradingPreferenceSet) {
        for (const [k, v] of Object.entries(ad.tradingPreferenceSet)) {
          tps[k] = String(v);
        }
      }

      await this.client.updateAd({
        id: ad.id,
        priceType: String(ad.priceType) as '0' | '1',
        premium: String(ad.premium || '0'),
        price: newPrice,
        minAmount: String(ad.minAmount),
        maxAmount: String(ad.maxAmount),
        remark: ad.remark || '',
        tradingPreferenceSet: tps,
        paymentIds,
        actionType: 'MODIFY',
        quantity: String(ad.lastQuantity),
        paymentPeriod: String(ad.paymentPeriod),
      });

      log.info({ adId, oldPrice, newPrice }, 'Ad price updated');
      return true;
    } catch (error: any) {
      log.error({ error: error.message, adId, newPrice }, 'updateAdPrice failed');
      return false;
    }
  }

  /**
   * Quick price update: find active SELL ad and change price
   */
  async quickPriceUpdate(
    newPrice: string,
    tokenId: string = 'USDT',
    currencyId: string = 'MXN'
  ): Promise<{ success: boolean; adId?: string; oldPrice?: string }> {
    const ad = await this.getActiveSellAd(tokenId, currencyId);
    if (!ad) {
      return { success: false };
    }

    const oldPrice = ad.price;
    const success = await this.updateAdPrice(ad.id, newPrice);

    return { success, adId: ad.id, oldPrice };
  }

  /**
   * Set ad online/offline by updating with ACTIVE action
   */
  async setAdOnline(adId: string): Promise<boolean> {
    try {
      const ad = await this.client.getAdDetail(adId);
      if (!ad) return false;

      const paymentIds = ad.paymentTerms?.map(pt => String(pt.id)) || ad.payments || [];
      const tps: Record<string, string> = {};
      if (ad.tradingPreferenceSet) {
        for (const [k, v] of Object.entries(ad.tradingPreferenceSet)) {
          tps[k] = String(v);
        }
      }

      await this.client.updateAd({
        id: ad.id,
        priceType: String(ad.priceType) as '0' | '1',
        premium: String(ad.premium || '0'),
        price: ad.price,
        minAmount: String(ad.minAmount),
        maxAmount: String(ad.maxAmount),
        remark: ad.remark || '',
        tradingPreferenceSet: tps,
        paymentIds,
        actionType: 'ACTIVE',
        quantity: String(ad.lastQuantity),
        paymentPeriod: String(ad.paymentPeriod),
      });

      log.info({ adId }, 'Ad set online');
      return true;
    } catch (error: any) {
      log.error({ error: error.message, adId }, 'setAdOnline failed');
      return false;
    }
  }
}
