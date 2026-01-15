import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Binance API configuration - support both env var names
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET_KEY = process.env.BINANCE_SECRET_KEY || process.env.BINANCE_API_SECRET;
const BINANCE_BASE_URL = 'https://api.binance.com';

// Generate signature for Binance API
function generateSignature(queryString: string): string {
  const crypto = require('crypto');
  return crypto
    .createHmac('sha256', BINANCE_SECRET_KEY || '')
    .update(queryString)
    .digest('hex');
}

// Build signed query string
function buildSignedQuery(params: Record<string, any> = {}): string {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };

  const queryString = Object.entries(allParams)
    .filter(([_, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');

  const signature = generateSignature(queryString);
  return `${queryString}&signature=${signature}`;
}

// Get order detail from Binance
// POST /sapi/v1/c2c/orderMatch/getUserOrderDetail
// Body: { adOrderNo: string } (per SAPI v7.4 docs)
async function getOrderFromBinance(orderNumber: string): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    if (!BINANCE_API_KEY || !BINANCE_SECRET_KEY) {
      return { success: false, error: 'Missing API credentials' };
    }

    // Build signed query string (timestamp + signature in query)
    const signedQuery = buildSignedQuery({});

    // Body uses adOrderNo, not orderNumber (per SAPI v7.4 docs)
    const body = { adOrderNo: orderNumber };

    const response = await fetch(
      `${BINANCE_BASE_URL}/sapi/v1/c2c/orderMatch/getUserOrderDetail?${signedQuery}`,
      {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': BINANCE_API_KEY || '',
          'Content-Type': 'application/json',
          'clientType': 'web',  // Required by Binance C2C API
        },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Binance API error for ${orderNumber}: ${response.status} - ${errorText}`);
      return { success: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();

    // Check if Binance returned an error
    if (data.code && data.code !== '000000' && data.code !== 0) {
      console.log(`Binance returned code ${data.code} for order ${orderNumber}: ${data.message || data.msg}`);
      // Order not found is a valid response
      return { success: true, data: null };
    }

    return { success: true, data: data.data || data };
  } catch (error) {
    console.error(`Error fetching order ${orderNumber}:`, error);
    return { success: false, error: 'Network error' };
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
    // Check credentials first
    if (!BINANCE_API_KEY || !BINANCE_SECRET_KEY) {
      return NextResponse.json({
        success: false,
        error: 'Missing Binance API credentials. Add BINANCE_API_KEY and BINANCE_SECRET_KEY (or BINANCE_API_SECRET) to environment variables.',
      }, { status: 500 });
    }

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
        binanceCreateTime: true,
      },
    });

    console.log(`Syncing ${activeOrders.length} orders with Binance...`);

    let synced = 0;
    let updated = 0;
    let errors = 0;
    let skipped = 0;
    const results: Array<{ orderNumber: string; oldStatus: string; newStatus: string }> = [];

    // Check each order against Binance (in batches to avoid rate limits)
    for (const order of activeOrders) {
      try {
        const result = await getOrderFromBinance(order.orderNumber);

        if (!result.success) {
          // API call failed (not order not found, but actual error)
          console.error(`API error for ${order.orderNumber}: ${result.error}`);
          errors++;
          continue; // Don't mark as completed on API errors
        }

        const binanceOrder = result.data;

        if (binanceOrder && binanceOrder.orderStatus) {
          // Got order data from Binance
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
          // Order not found in Binance (API call succeeded but no data)
          // Only mark as COMPLETED if order is older than 24 hours
          const orderAge = Date.now() - new Date(order.binanceCreateTime || 0).getTime();
          const hoursOld = orderAge / (1000 * 60 * 60);

          if (hoursOld > 24) {
            console.log(`Order ${order.orderNumber} not found in Binance and is ${hoursOld.toFixed(1)}h old, marking as COMPLETED`);

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
          } else {
            console.log(`Order ${order.orderNumber} not found but only ${hoursOld.toFixed(1)}h old, skipping`);
            skipped++;
          }
        }

        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (orderError) {
        console.error(`Error syncing order ${order.orderNumber}:`, orderError);
        errors++;
      }
    }

    return NextResponse.json({
      success: true,
      message: `Synced ${synced} orders, updated ${updated}, skipped ${skipped}, errors ${errors}`,
      total: activeOrders.length,
      synced,
      updated,
      skipped,
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
