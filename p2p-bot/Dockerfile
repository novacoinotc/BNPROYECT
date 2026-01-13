# =====================================================
# BINANCE P2P TRADING BOT
# Production Docker Image
# =====================================================

FROM node:20-alpine AS base

# Install dependencies for Tesseract OCR
RUN apk add --no-cache \
    tesseract-ocr \
    tesseract-ocr-data-spa \
    tesseract-ocr-data-eng

WORKDIR /app

# =====================================================
# Dependencies Stage
# =====================================================
FROM base AS deps

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci --only=production

# Generate Prisma client
RUN npx prisma generate

# =====================================================
# Build Stage
# =====================================================
FROM base AS builder

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci

COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript
RUN npm run build

# =====================================================
# Production Stage
# =====================================================
FROM base AS runner

ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 botuser

WORKDIR /app

# Copy built application
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json

# Copy Prisma client
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma

# Set ownership
RUN chown -R botuser:nodejs /app

USER botuser

# Expose webhook port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Start command
CMD ["node", "dist/index.js"]
