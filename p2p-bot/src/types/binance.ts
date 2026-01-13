// =====================================================
// BINANCE C2C API TYPES
// Based on SAPI v7.4 Documentation
// =====================================================

// ==================== ENUMS ====================

export enum TradeType {
  BUY = 'BUY',
  SELL = 'SELL'
}

export enum OrderStatus {
  PENDING = 1,           // Wait for payment
  PAID = 2,              // Wait for release (buyer marked as paid)
  APPEALING = 3,         // In dispute/appeal
  COMPLETED = 4,         // Order completed
  CANCELLED = 5,         // Cancelled by user
  CANCELLED_SYSTEM = 6,  // Cancelled by system
  CANCELLED_TIMEOUT = 7  // Cancelled by timeout
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

export interface OrderData {
  orderNumber: string;
  orderStatus: OrderStatus;
  tradeType: TradeType;
  asset: string;
  fiatUnit: string;
  amount: string;
  totalPrice: string;
  unitPrice: string;
  commission: string;
  commissionRate: string;
  createTime: number;
  payMethods: TradeMethod[];
  buyer: UserInfo;
  seller: UserInfo;
  confirmPayEndTime?: number;
  notifyPayEndTime?: number;
  chatEnabled: boolean;
  advNo: string;
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
