import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const limit = parseInt(searchParams.get('limit') || '50');
    const status = searchParams.get('status');

    const orders = await prisma.order.findMany({
      where: status ? { status: status as any } : undefined,
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
