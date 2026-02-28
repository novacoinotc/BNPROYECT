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
            beneficiaryAccount = value.replace(/\s|-/g, ''); // Strip spaces/dashes
          } else if (isBank && value && !bankName) {
            bankName = value;
          } else if (isIBAN && value && !beneficiaryAccount) {
            beneficiaryAccount = value.replace(/\s|-/g, ''); // Strip spaces/dashes
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

      // Last resort: identify bank from account number
      // Works for both 18-digit CLABE (prefix) and 16-digit cards (BIN)
      if (!bankName && beneficiaryAccount) {
        bankName = this.getBankFromAccount(beneficiaryAccount);
      }

      // Log everything we found for debugging
      logger.info({
        orderNumber,
        methodName,
        beneficiaryName: beneficiaryName || 'NOT FOUND',
        beneficiaryAccount: beneficiaryAccount ? `...${beneficiaryAccount.slice(-4)}` : 'NOT FOUND',
        bankName: bankName || 'NOT FOUND',
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

  // ==================== BANK LOOKUP ====================

  /**
   * Identify Mexican bank from account number.
   * For 18-digit CLABE: first 3 digits = bank code (Banxico standard)
   * For 16-digit debit card: first 4-6 digits = BIN
   */
  private getBankFromAccount(account: string): string | null {
    if (account.length === 18) {
      return this.getBankFromCLABE(account);
    }
    if (account.length === 16) {
      return this.getBankFromBIN(account);
    }
    return null;
  }

  /**
   * Identify Mexican bank from CLABE prefix (first 3 digits)
   * Based on Banxico's catalog of bank codes
   */
  private getBankFromCLABE(clabe: string): string | null {
    const prefix = clabe.slice(0, 3);

    const clabeMap: Record<string, string> = {
      '002': 'BBVA',
      '006': 'Bancomext',
      '009': 'Banobras',
      '012': 'BBVA',
      '014': 'Santander',
      '021': 'HSBC',
      '030': 'Bajio',
      '032': 'IXE',
      '036': 'Inbursa',
      '037': 'Interacciones',
      '042': 'Mifel',
      '044': 'Scotiabank',
      '058': 'Banregio',
      '059': 'Invex',
      '060': 'Bansi',
      '062': 'Afirme',
      '072': 'Banorte',
      '102': 'ABN AMRO',
      '103': 'American Express',
      '106': 'BAMSA',
      '108': 'Tokyo',
      '110': 'JP Morgan',
      '112': 'Bmonex',
      '113': 'Ve por Mas',
      '116': 'ING',
      '124': 'Deutsche',
      '126': 'Credit Suisse',
      '127': 'Azteca',
      '128': 'Autofin',
      '129': 'Barclays',
      '130': 'Compartamos',
      '131': 'Banco Famsa',
      '132': 'Multiva',
      '133': 'Actinver',
      '134': 'Walmart',
      '135': 'Nafin',
      '136': 'Interbanco',
      '137': 'Bancoppel',
      '138': 'ABC Capital',
      '139': 'UBS',
      '140': 'Consubanco',
      '141': 'Volkswagen',
      '143': 'CIBanco',
      '145': 'Bbase',
      '147': 'Bankaool',
      '148': 'PagaTodo',
      '149': 'Inmobiliario Mexicano',
      '150': 'NuBank',
      '151': 'Donde',
      '152': 'Bancrea',
      '154': 'Banco Covalto',
      '155': 'ICBC',
      '156': 'Sabadell',
      '157': 'Shinhan',
      '158': 'Mizuho',
      '159': 'Bank of China',
      '160': 'Banco S3',
      '166': 'BanBajio',
      '168': 'Hipotecaria Federal',
      '600': 'Monexcb',
      '601': 'GBM',
      '602': 'Masari',
      '605': 'Valué',
      '606': 'Fondos Mexicanos',
      '608': 'CB Intercam',
      '610': 'B&B',
      '613': 'Multiva CBOLSA',
      '616': 'Finamex',
      '617': 'Valmex',
      '618': 'Unica',
      '619': 'MAPFRE',
      '620': 'Profuturo',
      '621': 'CB Actinver',
      '622': 'Oactin',
      '623': 'Cibanco',
      '626': 'CBDEUTSCHE',
      '627': 'Zurich',
      '628': 'Zurichvi',
      '629': 'SU Casita',
      '630': 'CB Intercam',
      '631': 'CI Bolsa',
      '632': 'Bulltick CB',
      '633': 'Sterling',
      '634': 'Fincomun',
      '636': 'HDI Seguros',
      '637': 'Order',
      '638': 'Akala',
      '640': 'CB JP Morgan',
      '642': 'Reforma',
      '646': 'STP',
      '648': 'Evercore',
      '649': 'Skandia',
      '651': 'Segmty',
      '652': 'Asea',
      '653': 'Kuspit',
      '655': 'Sofiexpress',
      '656': 'Unagra',
      '659': 'ASP Integra OPC',
      '670': 'Libertad',
      '674': 'CASHI',
      '677': 'Caja Pop Mexicana',
      '679': 'Fondo de la Vivienda del ISSSTE',
      '680': 'Cristobal Colon',
      '683': 'Caja Telefonistas',
      '684': 'Transfer',
      '685': 'Fomped',
      '686': 'Fonaes',
      '689': 'Fondeadora',
      '699': 'Bnuvola',
      '703': 'Tesored',
      '706': 'Arcus',
      '710': 'Nvio',
      '722': 'Mercadopago',
      '723': 'Cuenca',
      '728': 'Spin by Oxxo',
      '729': 'Telegraph',
      '730': 'Klar',
      '901': 'CoDi Valida',
      '902': 'Indeval',
    };

    return clabeMap[prefix] || null;
  }

  /**
   * Identify Mexican bank from debit card BIN (first 4-6 digits)
   */
  private getBankFromBIN(cardNumber: string): string | null {
    const bin6 = cardNumber.slice(0, 6);
    const bin4 = cardNumber.slice(0, 4);

    // Common Mexican debit card BINs (4-digit)
    const binMap4: Record<string, string> = {
      // Banco Azteca
      '4027': 'Banco Azteca',
      '4741': 'Banco Azteca',
      '4576': 'Banco Azteca',
      // BBVA
      '4152': 'BBVA',
      '4772': 'BBVA',
      '4915': 'BBVA',
      '4555': 'BBVA',
      '4075': 'BBVA',
      // Banamex/Citibanamex
      '5256': 'Banamex',
      '5474': 'Banamex',
      '4766': 'Banamex',
      '5204': 'Banamex',
      // Banorte
      '4189': 'Banorte',
      '4413': 'Banorte',
      '5177': 'Banorte',
      // Santander
      '5339': 'Santander',
      '4217': 'Santander',
      '5468': 'Santander',
      // HSBC
      '4213': 'HSBC',
      '5429': 'HSBC',
      '4263': 'HSBC',
      // Scotiabank
      '4032': 'Scotiabank',
      '5570': 'Scotiabank',
      // Bancoppel
      '6042': 'Bancoppel',
      '6372': 'Bancoppel',
      // Spin/Oxxo
      '5512': 'Spin',
      // Inbursa
      '4000': 'Inbursa',
      '5036': 'Inbursa',
      // Hey Banco / Banregio
      '5579': 'Hey Banco',
      // Banco del Bajio
      '4093': 'Bajio',
      // Afirme
      '4565': 'Afirme',
      // Nu / NuBank
      '5230': 'Nu',
      '5355': 'Nu',
      // Stori
      '5255': 'Stori',
      // Klar
      '5315': 'Klar',
      // Rappi
      '5519': 'Rappi',
    };

    // 6-digit BINs (higher precision, checked first)
    const binMap6: Record<string, string> = {
      // Banco Azteca
      '402766': 'Banco Azteca',
      '474118': 'Banco Azteca',
      '457649': 'Banco Azteca',
      // BBVA
      '415231': 'BBVA',
      '477298': 'BBVA',
      '455590': 'BBVA',
      '407535': 'BBVA',
      // Banamex
      '525666': 'Banamex',
      '547400': 'Banamex',
      '476612': 'Banamex',
      // Banorte
      '418991': 'Banorte',
      '441330': 'Banorte',
      '517726': 'Banorte',
      // Bancoppel
      '604244': 'Bancoppel',
      '637230': 'Bancoppel',
      // Spin
      '551284': 'Spin',
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
