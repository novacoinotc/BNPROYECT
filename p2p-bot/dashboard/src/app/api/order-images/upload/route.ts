import { NextRequest, NextResponse } from 'next/server';
import { getMerchantContext } from '@/lib/merchant-context';
import { Pool } from 'pg';
import sharp from 'sharp';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function generateId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).substring(2, 15)}`;
}

export async function POST(request: NextRequest) {
  try {
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const orderNumber = formData.get('orderNumber') as string || '';
    const buyerName = formData.get('buyerName') as string || '';
    const amount = formData.get('amount') as string || '';
    const notes = formData.get('notes') as string || '';

    if (!file) {
      return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 });
    }

    // Read file
    const arrayBuffer = await file.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);
    const originalSize = imageBuffer.length;

    // Compress
    let compressedBuffer: Buffer;
    try {
      compressedBuffer = await sharp(imageBuffer)
        .resize(1200, null, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 60 })
        .toBuffer();
    } catch {
      compressedBuffer = imageBuffer;
    }

    // Classify from user-provided type or default to UNKNOWN
    const userType = formData.get('documentType') as string || '';
    let documentType = userType || 'UNKNOWN';
    let ocrText: string | undefined;

    // Append notes to ocrText
    if (notes) {
      ocrText = (ocrText || '') + '\n\n--- Notas ---\n' + notes;
    }

    // Save
    const id = generateId();
    await pool.query(
      `INSERT INTO "OrderImage" (id, "orderNumber", "imageData", "documentType", "mimeType",
        "originalSize", "compressedSize", "amount", "buyerName", "chatMessageId", "ocrText", "merchantId", "createdAt")
       VALUES ($1, $2, $3, $4, 'image/jpeg', $5, $6, $7, $8, $9, $10, $11, NOW())`,
      [
        id,
        orderNumber || 'MANUAL-' + Date.now(),
        compressedBuffer,
        documentType,
        originalSize,
        compressedBuffer.length,
        amount || null,
        buyerName || null,
        'upload-' + id,
        ocrText || null,
        context.merchantId,
      ]
    );

    return NextResponse.json({
      success: true,
      id,
      documentType,
      compressedSize: compressedBuffer.length,
      ocrDetected: !!ocrText,
      buyerNameDetected: ocrText ? extractName(ocrText) : null,
    });
  } catch (error: any) {
    console.error('Upload error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Try to extract a name from OCR text
function extractName(text: string): string | null {
  // Look for patterns like "NOMBRE: ..." or name-like text after common labels
  const patterns = [
    /NOMBRE[:\s]+([A-ZÁÉÍÓÚÑ\s]{5,40})/i,
    /APELLIDO[S]?[:\s]+([A-ZÁÉÍÓÚÑ\s]{5,40})/i,
    /TITULAR[:\s]+([A-ZÁÉÍÓÚÑ\s]{5,40})/i,
    /BENEFICIARIO[:\s]+([A-ZÁÉÍÓÚÑ\s]{5,40})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}
