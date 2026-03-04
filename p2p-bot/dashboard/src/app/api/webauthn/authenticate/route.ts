import { NextRequest, NextResponse } from 'next/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { PrismaClient } from '@prisma/client';
import { getMerchantContext } from '@/lib/merchant-context';
import { cookies } from 'next/headers';
import { getRPConfig } from '../rp-config';

const prisma = new PrismaClient();

// GET — Generate authentication options
export async function GET(request: NextRequest) {
  try {
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const credentials = await prisma.webAuthnCredential.findMany({
      where: { merchantId: context.merchantId },
      select: { credentialId: true, transports: true },
    });

    if (credentials.length === 0) {
      return NextResponse.json({ error: 'No passkeys registered' }, { status: 404 });
    }

    const { rpID } = getRPConfig(request);

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: credentials.map((cred) => ({
        id: cred.credentialId,
        transports: cred.transports as AuthenticatorTransport[],
      })),
      userVerification: 'required',
    });

    // Store challenge in cookie
    const cookieStore = await cookies();
    cookieStore.set('webauthn-challenge', options.challenge, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 120,
      path: '/',
    });

    return NextResponse.json(options);
  } catch (error: any) {
    console.error('WebAuthn authenticate options error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
