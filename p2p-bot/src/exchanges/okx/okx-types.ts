// =====================================================
// OKX P2P TYPES & STATUS MAPPERS
// Maps OKX-specific types to shared internal types
// ZERO imports from Binance code
// =====================================================

import {
  OrderData,
  OrderStatusString,
  TradeType,
  BankWebhookPayload,
  VerificationStatus,
  VerificationStep,
  VerificationResult,
  OrderMatch,
  SmartPositioningConfig,
  FollowModeConfig,
  PositioningAnalysis,
} from '../../types/binance.js';

// Re-export shared types used by OKX modules
export {
  OrderData,
  OrderStatusString,
  TradeType,
  BankWebhookPayload,
  VerificationStatus,
  VerificationStep,
  VerificationResult,
  OrderMatch,
  SmartPositioningConfig,
  FollowModeConfig,
  PositioningAnalysis,
};

// ==================== OKX-SPECIFIC TYPES ====================

/** OKX order status (top-level) */
export type OkxOrderStatus = 'new' | 'cancelled' | 'completed';

/** OKX payment status (sub-status for orders) */
export type OkxPaymentStatus =
  | 'unpaid'      // Buyer hasn't paid yet
  | 'paid'        // Buyer marked as paid
  | 'unreceived'  // Seller hasn't confirmed receipt
  | 'confirmed'   // Seller confirmed receipt
  | 'rejected';   // Payment rejected

/** OKX API response wrapper */
export interface OkxApiResponse<T> {
  code: string;      // "0" = success
  msg: string;       // Error message if code != "0"
  data: T;
}

/** OKX P2P order as returned by the API */
export interface OkxOrderData {
  orderId: string;
  side: 'buy' | 'sell';
  orderStatus: string;
  paymentStatus: string;
  cryptoCurrency: string;
  fiatCurrency: string;
  unitPrice: string;
  cryptoAmount: string;
  fiatAmount: string;
  createdTimestamp: string;
  paymentDeadline?: string;
  adId?: string;
  counterpartyDetail: OkxCounterpartyDetail;
  paymentMethods?: OkxPaymentMethod[];
}

/** OKX counterparty info (inline in order response) */
export interface OkxCounterpartyDetail {
  merchantId: string;
  nickName: string;
  realName: string;
  userId: string;
  completedOrders: string;
  completionRate: string;
  cancelledOrders?: string;
  kycLevel?: number;
  registerTime?: string;
  createdTimestamp?: string;
  blacklisted?: boolean;
}

/** OKX payment method */
export interface OkxPaymentMethod {
  paymentId: string;
  paymentType: string;
  bankName?: string;
  accountNo?: string;
  realName?: string;
}

/** OKX ad data from marketplace/active-list */
export interface OkxAdData {
  adId: string;
  side: 'buy' | 'sell';
  cryptoCurrency: string;
  fiatCurrency: string;
  unitPrice: string;
  availableAmount: string;
  minAmount: string;
  maxAmount: string;
  paymentMethods: OkxPaymentMethod[];
  creator: OkxAdCreator;
  status?: string;  // 'online', 'offline'
}

/** OKX ad creator info */
export interface OkxAdCreator {
  nickName: string;
  merchantId: string;
  userId?: string;
  type?: string;           // 'common', 'certified', 'diamond'
  completedOrders: number;
  completionRate: number;
  userGrade?: number;       // 1=common, 2=certified, 3=diamond
  isOnline?: boolean;
}

/** OKX ad create/update params */
export interface OkxAdParams {
  adId?: string;
  side: 'buy' | 'sell';
  cryptoCurrency: string;
  fiatCurrency: string;
  unitPrice: string;
  availableAmount?: string;
  minAmount?: string;
  maxAmount?: string;
  paymentMethods?: string[];  // payment method IDs
  remark?: string;
  autoReply?: string;
}

/** OKX ad update response (cancel+create) */
export interface OkxAdUpdateResult {
  oldAdId: string;
  newAdId: string;
}

/** OKX user basic info */
export interface OkxUserInfo {
  merchantId: string;
  nickName: string;
  userId: string;
  kycLevel: number;
  registerTime: string;
}

/** OKX balance info */
export interface OkxBalanceInfo {
  currency: string;
  available: string;
  frozen: string;
}

/** OKX spot instrument info */
export interface OkxInstrumentInfo {
  instId: string;
  instType: string;
  baseCcy: string;
  quoteCcy: string;
  lotSz: string;
  minSz: string;
  tickSz: string;
  state: string;
}

/** OKX spot order result */
export interface OkxSpotOrderResult {
  ordId: string;
  clOrdId: string;
  sCode: string;
  sMsg: string;
}

/** OKX spot order detail */
export interface OkxSpotOrderDetail {
  ordId: string;
  instId: string;
  side: string;
  sz: string;
  fillSz: string;
  fillPx: string;
  accFillSz: string;
  avgPx: string;
  state: string;    // 'filled', 'partially_filled', 'live', 'canceled'
  fee: string;
  feeCcy: string;
}

/** OKX asset transfer params */
export interface OkxTransferParams {
  ccy: string;       // Currency e.g. 'USDT'
  amt: string;       // Amount
  from: string;      // '6' = funding, '18' = trading
  to: string;        // '6' = funding, '18' = trading
  type?: string;     // '0' = within account
}

// ==================== ORDER EVENT (mirrors Binance OrderEvent) ====================

