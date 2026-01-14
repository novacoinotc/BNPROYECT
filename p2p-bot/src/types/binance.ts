// =====================================================
// BINANCE C2C API TYPES
// Based on SAPI v7.4 Documentation
// =====================================================

// ==================== ENUMS ====================

export enum TradeType {
  BUY = 'BUY',
  SELL = 'SELL'
}

// Order status as returned by the API (string values)
export type OrderStatusString =
  | 'TRADING'           // Wait for payment
  | 'BUYER_PAYED'       // Buyer marked as paid, wait for release
  | 'APPEALING'         // In dispute/appeal
  | 'COMPLETED'         // Order completed
  | 'CANCELLED'         // Cancelled by user
  | 'CANCELLED_BY_SYSTEM';  // Cancelled by system/timeout

// Legacy numeric status (for database compatibility)
export enum OrderStatus {
  PENDING = 1,           // Wait for payment
  PAID = 2,              // Wait for release (buyer marked as paid)
  APPEALING = 3,         // In dispute/appeal
  COMPLETED = 4,         // Order completed
  CANCELLED = 5,         // Cancelled by user
  CANCELLED_SYSTEM = 6,  // Cancelled by system
  CANCELLED_TIMEOUT = 7  // Cancelled by timeout
}

// Map string status to database status
export function mapOrderStatus(status: OrderStatusString): string {
  const statusMap: Record<OrderStatusString, string> = {
    'TRADING': 'PENDING',
    'BUYER_PAYED': 'PAID',
    'APPEALING': 'APPEALING',
    'COMPLETED': 'COMPLETED',
    'CANCELLED': 'CANCELLED',
    'CANCELLED_BY_SYSTEM': 'CANCELLED_SYSTEM',
  };
  return statusMap[status] || 'PENDING';
}

export enum PriceType {
  FIXED = 1,
  FLOATING = 2
}

export enum PayType {
  BANK = 'BANK',
  WECHAT = 'WECHAT',
  ALIPAY = 'ALIPAY',
  SPEI = 'SPEI',
  OXXO = 'OXXO',
  CASH = 'CASH'
}

export enum AuthType {
  GOOGLE = 'GOOGLE',
  SMS = 'SMS',
  FIDO2 = 'FIDO2',
  FUND_PWD = 'FUND_PWD'
}

export enum ChatMessageType {
  TEXT = 'text',
  IMAGE = 'image',
  AUTO_REPLY = 'auto_reply',
  CARD = 'card',
  SYSTEM = 'system',
  ERROR = 'error',
  MARK = 'mark',
  RECALL = 'recall',
  TRANSLATE = 'translate',
  VIDEO = 'video'
}

// ==================== REQUEST TYPES ====================

export interface SearchAdsRequest {
  asset: string;
  fiat: string;
  tradeType: TradeType;
  page?: number;
  rows?: number;
  payTypes?: string[];
  publisherType?: string;
  transAmount?: number;
}

export interface UpdateAdRequest {
  advNo: string;
  advStatus?: number;
  price?: number;
  priceType?: PriceType;
  priceFloatingRatio?: number;
  minSingleTransAmount?: number;
  maxSingleTransAmount?: number;
  minSingleTransQuantity?: number;
  maxSingleTransQuantity?: number;
  remarks?: string;
  autoReplyMsg?: string;
  payTimeLimit?: number;
  tradeMethods?: TradeMethodRequest[];
}

export interface TradeMethodRequest {
  identifier: string;
  payId?: number;
}

export interface ListOrdersRequest {
  tradeType?: TradeType;
  orderStatus?: OrderStatus;
  asset?: string;
  fiat?: string;
  page?: number;
  rows?: number;
  startTimestamp?: number;
  endTimestamp?: number;
}

export interface OrderDetailRequest {
  orderNumber: string;
}

export interface ReleaseCoinRequest {
  orderNumber: string;
  authType: AuthType;
  code: string;
  googleVerifyCode?: string;
  mobileVerifyCode?: string;
}

export interface MarkOrderAsPaidRequest {
  orderNumber: string;
  payId: number;
}

export interface ChatMessagesRequest {
  orderNo: string;
  page?: number;
  rows?: number;
}

// ==================== RESPONSE TYPES ====================

export interface BinanceApiResponse<T> {
  code: string;
  message: string;
  data: T;
  success: boolean;
}

export interface AdData {
  advNo: string;
  tradeType: TradeType;
  asset: string;
  fiatUnit: string;
  price: string;
  surplusAmount: string;
  minSingleTransAmount: string;
  maxSingleTransAmount: string;
  tradeMethods: TradeMethod[];
  advertiser: Advertiser;
  priceType: PriceType;
  priceFloatingRatio: number;
  advStatus: number;
}

export interface TradeMethod {
  payId: number;
  payType: string;
  payAccount?: string;
  payBank?: string;
  identifier: string;
  tradeMethodName: string;
  iconUrlColor?: string;
}

export interface Advertiser {
  userNo: string;
  realName?: string;
  nickName: string;
  userType: string;
  userGrade: number;
  monthFinishRate: number;
  monthOrderCount: number;
  positiveRate: number;
  isOnline: boolean;
  proMerchant?: boolean;
}

