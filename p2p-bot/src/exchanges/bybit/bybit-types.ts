// =====================================================
// BYBIT P2P TYPES & STATUS MAPPERS
// Maps Bybit-specific types to shared internal types
// ZERO imports from Binance or OKX code
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

// Re-export shared types used by Bybit modules
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

// ==================== BYBIT-SPECIFIC TYPES ====================

/** Bybit API response wrapper */
export interface BybitApiResponse<T> {
  ret_code: number;    // 0 = success
  ret_msg: string;
  result: T;
  ext_code: string;
  ext_info: any;
  time_now: string;
}

/** Bybit V5-style response wrapper (some endpoints use this) */
export interface BybitV5Response<T> {
  retCode: number;
  retMsg: string;
  result: T;
  retExtInfo: any;
  time: number;
}

// ==================== AD TYPES ====================

/** Bybit ad side: 0=buy, 1=sell */
export type BybitSide = '0' | '1';

/** Bybit ad price type: 0=fixed, 1=floating */
export type BybitPriceType = '0' | '1';

/** Bybit ad status: 10=online, 20=offline, 30=completed */
export type BybitAdStatus = 10 | 20 | 30;

/** Trading preferences for ad creation/update */
export interface BybitTradingPreferences {
  hasUnPostAd?: string;
  isKyc?: string;
  isEmail?: string;
  isMobile?: string;
  hasRegisterTime?: string;
  registerTimeThreshold?: string;
  orderFinishNumberDay30?: string;
  completeRateDay30?: string;
  nationalLimit?: string;
  hasOrderFinishNumberDay30?: string;
  hasCompleteRateDay30?: string;
  hasNationalLimit?: string;
}

/** Bybit ad from marketplace (online list) */
export interface BybitMarketplaceAd {
  id: string;
  userId: number;
  nickName: string;
  tokenId: string;
  currencyId: string;
  side: string;           // '0' = buy, '1' = sell
  price: string;
  lastQuantity: string;   // Available tradable amount
  minAmount: string;
  maxAmount: string;
  payments: string[];     // Payment method type IDs
  recentOrderNum: string;
  recentExecuteRate: string;
  isOnline: boolean;
  lastLogoutTime: string;
  authTag: string[];      // 'GA', 'VA', 'BA'
  paymentPeriod: number;
}

/** Bybit ad from personal list (my ads) */
export interface BybitMyAd {
  id: string;
  accountId: string;
  userId: string;
  nickName: string;
  tokenId: string;
  currencyId: string;
  side: number;           // 0 = buy, 1 = sell
  priceType: number;      // 0 = fixed, 1 = floating
  price: string;
  premium: string;
  lastQuantity: string;
  quantity: string;
  frozenQuantity: string;
  executedQuantity: string;
  minAmount: string;
  maxAmount: string;
  remark: string;
  status: BybitAdStatus;
  createDate: string;
  updateDate: string;
  payments: string[];
  hiddenReason: string;
  feeRate: string;
  paymentPeriod: number;
  itemType: string;       // 'ORIGIN' | 'BULK'
  tradingPreferenceSet: BybitTradingPreferences;
  paymentTerms?: BybitPaymentTerm[];
}

/** Payment term details */
export interface BybitPaymentTerm {
  id: string;
  paymentType: string;
  bankName?: string;
  accountNo?: string;
  mobile?: string;
}

/** Params for creating an ad */
export interface BybitCreateAdParams {
  tokenId: string;
  currencyId: string;
  side: BybitSide;
  priceType: BybitPriceType;
  premium: string;
  price: string;
  minAmount: string;
  maxAmount: string;
  remark: string;
  tradingPreferenceSet: BybitTradingPreferences;
  paymentIds: string[];
  quantity: string;
  paymentPeriod: string;
  itemType: string;       // 'ORIGIN' | 'BULK'
}

/** Params for updating an ad */
export interface BybitUpdateAdParams {
  id: string;
  priceType: string;
  premium: string;
  price: string;
  minAmount: string;
  maxAmount: string;
  remark: string;
  tradingPreferenceSet: BybitTradingPreferences;
  paymentIds: string[];
  actionType: 'MODIFY' | 'ACTIVE';  // MODIFY=edit, ACTIVE=re-online
  quantity: string;
  paymentPeriod: string;
}

