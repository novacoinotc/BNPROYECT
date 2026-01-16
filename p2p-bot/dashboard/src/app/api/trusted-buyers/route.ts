import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// GET - List all trusted buyers
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const includeInactive = searchParams.get('includeInactive') === 'true';

    const trustedBuyers = await prisma.trustedBuyer.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: { verifiedAt: 'desc' },
    });

    return NextResponse.json({
      success: true,
      trustedBuyers,
      count: trustedBuyers.length,
    });
  } catch (error) {
    console.error('Error fetching trusted buyers:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch trusted buyers' },
      { status: 500 }
    );
  }
}

// POST - Add a trusted buyer
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { counterPartNickName, realName, verifiedBy, notes } = body;

    if (!counterPartNickName) {
      return NextResponse.json(
        { success: false, error: 'counterPartNickName is required' },
        { status: 400 }
      );
    }

    // Upsert - create or reactivate
    const trustedBuyer = await prisma.trustedBuyer.upsert({
      where: { counterPartNickName },
      update: {
        isActive: true,
        realName: realName || undefined,
        verifiedBy: verifiedBy || undefined,
        notes: notes || undefined,
        verifiedAt: new Date(),
        updatedAt: new Date(),
      },
      create: {
        counterPartNickName,
        realName: realName || null,
        verifiedBy: verifiedBy || null,
        notes: notes || null,
        isActive: true,
      },
    });

    return NextResponse.json({
      success: true,
      trustedBuyer,
      message: `Trusted buyer "${counterPartNickName}" added successfully`,
    });
  } catch (error) {
    console.error('Error adding trusted buyer:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to add trusted buyer' },
      { status: 500 }
    );
  }
}

// DELETE - Remove (deactivate) a trusted buyer
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { counterPartNickName } = body;

    if (!counterPartNickName) {
      return NextResponse.json(
        { success: false, error: 'counterPartNickName is required' },
        { status: 400 }
      );
    }

    const result = await prisma.trustedBuyer.update({
      where: { counterPartNickName },
      data: {
        isActive: false,
        updatedAt: new Date(),
      },
    });

    return NextResponse.json({
      success: true,
      message: `Trusted buyer "${counterPartNickName}" removed`,
    });
  } catch (error: any) {
    if (error.code === 'P2025') {
      return NextResponse.json(
        { success: false, error: 'Trusted buyer not found' },
        { status: 404 }
      );
    }
    console.error('Error removing trusted buyer:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to remove trusted buyer' },
      { status: 500 }
    );
  }
}
