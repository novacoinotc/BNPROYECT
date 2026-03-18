// =====================================================
// OKX BUY ORDER MANAGER
// Independent module for auto-paying BUY orders via SPEI
// Supports manual approval mode and auto-dispatch mode
// Mirrors Binance buy-order-manager.ts patterns for OKX
// ZERO dependency on Binance or Bybit code
// =====================================================

import { EventEmitter } from 'events';
import { getOkxClient, OkxClient } from './okx-client.js';
import { OkxOrderData, OkxPaymentMethod } from './okx-types.js';
import { logger } from '../../utils/logger.js';
import {
  getBotConfig,
  saveBuyDispatch,
  updateBuyDispatch,
  claimBuyDispatch,
  getBuyDispatches,
  getBuyDispatchById,
  getBuyDispatchByOrderNumber,
  BuyDispatch,
} from '../../services/database-pg.js';

const log = logger.child({ module: 'okx-buy' });

// ==================== INTERFACES ====================

export interface OkxBuyOrderConfig {
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
}

interface SpeiResult {
  success: boolean;
  trackingKey?: string;
  transactionId?: string;
  error?: string;
}

// ==================== OKX BUY ORDER MANAGER ====================

export class OkxBuyOrderManager extends EventEmitter {
  private client: OkxClient;
  private config: OkxBuyOrderConfig;
  private isRunning = false;
  private isPolling = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private processedOrders = new Set<string>(); // Dedup within session

  constructor(config?: Partial<OkxBuyOrderConfig>) {
    super();
    this.client = getOkxClient();
    this.config = {
      pollIntervalMs: parseInt(process.env.OKX_AUTO_BUY_POLL_INTERVAL_MS || '5000'),
      maxAmount: parseFloat(process.env.OKX_AUTO_BUY_MAX_AMOUNT || '120000'),
      // Binance uses base URL (https://novacorp.mx) + appends /api/integrations/spei-dispatch
      // OKX reuses NOVACORE_API_URL which already has the full path, so we strip it if present
      novacoreUrl: (process.env.OKX_NOVACORE_BASE_URL || process.env.AUTO_BUY_NOVACORE_URL || process.env.NOVACORE_API_URL || '').replace(/\/api\/integrations\/spei-dispatch\/?$/, ''),
      novacoreApiKey: process.env.OKX_NOVACORE_API_KEY || process.env.AUTO_BUY_NOVACORE_API_KEY || process.env.NOVACORE_API_KEY || '',
      conceptPrefix: process.env.OKX_AUTO_BUY_CONCEPT_PREFIX || 'OKX',
      ...config,
    };
  }

  // ==================== LIFECYCLE ====================

  async start(): Promise<void> {
    if (this.isRunning) return;

    if (!this.config.novacoreUrl) {
      log.error('[OKX-BUY] NOVACORE_API_URL not configured - cannot start');
      return;
    }
    if (!this.config.novacoreApiKey) {
      log.error('[OKX-BUY] NOVACORE_API_KEY not configured - cannot start');
      return;
    }

    this.isRunning = true;
    log.info({
      pollInterval: this.config.pollIntervalMs,
      maxAmount: this.config.maxAmount,
      novacoreUrl: this.config.novacoreUrl,
    }, '[OKX-BUY] Module started');

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

    log.info('[OKX-BUY] Module stopped');
  }

  getStatus(): { isRunning: boolean } {
    return { isRunning: this.isRunning };
  }

  // ==================== PUBLIC: DISPATCH MANAGEMENT ====================

  /**
   * Get dispatches from DB (for dashboard).
   * For FAILED dispatches, checks OKX order status and auto-expires
   * orders that are no longer active.
   */
  async getDispatches(status?: string): Promise<(BuyDispatch & { okxStatus?: string })[]> {
    const dispatches = await getBuyDispatches(status);

    const enriched = await Promise.all(
      dispatches.map(async (d) => {
        if (d.status !== 'FAILED') return d;

        try {
          const order = await this.client.getOrder(d.orderNumber);
          if (!order) return d;

          const orderStatus = order.orderStatus?.toLowerCase();

          // If order is completed or cancelled, mark dispatch as EXPIRED
          if (orderStatus === 'completed' || orderStatus === 'cancelled') {
            await updateBuyDispatch(d.id, { status: 'EXPIRED', error: `Orden ${orderStatus} en OKX` });
            return { ...d, status: 'EXPIRED', error: `Orden ${orderStatus} en OKX`, okxStatus: orderStatus };
          }

          return { ...d, okxStatus: orderStatus };
        } catch {
          return d;
        }
      })
    );

    return enriched;
  }

