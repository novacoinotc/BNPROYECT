import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const RAILWAY_API_URL = process.env.RAILWAY_API_URL;

// Sync orders from Binance via Railway proxy
async function syncOrdersFromRailway(): Promise<{ success: boolean; synced?: number; error?: string }> {
  if (!RAILWAY_API_URL) {
    return { success: false, error: 'RAILWAY_API_URL not configured' };
  }

  try {
    const response = await fetch(`${RAILWAY_API_URL}/api/orders/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000), // 15 second timeout
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Railway sync error: ${response.status} - ${errorText}`);
      return { success: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    console.log(`Railway sync result: ${data.message || 'OK'}`);
    return { success: true, synced: data.saved || 0 };
  } catch (error: any) {
    console.error('Railway sync failed:', error.message);
    return { success: false, error: error.message };
  }
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const limit = parseInt(searchParams.get('limit') || '50');
    const status = searchParams.get('status');
    const showAll = searchParams.get('showAll') === 'true';
    const skipSync = searchParams.get('skipSync') === 'true';

    // Sync orders from Binance via Railway (unless skipSync is set)
    if (!skipSync) {
      const syncResult = await syncOrdersFromRailway();
      if (syncResult.success) {
        console.log(`Synced ${syncResult.synced} orders from Railway`);
      } else {
        console.warn(`Sync failed: ${syncResult.error} - showing cached orders`);
      }
    }

    // By default, only show active orders (PENDING, PAID, APPEALING)
    // Note: Binance "TRADING" status is mapped to "PENDING" when saved to DB
    // PENDING = waiting for buyer to pay (or waiting for release)
    // PAID = buyer marked as paid, waiting for release
    // Use showAll=true to see completed/cancelled orders
    const activeStatuses = ['PENDING', 'PAID', 'APPEALING'];

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
