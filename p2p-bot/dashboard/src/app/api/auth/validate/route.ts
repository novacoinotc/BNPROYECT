import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// POST — Validate email + password, check if 2FA (passkey) is required
export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json({ error: 'Email y password requeridos' }, { status: 400 });
    }

    const merchant = await prisma.merchant.findUnique({
      where: { email },
      select: { id: true, isActive: true, passwordHash: true },
    });

    if (!merchant || !merchant.isActive) {
      return NextResponse.json({ error: 'Credenciales invalidas' }, { status: 401 });
    }

    const valid = await bcrypt.compare(password, merchant.passwordHash);
    if (!valid) {
      return NextResponse.json({ error: 'Credenciales invalidas' }, { status: 401 });
    }

    // Check if merchant has passkeys registered
    const passkeyCount = await prisma.webAuthnCredential.count({
      where: { merchantId: merchant.id },
    });

    return NextResponse.json({
      valid: true,
      requires2fa: passkeyCount > 0,
      merchantId: merchant.id,
    });
  } catch (error: any) {
    console.error('Validate error:', error);
    return NextResponse.json({ error: 'Error al validar' }, { status: 500 });
  }
}
