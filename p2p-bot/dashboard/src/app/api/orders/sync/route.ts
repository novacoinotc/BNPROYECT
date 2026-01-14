import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Binance API configuration
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET_KEY = process.env.BINANCE_SECRET_KEY;
const BINANCE_BASE_URL = 'https://api.binance.com';

// Sign request for Binance API
async function signRequest(params: Record<string, string>): Promise<string> {
  const crypto = await import('crypto');
  const queryString = new URLSearchParams(params).toString();
  const signature = crypto
    .createHmac('sha256', BINANCE_SECRET_KEY || '')
    .update(queryString)
    .digest('hex');
  return `${queryString}&signature=${signature}`;
}

// Get order detail from Binance
async function getOrderFromBinance(orderNumber: string): Promise<any> {
  try {
    const timestamp = Date.now().toString();
    const params = { orderNumber, timestamp };
    const signedQuery = await signRequest(params);

    const response = await fetch(
      `${BINANCE_BASE_URL}/sapi/v1/c2c/orderMatch/getUserOrderDetail?${signedQuery}`,
      {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': BINANCE_API_KEY || '',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.data || data;
  } catch (error) {
    console.error(`Error fetching order ${orderNumber}:`, error);
    return null;
  }
}

// Map Binance status to our status
function mapBinanceStatus(binanceStatus: string): string {
  const statusMap: Record<string, string> = {
    'TRADING': 'PENDING',
    'BUYER_PAYED': 'PAID',
    'COMPLETED': 'COMPLETED',
    'CANCELLED': 'CANCELLED',
    'CANCELLED_BY_SYSTEM': 'CANCELLED_SYSTEM',
    'APPEALING': 'APPEALING',
  };
  return statusMap[binanceStatus] || binanceStatus;
}

export async function POST(request: NextRequest) {
  try {
    // Get all active orders from DB
    const activeOrders = await prisma.order.findMany({
      where: {
        status: {
          in: ['PENDING', 'PAID', 'APPEALING'],
        },
      },
      select: {
        id: true,
        orderNumber: true,
        status: true,
      },
    });

    console.log(`Syncing ${activeOrders.length} orders with Binance...`);

    let synced = 0;
    let updated = 0;
    let errors = 0;
    const results: Array<{ orderNumber: string; oldStatus: string; newStatus: string }> = [];

    // Check each order against Binance (in batches to avoid rate limits)
    for (const order of activeOrders) {
      try {
        const binanceOrder = await getOrderFromBinance(order.orderNumber);

        if (binanceOrder && binanceOrder.orderStatus) {
          const newStatus = mapBinanceStatus(binanceOrder.orderStatus);

          if (newStatus !== order.status) {
            // Update status in DB
            await prisma.order.update({
              where: { id: order.id },
              data: {
                status: newStatus as any,
                releasedAt: newStatus === 'COMPLETED' ? new Date() : undefined,
                cancelledAt: ['CANCELLED', 'CANCELLED_SYSTEM'].includes(newStatus) ? new Date() : undefined,
              },
            });

            results.push({
              orderNumber: order.orderNumber,
              oldStatus: order.status,
              newStatus,
            });
            updated++;
          }
          synced++;
        } else {
          // Order not found in Binance or no status returned
          // This means it was completed/cancelled and removed from Binance's active list
          // Mark as COMPLETED in our DB
          console.log(`Order ${order.orderNumber} not found in Binance, marking as COMPLETED`);

          await prisma.order.update({
            where: { id: order.id },
            data: {
              status: 'COMPLETED',
              releasedAt: new Date(),
            },
          });

          results.push({
            orderNumber: order.orderNumber,
            oldStatus: order.status,
            newStatus: 'COMPLETED',
          });
          updated++;
        }

        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (orderError) {
        console.error(`Error syncing order ${order.orderNumber}:`, orderError);
        errors++;
      }
    }

    return NextResponse.json({
      success: true,
      message: `Synced ${synced} orders, updated ${updated}, errors ${errors}`,
      total: activeOrders.length,
      synced,
      updated,
      errors,
      changes: results,
    });
  } catch (error) {
    console.error('Error syncing orders:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to sync orders' },
      { status: 500 }
    );
  }
}
