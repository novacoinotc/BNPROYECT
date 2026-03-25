// =====================================================
// BYBIT IMAGE SAVER - Saves chat image references
// Uses 2-step flow: getOrderDetail → session/list → message/listpage
// Bybit images can't be downloaded via API (require web session),
// so we save the URL as reference + order metadata for lookup.
// =====================================================

import { logger } from '../../utils/logger.js';
import { BybitClient, getBybitClient } from './bybit-client.js';
import { saveOrderImage } from '../../services/database-pg.js';
import { BybitOrderManager } from './bybit-order-manager.js';

const log = logger.child({ module: 'bybit-image-saver' });

const processedMessages = new Set<string>();
const lastPolled = new Map<string, number>();
const POLL_COOLDOWN_MS = 60000; // 60s between polls per order (Bybit rate limit: 10/s)

export function setupBybitImageSaver(orderManager: BybitOrderManager): void {
  const client = getBybitClient();

  orderManager.on('order', async (event: any) => {
    if (event.type === 'paid' || event.type === 'released' || event.type === 'completed') {
      const delay = event.type === 'paid' ? 10000 : 5000;
      setTimeout(() => {
        pollAndSave(client, event.order.orderNumber, event.order.totalPrice, event.order.counterPartNickName)
          .catch(err => log.error({ error: err.message, orderId: event.order.orderNumber }, 'Bybit chat poll failed'));
      }, delay);
    }
  });

  // Periodic poll for active orders
  setInterval(async () => {
    try {
      const orders = orderManager.getActiveOrders?.() || [];
      for (const order of orders) {
        const now = Date.now();
        if ((lastPolled.get(order.orderNumber) || 0) + POLL_COOLDOWN_MS > now) continue;

        await pollAndSave(client, order.orderNumber, order.totalPrice, order.counterPartNickName)
          .catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch { /* silent */ }
  }, 60000);

  // Cleanup
  setInterval(() => {
    if (processedMessages.size > 5000) processedMessages.clear();
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [k, v] of lastPolled) { if (v < cutoff) lastPolled.delete(k); }
  }, 5 * 60 * 1000);

  log.info('Bybit image auto-saver initialized (URL reference mode)');
}

async function pollAndSave(
  client: BybitClient,
  orderNumber: string,
  amount?: string,
  buyerName?: string,
): Promise<void> {
  lastPolled.set(orderNumber, Date.now());

  try {
    // Step 1: Get order detail to find targetUserMaskId
    const detail = await client.getOrderDetail(orderNumber);
    if (!detail) return;

    const targetMaskId = (detail as any).targetUserMaskId;
    if (!targetMaskId) {
      log.debug({ orderNumber }, 'No targetUserMaskId in order detail');
      return;
    }

    // Step 2: Get chat session
    const sessionResult = await (client as any).post('/v5/p2p/chat/session/list', {
      size: 5,
      userMaskId: targetMaskId,
    });
    const sessions = sessionResult?.chatSession || [];
    if (sessions.length === 0) return;

    const sessionId = sessions[0].sessionId;

    // Step 3: Get messages
    const msgResult = await (client as any).post('/v5/p2p/chat/message/listpage', {
      sessionId,
      limit: 30,
      lastId: 0,
    });
    const messages = msgResult?.messages || [];
    if (messages.length === 0) return;

    let savedCount = 0;

    for (const msg of messages) {
      // Only buyer-sent images
      if (msg.contentType !== 'pic' && msg.contentType !== 'PIC') continue;

      // Parse message JSON to get image URL
      let imageUrl = '';
      try {
        const parsed = JSON.parse(msg.message);
        imageUrl = parsed.content || '';
      } catch {
        imageUrl = msg.message || '';
      }

      if (!imageUrl) continue;

      // Build full URL reference
      const fullUrl = imageUrl.startsWith('http') ? imageUrl : `https://api.bybit.com${imageUrl}`;

      const msgId = `bybit-${orderNumber}-${msg.id || msg.createDate}`;
      if (processedMessages.has(msgId)) continue;
      processedMessages.add(msgId);

      // Save a 1x1 placeholder with the URL in ocrText field as reference
      // The URL can't be downloaded via API but serves as a lookup reference
      const placeholder = Buffer.from(
        `BYBIT_IMAGE_REFERENCE\nOrder: ${orderNumber}\nAmount: ${amount || 'N/A'}\nBuyer: ${buyerName || msg.sendUserNickName || 'N/A'}\nURL: ${fullUrl}\nDate: ${new Date(parseInt(msg.createDate) || Date.now()).toISOString()}`,
        'utf-8'
      );

      const savedId = await saveOrderImage({
        orderNumber,
        imageData: placeholder,
        documentType: 'BYBIT_REFERENCE',
        mimeType: 'text/plain',
        originalSize: 0,
        compressedSize: placeholder.length,
        amount,
        buyerName: buyerName || msg.sendUserNickName,
        chatMessageId: msgId,
        ocrText: `Bybit image URL: ${fullUrl}`,
      });

      if (savedId) savedCount++;
    }

    if (savedCount > 0) {
      log.info({ orderNumber, savedCount }, `📎 Bybit: ${savedCount} image reference(s) saved`);
    }
  } catch (err: any) {
    // Don't log for expected failures (no chat, etc)
    if (!err.message?.includes('10010') && !err.message?.includes('timestamp')) {
      log.warn({ error: err.message, orderNumber }, 'Bybit chat poll error');
    }
  }
}
