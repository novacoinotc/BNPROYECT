import { NextRequest, NextResponse } from 'next/server';
import { getMerchantContext } from '@/lib/merchant-context';
import { prisma } from '@/lib/prisma';

// GET — List credentials for current merchant
export async function GET() {
  try {
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const credentials = await prisma.webAuthnCredential.findMany({
      where: { merchantId: context.merchantId },
      select: {
        id: true,
        deviceName: true,
        createdAt: true,
        lastUsedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({ success: true, credentials });
  } catch (error: any) {
    console.error('WebAuthn credentials list error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// DELETE — Remove a credential
export async function DELETE(request: NextRequest) {
  try {
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { id } = body;

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    // Verify merchant owns this credential
    const credential = await prisma.webAuthnCredential.findFirst({
      where: { id, merchantId: context.merchantId },
    });

    if (!credential) {
      return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
    }

    await prisma.webAuthnCredential.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('WebAuthn credential delete error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