  /**
   * Approve a pending dispatch -- sends SPEI + marks as paid
   */
  async approveDispatch(dispatchId: string, approvedBy?: string): Promise<{ success: boolean; error?: string }> {
    const dispatch = await getBuyDispatchById(dispatchId);
    if (!dispatch) return { success: false, error: 'Dispatch not found' };
    if (dispatch.status !== 'PENDING_APPROVAL') return { success: false, error: `Cannot approve dispatch with status: ${dispatch.status}` };

    const claimed = await claimBuyDispatch(dispatchId, 'PENDING_APPROVAL', 'DISPATCHING');
    if (!claimed) {
      log.warn({ dispatchId }, '[OKX-BUY] Dispatch already claimed by another action');
      return { success: false, error: 'Esta dispersion ya esta siendo procesada' };
    }

    log.info({
      dispatchId,
      orderNumber: dispatch.orderNumber,
      amount: dispatch.amount,
      beneficiary: dispatch.beneficiaryName,
    }, '[OKX-BUY] Dispatch approved manually');

    await updateBuyDispatch(dispatchId, {
      approvedAt: new Date(),
      approvedBy: approvedBy || 'dashboard',
    });

    const updated = await getBuyDispatchById(dispatchId);
    if (!updated) return { success: false, error: 'Dispatch not found after claim' };
    return this.executeDispatch(updated);
  }

  /**
   * Reject a pending dispatch
   */
  async rejectDispatch(dispatchId: string): Promise<{ success: boolean; error?: string }> {
    const dispatch = await getBuyDispatchById(dispatchId);
    if (!dispatch) return { success: false, error: 'Dispatch not found' };
    if (dispatch.status !== 'PENDING_APPROVAL') return { success: false, error: `Cannot reject dispatch with status: ${dispatch.status}` };

    await updateBuyDispatch(dispatchId, { status: 'REJECTED' });
    this.processedOrders.delete(dispatch.orderNumber);

    log.info({ dispatchId, orderNumber: dispatch.orderNumber }, '[OKX-BUY] Dispatch rejected');
    return { success: true };
  }

  /**
   * Retry a failed dispatch -- re-extracts payment details from OKX if needed
   */
  async retryDispatch(dispatchId: string): Promise<{ success: boolean; error?: string }> {
    const dispatch = await getBuyDispatchById(dispatchId);
    if (!dispatch) return { success: false, error: 'Dispatch not found' };
    if (dispatch.status !== 'FAILED') return { success: false, error: `Cannot retry dispatch with status: ${dispatch.status}` };

    const claimed = await claimBuyDispatch(dispatchId, 'FAILED', 'DISPATCHING');
    if (!claimed) {
      log.warn({ dispatchId }, '[OKX-BUY] Retry already in progress');
      return { success: false, error: 'Esta dispersion ya esta siendo procesada' };
    }

    log.info({
      dispatchId,
      orderNumber: dispatch.orderNumber,
      amount: dispatch.amount,
    }, '[OKX-BUY] Retrying failed dispatch');

    // If account is N/A, re-extract from OKX order
    if (!dispatch.beneficiaryAccount || dispatch.beneficiaryAccount === 'N/A') {
      try {
        const order = await this.client.getOrder(dispatch.orderNumber);
        if (!order) {
          await updateBuyDispatch(dispatchId, { status: 'FAILED', error: 'No se pudo obtener detalle de orden en OKX' });
          return { success: false, error: 'No se pudo obtener detalle de orden en OKX' };
        }

        const paymentDetails = this.extractPaymentDetails(order, dispatch.amount);
        if (paymentDetails) {
          await updateBuyDispatch(dispatchId, {
            beneficiaryAccount: paymentDetails.beneficiaryAccount,
            bankName: paymentDetails.bankName,
            beneficiaryName: paymentDetails.beneficiaryName,
            error: null as any,
          });
          const updated = await getBuyDispatchById(dispatchId);
          if (!updated) return { success: false, error: 'Failed to update dispatch' };
          return this.executeDispatch(updated);
        } else {
          await updateBuyDispatch(dispatchId, { status: 'FAILED', error: 'No se encontro cuenta valida al re-extraer de OKX' });
          return { success: false, error: 'No se encontro cuenta valida al re-extraer de OKX' };
        }
      } catch (e: any) {
        await updateBuyDispatch(dispatchId, { status: 'FAILED', error: e.message });
        return { success: false, error: `Error re-extrayendo de OKX: ${e.message}` };
      }
    }

    // Account is valid, retry with existing data
    await updateBuyDispatch(dispatchId, { error: null as any });
    const updated = await getBuyDispatchById(dispatchId);
    if (!updated) return { success: false, error: 'Failed to read dispatch' };
    return this.executeDispatch(updated);
  }

