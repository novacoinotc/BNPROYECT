import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getMerchantContext, getMerchantFilter } from '@/lib/merchant-context';

// GET - Serve the stored image as binary
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const context = await getMerchantContext();
    if (!context) {
      return new NextResponse('Unauthorized', { status: 401 });
    }

    const { id } = await params;

    const merchantFilter = getMerchantFilter(context);
    const doc = await prisma.buyerDocument.findFirst({
      where: { id, ...merchantFilter },
      select: { imageData: true, mimeType: true },
    });

    if (!doc) {
      return new NextResponse('Not found', { status: 404 });
    }

    const uint8 = new Uint8Array(doc.imageData);
    return new NextResponse(uint8, {
      headers: {
        'Content-Type': doc.mimeType,
        'Cache-Control': 'private, max-age=86400',
      },
    });
  } catch (error) {
    console.error('Error serving buyer document image:', error);
    return new NextResponse('Internal server error', { status: 500 });
  }
}
