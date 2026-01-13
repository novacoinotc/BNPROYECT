// =====================================================
// LOGGER UTILITY
// Using Pino for structured logging
// =====================================================

import pino from 'pino';

const logLevel = process.env.LOG_LEVEL || 'info';
const isDevelopment = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: logLevel,
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  base: {
    service: 'p2p-bot',
  },
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
});

// Child loggers for different modules
export const createModuleLogger = (moduleName: string) => {
  return logger.child({ module: moduleName });
};

// Specific loggers
export const pricingLogger = createModuleLogger('pricing');
export const orderLogger = createModuleLogger('orders');
export const chatLogger = createModuleLogger('chat');
export const webhookLogger = createModuleLogger('webhook');
export const ocrLogger = createModuleLogger('ocr');
