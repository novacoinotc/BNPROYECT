-- =====================================================
-- P2P Trading Bot Database Schema
-- PostgreSQL initialization script
-- =====================================================

-- Create enums
DO $$ BEGIN
    CREATE TYPE "TradeType" AS ENUM ('BUY', 'SELL');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PAID', 'APPEALING', 'COMPLETED', 'CANCELLED', 'CANCELLED_SYSTEM', 'CANCELLED_TIMEOUT');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'VERIFIED', 'MATCHED', 'RELEASED', 'FAILED', 'REVERSED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "VerificationMethod" AS ENUM ('BANK_WEBHOOK', 'OCR_RECEIPT', 'MANUAL');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create Order table
CREATE TABLE IF NOT EXISTS "Order" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "advNo" TEXT NOT NULL,
    "tradeType" "TradeType" NOT NULL,
    "asset" TEXT NOT NULL,
    "fiatUnit" TEXT NOT NULL,
    "amount" DECIMAL(18, 8) NOT NULL,
    "totalPrice" DECIMAL(18, 2) NOT NULL,
    "unitPrice" DECIMAL(18, 2) NOT NULL,
    "commission" DECIMAL(18, 8) NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "buyerUserNo" TEXT NOT NULL,
    "buyerNickName" TEXT NOT NULL,
    "buyerRealName" TEXT,
    "sellerUserNo" TEXT NOT NULL,
    "sellerNickName" TEXT NOT NULL,
    "binanceCreateTime" TIMESTAMP(3) NOT NULL,
    "confirmPayEndTime" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- Create Payment table
CREATE TABLE IF NOT EXISTS "Payment" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "amount" DECIMAL(18, 2) NOT NULL,
    "currency" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "senderAccount" TEXT,
    "receiverAccount" TEXT,
    "concept" TEXT,
    "bankReference" TEXT,
    "bankTimestamp" TIMESTAMP(3) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "matchedOrderId" TEXT,
    "matchedAt" TIMESTAMP(3),
    "verificationMethod" "VerificationMethod",
    "ocrConfidence" DOUBLE PRECISION,
    "receiptUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- Create ChatMessage table
CREATE TABLE IF NOT EXISTS "ChatMessage" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "content" TEXT,
    "imageUrl" TEXT,
    "thumbnailUrl" TEXT,
    "messageType" TEXT NOT NULL,
    "fromNickName" TEXT NOT NULL,
    "isSelf" BOOLEAN NOT NULL,
    "binanceTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- Create PriceHistory table
CREATE TABLE IF NOT EXISTS "PriceHistory" (
    "id" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "fiat" TEXT NOT NULL,
    "tradeType" "TradeType" NOT NULL,
    "referencePrice" DECIMAL(18, 2) NOT NULL,
    "bestCompetitor" DECIMAL(18, 2) NOT NULL,
    "averagePrice" DECIMAL(18, 2) NOT NULL,
    "ourPrice" DECIMAL(18, 2) NOT NULL,
    "margin" DOUBLE PRECISION NOT NULL,
    "pricePosition" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceHistory_pkey" PRIMARY KEY ("id")
);

-- Create DailyStats table
CREATE TABLE IF NOT EXISTS "DailyStats" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "completedOrders" INTEGER NOT NULL DEFAULT 0,
    "cancelledOrders" INTEGER NOT NULL DEFAULT 0,
    "totalVolumeFiat" DECIMAL(18, 2) NOT NULL DEFAULT 0,
    "totalVolumeAsset" DECIMAL(18, 8) NOT NULL DEFAULT 0,
    "totalCommission" DECIMAL(18, 8) NOT NULL DEFAULT 0,
    "avgMargin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgPrice" DECIMAL(18, 2) NOT NULL DEFAULT 0,
    "avgPaymentTime" INTEGER,
    "avgReleaseTime" INTEGER,
    "autoReleaseRate" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyStats_pkey" PRIMARY KEY ("id")
);

