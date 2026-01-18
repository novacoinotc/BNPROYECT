// =====================================================
// BINANCE BROWSER AUTHENTICATION SERVICE
// Uses Puppeteer to capture login session cookies
// Then uses those cookies to call Binance BAPI endpoints
// =====================================================

import puppeteer, { Browser, Page, Cookie } from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

const COOKIES_FILE = path.join(process.cwd(), 'binance-cookies.json');
const BINANCE_LOGIN_URL = 'https://accounts.binance.com/en/login';
const BINANCE_P2P_URL = 'https://p2p.binance.com/en/myads';

export interface BinanceSession {
  cookies: Cookie[];
  csrfToken?: string;
  savedAt: number;
  expiresAt?: number;
}

export class BinanceBrowserAuth {
  private session: BinanceSession | null = null;
  private browser: Browser | null = null;

  constructor() {
    this.loadSession();
  }

  /**
   * Load saved session from file
   */
  private loadSession(): void {
    try {
      if (fs.existsSync(COOKIES_FILE)) {
        const data = fs.readFileSync(COOKIES_FILE, 'utf-8');
        this.session = JSON.parse(data);

        // Check if session is expired (older than 6 days)
        const sixDaysMs = 6 * 24 * 60 * 60 * 1000;
        if (this.session && Date.now() - this.session.savedAt > sixDaysMs) {
          logger.warn('Binance session expired (>6 days old). Please login again.');
          this.session = null;
        } else if (this.session) {
          logger.info('Loaded saved Binance session');
        }
      }
    } catch (error) {
      logger.error({ error }, 'Failed to load Binance session');
      this.session = null;
    }
  }

  /**
   * Save session to file
   */
  private saveSession(): void {
    if (!this.session) return;

    try {
      fs.writeFileSync(COOKIES_FILE, JSON.stringify(this.session, null, 2));
      logger.info('Saved Binance session to file');
    } catch (error) {
      logger.error({ error }, 'Failed to save Binance session');
    }
  }

  /**
   * Check if we have a valid session
   */
  hasValidSession(): boolean {
    if (!this.session) return false;

    // Check if session is older than 6 days
    const sixDaysMs = 6 * 24 * 60 * 60 * 1000;
    if (Date.now() - this.session.savedAt > sixDaysMs) {
      return false;
    }

    // Check if we have the required cookies
    const requiredCookies = ['p20t', 'cr00', 'bnc-uuid'];
    const cookieNames = this.session.cookies.map(c => c.name);

    return requiredCookies.some(name => cookieNames.includes(name));
  }

  /**
   * Open browser for manual login
   * Returns when user has logged in successfully
   */
  async openLoginBrowser(): Promise<boolean> {
    logger.info('Opening browser for Binance login...');

    try {
      // Launch visible browser
      this.browser = await puppeteer.launch({
        headless: false,
        defaultViewport: { width: 1280, height: 800 },
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
        ],
      });

      const page = await this.browser.newPage();

      // Set user agent to look like a normal browser
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      // Navigate to login page
      await page.goto(BINANCE_LOGIN_URL, { waitUntil: 'networkidle2' });

      logger.info('='.repeat(50));
      logger.info('BROWSER OPENED - Please login to Binance manually');
      logger.info('After login, navigate to: https://p2p.binance.com/en/myads');
      logger.info('The bot will detect when you are logged in');
      logger.info('='.repeat(50));

      // Wait for user to login and navigate to P2P page
      // We detect login by checking for specific cookies or URL
      let loggedIn = false;
      let attempts = 0;
      const maxAttempts = 300; // 5 minutes max

      while (!loggedIn && attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 1000));
        attempts++;