export interface OkxOrderEvent {
  type: 'new' | 'paid' | 'released' | 'cancelled' | 'expired' | 'matched';
  order: OrderData;
  match?: OrderMatch;
}

// ==================== RELEASE EVENT ====================

export interface OkxReleaseEvent {
  type: 'verification_started' | 'verification_complete' | 'release_queued' | 'release_success' | 'release_failed' | 'manual_required';
  orderNumber: string;
  reason?: string;
  data?: any;
}

// ==================== STATUS MAPPERS ====================

/**
 * Map OKX order+payment status to our internal OrderStatusString
 * This ensures DB compatibility with existing schema
 */
export function mapOkxOrderStatus(
  orderStatus: string,
  paymentStatus?: string
): OrderStatusString {
  const os = orderStatus.toLowerCase();
  const ps = (paymentStatus || '').toLowerCase();

  if (os === 'completed' || ps === 'confirmed') {
    return 'COMPLETED';
  }

  if (os === 'cancelled') {
    return 'CANCELLED';
  }

  if (os === 'new') {
    if (ps === 'paid' || ps === 'unreceived') {
      return 'BUYER_PAYED';
    }
    return 'TRADING';
  }

  // Fallback
  return 'TRADING';
}

/**
 * Map OKX side to our TradeType
 * OKX uses 'buy'/'sell' lowercase, we use 'BUY'/'SELL'
 */
export function mapOkxSide(side: string): TradeType {
  return side.toLowerCase() === 'sell' ? TradeType.SELL : TradeType.BUY;
}

/**
 * Map OKX creator type to userGrade number
 * Used for filtering in smart engine
 */
export function mapCreatorTypeToGrade(type?: string): number {
  switch (type?.toLowerCase()) {
    case 'diamond': return 3;
    case 'certified': return 2;
    case 'common':
    default: return 1;
  }
}

/**
 * Transform OKX order data to our generic OrderData for DB/events
 * This is the bridge between OKX API format and our shared data model
 */
export function toOrderData(okxOrder: OkxOrderData): OrderData {
  const status = mapOkxOrderStatus(okxOrder.orderStatus, okxOrder.paymentStatus);
  const tradeType = mapOkxSide(okxOrder.side);
  const cp = okxOrder.counterpartyDetail;

  return {
    // Map orderId → orderNumber for DB compatibility
    orderNumber: okxOrder.orderId,
    orderStatus: status,
    tradeType,
    asset: okxOrder.cryptoCurrency,
    fiat: okxOrder.fiatCurrency,
    fiatUnit: okxOrder.fiatCurrency,
    fiatSymbol: okxOrder.fiatCurrency === 'MXN' ? 'Mex$' : '$',
    amount: okxOrder.cryptoAmount,
    totalPrice: okxOrder.fiatAmount,
    unitPrice: okxOrder.unitPrice,
    commission: '0',
    createTime: parseInt(okxOrder.createdTimestamp) || Date.now(),
    counterPartNickName: cp.nickName || 'unknown',
    payMethodName: okxOrder.paymentMethods?.[0]?.paymentType || 'BANK',
    advNo: okxOrder.adId || '',

    // Buyer info from counterparty detail (inline in OKX response)
    buyer: {
      userNo: cp.userId || cp.merchantId,
      nickName: cp.nickName,
      realName: cp.realName,
      userType: 'USER',
      userGrade: cp.kycLevel || 0,
      monthFinishRate: parseFloat(cp.completionRate) || 0,
      monthOrderCount: parseInt(cp.completedOrders) || 0,
      blocked: cp.blacklisted ? '1' : '0',
      registerDays: cp.createdTimestamp
        ? Math.floor((Date.now() - parseInt(cp.createdTimestamp)) / (1000 * 60 * 60 * 24))
        : undefined,
    },
  } as OrderData;
}

/**
 * Transform OKX ad data to Binance-compatible AdData format
 * Used by smart/follow engines
 */
export function toAdData(okxAd: OkxAdData) {
  const creator = okxAd.creator;
  return {
    advNo: okxAd.adId,
    tradeType: mapOkxSide(okxAd.side),
    asset: okxAd.cryptoCurrency,
    fiatUnit: okxAd.fiatCurrency,
    price: okxAd.unitPrice,
    surplusAmount: okxAd.availableAmount,
    minSingleTransAmount: okxAd.minAmount,
    maxSingleTransAmount: okxAd.maxAmount,
    tradeMethods: (okxAd.paymentMethods || []).map(pm => ({
      payId: parseInt(pm.paymentId) || 0,
      payType: pm.paymentType,
      payBank: pm.bankName,
      identifier: pm.paymentId,
      tradeMethodName: pm.paymentType,
    })),
    advertiser: {
      userNo: creator.merchantId,
      nickName: creator.nickName,
      realName: undefined,
      userType: creator.type || 'common',
      userGrade: creator.userGrade || mapCreatorTypeToGrade(creator.type),
      monthFinishRate: creator.completionRate || 0,
      monthOrderCount: creator.completedOrders || 0,
      positiveRate: creator.completionRate || 0,
      isOnline: creator.isOnline ?? true,
      proMerchant: (creator.userGrade || 0) >= 2,
    },
    priceType: 1,  // Fixed
    priceFloatingRatio: 0,
    advStatus: okxAd.status === 'online' ? 1 : 4,
  };
}
