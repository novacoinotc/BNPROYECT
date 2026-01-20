import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { getMerchantContext, getMerchantFilter } from '@/lib/merchant-context';

const prisma = new PrismaClient();

// GET - List all trusted buyers
export async function GET(request: NextRequest) {
  try {
    // Get merchant context
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const includeInactive = searchParams.get('includeInactive') === 'true';

    // Get merchant filter (admin sees all, merchant sees own)
    const merchantFilter = getMerchantFilter(context);

    const trustedBuyers = await prisma.trustedBuyer.findMany({
      where: {
        ...(includeInactive ? {} : { isActive: true }),
        ...merchantFilter,
      },
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
// SECURITY: buyerUserNo is REQUIRED - it's the only reliable unique identifier
export async function POST(request: NextRequest) {
  try {
    // Get merchant context
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { counterPartNickName, buyerUserNo, realName, verifiedBy, notes } = body;

    if (!counterPartNickName) {
      return NextResponse.json(
        { success: false, error: 'counterPartNickName is required' },
        { status: 400 }
      );
    }

    if (!buyerUserNo) {
      return NextResponse.json(
        { success: false, error: 'buyerUserNo is required - find it in the order detail on Binance' },
        { status: 400 }
      );
    }

    // Check if buyerUserNo already exists for this merchant (unique per merchant)
    const existing = await prisma.trustedBuyer.findFirst({
      where: {
        buyerUserNo,
        merchantId: context.merchantId,
      },
    });

    if (existing) {
      // Reactivate existing entry if it was inactive
      if (!existing.isActive) {
        const reactivated = await prisma.trustedBuyer.update({
          where: { id: existing.id },
          data: {
            isActive: true,
            counterPartNickName, // Update nickname in case it changed
            realName: realName || existing.realName,
            verifiedBy: verifiedBy || existing.verifiedBy,
            notes: notes || existing.notes,
            verifiedAt: new Date(),
            updatedAt: new Date(),
          },
        });
        return NextResponse.json({
          success: true,
          trustedBuyer: reactivated,
          message: `Trusted buyer "${counterPartNickName}" reactivated`,
        });
      }

      // Already exists and is active
      return NextResponse.json(
        { success: false, error: `Buyer with userNo "${buyerUserNo}" already exists as "${existing.counterPartNickName}"` },
        { status: 409 }
      );
    }

    // Create new entry with unique buyerUserNo for this merchant
    const trustedBuyer = await prisma.trustedBuyer.create({
      data: {
        counterPartNickName,
        buyerUserNo,
        realName: realName || null,
        verifiedBy: verifiedBy || context.name,
        notes: notes || null,
        isActive: true,
        merchantId: context.merchantId,
      },
    });

    return NextResponse.json({
      success: true,
      trustedBuyer,
      message: `Trusted buyer "${counterPartNickName}" (userNo: ${buyerUserNo}) added successfully`,
    });
  } catch (error: any) {
    // Handle unique constraint violation
    if (error.code === 'P2002') {
      return NextResponse.json(
        { success: false, error: 'A buyer with this userNo already exists' },
        { status: 409 }
      );
    }
    console.error('Error adding trusted buyer:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to add trusted buyer' },
      { status: 500 }
    );
  }
}

// PATCH - Update a trusted buyer (e.g., add realName)
export async function PATCH(request: NextRequest) {
  try {
    // Get merchant context
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { id, realName, notes } = body;

    if (!id) {
      return NextResponse.json(
        { success: false, error: 'id is required' },
        { status: 400 }
      );
    }

    // Check if merchant has access to this trusted buyer
    const merchantFilter = getMerchantFilter(context);
    const existingBuyer = await prisma.trustedBuyer.findFirst({
      where: { id, ...merchantFilter },
    });

    if (!existingBuyer) {
      return NextResponse.json(
        { success: false, error: 'Trusted buyer not found or access denied' },
        { status: 404 }
      );
    }

    const trustedBuyer = await prisma.trustedBuyer.update({
      where: { id },
      data: {
        realName: realName !== undefined ? realName : undefined,
        notes: notes !== undefined ? notes : undefined,
        updatedAt: new Date(),
      },
    });

    return NextResponse.json({
      success: true,
      trustedBuyer,
      message: `Trusted buyer updated`,
    });
  } catch (error: any) {
    if (error.code === 'P2025') {
      return NextResponse.json(
        { success: false, error: 'Trusted buyer not found' },
        { status: 404 }
      );
    }
    console.error('Error updating trusted buyer:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update trusted buyer' },
      { status: 500 }
    );
  }
}

// DELETE - Remove (deactivate) a trusted buyer
export async function DELETE(request: NextRequest) {
  try {
    // Get merchant context
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

    // Check if merchant has access to this trusted buyer
    const merchantFilter = getMerchantFilter(context);
    const existingBuyer = await prisma.trustedBuyer.findFirst({
      where: { id, ...merchantFilter },
    });

    if (!existingBuyer) {
      return NextResponse.json(
        { success: false, error: 'Trusted buyer not found or access denied' },
        { status: 404 }
      );
    }

    const result = await prisma.trustedBuyer.update({
      where: { id },
      data: {
        isActive: false,
        updatedAt: new Date(),
      },
    });

    return NextResponse.json({
      success: true,
      message: `Trusted buyer removed`,
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
