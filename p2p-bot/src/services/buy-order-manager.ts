// =====================================================
// BUY ORDER MANAGER
// Independent module for auto-paying BUY orders via SPEI
// Does NOT interfere with existing SELL order processing
// =====================================================

import { EventEmitter } from 'events';
import { getBinanceClient, BinanceC2CClient } from './binance-client.js';
import { logger } from '../utils/logger.js';

// ==================== INTERFACES ====================

export interface BuyOrderConfig {
  pollIntervalMs: number;
  maxAmount: number;
  novacoreUrl: string;
  novacoreApiKey: string;
  conceptPrefix: string;
}

interface PaymentDetails {
  beneficiaryName: string;
  beneficiaryAccount: string;    // CLABE or card number
  bankName: string | null;
  amount: number;
  orderNumber: string;
  selectedPayId: number;
}

interface SpeiResult {
  success: boolean;
  trackingKey?: string;
  transactionId?: string;
  error?: string;
}

interface BuyOrderState {
  orderNumber: string;
  status: 'detected' | 'extracting' | 'sending_spei' | 'marking_paid' | 'completed' | 'failed';
  amount: number;
  sellerName: string | null;
  paymentDetails: PaymentDetails | null;
  speiResult: SpeiResult | null;
  error: string | null;
  detectedAt: Date;
  completedAt: Date | null;
}

// ==================== BUY ORDER MANAGER ====================

export class BuyOrderManager extends EventEmitter {
  private client: BinanceC2CClient;
  private config: BuyOrderConfig;
  private isRunning = false;
  private isPolling = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private processedOrders = new Map<string, BuyOrderState>();

  constructor(config?: Partial<BuyOrderConfig>) {
    super();
    this.client = getBinanceClient();
    this.config = {
      pollIntervalMs: parseInt(process.env.AUTO_BUY_POLL_INTERVAL_MS || '5000'),
      maxAmount: parseFloat(process.env.AUTO_BUY_MAX_AMOUNT || '25000'),
      novacoreUrl: process.env.AUTO_BUY_NOVACORE_URL || '',
      novacoreApiKey: process.env.AUTO_BUY_NOVACORE_API_KEY || '',
      conceptPrefix: process.env.AUTO_BUY_CONCEPT_PREFIX || 'P2P',
      ...config,
    };
  }

  // ==================== LIFECYCLE ====================

  async start(): Promise<void> {
    if (this.isRunning) return;

    // Validate configuration
    if (!this.config.novacoreUrl) {
      logger.error('[AUTO-BUY] AUTO_BUY_NOVACORE_URL not configured - cannot start');
      return;
    }
    if (!this.config.novacoreApiKey) {
      logger.error('[AUTO-BUY] AUTO_BUY_NOVACORE_API_KEY not configured - cannot start');
      return;
    }

    this.isRunning = true;
    logger.info({
      pollInterval: this.config.pollIntervalMs,
      maxAmount: this.config.maxAmount,
      novacoreUrl: this.config.novacoreUrl,
    }, '🛒 [AUTO-BUY] Module started');

    // First poll immediately
    await this.pollBuyOrders();

    // Then schedule interval
    this.pollInterval = setInterval(() => this.pollBuyOrders(), this.config.pollIntervalMs);
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    logger.info('[AUTO-BUY] Module stopped');
  }

  getStatus(): { isRunning: boolean; processedOrders: BuyOrderState[] } {
    return {
      isRunning: this.isRunning,
      processedOrders: Array.from(this.processedOrders.values()),
    };
  }

  // ==================== POLLING ====================

