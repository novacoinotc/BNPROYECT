// =====================================================
// CHAT HANDLER
// WebSocket connection for real-time chat messages
// =====================================================

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { getBinanceClient, BinanceC2CClient } from './binance-client.js';
import { chatLogger as logger } from '../utils/logger.js';
import {
  ChatMessage,
  ChatCredential,
  ChatMessageType,
} from '../types/binance.js';

export interface ChatEvent {
  type: 'message' | 'image' | 'connected' | 'disconnected' | 'error';
  message?: ChatMessage;
  orderNo?: string;
  error?: Error;
}

export interface ImageMessage {
  orderNo: string;
  imageUrl: string;
  thumbnailUrl?: string;
  senderId: string;
  senderName: string;
  timestamp: Date;
}

export class ChatHandler extends EventEmitter {
  private client: BinanceC2CClient;
  private ws: WebSocket | null = null;
  private credentials: ChatCredential | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectInterval: number = 5000;
  private pingInterval: NodeJS.Timeout | null = null;
  private pollingInterval: NodeJS.Timeout | null = null;
  private isConnected: boolean = false;
  private watchedOrders: Set<string> = new Set();

  // Track last seen message ID per order to avoid duplicate processing
  private lastSeenMessageId: Map<string, string> = new Map();

  // Callbacks
  private onImageCallbacks: ((image: ImageMessage) => void)[] = [];

  constructor() {
    super();
    this.client = getBinanceClient();
    logger.info('Chat handler initialized');
  }

  // ==================== CONNECTION ====================

  /**
   * Connect to chat WebSocket
   * Note: WebSocket credentials endpoint requires specific parameters that aren't documented
   * Falling back to polling-based chat monitoring
   */
  async connect(): Promise<void> {
    try {
      // WebSocket credential endpoint returns "illegal parameter" error
      // Use polling-based chat monitoring instead
      logger.info('Using polling-based chat monitoring (WebSocket credentials not available)');
      this.isConnected = true;  // Mark as "connected" for polling mode

      // Start polling for messages every 10 seconds
      this.startPolling();

      this.emit('chat', { type: 'connected' } as ChatEvent);
    } catch (error) {
      logger.error({ error }, 'Failed to connect to chat');
      this.scheduleReconnect();
    }
  }

  /**
   * Start polling for chat messages (fallback when WebSocket unavailable)
   */
  private startPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    // Poll every 10 seconds
    this.pollingInterval = setInterval(async () => {
      await this.pollAllWatchedOrders();
    }, 10000);

