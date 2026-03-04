import { NextRequest, NextResponse } from 'next/server';
import { getMerchantContext, getMerchantFilter } from '@/lib/merchant-context';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { Pool } from 'pg';
import { cookies } from 'next/headers';
import { getRPConfig } from '../../webauthn/rp-config';
import { prisma } from '@/lib/prisma';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const RAILWAY_API_URL = process.env.RAILWAY_API_URL;

async function getMerchantBotUrl(merchantId: string): Promise<string | null> {
  try {
    const result = await pool.query(
      'SELECT "botApiUrl" FROM "Merchant" WHERE id = $1',
      [merchantId]
    );
    return result.rows[0]?.botApiUrl || null;
  } catch (error) {
    console.error('Error getting merchant bot URL:', error);
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    // SECURITY: Require authentication
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { orderNumber, webauthnResponse } = body;

    // SECURITY: WebAuthn biometric is MANDATORY — no exceptions
    if (!orderNumber || !webauthnResponse) {
      return NextResponse.json(
        { success: false, error: 'Se requiere verificacion biometrica para liberar' },
        { status: 403 }
      );
    }

    // SECURITY: Verify merchant owns this order
    const merchantFilter = getMerchantFilter(context);
    const order = await prisma.order.findFirst({
      where: { orderNumber, ...merchantFilter },
      select: { id: true, orderNumber: true },
    });

    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found or access denied' },
        { status: 404 }
      );
    }

    // SECURITY: Read and validate WebAuthn challenge
    const cookieStore = await cookies();
    const challenge = cookieStore.get('webauthn-challenge')?.value;
    if (!challenge) {
      return NextResponse.json(
        { success: false, error: 'WebAuthn challenge expired — intenta de nuevo' },
        { status: 400 }
      );
    }

    // SECURITY: Find credential scoped to this merchant
    const credential = await prisma.webAuthnCredential.findFirst({
      where: {
        credentialId: webauthnResponse.id,
        merchantId: context.merchantId,
      },
    });

    if (!credential) {
      return NextResponse.json(
        { success: false, error: 'Passkey no reconocida' },
        { status: 403 }
      );
    }

    const { rpID, origin } = getRPConfig(request);

    // SECURITY: Verify the WebAuthn assertion
    const verification = await verifyAuthenticationResponse({
      response: webauthnResponse,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: credential.credentialId,
        publicKey: new Uint8Array(credential.publicKey),
        counter: Number(credential.counter),
        transports: credential.transports as AuthenticatorTransport[],
      },
      requireUserVerification: true,
    });

    if (!verification.verified) {
      return NextResponse.json(
        { success: false, error: 'Verificacion biometrica fallida' },
        { status: 403 }
      );
    }

    // Update credential counter and last used
    await prisma.webAuthnCredential.update({
      where: { id: credential.id },
      data: {
        counter: BigInt(verification.authenticationInfo.newCounter),
        lastUsedAt: new Date(),
      },
    });

    // Clear challenge cookie
    cookieStore.delete('webauthn-challenge');

    // Get bot URL
    const botUrl = await getMerchantBotUrl(context.merchantId);
    const apiUrl = botUrl || RAILWAY_API_URL;

    if (!apiUrl) {
      return NextResponse.json(
        { success: false, error: 'Bot API URL not configured' },
        { status: 500 }
      );
    }

    // SECURITY: Only useAutoTOTP — bot generates the code, never sent from client
    const response = await fetch(`${apiUrl}/api/orders/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderNumber, useAutoTOTP: true }),
      signal: AbortSignal.timeout(30000),
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: data.error || 'Failed to release order' },
        { status: response.status }
      );
    }

    return NextResponse.json(data);
  } catch (error: any) {
    console.error('Release API error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to release order' },
      { status: 500 }
    );
  }
}
