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

    // Get last 24 hours of price data
    const oneDayAgo = new Date();
    oneDayAgo.setHours(oneDayAgo.getHours() - 24);

    const priceHistory = await prisma.priceHistory.findMany({
      where: {
        createdAt: { gte: oneDayAgo },
        ...merchantFilter,
      },
      orderBy: { createdAt: 'asc' },
      select: {
        createdAt: true,
        ourPrice: true,
        bestCompetitor: true,
        referencePrice: true,
        margin: true,
      },
    });

    return NextResponse.json(priceHistory);
  } catch (error) {
    console.error('Error fetching price history:', error);
    return NextResponse.json(
      { error: 'Failed to fetch price history' },
      { status: 500 }
    );
  }
}