    logger.info('📡 [CHAT] Started polling for messages (every 10s)');
  }

  /**
   * Stop polling
   */
  private stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  /**
   * Poll messages for all watched orders
   */
  private async pollAllWatchedOrders(): Promise<void> {
    if (this.watchedOrders.size === 0) return;

    for (const orderNo of this.watchedOrders) {
      try {
        await this.pollOrderMessages(orderNo);
      } catch (error) {
        // Silent fail for individual orders to not block others
        logger.debug({ orderNo, error }, 'Failed to poll messages for order');
      }
    }
  }

  /**
   * Poll messages for a single order and emit events for new messages
   */
  private async pollOrderMessages(orderNo: string): Promise<void> {
    const messages = await this.getMessages(orderNo);
    if (messages.length === 0) return;

    // Get last seen message ID for this order
    const lastSeenId = this.lastSeenMessageId.get(orderNo);

    // Find new messages (messages after the last seen one)
    let foundLastSeen = !lastSeenId; // If no last seen, all messages are "new" on first poll
    const newMessages: ChatMessage[] = [];

    // Messages are typically returned newest first, so reverse to process oldest first
    const sortedMessages = [...messages].sort((a, b) =>
      new Date(a.createTime).getTime() - new Date(b.createTime).getTime()
    );

    for (const msg of sortedMessages) {
      if (!foundLastSeen) {
        // Compare as strings to handle both number and string IDs
        const msgId = String(msg.id || msg.createTime);
        if (msgId === lastSeenId) {
          foundLastSeen = true;
        }
        continue;
      }
      // Only process messages from counterparty (not self)
      if (!msg.self) {
        newMessages.push(msg);
      }
    }

    // Update last seen ID to the most recent message
    if (sortedMessages.length > 0) {
      const latestMsg = sortedMessages[sortedMessages.length - 1];
      this.lastSeenMessageId.set(orderNo, String(latestMsg.id || latestMsg.createTime));
    }

    // Emit events for new messages
    for (const msg of newMessages) {
      if (msg.type === ChatMessageType.IMAGE && msg.imageUrl) {
        // Image message
        this.emit('chat', {
          type: 'image',
          message: msg,
          orderNo,
        } as ChatEvent);

        // Also emit via legacy callback
        const imageMessage: ImageMessage = {
          orderNo: msg.orderNo,
          imageUrl: msg.imageUrl,
          thumbnailUrl: msg.thumbnailUrl,
          senderId: '',
          senderName: msg.fromNickName,
          timestamp: new Date(msg.createTime),
        };
        this.onImageCallbacks.forEach(cb => cb(imageMessage));

        logger.info({ orderNo, from: msg.fromNickName }, '📷 [CHAT POLL] New image received');
      } else if (msg.type === ChatMessageType.TEXT && msg.content) {
        // Text message
        this.emit('chat', {
          type: 'message',
          message: msg,
          orderNo,
        } as ChatEvent);

        logger.info({ orderNo, from: msg.fromNickName, content: msg.content.substring(0, 50) },
          '💬 [CHAT POLL] New message received');
      }
    }
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupWebSocketHandlers(): void {
    if (!this.ws) return;

    this.ws.on('open', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;

      logger.info('Chat WebSocket connected');

      // Start ping interval
      this.startPing();

      // Subscribe to orders
      this.subscribeToOrders();

      this.emit('chat', { type: 'connected' } as ChatEvent);
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch (error) {
        logger.error({ error, data: data.toString() }, 'Failed to parse message');
      }
    });

    this.ws.on('close', (code, reason) => {
      this.isConnected = false;
      this.stopPing();

      logger.warn({
        code,
        reason: reason.toString(),
      }, 'Chat WebSocket closed');

      this.emit('chat', { type: 'disconnected' } as ChatEvent);
      this.scheduleReconnect();
    });

    this.ws.on('error', (error) => {
      logger.error({ error }, 'Chat WebSocket error');
      this.emit('chat', { type: 'error', error } as ChatEvent);
    });
  }

  /**
   * Handle incoming message
   */
  private handleMessage(data: any): void {
    // Different message types from Binance
    if (data.e === 'chat') {
      this.handleChatMessage(data);
    } else if (data.e === 'ping') {
      this.sendPong();
    } else {
      logger.debug({ data }, 'Unknown message type');
    }
  }

  /**
   * Handle chat message
   */
  private handleChatMessage(data: any): void {
    const message: ChatMessage = {
      id: data.i,
      content: data.c,
      createTime: data.t,
      fromNickName: data.n,
      imageUrl: data.u,
      thumbnailUrl: data.tu,
      type: data.mt as ChatMessageType,
      status: data.s,
      self: data.sf,
      orderNo: data.o,
      uuid: data.uuid,
      height: data.h,
      width: data.w,
      imageType: data.it,
    };

    logger.info({
      orderNo: message.orderNo,
      type: message.type,
      from: message.fromNickName,
      self: message.self,
    }, 'Chat message received');

    // Emit message event
    this.emit('chat', { type: 'message', message } as ChatEvent);

    // Handle images (potential receipts)
    if (message.type === ChatMessageType.IMAGE && !message.self) {
      this.handleImageMessage(message);
    }
  }

  /**
   * Handle image message (potential receipt)
   */
  private handleImageMessage(message: ChatMessage): void {
    if (!message.imageUrl) return;

    const imageMessage: ImageMessage = {
      orderNo: message.orderNo,
      imageUrl: message.imageUrl,
      thumbnailUrl: message.thumbnailUrl,
      senderId: '', // Not available in message
      senderName: message.fromNickName,
      timestamp: new Date(message.createTime),
    };

    logger.info({
      orderNo: message.orderNo,
      imageUrl: message.imageUrl,
      from: message.fromNickName,
    }, 'Receipt image detected');

    // Emit image event
    this.emit('chat', {
      type: 'image',
      message,
      orderNo: message.orderNo,
    } as ChatEvent);

    // Trigger callbacks
    this.onImageCallbacks.forEach(cb => cb(imageMessage));
  }

  // ==================== SUBSCRIPTIONS ====================

  /**
   * Watch an order for chat messages
   */
  watchOrder(orderNo: string): void {
    this.watchedOrders.add(orderNo);

    if (this.isConnected) {
      this.subscribeToOrder(orderNo);
    }

    logger.debug({ orderNo }, 'Watching order');
  }

  /**
   * Stop watching an order
   */
  unwatchOrder(orderNo: string): void {
    this.watchedOrders.delete(orderNo);
    logger.debug({ orderNo }, 'Stopped watching order');
  }

  /**
   * Subscribe to order chat
   */
  private subscribeToOrder(orderNo: string): void {
    if (!this.ws || !this.isConnected) return;

    this.ws.send(JSON.stringify({
      method: 'SUBSCRIBE',
      params: [`chat@${orderNo}`],
      id: Date.now(),
    }));
  }

  /**
   * Subscribe to all watched orders
   */
  private subscribeToOrders(): void {
    for (const orderNo of this.watchedOrders) {
      this.subscribeToOrder(orderNo);
    }
  }

  // ==================== HISTORY ====================

  /**
   * Get chat messages for an order
   */
  async getMessages(orderNo: string, page: number = 1): Promise<ChatMessage[]> {
    return this.client.getChatMessages({ orderNo, page });
  }

  /**
   * Find receipt images in chat history
   */
  async findReceiptImages(orderNo: string): Promise<ImageMessage[]> {
    const messages = await this.getMessages(orderNo);

    return messages
      .filter(m => m.type === ChatMessageType.IMAGE && !m.self && m.imageUrl)
      .map(m => ({
        orderNo: m.orderNo,
        imageUrl: m.imageUrl!,
        thumbnailUrl: m.thumbnailUrl,
        senderId: '',
        senderName: m.fromNickName,
        timestamp: new Date(m.createTime),
      }));
  }

  // ==================== PING/PONG ====================

  /**
   * Start ping interval
   */
  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.isConnected) {
        this.ws.send(JSON.stringify({ method: 'ping' }));
      }
    }, 30000); // Ping every 30 seconds
  }

  /**
   * Stop ping interval
   */
  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Send pong response
   */
  private sendPong(): void {
    if (this.ws && this.isConnected) {
      this.ws.send(JSON.stringify({ method: 'pong' }));
    }
  }

  // ==================== RECONNECTION ====================

  /**
   * Schedule reconnection
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectInterval * this.reconnectAttempts;

    logger.info({
      attempt: this.reconnectAttempts,
      delay,
    }, 'Scheduling reconnect');

    setTimeout(() => this.connect(), delay);
  }

  // ==================== CALLBACKS ====================

  /**
   * Register callback for image messages
   */
  onImage(callback: (image: ImageMessage) => void): void {
    this.onImageCallbacks.push(callback);
  }

  // ==================== CLEANUP ====================

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    this.stopPing();
    this.stopPolling();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    this.watchedOrders.clear();
    this.lastSeenMessageId.clear();

    logger.info('Chat handler disconnected');
  }

  /**
   * Check if connected
   */
  isActive(): boolean {
    return this.isConnected;
  }
}

// Singleton instance
let chatInstance: ChatHandler | null = null;

export function getChatHandler(): ChatHandler {
  if (!chatInstance) {
    chatInstance = new ChatHandler();
  }
  return chatInstance;
}
