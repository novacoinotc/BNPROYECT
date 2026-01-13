import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function GET() {
  try {
    // Get last 24 hours of price data
    const oneDayAgo = new Date();
    oneDayAgo.setHours(oneDayAgo.getHours() - 24);

    const priceHistory = await prisma.priceHistory.findMany({
      where: {
        createdAt: { gte: oneDayAgo },
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