-- Create BuyerCache table
CREATE TABLE IF NOT EXISTS "BuyerCache" (
    "id" TEXT NOT NULL,
    "userNo" TEXT NOT NULL,
    "nickName" TEXT NOT NULL,
    "completedOrders" INTEGER NOT NULL DEFAULT 0,
    "completedOrders30d" INTEGER NOT NULL DEFAULT 0,
    "finishRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "finishRate30d" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgPayTime" INTEGER,
    "creditScore" INTEGER,
    "registerDays" INTEGER,
    "ordersWithUs" INTEGER NOT NULL DEFAULT 0,
    "issuesCount" INTEGER NOT NULL DEFAULT 0,
    "lastOrderAt" TIMESTAMP(3),
    "isTrusted" BOOLEAN NOT NULL DEFAULT false,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "blockReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyerCache_pkey" PRIMARY KEY ("id")
);

-- Create Alert table
CREATE TABLE IF NOT EXISTS "Alert" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "orderNumber" TEXT,
    "metadata" JSONB,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- Create AuditLog table
CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "orderNumber" TEXT,
    "details" JSONB,
    "success" BOOLEAN NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- Create unique indexes
CREATE UNIQUE INDEX IF NOT EXISTS "Order_orderNumber_key" ON "Order"("orderNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "Payment_transactionId_key" ON "Payment"("transactionId");
CREATE UNIQUE INDEX IF NOT EXISTS "DailyStats_date_key" ON "DailyStats"("date");
CREATE UNIQUE INDEX IF NOT EXISTS "BuyerCache_userNo_key" ON "BuyerCache"("userNo");

-- Create regular indexes
CREATE INDEX IF NOT EXISTS "Order_status_idx" ON "Order"("status");
CREATE INDEX IF NOT EXISTS "Order_buyerUserNo_idx" ON "Order"("buyerUserNo");
CREATE INDEX IF NOT EXISTS "Order_binanceCreateTime_idx" ON "Order"("binanceCreateTime");

CREATE INDEX IF NOT EXISTS "Payment_status_idx" ON "Payment"("status");
CREATE INDEX IF NOT EXISTS "Payment_amount_idx" ON "Payment"("amount");
CREATE INDEX IF NOT EXISTS "Payment_senderName_idx" ON "Payment"("senderName");

CREATE INDEX IF NOT EXISTS "ChatMessage_orderNumber_idx" ON "ChatMessage"("orderNumber");

CREATE INDEX IF NOT EXISTS "PriceHistory_asset_fiat_idx" ON "PriceHistory"("asset", "fiat");
CREATE INDEX IF NOT EXISTS "PriceHistory_createdAt_idx" ON "PriceHistory"("createdAt");

CREATE INDEX IF NOT EXISTS "BuyerCache_nickName_idx" ON "BuyerCache"("nickName");
CREATE INDEX IF NOT EXISTS "BuyerCache_isTrusted_idx" ON "BuyerCache"("isTrusted");
CREATE INDEX IF NOT EXISTS "BuyerCache_isBlocked_idx" ON "BuyerCache"("isBlocked");

CREATE INDEX IF NOT EXISTS "Alert_type_idx" ON "Alert"("type");
CREATE INDEX IF NOT EXISTS "Alert_severity_idx" ON "Alert"("severity");
CREATE INDEX IF NOT EXISTS "Alert_acknowledged_idx" ON "Alert"("acknowledged");
CREATE INDEX IF NOT EXISTS "Alert_createdAt_idx" ON "Alert"("createdAt");

CREATE INDEX IF NOT EXISTS "AuditLog_action_idx" ON "AuditLog"("action");
CREATE INDEX IF NOT EXISTS "AuditLog_orderNumber_idx" ON "AuditLog"("orderNumber");
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- Add foreign keys
DO $$ BEGIN
    ALTER TABLE "Payment" ADD CONSTRAINT "Payment_matchedOrderId_fkey"
    FOREIGN KEY ("matchedOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_orderNumber_fkey"
    FOREIGN KEY ("orderNumber") REFERENCES "Order"("orderNumber") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Success message
SELECT 'Database schema created successfully!' as message;
