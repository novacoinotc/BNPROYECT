-- =====================================================
-- Multi-Merchant Migration
-- Add Merchant table and merchantId to all tables
-- =====================================================

-- 1. Create Merchant table
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "binanceNickname" TEXT,
    "clabeAccount" TEXT,
    "bankName" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- Create indexes for Merchant
CREATE UNIQUE INDEX "Merchant_email_key" ON "Merchant"("email");
CREATE UNIQUE INDEX "Merchant_clabeAccount_key" ON "Merchant"("clabeAccount");
CREATE INDEX "Merchant_email_idx" ON "Merchant"("email");
CREATE INDEX "Merchant_clabeAccount_idx" ON "Merchant"("clabeAccount");
CREATE INDEX "Merchant_isActive_idx" ON "Merchant"("isActive");

-- 2. Add merchantId columns to existing tables (nullable first)
ALTER TABLE "Order" ADD COLUMN "merchantId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "merchantId" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN "merchantId" TEXT;
ALTER TABLE "PriceHistory" ADD COLUMN "merchantId" TEXT;
ALTER TABLE "DailyStats" ADD COLUMN "merchantId" TEXT;
ALTER TABLE "BuyerCache" ADD COLUMN "merchantId" TEXT;
ALTER TABLE "TrustedBuyer" ADD COLUMN "merchantId" TEXT;
ALTER TABLE "Alert" ADD COLUMN "merchantId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "merchantId" TEXT;
ALTER TABLE "SupportRequest" ADD COLUMN "merchantId" TEXT;
ALTER TABLE "BotConfig" ADD COLUMN "merchantId" TEXT;

-- 3. Add new columns to BotConfig (if not exist)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'BotConfig' AND column_name = 'sellMode') THEN
        ALTER TABLE "BotConfig" ADD COLUMN "sellMode" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'BotConfig' AND column_name = 'sellFollowTarget') THEN
        ALTER TABLE "BotConfig" ADD COLUMN "sellFollowTarget" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'BotConfig' AND column_name = 'buyMode') THEN
        ALTER TABLE "BotConfig" ADD COLUMN "buyMode" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'BotConfig' AND column_name = 'buyFollowTarget') THEN
        ALTER TABLE "BotConfig" ADD COLUMN "buyFollowTarget" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'BotConfig' AND column_name = 'positioningConfigs') THEN
        ALTER TABLE "BotConfig" ADD COLUMN "positioningConfigs" JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'BotConfig' AND column_name = 'matchPrice') THEN
        ALTER TABLE "BotConfig" ADD COLUMN "matchPrice" BOOLEAN NOT NULL DEFAULT false;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'BotConfig' AND column_name = 'ignoredAdvertisers') THEN
        ALTER TABLE "BotConfig" ADD COLUMN "ignoredAdvertisers" JSONB;
    END IF;
END $$;

-- 4. Create indexes for merchantId columns
CREATE INDEX "Order_merchantId_idx" ON "Order"("merchantId");
CREATE INDEX "Payment_merchantId_idx" ON "Payment"("merchantId");
CREATE INDEX "ChatMessage_merchantId_idx" ON "ChatMessage"("merchantId");
CREATE INDEX "PriceHistory_merchantId_idx" ON "PriceHistory"("merchantId");
CREATE INDEX "DailyStats_merchantId_idx" ON "DailyStats"("merchantId");
CREATE INDEX "BuyerCache_merchantId_idx" ON "BuyerCache"("merchantId");
CREATE INDEX "TrustedBuyer_merchantId_idx" ON "TrustedBuyer"("merchantId");
CREATE INDEX "Alert_merchantId_idx" ON "Alert"("merchantId");
CREATE INDEX "AuditLog_merchantId_idx" ON "AuditLog"("merchantId");
CREATE INDEX "SupportRequest_merchantId_idx" ON "SupportRequest"("merchantId");
CREATE INDEX "BotConfig_merchantId_idx" ON "BotConfig"("merchantId");

-- 5. Add foreign key constraints
ALTER TABLE "Order" ADD CONSTRAINT "Order_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PriceHistory" ADD CONSTRAINT "PriceHistory_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DailyStats" ADD CONSTRAINT "DailyStats_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BuyerCache" ADD CONSTRAINT "BuyerCache_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TrustedBuyer" ADD CONSTRAINT "TrustedBuyer_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportRequest" ADD CONSTRAINT "SupportRequest_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BotConfig" ADD CONSTRAINT "BotConfig_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 6. Change unique constraints to include merchantId

-- DailyStats: Remove old unique constraint on date, add composite unique
DROP INDEX IF EXISTS "DailyStats_date_key";
CREATE UNIQUE INDEX "DailyStats_date_merchantId_key" ON "DailyStats"("date", "merchantId");

-- BuyerCache: Remove old unique constraint on userNo, add composite unique
DROP INDEX IF EXISTS "BuyerCache_userNo_key";
CREATE UNIQUE INDEX "BuyerCache_userNo_merchantId_key" ON "BuyerCache"("userNo", "merchantId");

-- TrustedBuyer: Remove old unique constraint on buyerUserNo, add composite unique
DROP INDEX IF EXISTS "TrustedBuyer_buyerUserNo_key";
CREATE UNIQUE INDEX "TrustedBuyer_buyerUserNo_merchantId_key" ON "TrustedBuyer"("buyerUserNo", "merchantId");

-- BotConfig: Add unique constraint on merchantId (one config per merchant)
CREATE UNIQUE INDEX "BotConfig_merchantId_key" ON "BotConfig"("merchantId");

-- =====================================================
-- DATA MIGRATION INSTRUCTIONS
-- Run these manually after creating your first merchant
-- =====================================================
--
-- After creating your admin and first merchant accounts, run:
--
-- UPDATE "Order" SET "merchantId" = 'YOUR_MERCHANT_ID' WHERE "merchantId" IS NULL;
-- UPDATE "Payment" SET "merchantId" = 'YOUR_MERCHANT_ID' WHERE "merchantId" IS NULL;
-- UPDATE "ChatMessage" SET "merchantId" = 'YOUR_MERCHANT_ID' WHERE "merchantId" IS NULL;
-- UPDATE "PriceHistory" SET "merchantId" = 'YOUR_MERCHANT_ID' WHERE "merchantId" IS NULL;
-- UPDATE "DailyStats" SET "merchantId" = 'YOUR_MERCHANT_ID' WHERE "merchantId" IS NULL;
-- UPDATE "BuyerCache" SET "merchantId" = 'YOUR_MERCHANT_ID' WHERE "merchantId" IS NULL;
-- UPDATE "TrustedBuyer" SET "merchantId" = 'YOUR_MERCHANT_ID' WHERE "merchantId" IS NULL;
-- UPDATE "Alert" SET "merchantId" = 'YOUR_MERCHANT_ID' WHERE "merchantId" IS NULL;
-- UPDATE "AuditLog" SET "merchantId" = 'YOUR_MERCHANT_ID' WHERE "merchantId" IS NULL;
-- UPDATE "SupportRequest" SET "merchantId" = 'YOUR_MERCHANT_ID' WHERE "merchantId" IS NULL;
-- UPDATE "BotConfig" SET "merchantId" = 'YOUR_MERCHANT_ID' WHERE "merchantId" IS NULL;
--
-- Then optionally make merchantId NOT NULL:
-- ALTER TABLE "Order" ALTER COLUMN "merchantId" SET NOT NULL;
-- etc.