        try {
          const currentUrl = page.url();
          const cookies = await page.cookies();

          // Log progress every 30 seconds
          if (attempts % 30 === 0) {
            logger.info({ attempts, url: currentUrl, cookieCount: cookies.length }, 'Waiting for login...');
          }

          // Check if we have auth cookies (multiple possible names)
          const hasAuthCookies = cookies.some(c =>
            c.name === 'p20t' ||
            c.name === 'cr00' ||
            c.name === 'bnc-uuid' ||
            c.name.startsWith('BNC_')
          );

          // Check if we're past the login page
          const isPastLogin =
            currentUrl.includes('p2p.binance.com') ||
            currentUrl.includes('binance.com/en/my') ||
            currentUrl.includes('binance.com/es/my') ||
            currentUrl.includes('/fiat/') ||
            (currentUrl.includes('binance.com') && !currentUrl.includes('login'));

          if (hasAuthCookies && isPastLogin) {
            loggedIn = true;
            logger.info('Login detected! Capturing session...');
          }
        } catch (e) {
          // Page might be navigating
        }
      }

      if (!loggedIn) {
        logger.error('Login timeout - please try again');
        await this.browser.close();
        this.browser = null;
        return false;
      }

      // Navigate to P2P to ensure we have all cookies
      await page.goto(BINANCE_P2P_URL, { waitUntil: 'networkidle2' });
      await new Promise(r => setTimeout(r, 2000));

      // Capture all cookies
      const cookies = await page.cookies();

      // Also try to get CSRF token from cookies
      let csrfToken: string | undefined;
      const csrfCookie = cookies.find(c => c.name === 'csrftoken');
      if (csrfCookie) {
        csrfToken = csrfCookie.value;
      }

      // Save session
      this.session = {
        cookies,
        csrfToken,
        savedAt: Date.now(),
      };
      this.saveSession();

      logger.info({ cookieCount: cookies.length }, 'Session captured successfully!');

      // Close browser
      await this.browser.close();
      this.browser = null;

      return true;

    } catch (error) {
      logger.error({ error }, 'Failed to open login browser');
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      return false;
    }
  }

  /**
   * Get cookie string for HTTP requests
   */
  getCookieString(): string {
    if (!this.session) return '';

    return this.session.cookies
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
  }

  /**
   * Get specific cookie value
   */
  getCookie(name: string): string | undefined {
    if (!this.session) return undefined;

    const cookie = this.session.cookies.find(c => c.name === name);
    return cookie?.value;
  }

  /**
   * Get CSRF token
   */
  getCSRFToken(): string | undefined {
    return this.session?.csrfToken || this.getCookie('csrftoken');
  }

  /**
   * Make authenticated request to Binance BAPI
   */
  async makeAuthenticatedRequest<T>(
    url: string,
    method: 'GET' | 'POST' = 'POST',
    body?: any
  ): Promise<T> {
    if (!this.hasValidSession()) {
      throw new Error('No valid Binance session. Please login first.');
    }

    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
      'Content-Type': 'application/json',
      'Cookie': this.getCookieString(),
      'Origin': 'https://p2p.binance.com',
      'Referer': 'https://p2p.binance.com/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'clienttype': 'web',
    };

    // Add CSRF token if available
    const csrfToken = this.getCSRFToken();
    if (csrfToken) {
      headers['x-csrf-token'] = csrfToken;
      headers['csrftoken'] = csrfToken;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json() as any;

    // Check for auth errors
    if (data.code === '100001005' || data.message?.includes('log in')) {
      logger.error('Session expired - need to login again');
      this.session = null;
      throw new Error('Session expired. Please login again.');
    }

    return data as T;
  }

  /**
   * Update ad price using BAPI (browser API)
   */
  async updateAdPrice(advNo: string, price: number): Promise<boolean> {
    const url = 'https://p2p.binance.com/bapi/c2c/v2/private/c2c/adv/update';

    // Round price to 2 decimals
    const roundedPrice = Math.round(price * 100) / 100;

    logger.info(`[BROWSER AUTH] Updating ad ${advNo} to price ${roundedPrice}`);

    try {
      const response = await this.makeAuthenticatedRequest<{
        code: string;
        message: string;
        success: boolean;
        data?: any;
      }>(url, 'POST', {
        advNo,
        price: roundedPrice,
      });

      if (response.code === '000000' || response.success) {
        logger.info(`[BROWSER AUTH] Price updated successfully: ${roundedPrice}`);
        return true;
      } else {
        logger.error({ response }, '[BROWSER AUTH] Failed to update price');
        return false;
      }
    } catch (error) {
      logger.error({ error }, '[BROWSER AUTH] Error updating price');
      throw error;
    }
  }

  /**
   * Get my ads using BAPI
   */
  async getMyAds(): Promise<any[]> {
    const url = 'https://p2p.binance.com/bapi/c2c/v2/private/c2c/adv/list-by-page';

    try {
      const response = await this.makeAuthenticatedRequest<{
        code: string;
        data: any[];
        success: boolean;
      }>(url, 'POST', {
        page: 1,
        rows: 20,
      });

      if (response.success && response.data) {
        return response.data;
      }
      return [];
    } catch (error) {
      logger.error({ error }, '[BROWSER AUTH] Error getting ads');
      return [];
    }
  }

  /**
   * Close browser if open
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Clear saved session
   */
  clearSession(): void {
    this.session = null;
    if (fs.existsSync(COOKIES_FILE)) {
      fs.unlinkSync(COOKIES_FILE);
    }
    logger.info('Cleared Binance session');
  }
}

// Singleton instance
let instance: BinanceBrowserAuth | null = null;

export function getBinanceBrowserAuth(): BinanceBrowserAuth {
  if (!instance) {
    instance = new BinanceBrowserAuth();
  }
  return instance;
}

export function createBinanceBrowserAuth(): BinanceBrowserAuth {
  return new BinanceBrowserAuth();
}
