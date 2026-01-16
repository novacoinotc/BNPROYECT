// =====================================================
// BUYER RISK ASSESSOR
// Evaluates buyer trustworthiness for auto-release decisions
// =====================================================

import { logger } from '../utils/logger.js';
import { getBinanceClient } from './binance-client.js';
import { UserStats, CounterPartyStats } from '../types/binance.js';

export interface BuyerRiskConfig {
  minTotalOrders: number;        // Minimum total completed orders
  min30DayOrders: number;        // Minimum orders in last 30 days
  minRegisterDays: number;       // Minimum days since registration
  minPositiveRate: number;       // Minimum positive review rate (0-1)
  maxAutoReleaseAmount: number;  // Maximum amount for auto-release
}

export interface BuyerRiskAssessment {
  isTrusted: boolean;
  buyerNo?: string;          // Optional - may not have userNo when using orderNumber lookup
  orderNumber?: string;      // Order number used for lookup
  stats: {
    totalOrders: number;
    orders30Day: number;
    registerDays: number;
    positiveRate: number;
    finishRate: number;
  } | null;
  orderAmount: number;
  failedCriteria: string[];
  recommendation: 'AUTO_RELEASE' | 'MANUAL_VERIFICATION';
}

const DEFAULT_CONFIG: BuyerRiskConfig = {
  minTotalOrders: parseInt(process.env.MIN_BUYER_TOTAL_ORDERS || '100'),
  min30DayOrders: parseInt(process.env.MIN_BUYER_30DAY_ORDERS || '15'),
  minRegisterDays: parseInt(process.env.MIN_BUYER_REGISTER_DAYS || '100'),
  minPositiveRate: parseFloat(process.env.MIN_BUYER_POSITIVE_RATE || '0.85'),
  maxAutoReleaseAmount: parseFloat(process.env.MAX_AUTO_RELEASE_AMOUNT || '2500'),
};

export class BuyerRiskAssessor {
  private client = getBinanceClient();
  private config: BuyerRiskConfig;

  constructor(config?: Partial<BuyerRiskConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    logger.info(
      `🛡️ [RISK-ASSESSOR] Initialized with: ` +
      `minOrders=${this.config.minTotalOrders}, ` +
      `min30Day=${this.config.min30DayOrders}, ` +
      `minDays=${this.config.minRegisterDays}, ` +
      `minPositive=${(this.config.minPositiveRate * 100).toFixed(0)}%, ` +
      `maxAmount=$${this.config.maxAutoReleaseAmount}`
    );
  }

  /**
   * Assess buyer risk for an order
   */
  async assessBuyer(buyerNo: string, orderAmount: number): Promise<BuyerRiskAssessment> {
    const failedCriteria: string[] = [];

    logger.info(
      `🔍 [RISK-ASSESSOR] Evaluating buyer ${buyerNo} for order amount $${orderAmount}`
    );

    // Check amount first (no API call needed)
    if (orderAmount > this.config.maxAutoReleaseAmount) {
      failedCriteria.push(
        `Monto $${orderAmount} excede límite $${this.config.maxAutoReleaseAmount}`
      );
    }

    // Try to fetch buyer stats
    let stats: BuyerRiskAssessment['stats'] = null;

    try {
      const userStats = await this.client.getUserStats(buyerNo);

      stats = {
        totalOrders: userStats.completedOrderNum || 0,
        orders30Day: userStats.completedOrderNumOfLatest30day || 0,
        registerDays: userStats.registerDays || 0,
        positiveRate: userStats.finishRate || 0, // Note: API might use finishRate for this
        finishRate: userStats.finishRateLatest30Day || 0,
      };

      logger.info(
        `📊 [RISK-ASSESSOR] Buyer stats: ` +
        `totalOrders=${stats.totalOrders}, ` +
        `30day=${stats.orders30Day}, ` +
        `days=${stats.registerDays}, ` +
        `positiveRate=${(stats.positiveRate * 100).toFixed(1)}%`
      );

      // Evaluate criteria
      if (stats.totalOrders < this.config.minTotalOrders) {
        failedCriteria.push(
          `Órdenes totales ${stats.totalOrders} < ${this.config.minTotalOrders} requeridas`
        );
      }

      if (stats.orders30Day < this.config.min30DayOrders) {
        failedCriteria.push(
          `Órdenes 30 días ${stats.orders30Day} < ${this.config.min30DayOrders} requeridas`
        );
      }

      if (stats.registerDays < this.config.minRegisterDays) {
        failedCriteria.push(
          `Días registrado ${stats.registerDays} < ${this.config.minRegisterDays} requeridos`
        );
      }

      if (stats.positiveRate < this.config.minPositiveRate) {
        failedCriteria.push(
          `Tasa positiva ${(stats.positiveRate * 100).toFixed(1)}% < ${(this.config.minPositiveRate * 100).toFixed(0)}% requerida`
        );
      }

    } catch (error) {
      logger.warn(
        { error, buyerNo },
        '⚠️ [RISK-ASSESSOR] Could not fetch buyer stats - treating as risky'
      );
      failedCriteria.push('No se pudieron obtener estadísticas del comprador');
    }

    const isTrusted = failedCriteria.length === 0;
    const recommendation = isTrusted ? 'AUTO_RELEASE' : 'MANUAL_VERIFICATION';

    if (isTrusted) {
      logger.info(
        `✅ [RISK-ASSESSOR] Buyer ${buyerNo} is TRUSTED - auto-release approved`
      );
    } else {
      logger.warn(
        `⚠️ [RISK-ASSESSOR] Buyer ${buyerNo} requires MANUAL verification: ${failedCriteria.join(', ')}`
      );
    }

    return {
      isTrusted,
      buyerNo,
      stats,
      orderAmount,
      failedCriteria,
      recommendation,
    };
  }

