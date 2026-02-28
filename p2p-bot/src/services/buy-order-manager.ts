// =====================================================
// BUY ORDER MANAGER
// Independent module for auto-paying BUY orders via SPEI
// Supports manual approval mode and auto-dispatch mode
// Does NOT interfere with existing SELL order processing
// =====================================================

import { EventEmitter } from 'events';
import { getBinanceClient, BinanceC2CClient } from './binance-client.js';
import { logger } from '../utils/logger.js';
import {
  getBotConfig,
  saveBuyDispatch,
  updateBuyDispatch,
  getBuyDispatches,
  getBuyDispatchById,
  getBuyDispatchByOrderNumber,
  BuyDispatch,
} from './database-pg.js';

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

// ==================== BUY ORDER MANAGER ====================

export class BuyOrderManager extends EventEmitter {
  private client: BinanceC2CClient;
  private config: BuyOrderConfig;
  private isRunning = false;
  private isPolling = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private processedOrders = new Set<string>(); // Dedup within session

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

  getStatus(): { isRunning: boolean } {
    return { isRunning: this.isRunning };
  }

  // ==================== PUBLIC: DISPATCH MANAGEMENT ====================

  /**
   * Get dispatches from DB (for dashboard)
   */
  async getDispatches(status?: string): Promise<BuyDispatch[]> {
    return getBuyDispatches(status);
  }

  /**
   * Approve a pending dispatch — sends SPEI + marks as paid
   */
  async approveDispatch(dispatchId: string, approvedBy?: string): Promise<{ success: boolean; error?: string }> {
    const dispatch = await getBuyDispatchById(dispatchId);
    if (!dispatch) return { success: false, error: 'Dispatch not found' };
    if (dispatch.status !== 'PENDING_APPROVAL') return { success: false, error: `Cannot approve dispatch with status: ${dispatch.status}` };

    logger.info({
      dispatchId,
      orderNumber: dispatch.orderNumber,
      amount: dispatch.amount,
      beneficiary: dispatch.beneficiaryName,
    }, '🛒 [AUTO-BUY] Dispatch approved manually');

    // Mark as dispatching
    await updateBuyDispatch(dispatchId, {
      status: 'DISPATCHING',
      approvedAt: new Date(),
      approvedBy: approvedBy || 'dashboard',
    });

    // Execute SPEI + mark paid
    return this.executeDispatch(dispatch);
  }

