// =====================================================
// OKX IMAGE SAVER - Auto-polls chat and saves images
// Uses GET /api/v5/p2p/chat/history to fetch chat
// contentUrl has images (accessible 30 days per OKX docs)
// =====================================================

import { logger } from '../../utils/logger.js';
import { getOkxClient, OkxClient } from './okx-client.js';
import { OkxOrderManager } from './okx-order-manager.js';
import { saveOrderImage } from '../../services/database-pg.js';

const log = logger.child({ module: 'okx-image-saver' });

const processedMessages = new Set<string>();
const lastPolled = new Map<string, number>();
const POLL_COOLDOWN_MS = 30000;

export function setupOkxImageSaver(orderManager: OkxOrderManager): void {
  const client = getOkxClient();

  // Poll chat when order events fire
  orderManager.on('order', async (event: any) => {
    const orderId = event.order?.orderNumber || event.orderId;
    if (!orderId) return;

    if (event.type === 'new' || event.type === 'paid') {
      setTimeout(() => {
        pollAndSaveImages(client, orderId, event.order?.totalPrice, event.order?.counterPartNickName)
          .catch(err => log.error({ error: err.message, orderId }, 'OKX image poll failed'));
      }, 5000);
    }

    if (event.type === 'released' || event.type === 'completed') {
      setTimeout(() => {
        pollAndSaveImages(client, orderId, event.order?.totalPrice, event.order?.counterPartNickName)
          .catch(() => {});
      }, 3000);
    }
  });

  // Periodic poll for active orders
  setInterval(async () => {
    try {
      const activeOrders = orderManager.getActiveOrders?.();
      if (!activeOrders || activeOrders.length === 0) return;

      for (const order of activeOrders) {
        const orderId = order.orderNumber;
        if (!orderId) continue;

        const now = Date.now();
        const lastPoll = lastPolled.get(orderId) || 0;
        if (now - lastPoll < POLL_COOLDOWN_MS) continue;

        await pollAndSaveImages(client, orderId, order.totalPrice, order.counterPartNickName)
          .catch(() => {});

        await new Promise(r => setTimeout(r, 2000)); // OKX rate limit
      }
    } catch {
      // Silent
    }
  }, 30000);

  // Cleanup
  setInterval(() => {
    if (processedMessages.size > 5000) processedMessages.clear();
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [key, ts] of lastPolled) {
      if (ts < cutoff) lastPolled.delete(key);
    }
  }, 5 * 60 * 1000);

  log.info('OKX image auto-saver initialized');
}

async function pollAndSaveImages(
  client: OkxClient,
  orderId: string,
  amount?: string,
  buyerName?: string,
): Promise<void> {
  lastPolled.set(orderId, Date.now());

  const messages = await client.getChatHistory(orderId);
  if (!messages || messages.length === 0) return;

  for (const msg of messages) {
    // Only buyer-sent images (isSentBySelf = "false" or false)
    if (msg.isSentBySelf === 'true' || msg.isSentBySelf === true) continue;

    // Check for image URL
    const imageUrl = msg.contentUrl;
    if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.startsWith('http')) continue;

    const msgId = String(msg.lastMessageSequence || `okx-${orderId}-${msg.sentTimestamp}`);
    if (processedMessages.has(msgId)) continue;
    processedMessages.add(msgId);

    saveImageInBackground(orderId, imageUrl, msgId, amount, buyerName)
      .catch(err => log.error({ error: err.message, orderId }, 'OKX image save failed'));
  }
}

async function saveImageInBackground(
  orderNumber: string,
  imageUrl: string,
  chatMessageId: string,
  amount?: string,
  buyerName?: string,
): Promise<void> {
  let imageBuffer: Buffer;
  try {
    const response = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return;
    imageBuffer = Buffer.from(await response.arrayBuffer());
  } catch {
    return;
  }

  if (imageBuffer.length < 100) return;

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
    }, `📸 OKX image saved (${Math.round(compressedBuffer.length / 1024)}KB)`);
  }
}
