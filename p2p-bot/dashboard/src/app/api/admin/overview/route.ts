import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized - Admin only' }, { status: 403 });
    }

    // Get all merchants with their stats
    const merchantsResult = await pool.query(`
      SELECT
        m.id,
        m.name,
        m.email,
        m."binanceNickname",
        m."botApiUrl",
        m."isActive",
        m."lastLoginAt",
        (SELECT COUNT(*) FROM "Order" o WHERE o."merchantId" = m.id) as "totalOrders",
        (SELECT COUNT(*) FROM "Order" o WHERE o."merchantId" = m.id AND o.status = 'COMPLETED') as "completedOrders",
        (SELECT COUNT(*) FROM "Order" o WHERE o."merchantId" = m.id AND o.status IN ('PENDING', 'PAID')) as "activeOrders",
        (SELECT COALESCE(SUM(o."totalPrice"), 0) FROM "Order" o WHERE o."merchantId" = m.id AND o.status = 'COMPLETED') as "totalVolume"
      FROM "Merchant" m
      WHERE m."isAdmin" = false
      ORDER BY m."createdAt" DESC
    `);

    // Get today's stats across all merchants
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayStatsResult = await pool.query(`
      SELECT
        COUNT(*) as "todayOrders",
        COUNT(*) FILTER (WHERE status = 'COMPLETED') as "todayCompleted",
        COALESCE(SUM("totalPrice") FILTER (WHERE status = 'COMPLETED'), 0) as "todayVolume"
      FROM "Order"
      WHERE "binanceCreateTime" >= $1
    `, [today.toISOString()]);

    // Get active orders count by status
    const activeOrdersResult = await pool.query(`
      SELECT
        status,
        COUNT(*) as count
      FROM "Order"
      WHERE status IN ('PENDING', 'PAID', 'APPEALING')
      GROUP BY status
    `);

    // Get recent alerts
    const alertsResult = await pool.query(`
      SELECT
        a.id,
        a.type,
        a.severity,
        a.title,
        a."orderNumber",
        a."createdAt",
        a.acknowledged,
        m.name as "merchantName"
      FROM "Alert" a
      LEFT JOIN "Merchant" m ON a."merchantId" = m.id
      WHERE a.acknowledged = false
      ORDER BY a."createdAt" DESC
      LIMIT 10
    `);

    // Get bot status for each merchant (check if botApiUrl responds)
    const merchantsWithStatus = await Promise.all(
      merchantsResult.rows.map(async (merchant) => {
        let botStatus = 'unknown';
        if (merchant.botApiUrl) {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            const response = await fetch(`${merchant.botApiUrl}/health`, {
              signal: controller.signal,
            });
            clearTimeout(timeoutId);
            botStatus = response.ok ? 'online' : 'error';
          } catch {
            botStatus = 'offline';
          }
        } else {
          botStatus = 'not_configured';
        }
        return { ...merchant, botStatus };
      })
    );

    return NextResponse.json({
      success: true,
      merchants: merchantsWithStatus,
      todayStats: todayStatsResult.rows[0],
      activeOrders: activeOrdersResult.rows.reduce((acc, row) => {
        acc[row.status] = parseInt(row.count);
        return acc;
      }, {} as Record<string, number>),
      recentAlerts: alertsResult.rows,
    });
  } catch (error) {
    console.error('Admin overview error:', error);
    return NextResponse.json({ error: 'Failed to load overview' }, { status: 500 });
  }
}
