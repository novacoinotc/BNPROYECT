// =====================================================
// OCR SERVICE
// Extract payment info from receipt images
// =====================================================

import Tesseract from 'tesseract.js';
import axios from 'axios';
import { ocrLogger as logger } from '../utils/logger.js';
import { OCRResult } from '../types/binance.js';

export interface OCRConfig {
  language: string;
  minConfidence: number;
  timeout: number;
}

export interface ReceiptData {
  amount: number | null;
  date: string | null;
  senderName: string | null;
  receiverName: string | null;
  reference: string | null;
  bankName: string | null;
  confidence: number;
  rawText: string;
}

// Common Mexican bank patterns
const BANK_PATTERNS = {
  // Amount patterns (handles Mexican format: $1,234.56 or 1234.56)
  amount: [
    /\$?\s*([\d,]+\.?\d*)\s*(?:MXN|pesos?)?/gi,
    /monto\s*:?\s*\$?\s*([\d,]+\.?\d*)/gi,
    /importe\s*:?\s*\$?\s*([\d,]+\.?\d*)/gi,
    /total\s*:?\s*\$?\s*([\d,]+\.?\d*)/gi,
    /cantidad\s*:?\s*\$?\s*([\d,]+\.?\d*)/gi,
  ],

  // Date patterns
  date: [
    /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/g,
    /(\d{1,2}\s+(?:de\s+)?(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\w*\s+(?:de\s+)?\d{2,4})/gi,
  ],

  // Reference/folio patterns
  reference: [
    /(?:referencia|ref|folio|clave\s+rastreo)\s*:?\s*([A-Z0-9]{6,})/gi,
    /([A-Z]{2}\d{12,})/g, // SPEI format
  ],

  // Name patterns
  name: [
    /(?:ordenante|de|from|nombre)\s*:?\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{2,})/gi,
    /(?:beneficiario|a|to|para)\s*:?\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{2,})/gi,
  ],

  // Bank names
  banks: [
    'BBVA', 'Bancomer', 'Santander', 'Banamex', 'Citibanamex',
    'HSBC', 'Scotiabank', 'Banorte', 'Inbursa', 'Banregio',
    'Azteca', 'Compartamos', 'Afirme', 'BanBajío', 'Multiva',
  ],
};

export class OCRService {
  private config: OCRConfig;
  private worker: Tesseract.Worker | null = null;
  private isInitialized: boolean = false;

  constructor(config: OCRConfig) {
    this.config = config;
    logger.info({ language: config.language }, 'OCR service initialized');
  }

  // ==================== INITIALIZATION ====================

