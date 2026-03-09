// =====================================================
// DOCUMENT CLASSIFIER
// Classifies chat images as ID documents vs receipts
// Uses Tesseract OCR text analysis with pattern matching
// =====================================================

import { logger } from '../utils/logger.js';

export type DocumentType = 'ID_INE' | 'ID_PASSPORT' | 'ID_LICENSE' | 'RECEIPT' | 'UNKNOWN';

export interface ClassificationResult {
  type: DocumentType;
  confidence: number;       // 0-1
  detectedPatterns: string[];
  rawText: string;
}

// ==================== ID PATTERNS ====================

const INE_PATTERNS = [
  /INSTITUTO\s+NACIONAL\s+ELECTORAL/i,
  /CREDENCIAL\s+PARA\s+VOTAR/i,
  /CLAVE\s+DE\s+ELECTOR/i,
  /REGISTRO\s+FEDERAL\s+DE\s+ELECTORES/i,
  /SECCION\s+ELECTORAL/i,
  /\bINE\b/,
  /\bIFE\b/,
];

const PASSPORT_PATTERNS = [
  /\bPASAPORTE\b/i,
  /\bPASSPORT\b/i,
  /SECRETARIA\s+DE\s+RELACIONES\s+EXTERIORES/i,
  /ESTADOS\s+UNIDOS\s+MEXICANOS/i,
];

const LICENSE_PATTERNS = [
  /LICENCIA\s+(?:DE|PARA)\s+CONDUCIR/i,
  /TIPO\s+DE\s+LICENCIA/i,
  /SECRETARIA\s+DE\s+MOVILIDAD/i,
  /LICENCIA\s+DE\s+MANEJO/i,
];

// Supporting patterns that boost ID confidence
const ID_SUPPORT_PATTERNS = [
  /CURP\s*[:\s]?\s*[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z\d]{2}/i,
  /\bCURP\b/i,
  /\bDOMICILIO\b/i,
  /FECHA\s+DE\s+NACIMIENTO/i,
  /\bVIGENCIA\b/i,
  /\bNACIONALIDAD\b/i,
  /ESTADO\s+DE\s+NACIMIENTO/i,
  /A[ÑN]O\s+DE\s+REGISTRO/i,
  /CLAVE\s+DE\s+ELECTOR/i,
];

// Receipt patterns (to differentiate from IDs)
const RECEIPT_PATTERNS = [
  /\$\s*[\d,]+\.\d{2}/,                    // Money amounts like $1,234.56
  /\bCLABE\b/i,
  /\bSPEI\b/i,
  /CLAVE\s+DE\s+RASTREO/i,
  /\bREFERENCIA\b/i,
  /\bTRANSFERENCIA\b/i,
  /\bCOMPROBANTE\b/i,
  /\bBBVA\b/i,
  /\bBANORTE\b/i,
  /\bSANTANDER\b/i,
  /\bBANAMEX\b/i,
  /\bCITIBANAMEX\b/i,
  /\bHSBC\b/i,
  /\bSCOTIABANK\b/i,
  /\bINBURSA\b/i,
  /\bBANREGIO\b/i,
  /\bAZTECA\b/i,
  /OPERACI[OÓ]N\s+EXITOSA/i,
  /PAGO\s+(?:ENVIADO|REALIZADO)/i,
];

// ==================== CLASSIFIER ====================

/**
 * Classify OCR text as ID document, receipt, or unknown
 */
export function classifyText(rawText: string): ClassificationResult {
  const text = rawText.replace(/\s+/g, ' ').trim();
  const detectedPatterns: string[] = [];

  // Count ID matches per type
  let ineScore = 0;
  let passportScore = 0;
  let licenseScore = 0;
  let receiptScore = 0;
  let idSupportScore = 0;

  for (const p of INE_PATTERNS) {
    if (p.test(text)) {
      ineScore++;
      detectedPatterns.push(`INE: ${p.source}`);
    }
  }

  for (const p of PASSPORT_PATTERNS) {
    if (p.test(text)) {
      passportScore++;
      detectedPatterns.push(`PASSPORT: ${p.source}`);
    }
  }

  for (const p of LICENSE_PATTERNS) {
    if (p.test(text)) {
      licenseScore++;
      detectedPatterns.push(`LICENSE: ${p.source}`);
    }
  }

  for (const p of ID_SUPPORT_PATTERNS) {
    if (p.test(text)) {
      idSupportScore++;
      detectedPatterns.push(`ID_SUPPORT: ${p.source}`);
    }
  }

  for (const p of RECEIPT_PATTERNS) {
    if (p.test(text)) {
      receiptScore++;
      detectedPatterns.push(`RECEIPT: ${p.source}`);
    }
  }

  // Calculate scores
  const totalIdScore = ineScore + passportScore + licenseScore;
  const totalIdWithSupport = totalIdScore + idSupportScore * 0.5;

  // If receipt score dominates, classify as receipt
  if (receiptScore >= 2 && receiptScore > totalIdWithSupport) {
    return {
      type: 'RECEIPT',
      confidence: Math.min(receiptScore / 5, 1),
      detectedPatterns,
      rawText,
    };
  }

  // Determine best ID type
  let bestType: DocumentType = 'UNKNOWN';
  let bestScore = 0;

  if (ineScore > bestScore) {
    bestType = 'ID_INE';
    bestScore = ineScore;
  }
  if (passportScore > bestScore) {
    bestType = 'ID_PASSPORT';
    bestScore = passportScore;
  }
  if (licenseScore > bestScore) {
    bestType = 'ID_LICENSE';
    bestScore = licenseScore;
  }

  // Need at least 1 specific ID pattern match
  if (bestScore >= 1) {
    // Confidence: base from specific matches + boost from support patterns
    const confidence = Math.min((bestScore * 0.3) + (idSupportScore * 0.15), 1);
    return {
      type: bestType,
      confidence,
      detectedPatterns,
      rawText,
    };
  }

  // If only support patterns matched (no specific ID type), still might be an ID
  if (idSupportScore >= 3 && receiptScore === 0) {
    return {
      type: 'ID_INE', // Default to INE as most common
      confidence: Math.min(idSupportScore * 0.15, 0.6),
      detectedPatterns,
      rawText,
    };
  }

  return {
    type: 'UNKNOWN',
    confidence: 0,
    detectedPatterns,
    rawText,
  };
}

/**
 * Log classification result
 */
export function logClassification(result: ClassificationResult, orderNo: string): void {
  if (result.type !== 'UNKNOWN') {
    logger.info({
      orderNo,
      documentType: result.type,
      confidence: result.confidence.toFixed(2),
      patterns: result.detectedPatterns,
      textPreview: result.rawText.substring(0, 100),
    }, `🔍 [DOC CLASSIFIER] Detected: ${result.type}`);
  } else {
    logger.debug({
      orderNo,
      textLength: result.rawText.length,
    }, '🔍 [DOC CLASSIFIER] No document pattern detected');
  }
}