  /**
   * Assess buyer risk using order number - PREFERRED METHOD
   * Uses queryCounterPartyOrderStatistic endpoint which returns buyer stats
   * directly without needing their userNo.
   */
  async assessBuyerByOrder(orderNumber: string, orderAmount: number): Promise<BuyerRiskAssessment> {
    const failedCriteria: string[] = [];

    logger.info(
      `🔍 [RISK-ASSESSOR] Evaluating counterparty for order ${orderNumber}, amount $${orderAmount}`
    );

    // Check amount first (no API call needed)
    if (orderAmount > this.config.maxAutoReleaseAmount) {
      failedCriteria.push(
        `Monto $${orderAmount} excede límite $${this.config.maxAutoReleaseAmount}`
      );
    }

    // Fetch counterparty stats using the new endpoint
    let stats: BuyerRiskAssessment['stats'] = null;

    try {
      const counterPartyStats = await this.client.getCounterPartyStats(orderNumber);

      stats = {
        totalOrders: counterPartyStats.completedOrderNum || 0,
        orders30Day: counterPartyStats.completedOrderNumOfLatest30day || 0,
        registerDays: counterPartyStats.registerDays || 0,
        positiveRate: counterPartyStats.finishRate || 0,
        finishRate: counterPartyStats.finishRateLatest30Day || 0,
      };

      logger.info(
        `📊 [RISK-ASSESSOR] Counterparty stats for order ${orderNumber}: ` +
        `totalOrders=${stats.totalOrders}, ` +
        `30day=${stats.orders30Day}, ` +
        `days=${stats.registerDays}, ` +
        `positiveRate=${(stats.positiveRate * 100).toFixed(1)}%`
      );

      // Evaluate criteria
      if (stats.totalOrders < this.config.minTotalOrders) {
        failedCriteria.push(
          `Órdenes totales ${stats.totalOrders} < ${this.config.minTotalOrders} requeridas`
        );
      }

      if (stats.orders30Day < this.config.min30DayOrders) {
        failedCriteria.push(
          `Órdenes 30 días ${stats.orders30Day} < ${this.config.min30DayOrders} requeridas`
        );
      }

      if (stats.registerDays < this.config.minRegisterDays) {
        failedCriteria.push(
          `Días registrado ${stats.registerDays} < ${this.config.minRegisterDays} requeridos`
        );
      }

      if (stats.positiveRate < this.config.minPositiveRate) {
        failedCriteria.push(
          `Tasa positiva ${(stats.positiveRate * 100).toFixed(1)}% < ${(this.config.minPositiveRate * 100).toFixed(0)}% requerida`
        );
      }

    } catch (error) {
      logger.warn(
        { error, orderNumber },
        '⚠️ [RISK-ASSESSOR] Could not fetch counterparty stats - treating as risky'
      );
      failedCriteria.push('No se pudieron obtener estadísticas del comprador');
    }

    const isTrusted = failedCriteria.length === 0;
    const recommendation = isTrusted ? 'AUTO_RELEASE' : 'MANUAL_VERIFICATION';

    if (isTrusted) {
      logger.info(
        `✅ [RISK-ASSESSOR] Order ${orderNumber} counterparty is TRUSTED - auto-release approved`
      );
    } else {
      logger.warn(
        `⚠️ [RISK-ASSESSOR] Order ${orderNumber} counterparty requires MANUAL verification: ${failedCriteria.join(', ')}`
      );
    }

    return {
      isTrusted,
      orderNumber,
      stats,
      orderAmount,
      failedCriteria,
      recommendation,
    };
  }

  /**
   * Get current configuration
   */
  getConfig(): BuyerRiskConfig {
    return { ...this.config };
  }

  /**
   * Update configuration dynamically
   */
  updateConfig(newConfig: Partial<BuyerRiskConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info({ config: this.config }, '🛡️ [RISK-ASSESSOR] Configuration updated');
  }
}

// Singleton instance
let assessorInstance: BuyerRiskAssessor | null = null;

export function getBuyerRiskAssessor(): BuyerRiskAssessor {
  if (!assessorInstance) {
    assessorInstance = new BuyerRiskAssessor();
  }
  return assessorInstance;
}

export function createBuyerRiskAssessor(config?: Partial<BuyerRiskConfig>): BuyerRiskAssessor {
  assessorInstance = new BuyerRiskAssessor(config);
  return assessorInstance;
}
