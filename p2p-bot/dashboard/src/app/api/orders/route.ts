import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { getMerchantContext, getMerchantFilter } from '@/lib/merchant-context';

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
    // Get merchant context
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

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
    const showDismissed = searchParams.get('showDismissed') === 'true';

    // Build where clause based on filters
    // By default, hide dismissed orders unless showDismissed=true
    const dismissedFilter = showDismissed ? {} : { dismissed: false };

    // Get merchant filter (admin sees all, merchant sees own)
    const merchantFilter = getMerchantFilter(context);

    let whereClause: any;
    if (status) {
      whereClause = { status: status as any, ...dismissedFilter, ...merchantFilter };
    } else if (showAll) {
      whereClause = { ...dismissedFilter, ...merchantFilter };
    } else {
      whereClause = { status: { in: activeStatuses as any }, ...dismissedFilter, ...merchantFilter };
    }

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

// PATCH - Dismiss order (hide from dashboard)
export async function PATCH(request: NextRequest) {
  try {
    // Get merchant context
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { orderNumber, dismissed } = body;

    if (!orderNumber) {
      return NextResponse.json(
        { error: 'Missing orderNumber' },
        { status: 400 }
      );
    }

    // Check if merchant has access to this order
    const merchantFilter = getMerchantFilter(context);
    const existingOrder = await prisma.order.findFirst({
      where: { orderNumber, ...merchantFilter },
    });

    if (!existingOrder) {
      return NextResponse.json(
        { error: 'Order not found or access denied' },
        { status: 404 }
      );
    }

    const updated = await prisma.order.update({
      where: { orderNumber },
      data: { dismissed: dismissed ?? true },
      select: { orderNumber: true, dismissed: true },
    });

    return NextResponse.json({
      success: true,
      order: updated,
    });
  } catch (error) {
    console.error('Error dismissing order:', error);
    return NextResponse.json(
      { error: 'Failed to dismiss order' },
      { status: 500 }
    );
  }
}
