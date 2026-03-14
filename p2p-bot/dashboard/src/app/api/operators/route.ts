import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';
import { getMerchantContext } from '@/lib/merchant-context';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Normalize operator nicknames to canonical form
// Handles cases where same operator has different nickname formats (e.g. "LadyLee" vs "Lady-lee")
const NICKNAME_ALIASES: Record<string, string> = {
  'LadyLee': 'Lady-lee',
};

function normalizeNickname(nick: string): string {
  return NICKNAME_ALIASES[nick] || nick;
}

// Build SQL CASE expression to normalize nicknames in queries
function nicknameCaseExpr(col: string = 'nickname'): string {
  const entries = Object.entries(NICKNAME_ALIASES);
  if (entries.length === 0) return col;
  const whens = entries.map(([from, to]) => `WHEN ${col} = '${from}' THEN '${to}'`).join(' ');
  return `CASE ${whens} ELSE ${col} END`;
}

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
          m.id as "merchantId",
          m.name as "merchantName",
          m."binanceNickname",
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
        GROUP BY m.id, m.name, m."binanceNickname"
        ORDER BY "totalVolume" DESC`,
        [startDateStr, endDate]
      );

      return NextResponse.json({
        view: 'orders',
        startDate: startDateStr,
        endDate,
        data: result.rows.map(row => ({
          merchantId: row.merchantId,
          merchantName: row.merchantName,
          binanceNickname: row.binanceNickname,
          sellOrders: row.sellOrders,
          buyOrders: row.buyOrders,
          sellVolume: parseFloat(row.sellVolume) || 0,
          buyVolume: parseFloat(row.buyVolume) || 0,
          totalOrders: row.totalOrders,
          totalVolume: parseFloat(row.totalVolume) || 0,
        })),
      });
    }

    const nickExpr = nicknameCaseExpr('nickname');

    // Current status view
    if (view === 'current') {
      const result = await pool.query(
        `SELECT DISTINCT ON (norm_nick)
          ${nickExpr} as norm_nick, "isAdOnline", "surplusAmount", "adPrice", "lowFunds", "checkedAt"
        FROM "OperatorSnapshot"
        WHERE "checkedAt" > NOW() - INTERVAL '1 hour'
        ORDER BY norm_nick, "checkedAt" DESC`
      );

      return NextResponse.json({
        view: 'current',
        operators: result.rows.map(row => ({
          nickname: row.norm_nick,
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

    // Use CDMX timezone (America/Mexico_City) for date grouping
    // Snapshots are stored in UTC but work hours are CDMX-based
    const tz = 'America/Mexico_City';
    const conditions = [`("checkedAt" AT TIME ZONE '${tz}')::date >= $1`, `("checkedAt" AT TIME ZONE '${tz}')::date <= $2`];
    const params: any[] = [startDateStr, endDate];

    if (nickname) {
      // Find all raw nicknames that map to this canonical nickname
      const rawNicks = [nickname, ...Object.entries(NICKNAME_ALIASES)
        .filter(([, canonical]) => canonical === nickname)
        .map(([raw]) => raw)];
      if (rawNicks.length === 1) {
        params.push(nickname);
        conditions.push(`nickname = $${params.length}`);
      } else {
        const placeholders = rawNicks.map((_, i) => `$${params.length + i + 1}`);
        params.push(...rawNicks);
        conditions.push(`nickname IN (${placeholders.join(', ')})`);
      }
    }

    // Calculate hours based on snapshot ratio within work hours (9am-10pm CDMX).
    // Each snapshot represents ~1 minute of state. We count online snapshots
    // during work hours and scale by the actual monitoring span within work hours.
    // This prevents >100% coverage from overnight snapshots.
    const workStart = 9;  // 9 AM CDMX
    const workEnd = 22;   // 10 PM CDMX
    const result = await pool.query(
      `SELECT
        ${nickExpr} as nickname,
        ("checkedAt" AT TIME ZONE '${tz}')::date as date,
        COUNT(*)::int as "totalSnapshots",
        COUNT(*) FILTER (WHERE "isAdOnline" = true)::int as "onlineSnapshots",
        COUNT(*) FILTER (WHERE "lowFunds" = true)::int as "lowFundsSnapshots",
        -- Only count snapshots within work hours for time calculations
        COUNT(*) FILTER (
          WHERE EXTRACT(HOUR FROM "checkedAt" AT TIME ZONE '${tz}') >= ${workStart}
            AND EXTRACT(HOUR FROM "checkedAt" AT TIME ZONE '${tz}') < ${workEnd}
        )::int as "workSnapshots",
        COUNT(*) FILTER (
          WHERE "isAdOnline" = true
            AND EXTRACT(HOUR FROM "checkedAt" AT TIME ZONE '${tz}') >= ${workStart}
            AND EXTRACT(HOUR FROM "checkedAt" AT TIME ZONE '${tz}') < ${workEnd}
        )::int as "workOnlineSnapshots",
        COUNT(*) FILTER (
          WHERE "lowFunds" = true
            AND EXTRACT(HOUR FROM "checkedAt" AT TIME ZONE '${tz}') >= ${workStart}
            AND EXTRACT(HOUR FROM "checkedAt" AT TIME ZONE '${tz}') < ${workEnd}
        )::int as "workLowFundsSnapshots",
        -- Hours = (online work snapshots / total work snapshots) × work hours in that period
        -- Work hours in period = span of work snapshots (capped at 13h)
        CASE WHEN COUNT(*) FILTER (
          WHERE EXTRACT(HOUR FROM "checkedAt" AT TIME ZONE '${tz}') >= ${workStart}
            AND EXTRACT(HOUR FROM "checkedAt" AT TIME ZONE '${tz}') < ${workEnd}
        ) > 1
        THEN LEAST(
          EXTRACT(EPOCH FROM (
            MAX("checkedAt") FILTER (
              WHERE EXTRACT(HOUR FROM "checkedAt" AT TIME ZONE '${tz}') >= ${workStart}
                AND EXTRACT(HOUR FROM "checkedAt" AT TIME ZONE '${tz}') < ${workEnd}
            ) -
            MIN("checkedAt") FILTER (
              WHERE EXTRACT(HOUR FROM "checkedAt" AT TIME ZONE '${tz}') >= ${workStart}
                AND EXTRACT(HOUR FROM "checkedAt" AT TIME ZONE '${tz}') < ${workEnd}
            )
          )) / 3600.0,
          13.0
        )
        ELSE 0 END as "workSpanHours",
        ROUND(AVG("surplusAmount") FILTER (WHERE "isAdOnline" = true)::numeric, 2) as "avgSurplus",
        MIN("surplusAmount") FILTER (WHERE "isAdOnline" = true) as "minSurplus"
      FROM "OperatorSnapshot"
      WHERE ${conditions.join(' AND ')}
      GROUP BY ${nickExpr}, ("checkedAt" AT TIME ZONE '${tz}')::date
      ORDER BY date DESC, nickname`,
      params
    );

    // Post-process: calculate hours from work-hour snapshots
    const processedRows = result.rows.map(row => {
      const workSnapshots = parseInt(row.workSnapshots) || 0;
      const workOnline = parseInt(row.workOnlineSnapshots) || 0;
      const workLowFunds = parseInt(row.workLowFundsSnapshots) || 0;
      const workSpan = parseFloat(row.workSpanHours) || 0;

      // hoursOnline = (online work snapshots / total work snapshots) × work span
      const hoursOnline = workSnapshots > 0
        ? Math.round((workOnline / workSnapshots) * workSpan * 10) / 10
        : 0;
      const hoursLowFunds = workSnapshots > 0
        ? Math.round((workLowFunds / workSnapshots) * workSpan * 10) / 10
        : 0;

      return { ...row, hoursOnline, hoursLowFunds };
    });

    // Calculate expected work hours (9 AM to 10 PM = 13 hours)
    const workHoursPerDay = 13;

    return NextResponse.json({
      view: 'daily',
      workHoursPerDay,
      startDate: startDateStr,
      endDate,
      data: processedRows.map(row => ({
        nickname: row.nickname,
        date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : String(row.date),
        totalSnapshots: row.totalSnapshots,
        onlineSnapshots: row.onlineSnapshots,
        lowFundsSnapshots: row.lowFundsSnapshots,
        hoursOnline: row.hoursOnline,
        hoursLowFunds: row.hoursLowFunds,
        avgSurplus: row.avgSurplus ? parseFloat(row.avgSurplus) : null,
        minSurplus: row.minSurplus ? parseFloat(row.minSurplus) : null,
        coveragePct: Math.min(100, Math.round((row.hoursOnline / workHoursPerDay) * 100)),
      })),
    });
  } catch (error: any) {
    console.error('Operator API error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
