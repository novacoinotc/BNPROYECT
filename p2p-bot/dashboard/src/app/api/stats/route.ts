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

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get today's stats (use findFirst since unique now includes merchantId)
    const todayStats = await prisma.dailyStats.findFirst({
      where: {
        date: today,
        ...merchantFilter,
      },
    });

    // Get active orders count
    const activeOrders = await prisma.order.count({
      where: {
        status: { in: ['PENDING', 'PAID'] },
        ...merchantFilter,
      },
    });

    // Get pending releases count
    const pendingReleases = await prisma.payment.count({
      where: {
        status: 'MATCHED',
        ...merchantFilter,
      },
    });

    // Get latest price
    const latestPrice = await prisma.priceHistory.findFirst({
      where: merchantFilter,
      orderBy: { createdAt: 'desc' },
    });

    // Calculate completion rate (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const completedOrders = await prisma.order.count({
      where: {
        binanceCreateTime: { gte: thirtyDaysAgo },
        status: 'COMPLETED',
        ...merchantFilter,
      },
    });

    const totalOrders = await prisma.order.count({
      where: {
        binanceCreateTime: { gte: thirtyDaysAgo },
        status: { notIn: ['PENDING'] },
        ...merchantFilter,
      },
    });

    const completionRate = totalOrders > 0 ? completedOrders / totalOrders : 0;

    return NextResponse.json({
      todayOrders: todayStats?.totalOrders || 0,
      todayVolume: Number(todayStats?.totalVolumeFiat || 0),
      activeOrders,
      pendingReleases,
      currentPrice: Number(latestPrice?.ourPrice || 0),
      margin: latestPrice?.margin || 0,
      completionRate,
      avgReleaseTime: todayStats?.avgReleaseTime || 0,
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    return NextResponse.json(
      { error: 'Failed to fetch stats' },
      { status: 500 }
    );
  }
}