  // ==================== POLLING ====================

  private async pollBuyOrders(): Promise<void> {
    if (!this.isRunning || this.isPolling) return;
    this.isPolling = true;

    try {
      // Fetch pending BUY orders (side=buy, status=pending = waiting for our payment)
      const orders = await this.client.listOrders({
        side: 'buy',
        completionStatus: 'pending',
        pageSize: 30,
      });

      for (const order of orders) {
        const orderId = order.orderId;
        if (!orderId) continue;

        // Only process orders where we need to pay (paymentStatus = unpaid)
        const paymentStatus = (order.paymentStatus || '').toLowerCase();
        if (paymentStatus !== 'unpaid') continue;

        // Skip if already processed in this session
        if (this.processedOrders.has(orderId)) continue;

        // Also check DB to avoid reprocessing after restart
        const existing = await getBuyDispatchByOrderNumber(orderId);
        if (existing) {
          this.processedOrders.add(orderId);
          continue;
        }

        // OKX provides fiatAmount directly
        const rawAmount = parseFloat(order.fiatAmount);
        const amount = Math.round(rawAmount * 100) / 100;

        if (!isFinite(amount) || isNaN(amount) || amount <= 0) {
          log.error({ orderId, rawAmount }, '[OKX-BUY] Invalid amount - skipping');
          this.processedOrders.add(orderId);
          continue;
        }

        // High-amount check
        const isHighAmount = amount > this.config.maxAmount;
        const sellerNick = order.counterpartyDetail?.nickName || 'unknown';

        if (isHighAmount) {
          log.info({ orderId, amount, maxAmount: this.config.maxAmount }, '[OKX-BUY] High amount order - requires manual approval');
        } else {
          log.info({ orderId, amount, seller: sellerNick }, '[OKX-BUY] New BUY order detected');
        }

        await this.processBuyOrder(orderId, amount, sellerNick, order, isHighAmount);
        this.processedOrders.add(orderId);
      }
    } catch (error: any) {
      log.error({ error: error?.message }, '[OKX-BUY] Poll error');
    } finally {
      this.isPolling = false;
    }
  }

  // ==================== ORDER PROCESSING ====================