// Order data as returned by listUserOrderHistory API
export interface OrderData {
  orderNumber: string;
  orderStatus: OrderStatusString;  // String like "TRADING", "BUYER_PAYED", etc.
  tradeType: TradeType;
  asset: string;
  fiat: string;              // API returns 'fiat', not 'fiatUnit'
  fiatUnit?: string;         // Keep for compatibility
  fiatSymbol: string;        // e.g., "Mex$"
  amount: string;
  totalPrice: string;
  unitPrice: string;
  commission: string;
  takerCommission?: string;
  takerCommissionRate?: string;
  takerAmount?: string;
  createTime: number;
  counterPartNickName: string;  // API returns this instead of buyer/seller objects
  payMethodName: string;        // e.g., "BANK"
  additionalKycVerify?: number;
  advNo: string;
  // Legacy fields (may be present in order detail endpoint)
  payMethods?: TradeMethod[];
  buyer?: UserInfo;
  seller?: UserInfo;
  confirmPayEndTime?: number;
  notifyPayEndTime?: number;
  chatEnabled?: boolean;
}

export interface UserInfo {
  userNo: string;
  realName?: string;
  nickName: string;
  userType: string;
  userGrade: number;
  monthFinishRate: number;
  monthOrderCount: number;
}

export interface UserStats {
  completedOrderNum: number;
  completedOrderNumOfLatest30day: number;
  finishRate: number;
  finishRateLatest30Day: number;
  avgPayTime: number;
  avgReleaseTime: number;
  creditScore: number;
  registerDays: number;
}

export interface ChatCredential {
  chatWssUrl: string;
  listenKey: string;
  listenToken: string;
}

export interface ChatMessage {
  id: number;
  content: string;
  createTime: string;
  fromNickName: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  type: ChatMessageType;
  status: 'read' | 'unread';
  self: boolean;
  orderNo: string;
  uuid: string;
  height?: number;
  width?: number;
  imageType?: string;
}

export interface MerchantAdsDetail {
  buyList: AdData[];
  sellList: AdData[];
  merchant: {
    monthFinishRate: number;
    monthOrderCount: number;
    onlineStatus: string;
  };
}

export interface ReferencePrice {
  price: string;
  fiatUnit: string;
  asset: string;
  tradeType: TradeType;
}

// ==================== WEBHOOK TYPES ====================

export interface BankWebhookPayload {
  transactionId: string;
  amount: number;
  currency: string;
  senderName: string;
  senderAccount: string;
  receiverAccount: string;
  concept: string;
  timestamp: string;
  bankReference: string;
  status: 'completed' | 'pending' | 'failed';
}

// ==================== VERIFICATION STATES ====================

export enum VerificationStatus {
  // Initial states
  AWAITING_PAYMENT = 'AWAITING_PAYMENT',           // Order created, waiting for buyer to pay

  // Payment arrival scenarios
  BUYER_MARKED_PAID = 'BUYER_MARKED_PAID',         // Buyer clicked "paid", waiting for bank confirmation
  BANK_PAYMENT_RECEIVED = 'BANK_PAYMENT_RECEIVED', // Bank payment received, waiting for buyer to mark paid

  // Matching states
  PAYMENT_MATCHED = 'PAYMENT_MATCHED',             // Bank payment linked to order

  // Verification states
  AMOUNT_VERIFIED = 'AMOUNT_VERIFIED',             // Amount matches within tolerance
  AMOUNT_MISMATCH = 'AMOUNT_MISMATCH',             // Amount doesn't match
  NAME_VERIFIED = 'NAME_VERIFIED',                 // Payer name matches buyer name
  NAME_MISMATCH = 'NAME_MISMATCH',                 // Names don't match

  // Final states
  READY_TO_RELEASE = 'READY_TO_RELEASE',           // All checks passed, ready for release
  RELEASED = 'RELEASED',                           // Crypto released
  MANUAL_REVIEW = 'MANUAL_REVIEW',                 // Needs human intervention
}

export interface VerificationStep {
  timestamp: Date;
  status: VerificationStatus;
  message: string;
  details?: Record<string, any>;
}

export interface VerificationResult {
  orderNumber: string;
  currentStatus: VerificationStatus;
  timeline: VerificationStep[];
  recommendation: 'RELEASE' | 'MANUAL_REVIEW' | 'WAIT';
  checks: {
    bankPaymentReceived: boolean;
    buyerMarkedPaid: boolean;
    amountMatches: boolean;
    nameMatches: boolean | null; // null = not checked yet
  };
  bankPayment?: {
    transactionId: string;
    amount: number;
    senderName: string;
    receivedAt: Date;
  };
  orderDetails?: {
    expectedAmount: number;
    buyerName: string;
    createdAt: Date;
  };
}

// ==================== BOT INTERNAL TYPES ====================

export interface PricingConfig {
  strategy: 'competitive' | 'fixed' | 'floating';
  undercutPercentage: number;
  minMargin: number;
  maxMargin: number;
  updateIntervalMs: number;
}

export interface OrderMatch {
  orderNumber: string;
  expectedAmount: number;
  receivedAmount?: number;
  bankTransactionId?: string;
  senderName?: string;
  verified: boolean;
  receiptUrl?: string;
  ocrResult?: OCRResult;
  matchedAt?: Date;
}

export interface OCRResult {
  amount?: number;
  date?: string;
  senderName?: string;
  receiverName?: string;
  reference?: string;
  confidence: number;
  rawText: string;
}

export interface BotState {
  isRunning: boolean;
  activeOrders: Map<string, OrderData>;
  pendingMatches: Map<string, OrderMatch>;
  lastPriceUpdate: Date;
  currentPrice: number;
  todayVolume: number;
  todayOrders: number;
}
