// =====================================================
// BYBIT BUY ORDER MANAGER
// Independent module for auto-paying BUY orders via SPEI
// Supports manual approval mode and auto-dispatch mode
// Uses BybitClient for Bybit API, shared NOVACORE for SPEI
// ZERO dependency on Binance or OKX code
// =====================================================

import { EventEmitter } from 'events';
import { getBybitClient, BybitClient } from './bybit-client.js';
import { BybitOrderData, BybitOrderDetail } from './bybit-types.js';
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

const log = logger.child({ module: 'bybit-buy' });

// ==================== INTERFACES ====================

export interface BybitBuyOrderConfig {
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
  paymentType: string;           // Bybit payment type
  paymentId: string;             // Bybit payment term ID
}

interface SpeiResult {
  success: boolean;
  trackingKey?: string;
  transactionId?: string;
  error?: string;
}

// ==================== BYBIT BUY ORDER MANAGER ====================

export class BybitBuyOrderManager extends EventEmitter {
  private client: BybitClient;
  private config: BybitBuyOrderConfig;
  private isRunning = false;
  private isPolling = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private processedOrders = new Set<string>(); // Dedup within session

  constructor(config?: Partial<BybitBuyOrderConfig>) {
    super();
    this.client = getBybitClient();
    this.config = {
      pollIntervalMs: parseInt(process.env.BYBIT_AUTO_BUY_POLL_INTERVAL_MS || '5000'),
      maxAmount: parseFloat(process.env.BYBIT_AUTO_BUY_MAX_AMOUNT || '120000'),
      novacoreUrl: process.env.BYBIT_NOVACORE_API_URL || process.env.NOVACORE_API_URL || '',
      novacoreApiKey: process.env.BYBIT_NOVACORE_API_KEY || '',
      conceptPrefix: process.env.BYBIT_AUTO_BUY_CONCEPT_PREFIX || 'BYB',
      ...config,
    };
  }

  // ==================== LIFECYCLE ====================

  async start(): Promise<void> {
    if (this.isRunning) return;

    // Validate configuration
    if (!this.config.novacoreUrl) {
      log.error('[BYBIT-BUY] NOVACORE_API_URL not configured - cannot start');
      return;
    }
    if (!this.config.novacoreApiKey) {
      log.error('[BYBIT-BUY] NOVACORE_API_KEY not configured - cannot start');
      return;
    }

    this.isRunning = true;
    log.info({
      pollInterval: this.config.pollIntervalMs,
      maxAmount: this.config.maxAmount,
      novacoreUrl: this.config.novacoreUrl,
    }, '[BYBIT-BUY] Module started');

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

    log.info('[BYBIT-BUY] Module stopped');
  }

  getStatus(): { isRunning: boolean } {
    return { isRunning: this.isRunning };
  }

  // ==================== PUBLIC: DISPATCH MANAGEMENT ====================