  private async processBuyOrder(
    orderId: string,
    amount: number,
    sellerNick: string,
    order: OkxOrderData,
    forceManualApproval: boolean = false,
  ): Promise<void> {
    try {
      // Always fetch full order detail for BUY orders — listOrders doesn't include
      // counterpartyDetail.takerPaymentMethod which has the seller's actual bank details
      log.info({ orderId }, '[OKX-BUY] Fetching full order detail for payment info');
      const fullOrder = await this.client.getOrder(orderId);
      const orderForExtraction = fullOrder || order;

      const paymentDetails = this.extractPaymentDetails(orderForExtraction, amount);

      // If no valid account in payment fields, save as FAILED
      // NOTE: OKX has no chat API, so no background chat scan like Bybit
      if (!paymentDetails) {
        const methodType = order.paymentMethods?.[0]?.paymentType || 'desconocido';
        const errorMsg = `Cuenta invalida en campos de pago (metodo: ${methodType}) - OKX no tiene chat API, verificar manualmente`;

        await saveBuyDispatch({
          orderNumber: orderId,
          amount,
          beneficiaryName: order.counterpartyDetail?.realName || sellerNick || 'N/A',
          beneficiaryAccount: 'N/A',
          bankName: null,
          sellerNick,
          selectedPayId: 0,
          status: 'FAILED',
        });
        const saved = await getBuyDispatchByOrderNumber(orderId);
        if (saved) {
          await updateBuyDispatch(saved.id, { error: errorMsg });
        }
        this.emit('buy_order', { type: 'failed', orderNumber: orderId, error: errorMsg });
        return;
      }

      log.info({
        orderId,
        beneficiary: paymentDetails.beneficiaryName,
        account: paymentDetails.beneficiaryAccount.slice(-4).padStart(paymentDetails.beneficiaryAccount.length, '*'),
        amount: paymentDetails.amount,
      }, '[OKX-BUY] Payment details extracted');

      // Check auto-dispatch mode
      const botConfig = await getBotConfig();
      const autoDispatchEnv = process.env.OKX_AUTO_BUY_AUTO_DISPATCH;
      const autoDispatch = (autoDispatchEnv !== undefined
        ? autoDispatchEnv === 'true'
        : botConfig.autoBuyAutoDispatch) && !forceManualApproval;

      // Save dispatch to DB
      const dispatch = await saveBuyDispatch({
        orderNumber: orderId,
        amount: paymentDetails.amount,
        beneficiaryName: paymentDetails.beneficiaryName,
        beneficiaryAccount: paymentDetails.beneficiaryAccount,
        bankName: paymentDetails.bankName,
        sellerNick,
        selectedPayId: 0,
        status: autoDispatch ? 'DISPATCHING' : 'PENDING_APPROVAL',
      });

      if (forceManualApproval) {
        await updateBuyDispatch(dispatch.id, {
          error: `Monto $${paymentDetails.amount} excede $${this.config.maxAmount} - requiere autorizacion manual`,
        });
      }

      if (autoDispatch) {
        log.info({ orderId, amount: paymentDetails.amount }, '[OKX-BUY] Auto-dispatch mode - sending SPEI immediately');
        // Re-read from DB to get the real ID (saveBuyDispatch may return phantom ID on conflict)
        const realDispatch = await getBuyDispatchByOrderNumber(orderId);
        if (!realDispatch) {
          log.warn({ orderId }, '[OKX-BUY] Dispatch not found in DB after save - possible duplicate');
          return;
        }
        await this.executeDispatch(realDispatch);
      } else {
        const reason = forceManualApproval ? 'high amount' : 'manual mode';
        log.info({ orderId, amount: paymentDetails.amount, reason }, '[OKX-BUY] Awaiting dashboard approval');
        this.emit('buy_order', {
          type: 'pending_approval',
          orderNumber: orderId,
          amount: paymentDetails.amount,
          beneficiary: paymentDetails.beneficiaryName,
        });
      }
    } catch (error: any) {
      log.error({ orderId, error: error.message }, '[OKX-BUY] Processing error');
      this.emit('buy_order', { type: 'failed', orderNumber: orderId, error: error.message });
    }
  }

  // ==================== DISPATCH EXECUTION ====================

  /**
   * Execute a dispatch: send SPEI + mark order as paid on OKX
   */
  private async executeDispatch(dispatch: BuyDispatch): Promise<{ success: boolean; error?: string }> {
    const { id, orderNumber, amount, beneficiaryName, beneficiaryAccount, bankName } = dispatch;

    try {
      // Strict amount validation before sending money
      const safeAmount = Math.round(amount * 100) / 100;
      if (safeAmount !== amount || safeAmount <= 0) {
        const error = `Amount mismatch after rounding: original=${amount}, rounded=${safeAmount}`;
        await updateBuyDispatch(id, { status: 'FAILED', error });
        log.error({ orderNumber, amount, safeAmount }, `[OKX-BUY] ${error}`);
        return { success: false, error };
      }

      log.info({
        orderNumber,
        exactAmount: safeAmount,
        beneficiary: beneficiaryName,
        account: beneficiaryAccount.slice(-4).padStart(beneficiaryAccount.length, '*'),
      }, '[OKX-BUY] Sending SPEI dispatch');

      // Send SPEI via NOVACORE
      const speiResult = await this.sendSpeiPayment({
        beneficiaryName,
        beneficiaryAccount,
        bankName,
        amount: safeAmount,
        orderNumber,
      });

      if (!speiResult.success) {
        await updateBuyDispatch(id, { status: 'FAILED', error: `SPEI fallo: ${speiResult.error}` });
        log.error({ orderNumber, error: speiResult.error }, '[OKX-BUY] SPEI dispatch failed');
        this.emit('buy_order', { type: 'failed', orderNumber, error: speiResult.error });
        return { success: false, error: speiResult.error };
      }

      // Update dispatch with SPEI result
      await updateBuyDispatch(id, {
        trackingKey: speiResult.trackingKey || undefined,
        transactionId: speiResult.transactionId || undefined,
      });

      log.info({ orderNumber, trackingKey: speiResult.trackingKey }, '[OKX-BUY] SPEI sent successfully');

      // Mark order as paid on OKX (simpler than Bybit - just orderId needed)
      try {
        await this.client.markAsPaid(orderNumber);

        await updateBuyDispatch(id, {
          status: 'COMPLETED',
          dispatchedAt: new Date(),
        });

        log.info({
          orderNumber,
          amount: safeAmount,
          trackingKey: speiResult.trackingKey,
        }, '[OKX-BUY] Order completed - SPEI sent + marked as paid');

        this.emit('buy_order', {
          type: 'completed',
          orderNumber,
          amount: safeAmount,
          trackingKey: speiResult.trackingKey,
        });

        return { success: true };

      } catch (markError: any) {
        // SPEI sent but markAsPaid failed — CRITICAL: money was sent
        await updateBuyDispatch(id, {
          status: 'FAILED',
          error: `SPEI enviado pero fallo al marcar como pagada: ${markError.message}`,
          dispatchedAt: new Date(),
        });
        log.error({
          orderNumber,
          trackingKey: speiResult.trackingKey,
          error: markError.message,
        }, '[OKX-BUY] SPEI sent but FAILED to mark as paid - MANUAL ACTION NEEDED');
        this.emit('buy_order', { type: 'manual_required', orderNumber, error: markError.message });
        return { success: false, error: `SPEI enviado pero markAsPaid fallo: ${markError.message}` };
      }

    } catch (error: any) {
      await updateBuyDispatch(id, { status: 'FAILED', error: error.message });
      log.error({ orderNumber, error: error.message }, '[OKX-BUY] Dispatch execution error');
      return { success: false, error: error.message };
    }
  }

