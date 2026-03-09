import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getMerchantContext, getMerchantFilter } from '@/lib/merchant-context';
import { compressImage } from '@/lib/image-compress';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Get bot URL for the logged-in merchant
async function getMerchantBotUrl(merchantId: string): Promise<string | null> {
  try {
    const result = await pool.query(
      'SELECT "botApiUrl" FROM "Merchant" WHERE id = $1',
      [merchantId]
    );
    return result.rows[0]?.botApiUrl || null;
  } catch {
    return null;
  }
}

// POST - Download image from Binance chat URL via bot proxy, compress, and save
export async function POST(request: NextRequest) {
  try {
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { trustedBuyerId, imageUrl, orderNumber, chatMessageId, documentType } = body;

    if (!trustedBuyerId || !imageUrl) {
      return NextResponse.json(
        { success: false, error: 'trustedBuyerId and imageUrl are required' },
        { status: 400 }
      );
    }

    // Verify merchant owns this trusted buyer
    const merchantFilter = getMerchantFilter(context);
    const buyer = await prisma.trustedBuyer.findFirst({
      where: { id: trustedBuyerId, ...merchantFilter },
    });
    if (!buyer) {
      return NextResponse.json(
        { success: false, error: 'Trusted buyer not found or access denied' },
        { status: 404 }
      );
    }

    // Download image — try bot proxy first (for auth'd Binance URLs), then direct
    let imageBuffer: Buffer | null = null;

    // Try via bot proxy
    const botUrl = await getMerchantBotUrl(context.merchantId);
    const apiUrl = botUrl || process.env.RAILWAY_API_URL;

    if (apiUrl) {
      try {
        const proxyRes = await fetch(
          `${apiUrl}/api/proxy-image?url=${encodeURIComponent(imageUrl)}`,
          { signal: AbortSignal.timeout(15000) }
        );
        if (proxyRes.ok) {
          const arrayBuffer = await proxyRes.arrayBuffer();
          imageBuffer = Buffer.from(arrayBuffer);
        }
      } catch {
        // Bot proxy failed, try direct
      }
    }

    // Fallback: direct fetch (works for public CDN URLs)
    if (!imageBuffer) {
      try {
        const directRes = await fetch(imageUrl, {
          signal: AbortSignal.timeout(10000),
        });
        if (directRes.ok) {
          const arrayBuffer = await directRes.arrayBuffer();
          imageBuffer = Buffer.from(arrayBuffer);
        }
      } catch {
        // Direct fetch also failed
      }
    }

    if (!imageBuffer || imageBuffer.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No se pudo descargar la imagen. Es posible que haya expirado.' },
        { status: 422 }
      );
    }

    // Compress
    const compressed = await compressImage(imageBuffer);

    const document = await prisma.buyerDocument.create({
      data: {
        trustedBuyerId,
        documentType: documentType || 'INE',
        imageData: compressed.data,
        mimeType: compressed.mimeType,
        originalSize: compressed.originalSize,
        compressedSize: compressed.compressedSize,
        sourceOrderNumber: orderNumber || null,
        sourceChatMessageId: chatMessageId || null,
        uploadedBy: 'chat-extract',
        merchantId: context.merchantId,
      },
      select: {
        id: true,
        documentType: true,
        compressedSize: true,
        createdAt: true,
      },
    });

    return NextResponse.json({ success: true, document });
  } catch (error) {
    console.error('Error saving document from chat:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to save document from chat' },
      { status: 500 }
    );
  }
}