  /**
   * Reject a pending dispatch
   */
  async rejectDispatch(dispatchId: string): Promise<{ success: boolean; error?: string }> {
    const dispatch = await getBuyDispatchById(dispatchId);
    if (!dispatch) return { success: false, error: 'Dispatch not found' };
    if (dispatch.status !== 'PENDING_APPROVAL') return { success: false, error: `Cannot reject dispatch with status: ${dispatch.status}` };

    await updateBuyDispatch(dispatchId, { status: 'REJECTED' });
    // Remove from session dedup so it doesn't block reprocessing
    this.processedOrders.delete(dispatch.orderNumber);

    logger.info({ dispatchId, orderNumber: dispatch.orderNumber }, '🛒 [AUTO-BUY] Dispatch rejected');
    return { success: true };
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

        // Skip if already processed in this session
        if (this.processedOrders.has(orderNumber)) continue;

        // Also check DB to avoid reprocessing after restart
        const existing = await getBuyDispatchByOrderNumber(orderNumber);
        if (existing) {
          this.processedOrders.add(orderNumber);
          continue;
        }

        // Parse and validate amount with strict rounding
        const rawAmount = parseFloat(order.totalPrice || '0');
        const amount = Math.round(rawAmount * 100) / 100; // Strict 2-decimal rounding

        if (!isFinite(amount) || isNaN(amount) || amount <= 0) {
          logger.error({ orderNumber, rawAmount }, '[AUTO-BUY] Invalid amount - skipping');
          this.processedOrders.add(orderNumber);
          continue;
        }

        // Amount check
        if (amount > this.config.maxAmount) {
          logger.warn({
            orderNumber,
            amount,
            maxAmount: this.config.maxAmount,
          }, '🛒 [AUTO-BUY] Order exceeds max amount - skipping');
          // Save as failed in DB
          await saveBuyDispatch({
            orderNumber,
            amount,
            beneficiaryName: 'N/A',
            beneficiaryAccount: 'N/A',
            bankName: null,
            sellerNick: order.counterPartNickName || null,
            selectedPayId: 0,
            status: 'FAILED',
          });
          await updateBuyDispatch(
            (await getBuyDispatchByOrderNumber(orderNumber))!.id,
            { error: `Monto $${amount} excede el máximo $${this.config.maxAmount}` }
          );
          this.processedOrders.add(orderNumber);
          continue;
        }

        logger.info({
          orderNumber,
          amount,
          seller: order.counterPartNickName,
        }, '🛒 [AUTO-BUY] New BUY order detected');

        // Process the order
        await this.processBuyOrder(orderNumber, amount, order.counterPartNickName);
        this.processedOrders.add(orderNumber);
      }
    } catch (error: any) {
      logger.error({ error: error?.message }, '[AUTO-BUY] Poll error');
    } finally {
      this.isPolling = false;
    }
  }

  // ==================== ORDER PROCESSING ====================

  private async processBuyOrder(orderNumber: string, amount: number, sellerNick: string): Promise<void> {
    try {
      // Step 1: Get order detail to extract payment info
      const detail = await (this.client as any).signedPost(
        '/sapi/v1/c2c/orderMatch/getUserOrderDetail',
        { adOrderNo: orderNumber }
      );

      const paymentDetails = this.extractPaymentDetails(detail, orderNumber, amount);
      if (!paymentDetails) {
        // Try to identify the payment method for a better error message
        const methods = detail.payMethods || [];
        const methodName = methods[0]?.tradeMethodName || methods[0]?.payMethodName || 'desconocido';
        const errorMsg = `Metodo de pago no compatible con SPEI: ${methodName}`;
        await saveBuyDispatch({
          orderNumber,
          amount,
          beneficiaryName: sellerNick || 'N/A',
          beneficiaryAccount: 'N/A',
          bankName: null,
          sellerNick,
          selectedPayId: 0,
          status: 'FAILED',
        });
        const saved = await getBuyDispatchByOrderNumber(orderNumber);
        if (saved) await updateBuyDispatch(saved.id, { error: errorMsg });
        this.emit('buy_order', { type: 'failed', orderNumber, error: errorMsg });
        return;
      }

      logger.info({
        orderNumber,
        beneficiary: paymentDetails.beneficiaryName,
        account: paymentDetails.beneficiaryAccount.slice(-4).padStart(paymentDetails.beneficiaryAccount.length, '*'),
        amount: paymentDetails.amount,
        payId: paymentDetails.selectedPayId,
      }, '🛒 [AUTO-BUY] Payment details extracted');

      // Step 2: Check auto-dispatch mode
      const botConfig = await getBotConfig();
      const autoDispatch = botConfig.autoBuyAutoDispatch;

      // Save dispatch to DB
      const dispatch = await saveBuyDispatch({
        orderNumber,
        amount: paymentDetails.amount,
        beneficiaryName: paymentDetails.beneficiaryName,
        beneficiaryAccount: paymentDetails.beneficiaryAccount,
        bankName: paymentDetails.bankName,
        sellerNick,
        selectedPayId: paymentDetails.selectedPayId,
        status: autoDispatch ? 'DISPATCHING' : 'PENDING_APPROVAL',
      });

      if (autoDispatch) {
        // Auto mode: execute immediately
        logger.info({ orderNumber, amount: paymentDetails.amount }, '🛒 [AUTO-BUY] Auto-dispatch mode - sending SPEI immediately');
        await this.executeDispatch(dispatch);
      } else {
        // Manual mode: wait for dashboard approval
        logger.info({ orderNumber, amount: paymentDetails.amount }, '🛒 [AUTO-BUY] Manual mode - awaiting dashboard approval');
        this.emit('buy_order', {
          type: 'pending_approval',
          orderNumber,
          amount: paymentDetails.amount,
          beneficiary: paymentDetails.beneficiaryName,
        });
      }
    } catch (error: any) {
      logger.error({ orderNumber, error: error.message }, '[AUTO-BUY] Processing error');
      this.emit('buy_order', { type: 'failed', orderNumber, error: error.message });
    }
  }

  // ==================== DISPATCH EXECUTION ====================

  /**
   * Execute a dispatch: send SPEI + mark order as paid on Binance
   */
  private async executeDispatch(dispatch: BuyDispatch): Promise<{ success: boolean; error?: string }> {
    const { id, orderNumber, amount, beneficiaryName, beneficiaryAccount, bankName, selectedPayId } = dispatch;

    try {
      // Strict amount validation before sending money
      const safeAmount = Math.round(amount * 100) / 100;
      if (safeAmount !== amount || safeAmount <= 0) {
        const error = `Amount mismatch after rounding: original=${amount}, rounded=${safeAmount}`;
        await updateBuyDispatch(id, { status: 'FAILED', error });
        logger.error({ orderNumber, amount, safeAmount }, `[AUTO-BUY] ${error}`);
        return { success: false, error };
      }

      logger.info({
        orderNumber,
        exactAmount: safeAmount,
        beneficiary: beneficiaryName,
        account: beneficiaryAccount.slice(-4).padStart(beneficiaryAccount.length, '*'),
      }, '🛒 [AUTO-BUY] Sending SPEI dispatch');

      // Send SPEI via NOVACORE
      const details: PaymentDetails = {
        beneficiaryName,
        beneficiaryAccount,
        bankName,
        amount: safeAmount,
        orderNumber,
        selectedPayId,
      };

      const speiResult = await this.sendSpeiPayment(details);

      if (!speiResult.success) {
        await updateBuyDispatch(id, { status: 'FAILED', error: `SPEI falló: ${speiResult.error}` });
        logger.error({ orderNumber, error: speiResult.error }, '🛒 [AUTO-BUY] SPEI dispatch failed');
        this.emit('buy_order', { type: 'failed', orderNumber, error: speiResult.error });
        return { success: false, error: speiResult.error };
      }

      // Update dispatch with SPEI result
      await updateBuyDispatch(id, {
        trackingKey: speiResult.trackingKey || undefined,
        transactionId: speiResult.transactionId || undefined,
      });

      logger.info({ orderNumber, trackingKey: speiResult.trackingKey }, '🛒 [AUTO-BUY] SPEI sent successfully');

      // Mark order as paid on Binance
      try {
        await this.client.markOrderAsPaid({
          orderNumber,
          payId: selectedPayId,
        });

        await updateBuyDispatch(id, {
          status: 'COMPLETED',
          dispatchedAt: new Date(),
        });

        logger.info({
          orderNumber,
          amount: safeAmount,
          trackingKey: speiResult.trackingKey,
        }, '✅ [AUTO-BUY] Order completed - SPEI sent + marked as paid');

        this.emit('buy_order', {
          type: 'completed',
          orderNumber,
          amount: safeAmount,
          trackingKey: speiResult.trackingKey,
        });

        return { success: true };

      } catch (markError: any) {
        // SPEI sent but markAsPaid failed
        await updateBuyDispatch(id, {
          status: 'FAILED',
          error: `SPEI enviado pero fallo al marcar como pagada: ${markError.message}`,
          dispatchedAt: new Date(),
        });
        logger.error({
          orderNumber,
          trackingKey: speiResult.trackingKey,
          error: markError.message,
        }, '⚠️ [AUTO-BUY] SPEI sent but FAILED to mark as paid - MANUAL ACTION NEEDED');
        this.emit('buy_order', { type: 'manual_required', orderNumber, error: markError.message });
        return { success: false, error: `SPEI enviado pero markAsPaid falló: ${markError.message}` };
      }

    } catch (error: any) {
      await updateBuyDispatch(id, { status: 'FAILED', error: error.message });
      logger.error({ orderNumber, error: error.message }, '[AUTO-BUY] Dispatch execution error');
      return { success: false, error: error.message };
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
      const payMethods = orderDetail.payMethods || [];
      let beneficiaryName = '';
      let beneficiaryAccount = '';
      let bankName: string | null = null;
      let methodName: string | null = null;

      // Collect ALL field values for smart scanning
      const allFieldValues: { contentType: string; value: string }[] = [];

      for (const method of payMethods) {
        // Capture method-level name (e.g., "BBVA", "Bank Transfer", "Mercadopago")
        methodName = method.tradeMethodName || method.payMethodName || method.identifier || null;

        const fields = method.fields || [];
        for (const field of fields) {
          const contentType = field.fieldContentType || '';
          const value = (field.fieldValue || '').trim();
          if (value) allFieldValues.push({ contentType, value });

          // Standard field extraction
          if (contentType === 'payee' && value) {
            beneficiaryName = value;
          } else if (contentType === 'pay_account' && value) {
            beneficiaryAccount = value;
          } else if (contentType === 'bank' && value) {
            bankName = value;
          } else if (contentType === 'IBAN' && value && !beneficiaryAccount) {
            beneficiaryAccount = value;
          }
        }
      }

      // Fallback: check sellerName at top level
      if (!beneficiaryName && orderDetail.sellerName) {
        beneficiaryName = orderDetail.sellerName;
      }

      // SMART SCAN: If no account found via standard fields,
      // scan ALL field values for 16-18 digit numbers (CLABE or debit card)
      // Users sometimes put their CLABE in DNI, Cedula, or other wrong fields
      if (!beneficiaryAccount) {
        for (const { contentType, value } of allFieldValues) {
          // Skip fields we already checked
          if (contentType === 'payee' || contentType === 'pay_account' || contentType === 'bank') continue;

          // Check if the value is a 16 or 18 digit number (potential CLABE or card)
          const digitsOnly = value.replace(/\s|-/g, '');
          if (/^\d{16}$/.test(digitsOnly) || /^\d{18}$/.test(digitsOnly)) {
            beneficiaryAccount = digitsOnly;
            logger.info({
              orderNumber,
              foundIn: contentType,
              accountLength: digitsOnly.length,
            }, '🛒 [AUTO-BUY] Found account number in non-standard field');
            break;
          }
        }
      }

      // Also try to find beneficiary name from any text field if still missing
      if (!beneficiaryName) {
        for (const { contentType, value } of allFieldValues) {
          // Look for name-like fields
          if (contentType !== 'pay_account' && contentType !== 'bank' && contentType !== 'IBAN') {
            // If value looks like a name (has letters, not just digits)
            if (value.length >= 5 && /[a-zA-ZÀ-ÿ]/.test(value) && !/^\d+$/.test(value)) {
              beneficiaryName = value;
              break;
            }
          }
        }
      }

      // Log everything we found for debugging
      logger.info({
        orderNumber,
        methodName,
        beneficiaryName: beneficiaryName || 'NOT FOUND',
        beneficiaryAccount: beneficiaryAccount ? `...${beneficiaryAccount.slice(-4)}` : 'NOT FOUND',
        bankName: bankName || methodName || 'NOT FOUND',
        allFields: allFieldValues.map(f => `${f.contentType}: ${f.value.length > 20 ? f.value.slice(0, 10) + '...' + f.value.slice(-4) : f.value}`),
      }, '🛒 [AUTO-BUY] Extracted fields summary');

      // Validate we have minimum required fields
      if (!beneficiaryAccount) {
        logger.error({
          orderNumber,
          methodName,
        }, `[AUTO-BUY] No bank account found in any field - method: ${methodName || 'unknown'}`);
        return null;
      }
      if (!beneficiaryName) {
        logger.error({ orderNumber }, '[AUTO-BUY] No beneficiary name found');
        return null;
      }

      // Fallback for bank name: use the payment method name (e.g., "BBVA")
      if (!bankName && methodName) {
        bankName = methodName;
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

    logger.info({
      orderNumber: details.orderNumber,
      exactAmount: details.amount,
      beneficiary: body.beneficiaryName,
      accountLast4: details.beneficiaryAccount.slice(-4),
    }, '🛒 [AUTO-BUY] SPEI request details');

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
