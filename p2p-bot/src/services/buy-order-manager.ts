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

  /**
   * Retry a failed dispatch — resets to DISPATCHING and re-executes
   */
  async retryDispatch(dispatchId: string): Promise<{ success: boolean; error?: string }> {
    const dispatch = await getBuyDispatchById(dispatchId);
    if (!dispatch) return { success: false, error: 'Dispatch not found' };
    if (dispatch.status !== 'FAILED') return { success: false, error: `Cannot retry dispatch with status: ${dispatch.status}` };

    logger.info({
      dispatchId,
      orderNumber: dispatch.orderNumber,
      amount: dispatch.amount,
    }, '🛒 [AUTO-BUY] Retrying failed dispatch');

    // Reset to DISPATCHING
    await updateBuyDispatch(dispatchId, {
      status: 'DISPATCHING',
      error: null as any,
    });

    // Execute SPEI + mark paid
    return this.executeDispatch(dispatch);
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

      let paymentDetails = this.extractPaymentDetails(detail, orderNumber, amount);

      // Step 1b: If no valid account found, check chat messages with retries
      // Seller may take 1-2 minutes to send their CLABE in the chat
      if (!paymentDetails) {
        logger.info({ orderNumber }, '🛒 [AUTO-BUY] No valid account in fields, will check chat (up to 3 attempts, 30s apart)...');

        const MAX_CHAT_RETRIES = 3;
        const CHAT_RETRY_DELAY_MS = 30_000; // 30 seconds between attempts

        for (let attempt = 1; attempt <= MAX_CHAT_RETRIES; attempt++) {
          // Wait before checking chat (give seller time to type)
          if (attempt > 1) {
            await new Promise(resolve => setTimeout(resolve, CHAT_RETRY_DELAY_MS));
          } else {
            // First attempt: wait 15 seconds (seller just opened the order)
            await new Promise(resolve => setTimeout(resolve, 15_000));
          }

          const chatDetails = await this.extractFromChat(orderNumber, detail, amount);
          if (chatDetails) {
            paymentDetails = chatDetails;
            logger.info({
              orderNumber,
              attempt,
              account: chatDetails.beneficiaryAccount.slice(-4).padStart(chatDetails.beneficiaryAccount.length, '*'),
            }, '🛒 [AUTO-BUY] Found account in chat messages!');
            break;
          }

          logger.info({ orderNumber, attempt, maxRetries: MAX_CHAT_RETRIES }, '🛒 [AUTO-BUY] No account in chat yet, waiting...');
        }
      }

      if (!paymentDetails) {
        // Try to identify the payment method for a better error message
        const methods = detail.payMethods || [];
        const methodName = methods[0]?.tradeMethodName || methods[0]?.payMethodName || 'desconocido';
        const errorMsg = `No se encontro cuenta valida (CLABE/tarjeta) en campos ni en chat despues de ~2 min - metodo: ${methodName}`;
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
      const allFieldValues: { contentType: string; fieldName: string; value: string }[] = [];

      for (const method of payMethods) {
        // Capture method-level name (e.g., "BBVA", "Bank Transfer", "Mercadopago")
        methodName = method.tradeMethodName || method.payMethodName || method.identifier || null;

        const fields = method.fields || [];
        for (const field of fields) {
          const contentType = (field.fieldContentType || '').toLowerCase();
          const fieldName = (field.fieldName || field.fieldLabel || '').toLowerCase();
          const value = (field.fieldValue || '').trim();
          if (value) allFieldValues.push({ contentType, fieldName, value });

          // Standard field extraction (check both contentType and fieldName)
          const isPayee = contentType === 'payee' || fieldName.includes('name');
          const isAccount = contentType === 'pay_account' || fieldName.includes('account') || fieldName.includes('card');
          const isBank = contentType === 'bank' || fieldName.includes('bank');
          const isIBAN = contentType === 'iban';

          if (isPayee && value && !beneficiaryName) {
            beneficiaryName = value;
          } else if (isAccount && value && !beneficiaryAccount) {
            const cleaned = value.replace(/\s|-/g, '');
            // Only accept 16 or 18 digit accounts (debit card or CLABE)
            if (/^\d{16}$/.test(cleaned) || /^\d{18}$/.test(cleaned)) {
              beneficiaryAccount = cleaned;
            } else {
              logger.warn({ orderNumber, rawAccount: cleaned, length: cleaned.length }, '[AUTO-BUY] Account field has invalid length, will try smart scan');
            }
          } else if (isBank && value && !bankName) {
            bankName = value;
          } else if (isIBAN && value && !beneficiaryAccount) {
            const cleaned = value.replace(/\s|-/g, '');
            if (/^\d{16}$/.test(cleaned) || /^\d{18}$/.test(cleaned)) {
              beneficiaryAccount = cleaned;
            }
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

      // Smart scan for beneficiary name if still missing
      if (!beneficiaryName) {
        for (const { value } of allFieldValues) {
          if (value.length >= 5 && /[a-zA-ZÀ-ÿ]/.test(value) && !/^\d+$/.test(value)) {
            beneficiaryName = value;
            break;
          }
        }
      }

      // Smart scan for bank name: check all fields for known bank names
      if (!bankName) {
        const knownBanks = ['bbva', 'banamex', 'santander', 'banorte', 'hsbc', 'scotiabank', 'azteca', 'banco azteca', 'inbursa', 'banregio', 'bajio', 'banbajio', 'afirme', 'multiva', 'mifel', 'monex', 'invex', 'interacciones', 'compartamos', 'bancoppel', 'famsa', 'spin', 'nu', 'hey banco', 'klar', 'stori', 'rappi', 'mercadopago', 'oxxo'];
        for (const { value } of allFieldValues) {
          if (knownBanks.some(bank => value.toLowerCase().includes(bank))) {
            bankName = value;
            break;
          }
        }
      }

      // Fallback for bank name: use the payment method name (e.g., "BBVA")
      // But NOT generic names like "Bank Transfer"
      if (!bankName && methodName && !methodName.toLowerCase().includes('transfer')) {
        bankName = methodName;
      }

      // Last resort for display: identify bank from account number
      if (!bankName && beneficiaryAccount) {
        bankName = this.getBankDisplayName(beneficiaryAccount);
      }

      // For 16-digit debit cards: resolve the SPEI code that NOVACORE/OPM requires
      // OPM expects numeric codes like "40012" (BBVA), not names like "BBVA"
      let speiCode: string | null = null;
      if (beneficiaryAccount && beneficiaryAccount.length === 16) {
        speiCode = this.resolveSpeiCodeForCard(bankName, beneficiaryAccount);
        if (!speiCode) {
          logger.warn({
            orderNumber,
            bankName,
            cardPrefix: beneficiaryAccount.slice(0, 6),
          }, '[AUTO-BUY] Could not resolve SPEI code for debit card - will fail at NOVACORE');
        }
      }

      // Log everything we found for debugging
      logger.info({
        orderNumber,
        methodName,
        beneficiaryName: beneficiaryName || 'NOT FOUND',
        beneficiaryAccount: beneficiaryAccount ? `...${beneficiaryAccount.slice(-4)}` : 'NOT FOUND',
        bankName: bankName || 'NOT FOUND',
        speiCode: speiCode || 'N/A (CLABE or unresolved)',
        allFields: allFieldValues.map(f => `${f.contentType}/${f.fieldName}: ${f.value.length > 20 ? f.value.slice(0, 10) + '...' + f.value.slice(-4) : f.value}`),
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

      return {
        beneficiaryName,
        beneficiaryAccount,
        bankName: beneficiaryAccount.length === 16 ? (speiCode || bankName) : bankName,
        amount,
        orderNumber,
        selectedPayId,
      };
    } catch (error: any) {
      logger.error({ orderNumber, error: error.message }, '[AUTO-BUY] Error extracting payment details');
      return null;
    }
  }

  // ==================== CHAT EXTRACTION ====================

  /**
   * When payment fields don't have a valid account, check chat messages.
   * Sellers sometimes send their CLABE/card number in the chat.
   */
  private async extractFromChat(orderNumber: string, orderDetail: any, amount: number): Promise<PaymentDetails | null> {
    try {
      const messages = await this.client.getChatMessages({ orderNo: orderNumber, rows: 20 });
      if (!Array.isArray(messages) || messages.length === 0) return null;

      // Only look at RECENT messages from the counterparty (not self)
      // Limit to last 5 minutes to avoid picking up old CLABEs from previous conversations
      const fiveMinAgo = Date.now() - 5 * 60 * 1000;
      const sellerMessages = messages.filter(m => {
        if (m.self || !m.content) return false;
        const msgTime = parseInt(m.createTime) || new Date(m.createTime).getTime();
        return msgTime > fiveMinAgo;
      });

      let foundAccount: string | null = null;
      let foundBank: string | null = null;

      // Scan messages for 16 or 18 digit numbers
      for (const msg of sellerMessages) {
        const text = msg.content.replace(/\s|-/g, '');
        // Find all sequences of 16 or 18 digits
        const matches = text.match(/\d{16,18}/g);
        if (matches) {
          for (const match of matches) {
            if (match.length === 16 || match.length === 18) {
              foundAccount = match;
              break;
            }
          }
          if (foundAccount) break;
        }
      }

      if (!foundAccount) return null;

      // Try to find bank name in chat
      const knownBanks = ['bbva', 'banamex', 'santander', 'banorte', 'hsbc', 'scotiabank', 'azteca', 'banco azteca', 'inbursa', 'banregio', 'bajio', 'afirme', 'bancoppel', 'spin', 'nu', 'hey banco', 'klar', 'mercadopago'];
      for (const msg of sellerMessages) {
        const lower = msg.content.toLowerCase();
        for (const bank of knownBanks) {
          if (lower.includes(bank)) {
            foundBank = msg.content; // Keep original for display
            break;
          }
        }
        if (foundBank) break;
      }

      // Resolve bank from account if not found in chat
      if (!foundBank) {
        foundBank = this.getBankDisplayName(foundAccount);
      }

      // Get beneficiary name from order fields or chat
      let beneficiaryName = '';
      const payMethods = orderDetail.payMethods || [];
      for (const method of payMethods) {
        for (const field of (method.fields || [])) {
          const ct = (field.fieldContentType || '').toLowerCase();
          const fn = (field.fieldName || field.fieldLabel || '').toLowerCase();
          const val = (field.fieldValue || '').trim();
          if ((ct === 'payee' || fn.includes('name')) && val) {
            beneficiaryName = val;
            break;
          }
        }
        if (beneficiaryName) break;
      }
      if (!beneficiaryName) beneficiaryName = orderDetail.sellerName || 'N/A';

      const selectedPayId = orderDetail.selectedPayId || 0;

      // Resolve SPEI code for 16-digit cards
      let bankForDispatch: string | null = foundBank;
      if (foundAccount.length === 16) {
        const speiCode = this.resolveSpeiCodeForCard(foundBank, foundAccount);
        if (speiCode) bankForDispatch = speiCode;
      }

      logger.info({
        orderNumber,
        account: `...${foundAccount.slice(-4)}`,
        bank: foundBank,
        source: 'chat',
      }, '🛒 [AUTO-BUY] Extracted payment details from chat');

      return {
        beneficiaryName,
        beneficiaryAccount: foundAccount,
        bankName: bankForDispatch,
        amount,
        orderNumber,
        selectedPayId,
      };
    } catch (error: any) {
      logger.error({ orderNumber, error: error.message }, '[AUTO-BUY] Error reading chat messages');
      return null;
    }
  }

  // ==================== BANK LOOKUP ====================
  // NOVACORE/OPM expects SPEI numeric codes (e.g. "40012" for BBVA)
  // For CLABE (18 digits): NOVACORE resolves bank internally, we only need it for display
  // For debit cards (16 digits): we MUST send the speiCode as beneficiaryBank

  /**
   * Resolve SPEI code for 16-digit debit card.
   * Tries: 1) bankName→speiCode mapping, 2) BIN lookup
   * Returns the 5-digit SPEI code OPM expects (e.g. "40127" for Azteca)
   */
  private resolveSpeiCodeForCard(bankName: string | null, cardNumber: string): string | null {
    // First try to convert the bank name we already have to a SPEI code
    if (bankName) {
      const code = this.bankNameToSpeiCode(bankName);
      if (code) return code;
    }
    // Fallback: identify bank from BIN
    return this.getBankFromBIN(cardNumber);
  }

  /**
   * Convert a human-readable bank name to OPM SPEI code
   * Handles names from Binance fields, method names, and known bank scan
   */
  private bankNameToSpeiCode(name: string): string | null {
    // Normalize: lowercase + strip accents (é→e, ó→o, etc.)
    const lower = name.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // Map of common bank name patterns → SPEI codes
    // Must match NOVACORE's /lib/banks.ts BANK_CODES exactly
    const nameToCode: Record<string, string> = {
      // Traditional banks (40xxx)
      'bbva': '40012',
      'bbva mexico': '40012',
      'bbva bancomer': '40012',
      'bancomer': '40012',
      'banamex': '40002',
      'citibanamex': '40002',
      'santander': '40014',
      'banorte': '40072',
      'hsbc': '40021',
      'scotiabank': '40044',
      'inbursa': '40036',
      'bajio': '40030',
      'banco del bajio': '40030',
      'banbajio': '40030',
      'banregio': '40058',
      'afirme': '40062',
      'mifel': '40042',
      'invex': '40059',
      'azteca': '40127',
      'banco azteca': '40127',
      'multiva': '40132',
      'actinver': '40133',
      'bancoppel': '40137',
      'compartamos': '40130',
      'consubanco': '40140',
      'cibanco': '40143',
      'autofin': '40128',
      'bbase': '40145',
      'bankaool': '40147',
      'banco covalto': '40154',
      'covalto': '40154',
      'icbc': '40155',
      'banco s3': '40160',
      'hey banco': '40167',
      'banjercito': '40019',
      'nafin': '40135',
      'uala': '40138',
      // Non-bank financial institutions (90xxx)
      'stp': '90646',
      'mercadopago': '90722',
      'mercado pago': '90722',
      'spin': '90728',
      'spin by oxxo': '90728',
      'spin/oxxo': '90728',
      'oxxo': '90728',
      'klar': '90661',
      'nu': '90638',
      'nubank': '90638',
      'nu mexico': '90638',
      'fondeadora': '90699',
      'cuenca': '90723',
      'albo': '90721',
      'stori': '90706', // Stori uses Arcus
      'rappi': '90706', // RappiPay uses Arcus
      'arcus': '90706',
      'kuspit': '90653',
      'transfer': '90684',
      'opm': '90684',
      'fincomun': '90634',
      'libertad': '90670',
      'cashi': '90715',
      'nvio': '90710',
    };

    return nameToCode[lower] || null;
  }

  /**
   * Get display name for a bank from account number (for dashboard display only)
   * For CLABE: first 3 digits. For cards: BIN lookup.
   */
  private getBankDisplayName(account: string): string | null {
    if (account.length === 18) {
      return this.getBankNameFromCLABE(account);
    }
    if (account.length === 16) {
      const speiCode = this.getBankFromBIN(account);
      // Convert speiCode back to display name
      if (speiCode) {
        const displayNames: Record<string, string> = {
          '40012': 'BBVA', '40002': 'Banamex', '40014': 'Santander',
          '40072': 'Banorte', '40021': 'HSBC', '40044': 'Scotiabank',
          '40036': 'Inbursa', '40030': 'Bajio', '40058': 'Banregio',
          '40062': 'Afirme', '40127': 'Banco Azteca', '40137': 'Bancoppel',
          '90728': 'Spin', '90638': 'Nu', '90661': 'Klar',
          '90722': 'Mercadopago', '40167': 'Hey Banco',
        };
        return displayNames[speiCode] || speiCode;
      }
    }
    return null;
  }

  /**
   * Get human-readable bank name from CLABE (for display/logging only)
   */
  private getBankNameFromCLABE(clabe: string): string | null {
    const prefix = clabe.slice(0, 3);
    const clabeDisplayNames: Record<string, string> = {
      '002': 'Banamex', '012': 'BBVA', '014': 'Santander', '021': 'HSBC',
      '030': 'Bajio', '036': 'Inbursa', '042': 'Mifel', '044': 'Scotiabank',
      '058': 'Banregio', '062': 'Afirme', '072': 'Banorte', '127': 'Azteca',
      '130': 'Compartamos', '132': 'Multiva', '137': 'Bancoppel', '140': 'Consubanco',
      '143': 'CIBanco', '150': 'Inmobiliario', '167': 'Hey Banco',
      '638': 'Nu', '646': 'STP', '661': 'Klar', '684': 'Transfer/OPM',
      '689': 'Fondeadora', '699': 'Fondeadora', '706': 'Arcus', '710': 'Nvio',
      '722': 'Mercadopago', '723': 'Cuenca', '728': 'Spin', '730': 'Swap',
    };
    return clabeDisplayNames[prefix] || null;
  }

  /**
   * Identify Mexican bank from debit card BIN (first 4-6 digits)
   * Returns the 5-digit SPEI code (e.g. "40012" for BBVA)
   */
  private getBankFromBIN(cardNumber: string): string | null {
    const bin6 = cardNumber.slice(0, 6);
    const bin4 = cardNumber.slice(0, 4);

    // 6-digit BINs (higher precision, checked first) → SPEI codes
    const binMap6: Record<string, string> = {
      '402766': '40127', // Banco Azteca
      '474118': '40127',
      '457649': '40127',
      '415231': '40012', // BBVA
      '477298': '40012',
      '455590': '40012',
      '407535': '40012',
      '525666': '40002', // Banamex
      '547400': '40002',
      '476612': '40002',
      '418991': '40072', // Banorte
      '441330': '40072',
      '517726': '40072',
      '604244': '40137', // Bancoppel
      '637230': '40137',
      '551284': '90728', // Spin
    };

    // 4-digit BINs → SPEI codes
    const binMap4: Record<string, string> = {
      // Banco Azteca
      '4027': '40127', '4741': '40127', '4576': '40127',
      // BBVA
      '4152': '40012', '4772': '40012', '4915': '40012', '4555': '40012', '4075': '40012',
      // Banamex
      '5256': '40002', '5474': '40002', '4766': '40002', '5204': '40002',
      // Banorte
      '4189': '40072', '4413': '40072', '5177': '40072',
      // Santander
      '5339': '40014', '4217': '40014', '5468': '40014',
      // HSBC
      '4213': '40021', '5429': '40021', '4263': '40021',
      // Scotiabank
      '4032': '40044', '5570': '40044',
      // Bancoppel
      '6042': '40137', '6372': '40137',
      // Spin/Oxxo
      '5512': '90728',
      // Inbursa
      '4000': '40036', '5036': '40036',
      // Hey Banco
      '5579': '40167',
      // Bajio
      '4093': '40030',
      // Afirme
      '4565': '40062',
      // Nu
      '5101': '90638', '5230': '90638', '5355': '90638',
      // Klar
      '5315': '90661',
      // Rappi (uses Arcus)
      '5519': '90706',
    };

    return binMap6[bin6] || binMap4[bin4] || null;
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
