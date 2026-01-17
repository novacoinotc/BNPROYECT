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

// Numeric status as per Binance API documentation (SAPI v7.4)
// Note: Status 5 does NOT exist in Binance API
export enum OrderStatus {
  PENDING = 1,           // Wait for payment (TRADING)
  PAID = 2,              // Wait for release (BUYER_PAYED)
  APPEALING = 3,         // In dispute/appeal
  COMPLETED = 4,         // Order completed
  CANCELLED = 6,         // Cancelled by user
  CANCELLED_SYSTEM = 7,  // Cancelled by system/timeout
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
  proMerchant: boolean;
}

// ==================== POSITIONING CONFIG ====================

export interface SmartPositioningConfig {
  // === FILTROS DE VENDEDOR ===
  minUserGrade: number;          // Nivel mínimo (1-5), default: 2
  minMonthFinishRate: number;    // Tasa completado mínima (0-1), default: 0.90
  minMonthOrderCount: number;    // Órdenes mínimas del mes, default: 10
  minPositiveRate: number;       // Feedback positivo mínimo (0-1), default: 0.95
  requireOnline: boolean;        // Solo vendedores online, default: true
  requireProMerchant: boolean;   // Solo merchants verificados, default: false

  // === FILTROS DE ANUNCIO ===
  minSurplusAmount: number;      // Volumen mínimo disponible (USDT), default: 100
  minMaxTransAmount: number;     // Monto máximo mínimo (MXN), default: 5000

  // === ESTRATEGIA DE PRECIO ===
  undercutAmount: number;        // Monto a bajar (centavos), default: 1
  undercutPercent: number;       // O porcentaje a bajar, default: 0
  minMargin: number;             // Margen mínimo sobre referencia (%), default: 0.5
  maxMargin: number;             // Margen máximo sobre referencia (%), default: 2.0

  // === COMPORTAMIENTO ===
  updateIntervalMs: number;      // Intervalo de actualización, default: 30000
  maxCompetitorsToAnalyze: number; // Cuántos analizar, default: 20
}

export interface FollowModeConfig {
  enabled: boolean;              // Activar modo seguimiento
  targetNickName: string;        // Nickname del vendedor a seguir
  targetUserNo?: string;         // O userNo (más estable que nickname)

  // Estrategia
  followStrategy: 'match' | 'undercut';  // Igualar o bajar
  undercutAmount: number;        // Centavos a bajar (si undercut)

  // Fallback cuando el target no está activo
  fallbackToSmart: boolean;      // Usar modo inteligente como fallback

  // Límites de seguridad
  minMargin: number;             // No bajar de este margen
  maxMargin: number;             // No subir de este margen

  // Comportamiento
  updateIntervalMs: number;
}

export interface PositioningAnalysis {
  timestamp: Date;
  mode: 'smart' | 'follow' | 'manual';

  // Mercado
  totalAdsAnalyzed: number;
  qualifiedCompetitors: number;
  bestQualifiedPrice: number;
  averagePrice: number;
  referencePrice: number;

  // Mi posición
  currentPrice: number;
  targetPrice: number;
  priceChanged: boolean;
  marginPercent: number;

  // Filtros aplicados (solo modo smart)
  filterResults?: {
    passedGrade: number;
    passedFinishRate: number;
    passedOrderCount: number;
    passedPositiveRate: number;
    passedOnline: number;
    passedSurplus: number;
    passedMaxTrans: number;
  };

  // Target info (solo modo follow)
  targetInfo?: {
    nickName: string;
    userNo: string;
    price: number;
    isOnline: boolean;
    found: boolean;
  };
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

/**
 * Counter party statistics - returned by queryCounterPartyOrderStatistic
 * This gives us buyer stats directly by order number (no userNo needed!)
 */
export interface CounterPartyStats {
  completedOrderNum: number;              // Total completed orders
  completedOrderNumOfLatest30day: number; // Completed orders in last 30 days
  finishRate: number;                     // Completion rate (0-1)
  finishRateLatest30Day: number;          // Completion rate last 30 days (0-1)
  numberOfTradesWithCounterpartyCompleted30day: number;  // Trades with this counterparty
  registerDays: number;                   // Account age in days
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