  // ==================== PAYMENT DETAIL EXTRACTION ====================

  /**
   * Extract payment details from OKX order.
   * PRIMARY: counterpartyDetail.takerPaymentMethod (Get Order response)
   * FALLBACK: paymentMethods[] array
   * Returns null if no valid 16/18-digit account found.
   */
  private extractPaymentDetails(order: OkxOrderData, amount: number): PaymentDetails | null {
    try {
      const orderId = order.orderId;

      let beneficiaryName = '';
      let beneficiaryAccount = '';
      let bankName: string | null = null;

      // PRIMARY: Extract from counterpartyDetail.takerPaymentMethod (Get Order API)
      const takerPM = order.counterpartyDetail?.takerPaymentMethod;
      if (takerPM) {
        log.info({ orderId, type: takerPM.type, bankName: takerPM.bankName, hasAccountNo: !!takerPM.accountNo },
          '[OKX-BUY] Found takerPaymentMethod in order detail');

        // accountNo = CLABE or card number
        if (takerPM.accountNo) {
          const cleaned = takerPM.accountNo.replace(/\s|-/g, '');
          if (/^\d{16}$/.test(cleaned) || /^\d{18}$/.test(cleaned)) {
            beneficiaryAccount = cleaned;
          }
        }
        // paymentMethodNumber as fallback for accountNo
        if (!beneficiaryAccount && takerPM.paymentMethodNumber) {
          const cleaned = takerPM.paymentMethodNumber.replace(/\s|-/g, '');
          if (/^\d{16}$/.test(cleaned) || /^\d{18}$/.test(cleaned)) {
            beneficiaryAccount = cleaned;
          }
        }

        // beneficiary name: accountName (real name) or paymentMethodName
        beneficiaryName = takerPM.accountName || takerPM.paymentMethodName || '';
        bankName = takerPM.bankName || null;
      }

      // FALLBACK: Extract from paymentMethods[] array (ad-level data)
      if (!beneficiaryAccount) {
        const payMethods = order.paymentMethods || [];
        if (payMethods.length > 0) {
          log.info({ orderId, methodCount: payMethods.length }, '[OKX-BUY] Trying paymentMethods[] fallback');

          for (const method of payMethods) {
            if (method.realName && !beneficiaryName) {
              beneficiaryName = method.realName;
            }
            if (method.bankName && !bankName) {
              bankName = method.bankName;
            }
            if (method.accountNo && !beneficiaryAccount) {
              const cleaned = method.accountNo.replace(/\s|-/g, '');
              if (/^\d{16}$/.test(cleaned) || /^\d{18}$/.test(cleaned)) {
                beneficiaryAccount = cleaned;
              } else {
                const digitSequences = cleaned.match(/\d+/g) || [];
                const validAccounts = digitSequences.filter((d: string) => d.length === 16 || d.length === 18);
                if (validAccounts.length > 0) {
                  beneficiaryAccount = validAccounts.find((d: string) => d.length === 18) || validAccounts[0];
                  log.info({ orderId, extracted: `...${beneficiaryAccount.slice(-4)}` }, '[OKX-BUY] Extracted account from mixed-text field');
                }
              }
            }
          }

          // Smart scan: check all method fields for digit sequences
          if (!beneficiaryAccount) {
            for (const method of payMethods) {
              const fields = [method.accountNo, method.bankName, method.realName].filter(Boolean);
              for (const value of fields) {
                if (!value) continue;
                const cleaned = value.replace(/\s|-/g, '');
                const digitSequences = cleaned.match(/\d+/g) || [];
                const validAccounts = digitSequences.filter((d: string) => d.length === 16 || d.length === 18);
                if (validAccounts.length > 0) {
                  beneficiaryAccount = validAccounts.find((d: string) => d.length === 18) || validAccounts[0];
                  log.info({ orderId, extracted: `...${beneficiaryAccount.slice(-4)}`, source: 'smart-scan' }, '[OKX-BUY] Found account via smart scan');
                  break;
                }
              }
              if (beneficiaryAccount) break;
            }
          }
        } else {
          log.error({ orderId, hasTakerPM: !!takerPM }, '[OKX-BUY] No payment data in order (no takerPaymentMethod, no paymentMethods[])');
          return null;
        }
      }

      // Fallback: counterparty realName
      if (!beneficiaryName && order.counterpartyDetail?.realName) {
        beneficiaryName = order.counterpartyDetail.realName;
      }

      // Smart scan for bank name from known banks
      if (!bankName) {
        const knownBanks = ['bbva', 'banamex', 'santander', 'banorte', 'hsbc', 'scotiabank', 'azteca', 'banco azteca', 'inbursa', 'banregio', 'bajio', 'banbajio', 'afirme', 'bancoppel', 'spin', 'nu', 'hey banco', 'klar', 'mercadopago'];
        for (const method of (order.paymentMethods || [])) {
          const fields = [method.bankName, method.realName, method.accountNo].filter(Boolean);
          for (const value of fields) {
            if (!value) continue;
            if (knownBanks.some(bank => value.toLowerCase().includes(bank))) {
              bankName = value;
              break;
            }
          }
          if (bankName) break;
        }
      }

      // Last resort: identify bank from account number
      if (!bankName && beneficiaryAccount) {
        bankName = this.getBankDisplayName(beneficiaryAccount);
      }

      // For 16-digit debit cards: resolve SPEI code
      let speiCode: string | null = null;
      if (beneficiaryAccount && beneficiaryAccount.length === 16) {
        speiCode = this.resolveSpeiCodeForCard(bankName, beneficiaryAccount);

        // STP (90646) does not issue debit cards — if we resolved to STP,
        // scan ALL method fields for fintech bank names (Albo, MercadoPago, etc.)
        // that sellers mislabel as "STP" payment method
        if (speiCode === '90646') {
          const fintechNames: Record<string, string> = {
            'albo': '90721', 'mercado pago': '90722', 'mercadopago': '90722',
            'fondeadora': '90699', 'cuenca': '90723', 'klar': '90661',
            'nu': '90638', 'nubank': '90638', 'spin': '90728', 'stori': '90706',
            'rappi': '90706', 'cashi': '90715',
          };
          for (const method of (order.paymentMethods || [])) {
            const fields = [method.bankName, method.realName, method.accountNo, method.paymentType].filter(Boolean);
            for (const value of fields) {
              if (!value) continue;
              const lower = value.toLowerCase().trim();
              for (const [name, code] of Object.entries(fintechNames)) {
                if (lower.includes(name)) {
                  log.info({ orderId, foundName: name, oldCode: '90646', newCode: code, fieldValue: value },
                    '[OKX-BUY] STP card -> found real fintech in field values');
                  speiCode = code;
                  bankName = value;
                  break;
                }
              }
              if (speiCode !== '90646') break;
            }
            if (speiCode !== '90646') break;
          }
        }

        if (!speiCode) {
          log.warn({
            orderId,
            bankName,
            cardPrefix: beneficiaryAccount.slice(0, 6),
          }, '[OKX-BUY] Could not resolve SPEI code for debit card - will fail at NOVACORE');
        }
      }

      // Log extraction summary
      log.info({
        orderId,
        beneficiaryName: beneficiaryName || 'NOT FOUND',
        beneficiaryAccount: beneficiaryAccount ? `...${beneficiaryAccount.slice(-4)}` : 'NOT FOUND',
        bankName: bankName || 'NOT FOUND',
        speiCode: speiCode || 'N/A (CLABE or unresolved)',
      }, '[OKX-BUY] Extracted fields summary');

      // Validate minimum required fields
      if (!beneficiaryAccount) {
        log.error({ orderId }, '[OKX-BUY] No bank account found in paymentMethods');
        return null;
      }
      if (!beneficiaryName) {
        log.error({ orderId }, '[OKX-BUY] No beneficiary name found');
        return null;
      }

      return {
        beneficiaryName,
        beneficiaryAccount,
        bankName: beneficiaryAccount.length === 16 ? (speiCode || bankName) : bankName,
        amount,
        orderNumber: order.orderId,
      };
    } catch (error: any) {
      log.error({ orderId: order.orderId, error: error.message }, '[OKX-BUY] Error extracting payment details');
      return null;
    }
  }