/** Create/update ad response */
export interface BybitAdMutationResult {
  itemId?: string;
  securityRiskToken?: string;
  riskTokenType?: string;
  riskVersion?: string;
  needSecurityRisk?: boolean;
}

// ==================== ORDER TYPES ====================

/**
 * Bybit order status codes:
 *  5  = Pre-order
 * 10  = Unpaid (waiting for buyer payment)
 * 20  = Paid (buyer marked paid)
 * 30  = Released (seller released crypto)
 * 40  = Completed
 * 50  = Cancelled by buyer
 * 60  = Cancelled by seller
 * 70  = Cancelled by system
 * 80  = Appeal in progress
 * 90  = Appeal resolved
 * 100 = Timeout cancelled
 * 110 = Other
 */
export type BybitOrderStatus = 5 | 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 100 | 110;

/** Bybit P2P order */
export interface BybitOrderData {
  id: string;
  side: number;            // 0=buy, 1=sell
  tokenId: string;
  orderType: string;       // 'ORIGIN', 'SMALL_COIN', 'WEB3'
  amount: string;          // Trade amount (crypto)
  currencyId: string;
  price: string;
  fee: string;
  targetNickName: string;  // Counterparty nickname
  targetUserId: string;    // Counterparty UID
  status: BybitOrderStatus;
  createDate: string;
  transferLastSeconds: string;
  userId: string;
  sellerRealName: string;
  buyerRealName: string;
  extension?: {
    isDelayWithdraw: boolean;
    delayTime: string;
    startTime: string;
  };
}

/** Bybit P2P order detail (from /v5/p2p/order/info) */
export interface BybitOrderDetail {
  id: string;
  side: number;
  itemId: string;
  userId: string;
  nickName: string;
  makerUserId: string;
  targetUserId: string;
  targetNickName: string;
  targetConnectInformation: string;
  sellerRealName: string;
  buyerRealName: string;
  tokenId: string;
  currencyId: string;
  price: string;
  quantity: string;
  amount: string;
  paymentType: string;
  transferDate: string;
  status: BybitOrderStatus;
  createDate: string;
  paymentTermList?: Array<{
    id: string;
    paymentType: string;
    bankName?: string;
    accountNo?: string;
    realName?: string;
  }>;
  remark: string;
  transferLastSeconds: string;
  appealContent?: string;
  appealType?: string;
  appealNickName?: string;
  canAppeal: boolean;
  confirmedPayTerm?: any;
  makerFee: string;
  takerFee: string;
  extension?: {
    isDelayWithdraw: boolean;
    delayTime: string;
    startTime: string;
  };
  orderType: string;
  cancelReason?: string;
  fee?: string;
}

// ==================== USER TYPES ====================

/** Bybit P2P user account info */
export interface BybitUserInfo {
  nickName: string;
  defaultNickName: boolean;
  isOnline: boolean;
  kycLevel: string;
  email: string;
  mobile: string;
  lastLogoutTime: string;
  recentRate: string;          // Completion rate last 30 days
  totalFinishCount: number;
  totalFinishSellCount: number;
  totalFinishBuyCount: number;
  recentFinishCount: number;
  averageReleaseTime: string;  // Minutes
  averageTransferTime: string; // Minutes
  accountCreateDays: number;
  firstTradeDays: number;
  realName: string;
  recentTradeAmount: string;   // USDT, 30 days
  totalTradeAmount: string;    // USDT, lifetime
  registerTime: string;
  authStatus: number;          // 1=VA, 2=Not VA
  kycCountryCode: string;
  blocked: string;
  goodAppraiseRate: string;
  goodAppraiseCount: number;
  badAppraiseCount: number;
  accountId: number;
  userId: string;
  realNameEn: string;
  vipLevel: number;
}

// ==================== BALANCE TYPES ====================

export interface BybitCoinBalance {
  coin: string;
  walletBalance: string;
  transferBalance: string;
  bonus: string;
}

// ==================== ORDER EVENT ====================

export interface BybitOrderEvent {
  type: 'new' | 'paid' | 'released' | 'cancelled' | 'expired' | 'matched';
  order: OrderData;
  match?: OrderMatch;
}

export interface BybitReleaseEvent {
  type: 'verification_started' | 'verification_complete' | 'release_queued' | 'release_success' | 'release_failed' | 'manual_required';
  orderNumber: string;
  reason?: string;
  data?: any;
}

// ==================== STATUS MAPPERS ====================

/**
 * Map Bybit order status code to our internal OrderStatusString
 */
