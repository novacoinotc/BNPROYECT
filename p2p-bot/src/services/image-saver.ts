// =====================================================
// IMAGE SAVER - Auto-saves ALL chat images to database
// Listens for chat image events, downloads, compresses,
// classifies (OCR), and stores in OrderImage table.
// =====================================================

import { logger } from '../utils/logger.js';
import { ChatHandler, ChatEvent } from './chat-handler.js';
import { saveOrderImage } from './database-pg.js';
import type { OCRService } from './ocr-service.js';

const log = logger.child({ module: 'image-saver' });

// Track processed messages to avoid duplicates within session
const processedMessages = new Set<string>();

export function setupImageSaver(chatHandler: ChatHandler, ocrService?: OCRService): void {
  chatHandler.on('chat', (event: ChatEvent) => {
    if (event.type !== 'image' || !event.message || !event.orderNo) return;

    const msg = event.message;
    if (!msg.imageUrl) return;

    // Skip self-sent images (we only need buyer evidence)
    if (msg.self) return;

    // Deduplicate within session
    const msgId = String(msg.id || `${event.orderNo}-${msg.createTime}`);
    if (processedMessages.has(msgId)) return;
    processedMessages.add(msgId);

    // Fire and forget - don't block chat polling
    saveImageInBackground(event.orderNo, msg.imageUrl, msgId, msg.fromNickName, ocrService)
      .catch(err => log.error({ error: err.message, orderNo: event.orderNo }, 'Image save failed'));
  });

  // Cleanup processed set periodically (prevent memory leak)
  setInterval(() => {
    if (processedMessages.size > 5000) {
      processedMessages.clear();
    }
  }, 30 * 60 * 1000); // Every 30 min

  log.info('Image auto-saver initialized — all chat images will be saved');
}

async function saveImageInBackground(
  orderNumber: string,
  imageUrl: string,
  chatMessageId: string,
  senderName: string,
  ocrService?: OCRService,
): Promise<void> {
  // Step 1: Download image
  let imageBuffer: Buffer;
  try {
    const response = await fetch(imageUrl, {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      log.warn({ orderNumber, status: response.status }, 'Image download failed');
      return;
    }
    const arrayBuffer = await response.arrayBuffer();
    imageBuffer = Buffer.from(arrayBuffer);
  } catch (err: any) {
    log.warn({ orderNumber, error: err.message }, 'Image download error');
    return;
  }

  const originalSize = imageBuffer.length;

  // Step 2: Compress with sharp
  let compressedBuffer: Buffer;
  try {
    const sharp = (await import('sharp')).default;
    compressedBuffer = await sharp(imageBuffer)
      .resize(1200, null, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 60 })
      .toBuffer();
  } catch (err: any) {
    // If sharp fails, save original
    log.warn({ orderNumber, error: err.message }, 'Image compression failed, saving original');
    compressedBuffer = imageBuffer;
  }

  // Step 3: OCR + classify (optional, don't block save)
  let documentType = 'UNKNOWN';
  let ocrText: string | undefined;

  if (ocrService) {
    try {
      const ocrResult = await ocrService.processReceiptBuffer(compressedBuffer);
      if (ocrResult?.rawText && ocrResult.rawText.length > 10) {
        ocrText = ocrResult.rawText.substring(0, 2000); // Cap at 2KB
        const { classifyText } = await import('./document-classifier.js');
        const classification = classifyText(ocrText);
        if (classification.confidence >= 0.3) {
          documentType = classification.type;
        }
      }
    } catch {
      // OCR failed — save as UNKNOWN, not critical
    }
  }

  // Step 4: Look up order info for amount/buyerName
  let amount: string | undefined;
  let buyerName: string | undefined;
  try {
    const pg = await import('pg');
    const tmpPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    const result = await tmpPool.query(
      `SELECT "totalPrice", "buyerRealName", "buyerNickName" FROM "Order" WHERE "orderNumber" = $1 LIMIT 1`,
      [orderNumber]
    );
    await tmpPool.end();
    if (result.rows[0]) {
      amount = result.rows[0].totalPrice;
      buyerName = result.rows[0].buyerRealName || result.rows[0].buyerNickName;
    }
  } catch {
    // Not critical
  }

  // Step 5: Save to database
  const savedId = await saveOrderImage({
    orderNumber,
    imageData: compressedBuffer,
    documentType,
    originalSize,
    compressedSize: compressedBuffer.length,
    amount,
    buyerName: buyerName || senderName,
    chatMessageId,
    ocrText,
  });

  if (savedId) {
    const reduction = Math.round((1 - compressedBuffer.length / originalSize) * 100);
    log.info({
      orderNumber,
      documentType,
      originalKB: Math.round(originalSize / 1024),
      compressedKB: Math.round(compressedBuffer.length / 1024),
      reduction: `${reduction}%`,
    }, `📸 Image saved: ${documentType} (${Math.round(compressedBuffer.length / 1024)}KB)`);
  }
}
