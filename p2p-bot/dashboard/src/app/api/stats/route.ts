import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function GET() {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get today's stats
    const todayStats = await prisma.dailyStats.findUnique({
      where: { date: today },
    });

    // Get active orders count
    const activeOrders = await prisma.order.count({
      where: {
        status: { in: ['PENDING', 'PAID'] },
      },
    });

    // Get pending releases count
    const pendingReleases = await prisma.payment.count({
      where: {
        status: 'MATCHED',
      },
    });

    // Get latest price
    const latestPrice = await prisma.priceHistory.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    // Calculate completion rate (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const completedOrders = await prisma.order.count({
      where: {
        binanceCreateTime: { gte: thirtyDaysAgo },
        status: 'COMPLETED',
      },
    });

    const totalOrders = await prisma.order.count({
      where: {
        binanceCreateTime: { gte: thirtyDaysAgo },
        status: { notIn: ['PENDING'] },
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