export function mapBybitOrderStatus(status: BybitOrderStatus): OrderStatusString {
  switch (status) {
    case 5:
    case 10:
      return 'TRADING';          // Waiting for payment
    case 20:
      return 'BUYER_PAYED';     // Buyer marked paid
    case 30:
    case 40:
      return 'COMPLETED';       // Released/completed
    case 50:
    case 60:
      return 'CANCELLED';       // Cancelled by user
    case 70:
    case 100:
      return 'CANCELLED_BY_SYSTEM'; // System/timeout cancel
    case 80:
    case 90:
      return 'APPEALING';       // Appeal
    default:
      return 'TRADING';
  }
}

/**
 * Map Bybit side (0/1) to our TradeType
 */
export function mapBybitSide(side: number | string): TradeType {
  return String(side) === '1' ? TradeType.SELL : TradeType.BUY;
}

/**
 * Map Bybit authTag to userGrade number
 * BA=3 (Block Advertiser), VA=2 (Verified), GA=1 (General)
 */
export function mapAuthTagToGrade(authTag: string[]): number {
  if (authTag.includes('BA')) return 3;
  if (authTag.includes('VA')) return 2;
  if (authTag.includes('GA')) return 1;
  return 0;
}

/**
 * Transform Bybit order to our generic OrderData for DB/events
 */
export function toOrderData(bybitOrder: BybitOrderData): OrderData {
  const status = mapBybitOrderStatus(bybitOrder.status);
  const tradeType = mapBybitSide(bybitOrder.side);
  const isSell = bybitOrder.side === 1;

  return {
    orderNumber: bybitOrder.id,
    orderStatus: status,
    tradeType,
    asset: bybitOrder.tokenId,
    fiat: bybitOrder.currencyId,
    fiatUnit: bybitOrder.currencyId,
    fiatSymbol: bybitOrder.currencyId === 'MXN' ? 'Mex$' : '$',
    amount: bybitOrder.amount,
    totalPrice: String(parseFloat(bybitOrder.amount) * parseFloat(bybitOrder.price)),
    unitPrice: bybitOrder.price,
    commission: bybitOrder.fee || '0',
    createTime: parseInt(bybitOrder.createDate) || Date.now(),
    counterPartNickName: bybitOrder.targetNickName || 'unknown',
    payMethodName: 'BANK',
    advNo: '',
    buyer: {
      userNo: isSell ? bybitOrder.targetUserId : bybitOrder.userId,
      nickName: isSell ? bybitOrder.targetNickName : '',
      realName: bybitOrder.buyerRealName,
      userType: 'USER',
      userGrade: 0,
      monthFinishRate: 0,
      monthOrderCount: 0,
    },
    seller: {
      userNo: isSell ? bybitOrder.userId : bybitOrder.targetUserId,
      nickName: isSell ? '' : bybitOrder.targetNickName,
      realName: bybitOrder.sellerRealName,
      userType: 'USER',
      userGrade: 0,
      monthFinishRate: 0,
      monthOrderCount: 0,
    },
  } as OrderData;
}

/**
 * Transform Bybit marketplace ad to Binance-compatible AdData format
 */
export function toAdData(ad: BybitMarketplaceAd) {
  const grade = mapAuthTagToGrade(ad.authTag);
  return {
    advNo: ad.id,
    tradeType: mapBybitSide(ad.side),
    asset: ad.tokenId,
    fiatUnit: ad.currencyId,
    price: ad.price,
    surplusAmount: ad.lastQuantity,
    minSingleTransAmount: ad.minAmount,
    maxSingleTransAmount: ad.maxAmount,
    tradeMethods: ad.payments.map(p => ({
      payId: parseInt(p) || 0,
      payType: p,
      identifier: p,
      tradeMethodName: p,
    })),
    advertiser: {
      userNo: String(ad.userId),
      nickName: ad.nickName,
      realName: undefined,
      userType: ad.authTag[0] || 'GA',
      userGrade: grade,
      monthFinishRate: parseFloat(ad.recentExecuteRate) || 0,
      monthOrderCount: parseInt(ad.recentOrderNum) || 0,
      positiveRate: parseFloat(ad.recentExecuteRate) || 0,
      isOnline: ad.isOnline,
      proMerchant: grade >= 2,
    },
    priceType: 1,
    priceFloatingRatio: 0,
    advStatus: 1,
  };
}