  private async pollBuyOrders(): Promise<void> {
    if (!this.isRunning || this.isPolling) return;
    this.isPolling = true;

    try {
      // Fetch pending BUY orders (status 1 = TRADING = waiting for our payment)
      const response = await (this.client as any).signedPost(
        '/sapi/v1/c2c/orderMatch/listOrders',
        { tradeType: 'BUY', rows: 20, page: 1, orderStatusList: [1] }
      );

      const orders = (response as any)?.data || response || [];
      if (!Array.isArray(orders)) return;

      for (const order of orders) {
        const orderNumber = order.orderNumber || order.adOrderNo;
        if (!orderNumber) continue;

        // Skip if already processed or in progress
        if (this.processedOrders.has(orderNumber)) {
          const existing = this.processedOrders.get(orderNumber)!;
          if (existing.status === 'completed' || existing.status === 'sending_spei' || existing.status === 'marking_paid') {
            continue;
          }
          // Retry failed orders? For now skip - require manual intervention
          if (existing.status === 'failed') continue;
        }

        const amount = parseFloat(order.totalPrice || '0');

        // Amount check
        if (amount > this.config.maxAmount) {
          logger.warn({
            orderNumber,
            amount,
            maxAmount: this.config.maxAmount,
          }, '🛒 [AUTO-BUY] Order exceeds max amount - skipping');
          this.processedOrders.set(orderNumber, {
            orderNumber,
            status: 'failed',
            amount,
            sellerName: order.counterPartNickName || null,
            paymentDetails: null,
            speiResult: null,
            error: `Amount $${amount} exceeds max $${this.config.maxAmount}`,
            detectedAt: new Date(),
            completedAt: null,
          });
          continue;
        }

        logger.info({
          orderNumber,
          amount,
          seller: order.counterPartNickName,
        }, '🛒 [AUTO-BUY] New BUY order detected');

        // Process the order
        await this.processBuyOrder(orderNumber, amount, order.counterPartNickName);
      }
    } catch (error: any) {
      logger.error({ error: error?.message }, '[AUTO-BUY] Poll error');
    } finally {
      this.isPolling = false;
    }
  }

  // ==================== ORDER PROCESSING ====================

  private async processBuyOrder(orderNumber: string, amount: number, sellerNick: string): Promise<void> {
    const state: BuyOrderState = {
      orderNumber,
      status: 'detected',
      amount,
      sellerName: sellerNick,
      paymentDetails: null,
      speiResult: null,
      error: null,
      detectedAt: new Date(),
      completedAt: null,
    };
    this.processedOrders.set(orderNumber, state);

    try {
      // Step 1: Get order detail to extract payment info
      state.status = 'extracting';
      const detail = await (this.client as any).signedPost(
        '/sapi/v1/c2c/orderMatch/getUserOrderDetail',
        { adOrderNo: orderNumber }
      );

      const paymentDetails = this.extractPaymentDetails(detail, orderNumber, amount);
      if (!paymentDetails) {
        state.status = 'failed';
        state.error = 'Could not extract payment details from order';
        logger.error({ orderNumber }, '[AUTO-BUY] Failed to extract payment details');
        this.emit('buy_order', { type: 'failed', orderNumber, error: state.error });
        return;
      }

      state.paymentDetails = paymentDetails;
      state.sellerName = paymentDetails.beneficiaryName;

      logger.info({
        orderNumber,
        beneficiary: paymentDetails.beneficiaryName,
        account: paymentDetails.beneficiaryAccount.slice(-4).padStart(paymentDetails.beneficiaryAccount.length, '*'),
        amount: paymentDetails.amount,
        payId: paymentDetails.selectedPayId,
      }, '🛒 [AUTO-BUY] Payment details extracted');

      // Step 2: Send SPEI via NOVACORE
      state.status = 'sending_spei';
      const speiResult = await this.sendSpeiPayment(paymentDetails);
      state.speiResult = speiResult;

      if (!speiResult.success) {
        state.status = 'failed';
        state.error = `SPEI failed: ${speiResult.error}`;
        logger.error({
          orderNumber,
          error: speiResult.error,
        }, '🛒 [AUTO-BUY] SPEI dispatch failed');
        this.emit('buy_order', { type: 'failed', orderNumber, error: state.error });
        return;
      }

      logger.info({
        orderNumber,
        trackingKey: speiResult.trackingKey,
      }, '🛒 [AUTO-BUY] SPEI sent successfully');

      // Step 3: Mark order as paid on Binance
      state.status = 'marking_paid';
      try {
        await this.client.markOrderAsPaid({
          orderNumber,
          payId: paymentDetails.selectedPayId,
        });

        state.status = 'completed';
        state.completedAt = new Date();

        const elapsed = state.completedAt.getTime() - state.detectedAt.getTime();
        logger.info({
          orderNumber,
          amount: paymentDetails.amount,
          beneficiary: paymentDetails.beneficiaryName,
          trackingKey: speiResult.trackingKey,
          elapsedMs: elapsed,
        }, '✅ [AUTO-BUY] Order completed - SPEI sent + marked as paid');

        this.emit('buy_order', {
          type: 'completed',
          orderNumber,
          amount: paymentDetails.amount,
          trackingKey: speiResult.trackingKey,
        });

      } catch (markError: any) {
        // SPEI was sent but couldn't mark as paid - needs manual intervention
        state.status = 'failed';
        state.error = `SPEI sent but markAsPaid failed: ${markError.message}`;
        logger.error({
          orderNumber,
          trackingKey: speiResult.trackingKey,
          error: markError.message,
        }, '⚠️ [AUTO-BUY] SPEI sent but FAILED to mark as paid - MANUAL ACTION NEEDED');
        this.emit('buy_order', { type: 'manual_required', orderNumber, error: state.error });
      }

    } catch (error: any) {
      state.status = 'failed';
      state.error = error.message;
      logger.error({ orderNumber, error: error.message }, '[AUTO-BUY] Processing error');
      this.emit('buy_order', { type: 'failed', orderNumber, error: error.message });
    }
  }

