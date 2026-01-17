// =====================================================
// TOTP SERVICE
// Generates Time-based One-Time Passwords for 2FA
// =====================================================

import * as OTPAuth from 'otpauth';
import { logger } from '../utils/logger.js';

export interface TOTPConfig {
  secret: string;
  enabled: boolean;
}

const TOTP_PERIOD = 30; // Standard 30-second period

export class TOTPService {
  private config: TOTPConfig;
  private totp: OTPAuth.TOTP | null = null;

  constructor(config: TOTPConfig) {
    this.config = config;

    if (config.enabled && !config.secret) {
      logger.warn('TOTP enabled but no secret provided - auto-release will fail');
    }

    if (config.enabled && config.secret) {
      // Initialize TOTP instance with the secret
      this.totp = new OTPAuth.TOTP({
        issuer: 'Binance.com',
        algorithm: 'SHA1',
        digits: 6,
        period: TOTP_PERIOD,
        secret: config.secret,
      });
      logger.info('TOTP service initialized - auto-release ready');
    }
  }

  /**
   * Generate current TOTP code
   */
  generateCode(): string {
    if (!this.config.enabled) {
      throw new Error('TOTP not enabled');
    }

    if (!this.totp) {
      throw new Error('TOTP secret not configured');
    }

    const code = this.totp.generate();
    logger.debug({ codeLength: code.length }, 'Generated TOTP code');
    return code;
  }

  /**
   * Verify a TOTP code (for testing)
   */
  verifyCode(code: string): boolean {
    if (!this.totp) {
      return false;
    }

    const delta = this.totp.validate({ token: code, window: 1 });
    return delta !== null;
  }

  /**
   * Check if TOTP is properly configured
   */
  isConfigured(): boolean {
    return this.config.enabled && !!this.config.secret;
  }

  /**
   * Get time remaining until next code (in seconds)
   */
  getTimeRemaining(): number {
    return TOTP_PERIOD - (Math.floor(Date.now() / 1000) % TOTP_PERIOD);
  }

  /**
   * Wait for the next TOTP window and return a fresh code
   * Use this when a release fails and you want to retry with a new code
   */
  async waitForNextWindowAndGenerate(): Promise<string> {
    if (!this.config.enabled) {
      throw new Error('TOTP not enabled');
    }

    if (!this.totp) {
      throw new Error('TOTP secret not configured');
    }

    const waitTime = this.getTimeRemaining();
    logger.info(
      { waitTime },
      `🕐 [TOTP] Waiting ${waitTime}s for next window to get fresh code`
    );

    // Wait for next window + 1 second buffer
    await new Promise((resolve) => setTimeout(resolve, (waitTime + 1) * 1000));

    const code = this.totp.generate();
    logger.debug({ codeLength: code.length }, '🔐 [TOTP] Generated fresh code after waiting');

    return code;
  }
}

// Singleton instance
let totpInstance: TOTPService | null = null;

export function createTOTPService(): TOTPService {
  if (!totpInstance) {
    totpInstance = new TOTPService({
      secret: process.env.TOTP_SECRET || '',
      enabled: process.env.TOTP_SECRET ? true : false,
    });
  }
  return totpInstance;
}

export function getTOTPService(): TOTPService {
  if (!totpInstance) {
    return createTOTPService();
  }
  return totpInstance;
}
