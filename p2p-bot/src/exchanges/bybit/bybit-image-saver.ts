// =====================================================
// BYBIT IMAGE SAVER - Auto-polls chat and saves images
// Polls chat messages for tracked orders and downloads
// any buyer-sent images to OrderImage table.
// =====================================================

import { logger } from '../../utils/logger.js';
import { BybitClient, getBybitClient } from './bybit-client.js';
import { saveOrderImage } from '../../services/database-pg.js';
import { BybitOrderManager } from './bybit-order-manager.js';

const log = logger.child({ module: 'bybit-image-saver' });

// Track which message IDs we've already processed
const processedMessages = new Set<string>();
// Track which orders we've polled recently (avoid spamming)
const lastPolled = new Map<string, number>();
const POLL_COOLDOWN_MS = 30000; // 30s between polls per order

export function setupBybitImageSaver(orderManager: BybitOrderManager): void {
  const client = getBybitClient();

  // Poll chat for new/active orders periodically
  orderManager.on('order', async (event: any) => {
    if (event.type === 'new' || event.type === 'paid') {
      // Small delay to let chat populate
      setTimeout(() => {
        pollAndSaveImages(client, event.order.orderNumber, event.order.totalPrice, event.order.counterPartNickName)
          .catch(err => log.error({ error: err.message, orderId: event.order.orderNumber }, 'Image poll failed'));
      }, 5000);
    }

    if (event.type === 'released' || event.type === 'completed') {
      // Final poll after release to catch any last images
      setTimeout(() => {
        pollAndSaveImages(client, event.order.orderNumber, event.order.totalPrice, event.order.counterPartNickName)
          .catch(() => {});
      }, 3000);
    }
  });

  // Periodic poll for all active orders (every 30s)
  setInterval(async () => {
    try {
      const trackedOrders = orderManager.getActiveOrders?.();
      if (!trackedOrders || trackedOrders.length === 0) return;

      for (const order of trackedOrders) {
        const now = Date.now();
        const lastPoll = lastPolled.get(order.orderNumber) || 0;
        if (now - lastPoll < POLL_COOLDOWN_MS) continue;

        await pollAndSaveImages(client, order.orderNumber, order.totalPrice, order.counterPartNickName)
          .catch(() => {});

        // Delay between orders
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch {
      // Silent
    }
  }, 30000);

  // Cleanup processed set periodically
  setInterval(() => {
    if (processedMessages.size > 5000) processedMessages.clear();
    // Cleanup old poll timestamps
    const cutoff = Date.now() - 10 * 60 * 1000; // 10 min
    for (const [key, ts] of lastPolled) {
      if (ts < cutoff) lastPolled.delete(key);
    }
  }, 5 * 60 * 1000);

  log.info('Bybit image auto-saver initialized');
}

async function pollAndSaveImages(
  client: BybitClient,
  orderNumber: string,
  amount?: string,
  buyerName?: string,
): Promise<void> {
  lastPolled.set(orderNumber, Date.now());

  const messages = await client.getChatMessages(orderNumber);
  if (!messages || messages.length === 0) return;

  for (const msg of messages) {
    // Only process images from buyer (not self)
    const isImage = msg.contentType === 2 || msg.contentType === '2';
    if (!isImage || msg.isSelf) continue;

    const imageUrl = msg.message || msg.content;
    if (!imageUrl || !imageUrl.startsWith('http')) continue;

    const msgId = String(msg.id || `bybit-${orderNumber}-${msg.createTime}`);
    if (processedMessages.has(msgId)) continue;
    processedMessages.add(msgId);

    // Fire and forget
    saveImageInBackground(orderNumber, imageUrl, msgId, amount, buyerName || msg.nickName)
      .catch(err => log.error({ error: err.message, orderId: orderNumber }, 'Bybit image save failed'));
  }
}

async function saveImageInBackground(
  orderNumber: string,
  imageUrl: string,
  chatMessageId: string,
  amount?: string,
  buyerName?: string,
): Promise<void> {
  // Download
  let imageBuffer: Buffer;
  try {
    const response = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return;
    imageBuffer = Buffer.from(await response.arrayBuffer());
  } catch {
    return;
  }

  if (imageBuffer.length < 100) return;

  // Compress
  let compressedBuffer: Buffer;
  try {
    const sharp = (await import('sharp')).default;
    compressedBuffer = await sharp(imageBuffer)
      .resize(1200, null, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 60 })
      .toBuffer();
  } catch {
    compressedBuffer = imageBuffer;
  }

  // Save (no OCR for Bybit — keep it simple and fast)
  const savedId = await saveOrderImage({
    orderNumber,
    imageData: compressedBuffer,
    documentType: 'UNKNOWN',
    originalSize: imageBuffer.length,
    compressedSize: compressedBuffer.length,
    amount,
    buyerName,
    chatMessageId,
  });

  if (savedId) {
    log.info({
      orderNumber,
      compressedKB: Math.round(compressedBuffer.length / 1024),
    }, `📸 Bybit image saved (${Math.round(compressedBuffer.length / 1024)}KB)`);
  }
}