  // ==================== PAYMENT DETAIL EXTRACTION ====================

  private extractPaymentDetails(orderDetail: any, orderNumber: string, amount: number): PaymentDetails | null {
    try {
      // Extract selectedPayId (required for markOrderAsPaid)
      const selectedPayId = orderDetail.selectedPayId;
      if (!selectedPayId) {
        logger.error({ orderNumber }, '[AUTO-BUY] No selectedPayId in order detail');
        return null;
      }

      // Extract payment fields from the payMethods array
      // The fields[] array inside payMethods contains the actual bank details
      const payMethods = orderDetail.payMethods || [];
      let beneficiaryName = '';
      let beneficiaryAccount = '';
      let bankName: string | null = null;

      for (const method of payMethods) {
        const fields = method.fields || [];
        for (const field of fields) {
          const contentType = field.fieldContentType || '';
          const value = field.fieldValue || '';

          if (contentType === 'payee' && value) {
            beneficiaryName = value;
          } else if (contentType === 'pay_account' && value) {
            beneficiaryAccount = value;
          } else if (contentType === 'bank' && value) {
            bankName = value;
          } else if (contentType === 'IBAN' && value && !beneficiaryAccount) {
            // Use IBAN as fallback if no pay_account
            beneficiaryAccount = value;
          }
        }
      }

      // Fallback: also check sellerName at top level
      if (!beneficiaryName && orderDetail.sellerName) {
        beneficiaryName = orderDetail.sellerName;
      }

      // Validate we have minimum required fields
      if (!beneficiaryAccount) {
        logger.error({ orderNumber, fields: JSON.stringify(payMethods) }, '[AUTO-BUY] No account found in payment fields');
        return null;
      }
      if (!beneficiaryName) {
        logger.error({ orderNumber }, '[AUTO-BUY] No beneficiary name found');
        return null;
      }

      return {
        beneficiaryName,
        beneficiaryAccount,
        bankName,
        amount,
        orderNumber,
        selectedPayId,
      };
    } catch (error: any) {
      logger.error({ orderNumber, error: error.message }, '[AUTO-BUY] Error extracting payment details');
      return null;
    }
  }

  // ==================== SPEI DISPATCH ====================

  private async sendSpeiPayment(details: PaymentDetails): Promise<SpeiResult> {
    const concept = `${this.config.conceptPrefix}-${details.orderNumber.slice(-10)}`;

    // Build request body
    const body: Record<string, any> = {
      beneficiaryAccount: details.beneficiaryAccount,
      beneficiaryName: details.beneficiaryName.substring(0, 40),
      amount: details.amount,
      concept: concept.substring(0, 40),
      externalReference: details.orderNumber,
    };

    // beneficiaryBank is required for 16-digit debit cards (not CLABE)
    if (details.beneficiaryAccount.length === 16 && details.bankName) {
      body.beneficiaryBank = details.bankName;
    }

    try {
      const response = await fetch(`${this.config.novacoreUrl}/api/integrations/spei-dispatch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.config.novacoreApiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });

      const data = await response.json() as any;

      if (!response.ok || !data.success) {
        return {
          success: false,
          error: data.error || `HTTP ${response.status}`,
        };
      }

      return {
        success: true,
        trackingKey: data.trackingKey,
        transactionId: data.transactionId,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
      };
    }
  }
}

// ==================== FACTORY ====================

export function createBuyOrderManager(config?: Partial<BuyOrderConfig>): BuyOrderManager {
  return new BuyOrderManager(config);
}
