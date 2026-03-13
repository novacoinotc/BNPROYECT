import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';
import { getMerchantContext } from '@/lib/merchant-context';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// GET /api/operators?date=2026-03-09&range=7
// Returns operator daily summaries
// NOTE: Operator data is global — all users see all operators
export async function GET(request: NextRequest) {
  try {
    const context = await getMerchantContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date') || new Date().toISOString().split('T')[0];
    const range = parseInt(searchParams.get('range') || '1');
    const nickname = searchParams.get('nickname') || undefined;
    const view = searchParams.get('view') || 'daily'; // 'daily' | 'current'

    // Order stats view — join Order + Merchant to get volume per operator
    if (view === 'orders') {
      const endDate = date;
      const startDate = new Date(date);
      startDate.setDate(startDate.getDate() - (range - 1));
      const startDateStr = startDate.toISOString().split('T')[0];

      const result = await pool.query(
        `SELECT
          m."binanceNickname" as nickname,
          COUNT(*) FILTER (WHERE o.status = 'COMPLETED' AND o."tradeType" = 'SELL')::int as "sellOrders",
          COUNT(*) FILTER (WHERE o.status = 'COMPLETED' AND o."tradeType" = 'BUY')::int as "buyOrders",
          COALESCE(SUM(o."totalPrice") FILTER (WHERE o.status = 'COMPLETED' AND o."tradeType" = 'SELL'), 0)::numeric as "sellVolume",
          COALESCE(SUM(o."totalPrice") FILTER (WHERE o.status = 'COMPLETED' AND o."tradeType" = 'BUY'), 0)::numeric as "buyVolume",
          COUNT(*) FILTER (WHERE o.status = 'COMPLETED')::int as "totalOrders",
          COALESCE(SUM(o."totalPrice") FILTER (WHERE o.status = 'COMPLETED'), 0)::numeric as "totalVolume"
        FROM "Order" o
        JOIN "Merchant" m ON o."merchantId" = m.id
        WHERE COALESCE(o."binanceCreateTime", o."createdAt")::date >= $1
          AND COALESCE(o."binanceCreateTime", o."createdAt")::date <= $2
          AND m."binanceNickname" IS NOT NULL
        GROUP BY m."binanceNickname"
        ORDER BY "totalVolume" DESC`,
        [startDateStr, endDate]
      );

      return NextResponse.json({
        view: 'orders',
        startDate: startDateStr,
        endDate,
        data: result.rows.map(row => ({
          nickname: row.nickname,
          sellOrders: row.sellOrders,
          buyOrders: row.buyOrders,
          sellVolume: parseFloat(row.sellVolume) || 0,
          buyVolume: parseFloat(row.buyVolume) || 0,
          totalOrders: row.totalOrders,
          totalVolume: parseFloat(row.totalVolume) || 0,
        })),
      });
    }

    // Current status view
    if (view === 'current') {
      const result = await pool.query(
        `SELECT DISTINCT ON (nickname)
          nickname, "isAdOnline", "surplusAmount", "adPrice", "lowFunds", "checkedAt"
        FROM "OperatorSnapshot"
        WHERE "checkedAt" > NOW() - INTERVAL '1 hour'
        ORDER BY nickname, "checkedAt" DESC`
      );

      return NextResponse.json({
        view: 'current',
        operators: result.rows.map(row => ({
          nickname: row.nickname,
          isAdOnline: row.isAdOnline,
          surplusAmount: row.surplusAmount ? parseFloat(row.surplusAmount) : null,
          adPrice: row.adPrice ? parseFloat(row.adPrice) : null,
          lowFunds: row.lowFunds,
          lastChecked: row.checkedAt,
        })),
      });
    }

    // Daily summary view (with range support)
    const endDate = date;
    const startDate = new Date(date);
    startDate.setDate(startDate.getDate() - (range - 1));
    const startDateStr = startDate.toISOString().split('T')[0];

    const conditions = [`"checkedAt"::date >= $1`, `"checkedAt"::date <= $2`];
    const params: any[] = [startDateStr, endDate];

    if (nickname) {
      params.push(nickname);
      conditions.push(`nickname = $${params.length}`);
    }

    const result = await pool.query(
      `SELECT
        nickname,
        "checkedAt"::date as date,
        COUNT(*)::int as "totalSnapshots",
        COUNT(*) FILTER (WHERE "isAdOnline" = true)::int as "onlineSnapshots",
        COUNT(*) FILTER (WHERE "lowFunds" = true)::int as "lowFundsSnapshots",
        ROUND((COUNT(*) FILTER (WHERE "isAdOnline" = true) * 5.0 / 60)::numeric, 2) as "hoursOnline",
        ROUND((COUNT(*) FILTER (WHERE "lowFunds" = true) * 5.0 / 60)::numeric, 2) as "hoursLowFunds",
        ROUND(AVG("surplusAmount") FILTER (WHERE "isAdOnline" = true)::numeric, 2) as "avgSurplus",
        MIN("surplusAmount") FILTER (WHERE "isAdOnline" = true) as "minSurplus"
      FROM "OperatorSnapshot"
      WHERE ${conditions.join(' AND ')}
      GROUP BY nickname, "checkedAt"::date
      ORDER BY date DESC, nickname`,
      params
    );

    // Calculate expected work hours (9 AM to 10 PM = 13 hours)
    const workHoursPerDay = 13;

    return NextResponse.json({
      view: 'daily',
      workHoursPerDay,
      startDate: startDateStr,
      endDate,
      data: result.rows.map(row => ({
        nickname: row.nickname,
        date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : String(row.date),
        totalSnapshots: row.totalSnapshots,
        onlineSnapshots: row.onlineSnapshots,
        lowFundsSnapshots: row.lowFundsSnapshots,
        hoursOnline: parseFloat(row.hoursOnline) || 0,
        hoursLowFunds: parseFloat(row.hoursLowFunds) || 0,
        avgSurplus: row.avgSurplus ? parseFloat(row.avgSurplus) : null,
        minSurplus: row.minSurplus ? parseFloat(row.minSurplus) : null,
        coveragePct: Math.round(((parseFloat(row.hoursOnline) || 0) / workHoursPerDay) * 100),
      })),
    });
  } catch (error: any) {
    console.error('Operator API error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
