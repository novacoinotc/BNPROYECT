import { NextRequest, NextResponse } from 'next/server';
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { prisma } from '@/lib/prisma';
import { cookies } from 'next/headers';
import { getRPConfig } from '../../webauthn/rp-config';
import jwt from 'next-auth/jwt';

// GET — Generate authentication options for login (no session required)
// Accepts optional ?merchantId= to include allowCredentials for non-discoverable fallback
export async function GET(request: NextRequest) {
  try {
    const { rpID } = getRPConfig(request);
    const merchantId = request.nextUrl.searchParams.get('merchantId');

    // If merchantId provided, fetch credentials to include as allowCredentials
    let allowCredentials: { id: string; transports?: AuthenticatorTransport[] }[] | undefined;
    if (merchantId) {
      const credentials = await prisma.webAuthnCredential.findMany({
        where: { merchantId },
        select: { credentialId: true, transports: true },
      });
      if (credentials.length > 0) {
        allowCredentials = credentials.map((c) => ({
          id: c.credentialId,
          transports: c.transports as AuthenticatorTransport[],
        }));
      }
    }

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials,
    });

    const cookieStore = await cookies();
    cookieStore.set('webauthn-login-challenge', options.challenge, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 120,
      path: '/',
    });

    return NextResponse.json(options);
  } catch (error: any) {
    console.error('WebAuthn login options error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST — Verify passkey and return merchant info for session creation
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { assertionResponse } = body;

    if (!assertionResponse) {
      return NextResponse.json({ error: 'assertionResponse is required' }, { status: 400 });
    }

    const cookieStore = await cookies();
    const challenge = cookieStore.get('webauthn-login-challenge')?.value;
    if (!challenge) {
      return NextResponse.json({ error: 'Challenge expired' }, { status: 400 });
    }

    // Find credential by ID to get the merchant
    const credential = await prisma.webAuthnCredential.findFirst({
      where: { credentialId: assertionResponse.id },
      include: { merchant: { select: { id: true, name: true, email: true, isAdmin: true, isActive: true } } },
    });

    if (!credential) {
      return NextResponse.json({ error: 'Passkey no reconocida' }, { status: 401 });
    }

    if (!credential.merchant.isActive) {
      return NextResponse.json({ error: 'Cuenta desactivada' }, { status: 401 });
    }

    const { rpID, origin } = getRPConfig(request);

    const verification = await verifyAuthenticationResponse({
      response: assertionResponse,
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
      return NextResponse.json({ error: 'Verificacion fallida' }, { status: 401 });
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
    cookieStore.delete('webauthn-login-challenge');

    // Return merchant info — the client will use signIn('credentials') with a special token
    return NextResponse.json({
      success: true,
      merchant: {
        id: credential.merchant.id,
        name: credential.merchant.name,
        email: credential.merchant.email,
        isAdmin: credential.merchant.isAdmin,
      },
    });
  } catch (error: any) {
    console.error('WebAuthn login verify error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
