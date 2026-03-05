import { NextRequest, NextResponse } from 'next/server';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import { getMerchantContext } from '@/lib/merchant-context';
import { cookies } from 'next/headers';
import { getRPConfig } from '../rp-config';
import { prisma } from '@/lib/prisma';

// GET — Generate registration options
export async function GET(request: NextRequest) {
  try {
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get existing credentials to exclude
    const existingCredentials = await prisma.webAuthnCredential.findMany({
      where: { merchantId: context.merchantId },
      select: { credentialId: true, transports: true },
    });

    const { rpID, rpName } = getRPConfig(request);

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: context.email,
      userDisplayName: context.name,
      attestationType: 'none',
      excludeCredentials: existingCredentials.map((cred) => ({
        id: cred.credentialId,
        transports: cred.transports as AuthenticatorTransport[],
      })),
      authenticatorSelection: {
        userVerification: 'required',
        residentKey: 'required',
      },
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
    console.error('WebAuthn register options error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST — Verify registration and save credential
export async function POST(request: NextRequest) {
  try {
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { attestationResponse, deviceName } = body;

    if (!attestationResponse) {
      return NextResponse.json({ error: 'attestationResponse is required' }, { status: 400 });
    }

    // Read challenge from cookie
    const cookieStore = await cookies();
    const challenge = cookieStore.get('webauthn-challenge')?.value;
    if (!challenge) {
      return NextResponse.json({ error: 'Challenge expired or not found' }, { status: 400 });
    }

    const { rpID, origin } = getRPConfig(request);

    const verification = await verifyRegistrationResponse({
      response: attestationResponse,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return NextResponse.json({ error: 'Verification failed' }, { status: 400 });
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    // Save credential to DB
    console.log(`[webauthn/register] Saving credential for merchant=${context.merchantId} credentialId=${credential.id}`);
    const saved = await prisma.webAuthnCredential.create({
      data: {
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        transports: credential.transports || [],
        deviceName: deviceName || null,
        merchantId: context.merchantId,
      },
    });

    // Verify the save actually persisted (catches PgBouncer/Neon phantom writes)
    const verifyCount = await prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*)::bigint as count FROM "WebAuthnCredential" WHERE "merchantId" = ${context.merchantId}
    `;
    const count = Number(verifyCount[0].count);
    console.log(`[webauthn/register] After save: merchantId=${context.merchantId} savedId=${saved.id} dbCount=${count}`);

    if (count === 0) {
      console.error(`[webauthn/register] CRITICAL: Prisma create returned but credential NOT in DB!`);
      return NextResponse.json({ error: 'Credential no persistio en la base de datos' }, { status: 500 });
    }

    // Clear challenge cookie
    cookieStore.delete('webauthn-challenge');

    return NextResponse.json({
      success: true,
      credential: {
        id: saved.id,
        deviceName: saved.deviceName,
        createdAt: saved.createdAt,
      },
    });
  } catch (error: any) {
    console.error('WebAuthn register verify error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
