import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { getMerchantContext, getMerchantFilter } from '@/lib/merchant-context';

const prisma = new PrismaClient();

export async function GET() {
  try {
    // Get merchant context
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const merchantFilter = getMerchantFilter(context);

    const alerts = await prisma.alert.findMany({
      where: {
        acknowledged: false,
        ...merchantFilter,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return NextResponse.json(alerts);
  } catch (error) {
    console.error('Error fetching alerts:', error);
    return NextResponse.json(
      { error: 'Failed to fetch alerts' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    // Get merchant context
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { id, acknowledgedBy } = body;

    // Verify merchant has access to this alert
    const merchantFilter = getMerchantFilter(context);
    const existingAlert = await prisma.alert.findFirst({
      where: { id, ...merchantFilter },
    });

    if (!existingAlert) {
      return NextResponse.json(
        { error: 'Alert not found or access denied' },
        { status: 404 }
      );
    }

    await prisma.alert.update({
      where: { id },
      data: {
        acknowledged: true,
        acknowledgedAt: new Date(),
        acknowledgedBy,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error acknowledging alert:', error);
    return NextResponse.json(
      { error: 'Failed to acknowledge alert' },
      { status: 500 }
    );
  }
}
