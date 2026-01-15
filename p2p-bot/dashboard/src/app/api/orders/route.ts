import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const limit = parseInt(searchParams.get('limit') || '50');
    const status = searchParams.get('status');
    const showAll = searchParams.get('showAll') === 'true';

    // By default, only show active orders (TRADING, PENDING, PAID, APPEALING)
    // TRADING = waiting for buyer to pay
    // PENDING/PAID = buyer marked as paid, waiting for release
    // Use showAll=true to see completed/cancelled orders
    const activeStatuses = ['TRADING', 'PENDING', 'PAID', 'APPEALING'];

    const whereClause = status
      ? { status: status as any }
      : showAll
        ? undefined
        : { status: { in: activeStatuses as any } };

    const orders = await prisma.order.findMany({
      where: whereClause,
      orderBy: { binanceCreateTime: 'desc' },
      take: limit,
      select: {
        id: true,
        orderNumber: true,
        advNo: true,
        tradeType: true,
        asset: true,
        fiatUnit: true,
        amount: true,
        totalPrice: true,
        unitPrice: true,
        status: true,
        buyerNickName: true,
        buyerRealName: true,
        binanceCreateTime: true,
        paidAt: true,
        releasedAt: true,
        verificationStatus: true,
        verificationTimeline: true,
        payments: {
          select: {
            transactionId: true,
            amount: true,
            senderName: true,
            status: true,
            matchedAt: true,
          },
        },
      },
    });

    return NextResponse.json(orders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    return NextResponse.json(
      { error: 'Failed to fetch orders' },
      { status: 500 }
    );
  }
}