  /**
   * Get dispatches from DB (for dashboard).
   * For FAILED dispatches, checks Bybit order status and auto-expires
   * orders that are no longer active (canceled, completed, etc.)
   */
  async getDispatches(status?: string): Promise<(BuyDispatch & { bybitStatus?: string })[]> {
    const dispatches = await getBuyDispatches(status);

    // Enrich FAILED dispatches with live Bybit order status
    const enriched = await Promise.all(
      dispatches.map(async (d) => {
        if (d.status !== 'FAILED') return d;

        try {
          const detail = await this.client.getOrderDetail(d.orderNumber);
          if (!detail) return d;

          const bybitStatus = detail.status;

          // If order is no longer active (cancelled/completed), mark dispatch as EXPIRED
          // Bybit: 40=completed, 50/60/70/100=cancelled
          if ([40, 50, 60, 70, 100].includes(bybitStatus)) {
            const statusLabel = this.getStatusLabel(bybitStatus);
            await updateBuyDispatch(d.id, { status: 'EXPIRED', error: `Orden ${statusLabel} en Bybit` });
            return { ...d, status: 'EXPIRED', error: `Orden ${statusLabel} en Bybit`, bybitStatus: statusLabel };
          }

          return { ...d, bybitStatus: this.getStatusLabel(bybitStatus) };
        } catch (err: any) {
          const msg = err?.message || '';
          const isNotFound = msg.includes('not found') || msg.includes('does not exist') || err?.response?.status === 400;
          if (isNotFound) {
            await updateBuyDispatch(d.id, { status: 'EXPIRED', error: 'Orden ya no existe en Bybit' });
            return { ...d, status: 'EXPIRED', error: 'Orden ya no existe en Bybit' };
          }
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

    // Atomic claim: only proceed if still PENDING_APPROVAL (prevents double-click)
    const claimed = await claimBuyDispatch(dispatchId, 'PENDING_APPROVAL', 'DISPATCHING');
    if (!claimed) {
      log.warn({ dispatchId }, '[BYBIT-BUY] Dispatch already claimed by another action');
      return { success: false, error: 'Esta dispersion ya esta siendo procesada' };
    }

    log.info({
      dispatchId,
      orderNumber: dispatch.orderNumber,
      amount: dispatch.amount,
      beneficiary: dispatch.beneficiaryName,
    }, '[BYBIT-BUY] Dispatch approved manually');

    await updateBuyDispatch(dispatchId, {
      approvedAt: new Date(),
      approvedBy: approvedBy || 'dashboard',
    });

    // Execute SPEI + mark paid
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
    // Remove from session dedup so it doesn't block reprocessing
    this.processedOrders.delete(dispatch.orderNumber);

    log.info({ dispatchId, orderNumber: dispatch.orderNumber }, '[BYBIT-BUY] Dispatch rejected');
    return { success: true };
  }

  /**
   * Retry a failed dispatch -- re-extracts payment details from Bybit if needed
   */
  async retryDispatch(dispatchId: string): Promise<{ success: boolean; error?: string }> {
    const dispatch = await getBuyDispatchById(dispatchId);
    if (!dispatch) return { success: false, error: 'Dispatch not found' };
    if (dispatch.status !== 'FAILED') return { success: false, error: `Cannot retry dispatch with status: ${dispatch.status}` };

    // Atomic claim: prevents double-click sending two SPEIs
    const claimed = await claimBuyDispatch(dispatchId, 'FAILED', 'DISPATCHING');
    if (!claimed) {
      log.warn({ dispatchId }, '[BYBIT-BUY] Retry already in progress');
      return { success: false, error: 'Esta dispersion ya esta siendo procesada' };
    }

    log.info({
      dispatchId,
      orderNumber: dispatch.orderNumber,
      amount: dispatch.amount,
      currentAccount: dispatch.beneficiaryAccount,
    }, '[BYBIT-BUY] Retrying failed dispatch');

    // If account is N/A or invalid, re-extract from Bybit order details
    if (!dispatch.beneficiaryAccount || dispatch.beneficiaryAccount === 'N/A') {
      log.info({ dispatchId }, '[BYBIT-BUY] Account is N/A, re-extracting from Bybit...');
      try {
        const detail = await this.client.getOrderDetail(dispatch.orderNumber);
        if (!detail) {
          await updateBuyDispatch(dispatchId, { status: 'FAILED', error: 'No se pudo obtener detalle de orden en Bybit' });
          return { success: false, error: 'No se pudo obtener detalle de orden en Bybit' };
        }

        const paymentDetails = this.extractPaymentDetails(detail, dispatch.amount);
        if (paymentDetails) {
          await updateBuyDispatch(dispatchId, {
            beneficiaryAccount: paymentDetails.beneficiaryAccount,
            bankName: paymentDetails.bankName,
            beneficiaryName: paymentDetails.beneficiaryName,
            selectedPayId: parseInt(paymentDetails.paymentId) || 0,
            error: null as any,
          });
          const updated = await getBuyDispatchById(dispatchId);
          if (!updated) return { success: false, error: 'Failed to update dispatch' };
          return this.executeDispatch(updated);
        } else {
          await updateBuyDispatch(dispatchId, { status: 'FAILED', error: 'No se encontro cuenta valida al re-extraer de Bybit' });
          return { success: false, error: 'No se encontro cuenta valida al re-extraer de Bybit' };
        }
      } catch (e: any) {
        await updateBuyDispatch(dispatchId, { status: 'FAILED', error: e.message });
        return { success: false, error: `Error re-extrayendo de Bybit: ${e.message}` };
      }
    }

    // Account is valid, just retry with existing data
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
      // Fetch pending BUY orders (status=10 = unpaid, waiting for our payment)
      const response = await this.client.listPendingOrders({
        side: 0,   // 0 = buy
        page: 1,
        size: 30,
      });

      const orders = response.items || [];

      for (const order of orders) {
        // Only process unpaid orders (status=10)
        if (order.status !== 10) continue;

        const orderId = order.id;
        if (!orderId) continue;

        // Skip if already processed in this session
        if (this.processedOrders.has(orderId)) continue;

        // Also check DB to avoid reprocessing after restart
        const existing = await getBuyDispatchByOrderNumber(orderId);
        if (existing) {
          this.processedOrders.add(orderId);
          continue;
        }

        // Parse and validate amount with strict rounding
        // Bybit: totalPrice = amount (crypto qty) * price
        const rawAmount = parseFloat(order.amount) * parseFloat(order.price);
        const amount = Math.round(rawAmount * 100) / 100; // Strict 2-decimal rounding

        if (!isFinite(amount) || isNaN(amount) || amount <= 0) {
          log.error({ orderId, rawAmount }, '[BYBIT-BUY] Invalid amount - skipping');
          this.processedOrders.add(orderId);
          continue;
        }

        // Amount check -- high amounts go to manual approval
        const isHighAmount = amount > this.config.maxAmount;
        if (isHighAmount) {
          log.info({
            orderId,
            amount,
            maxAmount: this.config.maxAmount,
          }, '[BYBIT-BUY] High amount order - requires manual approval');
        } else {
          log.info({
            orderId,
            amount,
            seller: order.targetNickName,
          }, '[BYBIT-BUY] New BUY order detected');
        }

        // Process the order
        await this.processBuyOrder(orderId, amount, order.targetNickName || 'unknown', isHighAmount);
        this.processedOrders.add(orderId);
      }
    } catch (error: any) {
      log.error({ error: error?.message }, '[BYBIT-BUY] Poll error');
    } finally {
      this.isPolling = false;
    }
  }

  // ==================== ORDER PROCESSING ====================

  private async processBuyOrder(orderId: string, amount: number, sellerNick: string, forceManualApproval: boolean = false): Promise<void> {
    try {
      // Step 1: Get order detail to extract payment info
      const detail = await this.client.getOrderDetail(orderId);
      if (!detail) {
        log.error({ orderId }, '[BYBIT-BUY] Could not fetch order detail');
        this.emit('buy_order', { type: 'failed', orderNumber: orderId, error: 'Could not fetch order detail' });
        return;
      }

      const paymentDetails = this.extractPaymentDetails(detail, amount);

      // If no valid account in payment fields, save as FAILED
      if (!paymentDetails) {
        const payTerms = detail.paymentTermList || [];
        const methodType = payTerms[0]?.paymentType || 'desconocido';

        const errorMsg = `Cuenta invalida en campos de pago (metodo: ${methodType})`;
        await saveBuyDispatch({
          orderNumber: orderId,
          amount,
          beneficiaryName: detail.sellerRealName || sellerNick || 'N/A',
          beneficiaryAccount: 'N/A',
          bankName: null,
          sellerNick,
          selectedPayId: 0,
          status: 'FAILED',
        });
        const saved = await getBuyDispatchByOrderNumber(orderId);
        if (saved) {
          await updateBuyDispatch(saved.id, { error: errorMsg });
          // Launch background chat scan
          this.backgroundChatScan(saved.id, orderId, detail, amount);
        }
        this.emit('buy_order', { type: 'pending_chat', orderNumber: orderId });
        return;
      }

      log.info({
        orderId,
        beneficiary: paymentDetails.beneficiaryName,
        account: paymentDetails.beneficiaryAccount.slice(-4).padStart(paymentDetails.beneficiaryAccount.length, '*'),
        amount: paymentDetails.amount,
        paymentType: paymentDetails.paymentType,
      }, '[BYBIT-BUY] Payment details extracted');

      // Step 2: Check auto-dispatch mode
      const botConfig = await getBotConfig();
      const autoDispatchEnv = process.env.BYBIT_AUTO_BUY_AUTO_DISPATCH;
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
        selectedPayId: parseInt(paymentDetails.paymentId) || 0,
        status: autoDispatch ? 'DISPATCHING' : 'PENDING_APPROVAL',
      });

      if (forceManualApproval) {
        await updateBuyDispatch(dispatch.id, {
          error: `Monto $${paymentDetails.amount} excede $${this.config.maxAmount} - requiere autorizacion manual`,
        });
      }

      if (autoDispatch) {
        // Auto mode: execute immediately
        log.info({ orderId, amount: paymentDetails.amount }, '[BYBIT-BUY] Auto-dispatch mode - sending SPEI immediately');
        await this.executeDispatch(dispatch);
      } else {
        // Manual mode: wait for dashboard approval
        const reason = forceManualApproval ? 'high amount' : 'manual mode';
        log.info({ orderId, amount: paymentDetails.amount, reason }, '[BYBIT-BUY] Awaiting dashboard approval');
        this.emit('buy_order', {
          type: 'pending_approval',
          orderNumber: orderId,
          amount: paymentDetails.amount,
          beneficiary: paymentDetails.beneficiaryName,
        });
      }
    } catch (error: any) {
      log.error({ orderId, error: error.message }, '[BYBIT-BUY] Processing error');
      this.emit('buy_order', { type: 'failed', orderNumber: orderId, error: error.message });
    }
  }

  // ==================== BACKGROUND CHAT SCAN ====================

  /**
   * Runs in background (fire-and-forget) -- scans chat for CLABE/card every 30s up to 10 min.
   * Updates the dispatch error field on each attempt so dashboard shows progress.
   * If found, atomically claims the dispatch and sends SPEI.
   */
  private backgroundChatScan(dispatchId: string, orderId: string, orderDetail: BybitOrderDetail, amount: number): void {
    const MAX_ATTEMPTS = 20;
    const DELAY_MS = 30_000; // 30 seconds between attempts

    // Fire and forget -- no await
    (async () => {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));

        // Check if dispatch is still FAILED (not already claimed by manual button)
        const current = await getBuyDispatchById(dispatchId);
        if (!current || current.status !== 'FAILED') {
          log.info({ dispatchId, orderId, status: current?.status }, '[BYBIT-BUY] Background chat scan stopped - dispatch no longer FAILED');
          return;
        }

        // Update progress in error field so dashboard shows it
        const remainingSecs = (MAX_ATTEMPTS - attempt) * (DELAY_MS / 1000);
        const remainingMin = Math.ceil(remainingSecs / 60);
        await updateBuyDispatch(dispatchId, {
          error: `Buscando cuenta en chat... (intento ${attempt}/${MAX_ATTEMPTS} - ~${remainingMin} min restantes)`,
        });

        const chatDetails = await this.extractFromChat(orderId, orderDetail, amount);
        if (chatDetails) {
          log.info({
            orderId,
            attempt,
            account: `...${chatDetails.beneficiaryAccount.slice(-4)}`,
          }, '[BYBIT-BUY] Background chat scan found account!');

          // Atomic claim to prevent race with manual buttons
          const claimed = await claimBuyDispatch(dispatchId, 'FAILED', 'DISPATCHING');
          if (!claimed) {
            log.info({ dispatchId }, '[BYBIT-BUY] Background chat scan - dispatch already claimed');
            return;
          }

          await updateBuyDispatch(dispatchId, {
            beneficiaryAccount: chatDetails.beneficiaryAccount,
            bankName: chatDetails.bankName,
            beneficiaryName: chatDetails.beneficiaryName || current.beneficiaryName,
            selectedPayId: parseInt(chatDetails.paymentId) || current.selectedPayId,
            error: null as any,
          });

          const updated = await getBuyDispatchById(dispatchId);
          if (updated) await this.executeDispatch(updated);
          return;
        }

        log.info({ orderId, attempt, max: MAX_ATTEMPTS }, '[BYBIT-BUY] Background chat scan - no account yet');
      }

      // All attempts exhausted
      const current = await getBuyDispatchById(dispatchId);
      if (current && current.status === 'FAILED') {
        await updateBuyDispatch(dispatchId, {
          error: 'No se encontro cuenta en campos ni en chat (~10 min) - usa "Buscar en chat" manualmente',
        });
      }
      log.info({ orderId }, '[BYBIT-BUY] Background chat scan exhausted - no account found');
    })().catch(err => {
      log.error({ orderId, error: err.message }, '[BYBIT-BUY] Background chat scan error');
    });
  }

  /**
   * Re-scan chat for a failed dispatch -- finds CLABE/card in chat and updates dispatch data
   * Then executes the SPEI dispatch if account found
   */
  async rescanChat(dispatchId: string): Promise<{ success: boolean; error?: string }> {
    const dispatch = await getBuyDispatchById(dispatchId);
    if (!dispatch) return { success: false, error: 'Dispatch not found' };
    if (dispatch.status !== 'FAILED') return { success: false, error: `Cannot rescan dispatch with status: ${dispatch.status}` };

    // Atomic claim: prevents double-click
    const claimed = await claimBuyDispatch(dispatchId, 'FAILED', 'DISPATCHING');
    if (!claimed) {
      log.warn({ dispatchId }, '[BYBIT-BUY] Rescan already in progress');
      return { success: false, error: 'Esta dispersion ya esta siendo procesada' };
    }

    log.info({ dispatchId, orderNumber: dispatch.orderNumber }, '[BYBIT-BUY] Re-scanning chat for account...');

    // Get order detail for context
    let detail: BybitOrderDetail | null = null;
    try {
      detail = await this.client.getOrderDetail(dispatch.orderNumber);
    } catch {
      // proceed with null detail
    }

    if (!detail) {
      await updateBuyDispatch(dispatchId, { status: 'FAILED', error: 'No se pudo obtener detalle de orden' });
      return { success: false, error: 'No se pudo obtener detalle de orden' };
    }

    const chatDetails = await this.extractFromChat(dispatch.orderNumber, detail, dispatch.amount, true);
    if (!chatDetails) {
      // Return to FAILED so user can try again
      await updateBuyDispatch(dispatchId, { status: 'FAILED' });
      return { success: false, error: 'No se encontro CLABE/tarjeta en el chat' };
    }

    log.info({
      dispatchId,
      orderNumber: dispatch.orderNumber,
      account: `...${chatDetails.beneficiaryAccount.slice(-4)}`,
      bank: chatDetails.bankName,
    }, '[BYBIT-BUY] Found account in chat, updating dispatch and sending SPEI');

    // Update dispatch with new data (already DISPATCHING from atomic claim)
    await updateBuyDispatch(dispatchId, {
      beneficiaryAccount: chatDetails.beneficiaryAccount,
      bankName: chatDetails.bankName,
      beneficiaryName: chatDetails.beneficiaryName || dispatch.beneficiaryName,
      selectedPayId: parseInt(chatDetails.paymentId) || dispatch.selectedPayId,
      error: null as any,
    });

    // Re-read updated dispatch and execute
    const updated = await getBuyDispatchById(dispatchId);
    if (!updated) return { success: false, error: 'Failed to update dispatch' };

    return this.executeDispatch(updated);
  }

  // ==================== DISPATCH EXECUTION ====================

  /**
   * Execute a dispatch: send SPEI + mark order as paid on Bybit
   */
  private async executeDispatch(dispatch: BuyDispatch): Promise<{ success: boolean; error?: string }> {
    const { id, orderNumber, amount, beneficiaryName, beneficiaryAccount, bankName, selectedPayId } = dispatch;

    try {
      // Strict amount validation before sending money
      const safeAmount = Math.round(amount * 100) / 100;
      if (safeAmount !== amount || safeAmount <= 0) {
        const error = `Amount mismatch after rounding: original=${amount}, rounded=${safeAmount}`;
        await updateBuyDispatch(id, { status: 'FAILED', error });
        log.error({ orderNumber, amount, safeAmount }, `[BYBIT-BUY] ${error}`);
        return { success: false, error };
      }

      log.info({
        orderNumber,
        exactAmount: safeAmount,
        beneficiary: beneficiaryName,
        account: beneficiaryAccount.slice(-4).padStart(beneficiaryAccount.length, '*'),
      }, '[BYBIT-BUY] Sending SPEI dispatch');

      // We need the paymentType and paymentId to mark as paid on Bybit
      // Retrieve from order detail
      let paymentType = '';
      let paymentId = '';

      const detail = await this.client.getOrderDetail(orderNumber);
      if (detail && detail.paymentTermList && detail.paymentTermList.length > 0) {
        // Use the selectedPayId stored in dispatch, or fallback to first term
        const matchedTerm = detail.paymentTermList.find(t => t.id === String(selectedPayId)) || detail.paymentTermList[0];
        paymentType = matchedTerm.paymentType;
        paymentId = matchedTerm.id;
      } else if (detail) {
        paymentType = detail.paymentType || '';
        paymentId = String(selectedPayId);
      }

      // Send SPEI via NOVACORE
      const speiResult = await this.sendSpeiPayment({
        beneficiaryName,
        beneficiaryAccount,
        bankName,
        amount: safeAmount,
        orderNumber,
        paymentType,
        paymentId,
      });

      if (!speiResult.success) {
        await updateBuyDispatch(id, { status: 'FAILED', error: `SPEI fallo: ${speiResult.error}` });
        log.error({ orderNumber, error: speiResult.error }, '[BYBIT-BUY] SPEI dispatch failed');
        this.emit('buy_order', { type: 'failed', orderNumber, error: speiResult.error });
        return { success: false, error: speiResult.error };
      }

      // Update dispatch with SPEI result
      await updateBuyDispatch(id, {
        trackingKey: speiResult.trackingKey || undefined,
        transactionId: speiResult.transactionId || undefined,
      });

      log.info({ orderNumber, trackingKey: speiResult.trackingKey }, '[BYBIT-BUY] SPEI sent successfully');

      // Mark order as paid on Bybit
      try {
        await this.client.markOrderPaid(orderNumber, paymentType, paymentId);

        await updateBuyDispatch(id, {
          status: 'COMPLETED',
          dispatchedAt: new Date(),
        });

        log.info({
          orderNumber,
          amount: safeAmount,
          trackingKey: speiResult.trackingKey,
        }, '[BYBIT-BUY] Order completed - SPEI sent + marked as paid');

        this.emit('buy_order', {
          type: 'completed',
          orderNumber,
          amount: safeAmount,
          trackingKey: speiResult.trackingKey,
        });

        return { success: true };

      } catch (markError: any) {
        // SPEI sent but markOrderPaid failed
        await updateBuyDispatch(id, {
          status: 'FAILED',
          error: `SPEI enviado pero fallo al marcar como pagada: ${markError.message}`,
          dispatchedAt: new Date(),
        });
        log.error({
          orderNumber,
          trackingKey: speiResult.trackingKey,
          error: markError.message,
        }, '[BYBIT-BUY] SPEI sent but FAILED to mark as paid - MANUAL ACTION NEEDED');
        this.emit('buy_order', { type: 'manual_required', orderNumber, error: markError.message });
        return { success: false, error: `SPEI enviado pero markOrderPaid fallo: ${markError.message}` };
      }

    } catch (error: any) {
      await updateBuyDispatch(id, { status: 'FAILED', error: error.message });
      log.error({ orderNumber, error: error.message }, '[BYBIT-BUY] Dispatch execution error');
      return { success: false, error: error.message };
    }
  }

  // ==================== PAYMENT DETAIL EXTRACTION ====================

  /**
   * Extract payment details from Bybit order detail's paymentTermList.
   * Returns null if no valid 16/18-digit account found.
   */
  private extractPaymentDetails(detail: BybitOrderDetail, amount: number): PaymentDetails | null {
    try {
      const orderId = detail.id;
      const payTerms = detail.paymentTermList || [];

      if (payTerms.length === 0) {
        log.error({ orderId }, '[BYBIT-BUY] No paymentTermList in order detail');
        return null;
      }

      let beneficiaryName = '';
      let beneficiaryAccount = '';
      let bankName: string | null = null;
      let paymentType = '';
      let paymentId = '';

      for (const term of payTerms) {
        paymentType = term.paymentType || paymentType;
        paymentId = term.id || paymentId;

        // Extract realName (beneficiary)
        if (term.realName && !beneficiaryName) {
          beneficiaryName = term.realName;
        }

        // Extract bankName
        if (term.bankName && !bankName) {
          bankName = term.bankName;
        }

        // Extract accountNo (CLABE or card)
        if (term.accountNo && !beneficiaryAccount) {
          const cleaned = term.accountNo.replace(/\s|-/g, '');
          // Exact match for 16 or 18 digit
          if (/^\d{16}$/.test(cleaned) || /^\d{18}$/.test(cleaned)) {
            beneficiaryAccount = cleaned;
          } else {
            // Search within text for 16/18-digit numbers
            const digitSequences = cleaned.match(/\d+/g) || [];
            const validAccounts = digitSequences.filter((d: string) => d.length === 16 || d.length === 18);
            if (validAccounts.length > 0) {
              // Prefer 18-digit CLABE over 16-digit card
              beneficiaryAccount = validAccounts.find((d: string) => d.length === 18) || validAccounts[0];
              log.info({ orderId, extracted: `...${beneficiaryAccount.slice(-4)}` }, '[BYBIT-BUY] Extracted account from mixed-text field');
            }
          }
        }
      }

      // Fallback: seller real name from order detail
      if (!beneficiaryName && detail.sellerRealName) {
        beneficiaryName = detail.sellerRealName;
      }

      // Smart scan: if no account found, check all term fields for digit sequences
      if (!beneficiaryAccount) {
        for (const term of payTerms) {
          const fields = [term.accountNo, term.bankName, term.realName].filter(Boolean);
          for (const value of fields) {
            if (!value) continue;
            const cleaned = value.replace(/\s|-/g, '');
            const digitSequences = cleaned.match(/\d+/g) || [];
            const validAccounts = digitSequences.filter((d: string) => d.length === 16 || d.length === 18);
            if (validAccounts.length > 0) {
              beneficiaryAccount = validAccounts.find((d: string) => d.length === 18) || validAccounts[0];
              log.info({ orderId, extracted: `...${beneficiaryAccount.slice(-4)}`, source: 'smart-scan' }, '[BYBIT-BUY] Found account via smart scan');
              break;
            }
          }
          if (beneficiaryAccount) break;
        }
      }

      // Smart scan for bank name from known banks
      if (!bankName) {
        const knownBanks = ['bbva', 'banamex', 'santander', 'banorte', 'hsbc', 'scotiabank', 'azteca', 'banco azteca', 'inbursa', 'banregio', 'bajio', 'banbajio', 'afirme', 'bancoppel', 'spin', 'nu', 'hey banco', 'klar', 'mercadopago'];
        for (const term of payTerms) {
          const fields = [term.bankName, term.realName, term.accountNo].filter(Boolean);
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
        if (!speiCode) {
          log.warn({
            orderId,
            bankName,
            cardPrefix: beneficiaryAccount.slice(0, 6),
          }, '[BYBIT-BUY] Could not resolve SPEI code for debit card');
        }
      }

      // Log extraction summary
      log.info({
        orderId,
        beneficiaryName: beneficiaryName || 'NOT FOUND',
        beneficiaryAccount: beneficiaryAccount ? `...${beneficiaryAccount.slice(-4)}` : 'NOT FOUND',
        bankName: bankName || 'NOT FOUND',
        speiCode: speiCode || 'N/A (CLABE or unresolved)',
        paymentType,
      }, '[BYBIT-BUY] Extracted fields summary');

      // Validate minimum required fields
      if (!beneficiaryAccount) {
        log.error({ orderId }, '[BYBIT-BUY] No bank account found in paymentTermList');
        return null;
      }
      if (!beneficiaryName) {
        log.error({ orderId }, '[BYBIT-BUY] No beneficiary name found');
        return null;
      }

      return {
        beneficiaryName,
        beneficiaryAccount,
        bankName: beneficiaryAccount.length === 16 ? (speiCode || bankName) : bankName,
        amount,
        orderNumber: orderId,
        paymentType,
        paymentId,
      };
    } catch (error: any) {
      log.error({ orderId: detail.id, error: error.message }, '[BYBIT-BUY] Error extracting payment details');
      return null;
    }
  }

  // ==================== CHAT EXTRACTION ====================

  /**
   * When payment fields don't have a valid account, check Bybit chat messages.
   * Sellers sometimes send their CLABE/card number in the chat.
   */
  private async extractFromChat(orderId: string, orderDetail: BybitOrderDetail, amount: number, skipTimeFilter = false): Promise<PaymentDetails | null> {
    try {
      const messages = await this.client.getChatMessages(orderId);
      if (!Array.isArray(messages) || messages.length === 0) return null;

      // Only look at messages from the counterparty (not self)
      // For automatic polling: limit to last 15 minutes to avoid old CLABEs
      const sellerMessages = messages.filter((m: any) => {
        if (m.self || !m.content) return false;
        if (skipTimeFilter) return true;
        const fifteenMinAgo = Date.now() - 15 * 60 * 1000;
        const msgTime = parseInt(m.createTime) || new Date(m.createTime).getTime();
        return msgTime > fifteenMinAgo;
      });

      let foundAccount: string | null = null;
      let foundBank: string | null = null;

      // Scan messages for 16 or 18 digit numbers
      for (const msg of sellerMessages) {
        const text = (msg.content || '').replace(/\s|-/g, '');
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
        const lower = (msg.content || '').toLowerCase();
        for (const bank of knownBanks) {
          if (lower.includes(bank)) {
            foundBank = msg.content;
            break;
          }
        }
        if (foundBank) break;
      }

      // Resolve bank from account if not found in chat
      if (!foundBank) {
        foundBank = this.getBankDisplayName(foundAccount);
      }

      // Get beneficiary name from order detail
      let beneficiaryName = orderDetail.sellerRealName || '';
      if (!beneficiaryName) {
        const payTerms = orderDetail.paymentTermList || [];
        for (const term of payTerms) {
          if (term.realName) {
            beneficiaryName = term.realName;
            break;
          }
        }
      }
      if (!beneficiaryName) beneficiaryName = orderDetail.targetNickName || 'N/A';

      // Get payment type/id from order detail
      const payTerms = orderDetail.paymentTermList || [];
      const paymentType = payTerms[0]?.paymentType || orderDetail.paymentType || '';
      const paymentId = payTerms[0]?.id || '';

      // Resolve SPEI code for 16-digit cards
      let bankForDispatch: string | null = foundBank;
      if (foundAccount.length === 16) {
        const speiCode = this.resolveSpeiCodeForCard(foundBank, foundAccount);
        if (speiCode) bankForDispatch = speiCode;
      }

      log.info({
        orderId,
        account: `...${foundAccount.slice(-4)}`,
        bank: foundBank,
        source: 'chat',
      }, '[BYBIT-BUY] Extracted payment details from chat');

      return {
        beneficiaryName,
        beneficiaryAccount: foundAccount,
        bankName: bankForDispatch,
        amount,
        orderNumber: orderId,
        paymentType,
        paymentId,
      };
    } catch (error: any) {
      log.error({ orderId, error: error.message }, '[BYBIT-BUY] Error reading chat messages');
      return null;
    }
  }

  // ==================== SPEI DISPATCH ====================

  private async sendSpeiPayment(details: PaymentDetails): Promise<SpeiResult> {
    const concept = `${this.config.conceptPrefix}-${details.orderNumber.slice(-10)}`;

    // Sanitize beneficiary name: if it contains non-Latin characters (Cyrillic, Chinese, etc.)
    // use a generic name to avoid OPM/Banxico rejection
    let safeName = details.beneficiaryName;
    if (!/^[a-zA-ZÀ-ÿ\s.,'-]+$/.test(safeName)) {
      log.warn({
        orderNumber: details.orderNumber,
        originalName: safeName,
      }, '[BYBIT-BUY] Non-Latin beneficiary name detected, using generic name');
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

    // beneficiaryBank is required for 16-digit debit cards (not CLABE)
    if (details.beneficiaryAccount.length === 16 && details.bankName) {
      body.beneficiaryBank = details.bankName;
    }

    log.info({
      orderNumber: details.orderNumber,
      exactAmount: details.amount,
      beneficiary: body.beneficiaryName,
      accountLast4: details.beneficiaryAccount.slice(-4),
    }, '[BYBIT-BUY] SPEI request details');

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

      // Handle NOVACORE idempotent response: if previous attempt failed at OPM,
      // NOVACORE returns success:true + idempotent:true + status:failed
      if (data.idempotent && data.status === 'failed') {
        log.warn({
          orderNumber: details.orderNumber,
          transactionId: data.transactionId,
        }, '[BYBIT-BUY] NOVACORE returned idempotent failed - previous attempt failed, SPEI not sent');
        return {
          success: false,
          error: 'SPEI anterior fallo en OPM (idempotente) - contacta soporte para reintentar',
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

  // ==================== BANK LOOKUP ====================

  /**
   * Resolve SPEI code for 16-digit debit card.
   * Tries: 1) bankName->speiCode mapping, 2) BIN lookup
   */
  private resolveSpeiCodeForCard(bankName: string | null, cardNumber: string): string | null {
    if (bankName) {
      const code = this.bankNameToSpeiCode(bankName);
      if (code) return code;
    }
    return this.getBankFromBIN(cardNumber);
  }

  /**
   * Convert a human-readable bank name to OPM SPEI code
   */
  private bankNameToSpeiCode(name: string): string | null {
    const lower = name.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

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
      'stori': '90706',
      'rappi': '90706',
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
   */
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
   * Returns the 5-digit SPEI code
   */
  private getBankFromBIN(cardNumber: string): string | null {
    const bin6 = cardNumber.slice(0, 6);
    const bin4 = cardNumber.slice(0, 4);

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

  // ==================== HELPERS ====================

  private getStatusLabel(status: number): string {
    const labels: Record<number, string> = {
      5: 'Pre-order',
      10: 'Unpaid',
      20: 'Paid',
      30: 'Released',
      40: 'Completed',
      50: 'Cancelled (buyer)',
      60: 'Cancelled (seller)',
      70: 'Cancelled (system)',
      80: 'Appeal',
      90: 'Appeal resolved',
      100: 'Timeout cancelled',
      110: 'Other',
    };
    return labels[status] || `Status ${status}`;
  }
}

// ==================== FACTORY ====================

export function createBybitBuyOrderManager(config?: Partial<BybitBuyOrderConfig>): BybitBuyOrderManager {
  return new BybitBuyOrderManager(config);
}