  // ==================== SPEI DISPATCH ====================

  private async sendSpeiPayment(details: PaymentDetails): Promise<SpeiResult> {
    const concept = `${this.config.conceptPrefix}-${details.orderNumber.slice(-10)}`;

    // Sanitize beneficiary name: non-Latin characters → generic name (Banxico requirement)
    let safeName = details.beneficiaryName;
    if (!/^[a-zA-ZÀ-ÿ\s.,'-]+$/.test(safeName)) {
      log.warn({
        orderNumber: details.orderNumber,
        originalName: safeName,
      }, '[OKX-BUY] Non-Latin beneficiary name detected, using generic name');
      safeName = 'JUAN MENDEZ';
    }

    // Build request body
    const body: Record<string, any> = {
      beneficiaryAccount: details.beneficiaryAccount,
      beneficiaryName: safeName.substring(0, 40),
      amount: details.amount,
      concept: concept.substring(0, 40),
      externalReference: details.orderNumber,
    };

    // beneficiaryBank required for 16-digit debit cards (not CLABE)
    if (details.beneficiaryAccount.length === 16 && details.bankName) {
      body.beneficiaryBank = details.bankName;
    }

    log.info({
      orderNumber: details.orderNumber,
      exactAmount: details.amount,
      beneficiary: body.beneficiaryName,
      accountLast4: details.beneficiaryAccount.slice(-4),
    }, '[OKX-BUY] SPEI request details');

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

      // Handle NOVACORE idempotent response: previous attempt failed at OPM
      // Auto-retry with suffixed reference to bypass idempotency
      if (data.idempotent && data.status === 'failed') {
        log.warn({
          orderNumber: details.orderNumber,
          transactionId: data.transactionId,
        }, '[OKX-BUY] NOVACORE idempotent failed — retrying with new reference');

        const retryRef = `${details.orderNumber}-R${Date.now().toString(36)}`;
        const retryBody = { ...body, externalReference: retryRef };

        try {
          const retryResp = await fetch(`${this.config.novacoreUrl}/api/integrations/spei-dispatch`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-Key': this.config.novacoreApiKey,
            },
            body: JSON.stringify(retryBody),
            signal: AbortSignal.timeout(30000),
          });
          const retryData = await retryResp.json() as any;

          if (retryResp.ok && retryData.success && !(retryData.idempotent && retryData.status === 'failed')) {
            log.info({ orderNumber: details.orderNumber, retryRef }, '[OKX-BUY] Idempotent retry succeeded');
            return { success: true, trackingKey: retryData.trackingKey, transactionId: retryData.transactionId };
          }
          return { success: false, error: retryData.error || 'SPEI retry con nueva referencia también falló' };
        } catch (retryError: any) {
          return { success: false, error: `SPEI retry falló: ${retryError.message}` };
        }
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

  // ==================== BANK LOOKUP ====================

  /**
   * Resolve SPEI code for 16-digit debit card.
   * Tries: 1) bankName->speiCode mapping, 2) BIN lookup
   */
  private resolveSpeiCodeForCard(bankName: string | null, cardNumber: string): string | null {
    if (bankName) {
      const code = this.bankNameToSpeiCode(bankName);
      // STP (90646) does not issue debit cards — try BIN lookup instead
      if (code && code !== '90646') return code;
      if (code === '90646') {
        const binCode = this.getBankFromBIN(cardNumber);
        if (binCode) return binCode;
        return code; // Fall back to STP if BIN lookup fails
      }
    }
    return this.getBankFromBIN(cardNumber);
  }

  private bankNameToSpeiCode(name: string): string | null {
    const lower = name.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const nameToCode: Record<string, string> = {
      'bbva': '40012', 'bbva mexico': '40012', 'bbva bancomer': '40012', 'bancomer': '40012',
      'banamex': '40002', 'citibanamex': '40002',
      'santander': '40014', 'banorte': '40072', 'hsbc': '40021', 'scotiabank': '40044',
      'inbursa': '40036', 'bajio': '40030', 'banco del bajio': '40030', 'banbajio': '40030',
      'banregio': '40058', 'afirme': '40062', 'mifel': '40042', 'invex': '40059',
      'azteca': '40127', 'banco azteca': '40127',
      'multiva': '40132', 'actinver': '40133', 'bancoppel': '40137',
      'compartamos': '40130', 'consubanco': '40140', 'cibanco': '40143',
      'autofin': '40128', 'bbase': '40145', 'bankaool': '40147',
      'banco covalto': '40154', 'covalto': '40154',
      'icbc': '40155', 'banco s3': '40160', 'hey banco': '40167', 'banjercito': '40019',
      'nafin': '40135', 'uala': '40138',
      'stp': '90646', 'mercadopago': '90722', 'mercado pago': '90722',
      'spin': '90728', 'spin by oxxo': '90728', 'spin/oxxo': '90728', 'oxxo': '90728',
      'klar': '90661', 'nu': '90638', 'nubank': '90638', 'nu mexico': '90638',
      'fondeadora': '90699', 'cuenca': '90723', 'albo': '90721',
      'stori': '90706', 'rappi': '90706', 'arcus': '90706',
      'kuspit': '90653', 'transfer': '90684', 'opm': '90684',
      'fincomun': '90634', 'libertad': '90670', 'cashi': '90715', 'nvio': '90710',
    };

    return nameToCode[lower] || null;
  }

  private getBankDisplayName(account: string): string | null {
    if (account.length === 18) {
      return this.getBankNameFromCLABE(account);
    }
    if (account.length === 16) {
      const speiCode = this.getBankFromBIN(account);
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

  private getBankFromBIN(cardNumber: string): string | null {
    const bin6 = cardNumber.slice(0, 6);
    const bin4 = cardNumber.slice(0, 4);

    const binMap6: Record<string, string> = {
      '402766': '40127', '474118': '40127', '457649': '40127', // Banco Azteca
      '415231': '40012', '477298': '40012', '455590': '40012', '407535': '40012', // BBVA
      '525666': '40002', '547400': '40002', '476612': '40002', // Banamex
      '418991': '40072', '441330': '40072', '517726': '40072', // Banorte
      '604244': '40137', '637230': '40137', // Bancoppel
      '551284': '90728', // Spin
    };

    const binMap4: Record<string, string> = {
      '4027': '40127', '4741': '40127', '4576': '40127', // Banco Azteca
      '4152': '40012', '4772': '40012', '4915': '40012', '4555': '40012', '4075': '40012', '4815': '40012', // BBVA
      '5256': '40002', '5474': '40002', '4766': '40002', '5204': '40002', // Banamex
      '4189': '40072', '4413': '40072', '5177': '40072', // Banorte
      '5339': '40014', '4217': '40014', '5468': '40014', // Santander
      '4213': '40021', '5429': '40021', '4263': '40021', // HSBC
      '4032': '40044', '5570': '40044', // Scotiabank
      '6042': '40137', '6372': '40137', '4169': '40137', // Bancoppel
      '5512': '90728', // Spin/Oxxo
      '4000': '40036', '5036': '40036', // Inbursa
      '5579': '40167', // Hey Banco
      '4093': '40030', // Bajio
      '4565': '40062', // Afirme
      '5101': '90638', '5230': '90638', '5355': '90638', // Nu
      '5315': '90661', // Klar
      '5519': '90706', // Rappi (Arcus)
    };

    return binMap6[bin6] || binMap4[bin4] || null;
  }
}

// ==================== FACTORY ====================

export function createOkxBuyOrderManager(config?: Partial<OkxBuyOrderConfig>): OkxBuyOrderManager {
  return new OkxBuyOrderManager(config);
}