  /**
   * Initialize Tesseract worker
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      logger.info('Initializing Tesseract worker...');

      this.worker = await Tesseract.createWorker(this.config.language);

      this.isInitialized = true;
      logger.info('Tesseract worker ready');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize Tesseract');
      throw error;
    }
  }

  /**
   * Terminate worker
   */
  async terminate(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      this.isInitialized = false;
      logger.info('Tesseract worker terminated');
    }
  }

  // ==================== OCR PROCESSING ====================

  /**
   * Process receipt image from URL
   */
  async processReceiptUrl(imageUrl: string): Promise<OCRResult> {
    try {
      logger.debug({ imageUrl }, 'Downloading receipt image');

      // Download image
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: this.config.timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0',
        },
      });

      const imageBuffer = Buffer.from(response.data);
      return this.processReceiptBuffer(imageBuffer);
    } catch (error) {
      logger.error({ error, imageUrl }, 'Failed to download/process image');
      return {
        confidence: 0,
        rawText: '',
      };
    }
  }

  /**
   * Process receipt image from buffer
   */
  async processReceiptBuffer(imageBuffer: Buffer): Promise<OCRResult> {
    await this.initialize();

    if (!this.worker) {
      throw new Error('OCR worker not initialized');
    }

    try {
      logger.debug('Running OCR on image...');

      const { data } = await this.worker.recognize(imageBuffer);

      const rawText = data.text;
      const confidence = data.confidence / 100;

      logger.debug({
        confidence: confidence.toFixed(2),
        textLength: rawText.length,
      }, 'OCR completed');

      // Extract structured data
      const receiptData = this.extractReceiptData(rawText);

      const result: OCRResult = {
        amount: receiptData.amount || undefined,
        date: receiptData.date || undefined,
        senderName: receiptData.senderName || undefined,
        receiverName: receiptData.receiverName || undefined,
        reference: receiptData.reference || undefined,
        confidence,
        rawText,
      };

      logger.info({
        amount: result.amount,
        date: result.date,
        sender: result.senderName,
        reference: result.reference,
        confidence: confidence.toFixed(2),
      }, 'Receipt data extracted');

      return result;
    } catch (error) {
      logger.error({ error }, 'OCR processing failed');
      return {
        confidence: 0,
        rawText: '',
      };
    }
  }

  // ==================== DATA EXTRACTION ====================

  /**
   * Extract structured data from OCR text
   */
  private extractReceiptData(text: string): ReceiptData {
    const normalizedText = this.normalizeText(text);

    return {
      amount: this.extractAmount(normalizedText),
      date: this.extractDate(normalizedText),
      senderName: this.extractSenderName(normalizedText),
      receiverName: this.extractReceiverName(normalizedText),
      reference: this.extractReference(normalizedText),
      bankName: this.extractBankName(normalizedText),
      confidence: 0,
      rawText: text,
    };
  }

  /**
   * Normalize text for pattern matching
   */
  private normalizeText(text: string): string {
    return text
      .replace(/\s+/g, ' ')
      .replace(/['']/g, "'")
      .trim();
  }

  /**
   * Extract amount from text
   */
  private extractAmount(text: string): number | null {
    const amounts: number[] = [];

    for (const pattern of BANK_PATTERNS.amount) {
      const matches = text.matchAll(pattern);

      for (const match of matches) {
        if (match[1]) {
          // Parse Mexican number format (1,234.56)
          const cleanAmount = match[1]
            .replace(/,/g, '')
            .replace(/\s/g, '');

          const amount = parseFloat(cleanAmount);

          if (!isNaN(amount) && amount > 0 && amount < 1000000) {
            amounts.push(amount);
          }
        }
      }
    }

    if (amounts.length === 0) return null;

    // Return the most likely amount (typically the largest reasonable one)
    const validAmounts = amounts.filter(a => a >= 100 && a <= 500000);

    if (validAmounts.length > 0) {
      // Sort and return the most common or largest
      return validAmounts.sort((a, b) => b - a)[0];
    }

    return amounts[0];
  }

  /**
   * Extract date from text
   */
  private extractDate(text: string): string | null {
    for (const pattern of BANK_PATTERNS.date) {
      const match = text.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * Extract sender name from text
   */
  private extractSenderName(text: string): string | null {
    // Look for patterns like "De: NOMBRE" or "Ordenante: NOMBRE"
    const senderPatterns = [
      /(?:ordenante|de|from)\s*:?\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{3,30})/i,
      /(?:nombre)\s*:?\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{3,30})/i,
    ];

    for (const pattern of senderPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return this.cleanName(match[1]);
      }
    }

    return null;
  }

  /**
   * Extract receiver name from text
   */
  private extractReceiverName(text: string): string | null {
    const receiverPatterns = [
      /(?:beneficiario|a|to|para|destino)\s*:?\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{3,30})/i,
    ];

    for (const pattern of receiverPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return this.cleanName(match[1]);
      }
    }

    return null;
  }

  /**
   * Extract reference/folio from text
   */
  private extractReference(text: string): string | null {
    for (const pattern of BANK_PATTERNS.reference) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return match[1].toUpperCase();
      }
    }

    return null;
  }

  /**
   * Extract bank name from text
   */
  private extractBankName(text: string): string | null {
    const upperText = text.toUpperCase();

    for (const bank of BANK_PATTERNS.banks) {
      if (upperText.includes(bank.toUpperCase())) {
        return bank;
      }
    }

    return null;
  }

  /**
   * Clean extracted name
   */
  private cleanName(name: string): string {
    return name
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[^A-ZÁÉÍÓÚÑ\s]/gi, '')
      .split(' ')
      .filter(word => word.length > 1)
      .join(' ')
      .substring(0, 50);
  }

  // ==================== VERIFICATION ====================

  /**
   * Verify receipt matches expected payment
   */
  verifyReceipt(
    ocrResult: OCRResult,
    expectedAmount: number,
    expectedName?: string,
    tolerance: number = 0.01
  ): { verified: boolean; confidence: number; issues: string[] } {
    const issues: string[] = [];
    let confidence = ocrResult.confidence;

    // Check OCR confidence
    if (confidence < this.config.minConfidence) {
      issues.push(`Low OCR confidence: ${(confidence * 100).toFixed(0)}%`);
    }

    // Verify amount
    if (ocrResult.amount) {
      const amountDiff = Math.abs(ocrResult.amount - expectedAmount);
      const maxDiff = expectedAmount * tolerance;

      if (amountDiff > maxDiff) {
        issues.push(
          `Amount mismatch: expected ${expectedAmount}, found ${ocrResult.amount}`
        );
        confidence *= 0.5;
      } else {
        confidence *= 1.2; // Boost confidence for matching amount
      }
    } else {
      issues.push('Could not extract amount from receipt');
      confidence *= 0.7;
    }

    // Verify sender name (optional)
    if (expectedName && ocrResult.senderName) {
      const nameMatch = this.fuzzyNameMatch(ocrResult.senderName, expectedName);

      if (!nameMatch) {
        issues.push(
          `Name mismatch: expected "${expectedName}", found "${ocrResult.senderName}"`
        );
        confidence *= 0.8;
      } else {
        confidence *= 1.1; // Boost for matching name
      }
    }

    // Check for date (should be recent)
    if (!ocrResult.date) {
      issues.push('Could not extract date from receipt');
      confidence *= 0.9;
    }

    // Cap confidence at 1.0
    confidence = Math.min(confidence, 1.0);

    const verified = confidence >= this.config.minConfidence && issues.length <= 1;

    logger.info({
      verified,
      confidence: confidence.toFixed(2),
      issues,
      expectedAmount,
      foundAmount: ocrResult.amount,
    }, 'Receipt verification result');

    return {
      verified,
      confidence,
      issues,
    };
  }

  /**
   * Fuzzy name matching
   */
  private fuzzyNameMatch(name1: string, name2: string): boolean {
    const normalize = (s: string) =>
      s.toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');

    const n1 = normalize(name1);
    const n2 = normalize(name2);

    // Check for containment
    if (n1.includes(n2) || n2.includes(n1)) {
      return true;
    }

    // Check for partial word matches
    const words1 = n1.split(/\s+/).filter(w => w.length > 2);
    const words2 = n2.split(/\s+/).filter(w => w.length > 2);

    const matchingWords = words1.filter(w1 =>
      words2.some(w2 => w1.includes(w2) || w2.includes(w1))
    );

    return matchingWords.length >= Math.min(words1.length, words2.length) / 2;
  }

  // ==================== UTILITIES ====================

  /**
   * Check if service is ready
   */
  isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Get configuration
   */
  getConfig(): OCRConfig {
    return { ...this.config };
  }
}

// Factory function
export function createOCRService(config?: Partial<OCRConfig>): OCRService {
  const defaultConfig: OCRConfig = {
    language: process.env.OCR_LANGUAGE || 'spa',
    minConfidence: parseFloat(process.env.OCR_MIN_CONFIDENCE || '0.6'),
    timeout: parseInt(process.env.OCR_TIMEOUT_MS || '30000'),
  };

  return new OCRService({ ...defaultConfig, ...config });
}
