import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { getMerchantContext, getMerchantFilter } from '@/lib/merchant-context';
import { Pool } from 'pg';

const prisma = new PrismaClient();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const RAILWAY_API_URL = process.env.RAILWAY_API_URL;

// Get bot URL for the logged-in merchant
async function getMerchantBotUrl(merchantId: string): Promise<string | null> {
  try {
    const result = await pool.query(
      'SELECT "botApiUrl" FROM "Merchant" WHERE id = $1',
      [merchantId]
    );
    return result.rows[0]?.botApiUrl || null;
  } catch (error) {
    console.error('Error getting merchant bot URL:', error);
    return null;
  }
}

// Sync orders from Binance via merchant's bot proxy
async function syncOrdersFromRailway(botUrl?: string | null): Promise<{ success: boolean; synced?: number; error?: string }> {
  const apiUrl = botUrl || RAILWAY_API_URL;

  if (!apiUrl) {
    return { success: false, error: 'Bot API URL not configured' };
  }

  try {
    const response = await fetch(`${apiUrl}/api/orders/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000), // 15 second timeout
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Bot sync error: ${response.status} - ${errorText}`);
      return { success: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    console.log(`Bot sync result: ${data.message || 'OK'}`);
    return { success: true, synced: data.saved || 0 };
  } catch (error: any) {
    console.error('Bot sync failed:', error.message);
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

    // Get merchant's bot URL for syncing
    const botUrl = await getMerchantBotUrl(context.merchantId);

    // Sync orders from Binance via merchant's bot (unless skipSync is set)
    if (!skipSync) {
      const syncResult = await syncOrdersFromRailway(botUrl);
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
        buyerUserNo: true,
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

// DELETE - Bulk dismiss orders (hide from dashboard)
export async function DELETE(request: NextRequest) {
  try {
    // Get merchant context
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { orderNumbers } = body;

    if (!orderNumbers || !Array.isArray(orderNumbers) || orderNumbers.length === 0) {
      return NextResponse.json(
        { error: 'orderNumbers array is required' },
        { status: 400 }
      );
    }

    // Limit to 100 orders at a time
    if (orderNumbers.length > 100) {
      return NextResponse.json(
        { error: 'Maximum 100 orders can be dismissed at once' },
        { status: 400 }
      );
    }

    // Get merchant filter for security
    const merchantFilter = getMerchantFilter(context);

    // Update all matching orders
    const result = await prisma.order.updateMany({
      where: {
        orderNumber: { in: orderNumbers },
        ...merchantFilter,
      },
      data: { dismissed: true },
    });

    // Create audit log entry
    const id = `c${Date.now().toString(36)}${Math.random().toString(36).substring(2, 9)}`;
    await pool.query(
      `INSERT INTO "AuditLog" (id, action, details, success, "merchantId", "createdAt")
       VALUES ($1, 'bulk_order_dismiss', $2, true, $3, NOW())`,
      [
        id,
        JSON.stringify({
          orderNumbers,
          dismissedCount: result.count,
        }),
        context.merchantId,
      ]
    );

    return NextResponse.json({
      success: true,
      message: `${result.count} order(s) dismissed successfully`,
      dismissedCount: result.count,
      requestedCount: orderNumbers.length,
    });
  } catch (error) {
    console.error('Error bulk dismissing orders:', error);
    return NextResponse.json(
      { error: 'Failed to dismiss orders' },
      { status: 500 }
    );
  }
}
