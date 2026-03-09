import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getMerchantContext, getMerchantFilter } from '@/lib/merchant-context';
import { compressImage } from '@/lib/image-compress';

// GET - List documents for a trusted buyer (metadata only, no imageData)
export async function GET(request: NextRequest) {
  try {
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const trustedBuyerId = searchParams.get('trustedBuyerId');

    const merchantFilter = getMerchantFilter(context);

    const documents = await prisma.buyerDocument.findMany({
      where: {
        ...(trustedBuyerId ? { trustedBuyerId } : {}),
        ...merchantFilter,
      },
      select: {
        id: true,
        trustedBuyerId: true,
        documentType: true,
        mimeType: true,
        originalSize: true,
        compressedSize: true,
        sourceOrderNumber: true,
        notes: true,
        uploadedBy: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({ success: true, documents });
  } catch (error) {
    console.error('Error fetching buyer documents:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch documents' },
      { status: 500 }
    );
  }
}

// POST - Upload a document (base64 image)
export async function POST(request: NextRequest) {
  try {
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { trustedBuyerId, imageBase64, documentType, notes } = body;

    if (!trustedBuyerId || !imageBase64) {
      return NextResponse.json(
        { success: false, error: 'trustedBuyerId and imageBase64 are required' },
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

    // Decode base64 and compress
    const rawBuffer = Buffer.from(imageBase64, 'base64');
    const compressed = await compressImage(rawBuffer);

    const document = await prisma.buyerDocument.create({
      data: {
        trustedBuyerId,
        documentType: documentType || 'INE',
        imageData: compressed.data,
        mimeType: compressed.mimeType,
        originalSize: compressed.originalSize,
        compressedSize: compressed.compressedSize,
        notes: notes || null,
        uploadedBy: 'manual',
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
    console.error('Error uploading buyer document:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to upload document' },
      { status: 500 }
    );
  }
}

// DELETE - Remove a document
export async function DELETE(request: NextRequest) {
  try {
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { id } = body;

    if (!id) {
      return NextResponse.json(
        { success: false, error: 'id is required' },
        { status: 400 }
      );
    }

    // Verify merchant owns this document
    const merchantFilter = getMerchantFilter(context);
    const doc = await prisma.buyerDocument.findFirst({
      where: { id, ...merchantFilter },
    });
    if (!doc) {
      return NextResponse.json(
        { success: false, error: 'Document not found or access denied' },
        { status: 404 }
      );
    }

    await prisma.buyerDocument.delete({ where: { id } });

    return NextResponse.json({ success: true, message: 'Document deleted' });
  } catch (error) {
    console.error('Error deleting buyer document:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete document' },
      { status: 500 }
    );
  }
}
