import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// GET - Fetch support requests
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status'); // PENDING, ATTENDED, CLOSED, or null for all

    const where = status ? { status } : {};

    const supportRequests = await prisma.supportRequest.findMany({
      where,
      orderBy: [
        { status: 'asc' }, // PENDING first
        { createdAt: 'desc' },
      ],
    });

    // Get count by status
    const counts = await prisma.supportRequest.groupBy({
      by: ['status'],
      _count: { status: true },
    });

    const countByStatus = {
      PENDING: 0,
      ATTENDED: 0,
      CLOSED: 0,
    };

    counts.forEach((c) => {
      countByStatus[c.status as keyof typeof countByStatus] = c._count.status;
    });

    return NextResponse.json({
      supportRequests: supportRequests.map((sr) => ({
        ...sr,
        amount: sr.amount.toNumber(),
      })),
      counts: countByStatus,
    });
  } catch (error) {
    console.error('Error fetching support requests:', error);
    return NextResponse.json(
      { error: 'Failed to fetch support requests' },
      { status: 500 }
    );
  }
}

// PATCH - Update support request status
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const { id, status, attendedBy, notes } = body;

    if (!id || !status) {
      return NextResponse.json(
        { error: 'Missing id or status' },
        { status: 400 }
      );
    }

    if (!['PENDING', 'ATTENDED', 'CLOSED'].includes(status)) {
      return NextResponse.json(
        { error: 'Invalid status. Must be PENDING, ATTENDED, or CLOSED' },
        { status: 400 }
      );
    }

    const updateData: Record<string, any> = { status };

    if (status === 'ATTENDED') {
      updateData.attendedAt = new Date();
      if (attendedBy) updateData.attendedBy = attendedBy;
    } else if (status === 'CLOSED') {
      updateData.closedAt = new Date();
    }

    if (notes !== undefined) {
      updateData.notes = notes;
    }

    const updated = await prisma.supportRequest.update({
      where: { id },
      data: updateData,
    });

    return NextResponse.json({
      success: true,
      supportRequest: {
        ...updated,
        amount: updated.amount.toNumber(),
      },
    });
  } catch (error) {
    console.error('Error updating support request:', error);
    return NextResponse.json(
      { error: 'Failed to update support request' },
      { status: 500 }
    );
  }
}
