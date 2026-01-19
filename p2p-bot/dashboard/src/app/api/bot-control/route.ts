import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// GET - Get current bot configuration
export async function GET() {
  try {
    // Try to get existing config
    let result = await pool.query(
      `SELECT * FROM "BotConfig" WHERE id = 'main'`
    );

    // If no config exists, create default
    if (result.rows.length === 0) {
      await pool.query(
        `INSERT INTO "BotConfig" (id, "releaseEnabled", "positioningEnabled", "positioningMode", "updatedAt")
         VALUES ('main', true, false, 'off', NOW())
         ON CONFLICT (id) DO NOTHING`
      );
      result = await pool.query(
        `SELECT * FROM "BotConfig" WHERE id = 'main'`
      );
    }

    const config = result.rows[0];

    // Parse positioningConfigs from JSONB
    let positioningConfigs = {};
    if (config.positioningConfigs) {
      try {
        positioningConfigs = typeof config.positioningConfigs === 'string'
          ? JSON.parse(config.positioningConfigs)
          : config.positioningConfigs;
      } catch {
        positioningConfigs = {};
      }
    }

    return NextResponse.json({
      success: true,
      config: {
        // Kill switches
        releaseEnabled: config.releaseEnabled,
        positioningEnabled: config.positioningEnabled,
        positioningMode: config.positioningMode,

        // Legacy follow mode (for backwards compatibility)
        followTargetNickName: config.followTargetNickName,
        followTargetUserNo: config.followTargetUserNo,

        // SELL ads config (defaults)
        sellMode: config.sellMode ?? config.positioningMode ?? 'smart',
        sellFollowTarget: config.sellFollowTarget ?? config.followTargetNickName ?? null,

        // BUY ads config (defaults)
        buyMode: config.buyMode ?? config.positioningMode ?? 'smart',
        buyFollowTarget: config.buyFollowTarget ?? config.followTargetNickName ?? null,

        // Per-asset positioning configs (overrides above when set)
        // Key format: "SELL:USDT", "BUY:BTC", etc.
        positioningConfigs,

        // Smart mode filters
        smartMinUserGrade: config.smartMinUserGrade ?? 2,
        smartMinFinishRate: config.smartMinFinishRate ?? 0.90,
        smartMinOrderCount: config.smartMinOrderCount ?? 10,
        smartMinPositiveRate: config.smartMinPositiveRate ?? 0.95,
        smartRequireOnline: config.smartRequireOnline ?? true,
        smartMinSurplus: config.smartMinSurplus ?? 100,

        // Strategy
        undercutCents: config.undercutCents ?? 1,
        matchPrice: config.matchPrice ?? false,

        // Auto-message
        autoMessageEnabled: config.autoMessageEnabled ?? false,
        autoMessageText: config.autoMessageText ?? '',

        // Status
        releaseLastActive: config.releaseLastActive,
        positioningLastActive: config.positioningLastActive,
        updatedAt: config.updatedAt,
        updatedBy: config.updatedBy,
      },
    });
  } catch (error) {
    console.error('Error fetching bot config:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch bot configuration' },
      { status: 500 }
    );
  }
}

// POST - Update bot configuration
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Build dynamic update query
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    // Kill switches
    if (typeof body.releaseEnabled === 'boolean') {
      updates.push(`"releaseEnabled" = $${paramIndex++}`);
      values.push(body.releaseEnabled);
    }
    if (typeof body.positioningEnabled === 'boolean') {
      updates.push(`"positioningEnabled" = $${paramIndex++}`);
      values.push(body.positioningEnabled);
    }
    if (typeof body.positioningMode === 'string') {
      updates.push(`"positioningMode" = $${paramIndex++}`);
      values.push(body.positioningMode);
    }

    // Legacy follow mode (for backwards compatibility)
    if (body.followTargetNickName !== undefined) {
      updates.push(`"followTargetNickName" = $${paramIndex++}`);
      values.push(body.followTargetNickName || null);
    }
    if (body.followTargetUserNo !== undefined) {
      updates.push(`"followTargetUserNo" = $${paramIndex++}`);
      values.push(body.followTargetUserNo || null);
    }

    // SELL ads config
    if (typeof body.sellMode === 'string') {
      updates.push(`"sellMode" = $${paramIndex++}`);
      values.push(body.sellMode);
    }
    if (body.sellFollowTarget !== undefined) {
      updates.push(`"sellFollowTarget" = $${paramIndex++}`);
      values.push(body.sellFollowTarget || null);
    }

    // BUY ads config
    if (typeof body.buyMode === 'string') {
      updates.push(`"buyMode" = $${paramIndex++}`);
      values.push(body.buyMode);
    }
    if (body.buyFollowTarget !== undefined) {
      updates.push(`"buyFollowTarget" = $${paramIndex++}`);
      values.push(body.buyFollowTarget || null);
    }

    // Per-asset positioning configs (JSONB)
    if (body.positioningConfigs !== undefined) {
      updates.push(`"positioningConfigs" = $${paramIndex++}`);
      values.push(JSON.stringify(body.positioningConfigs));
    }

    // Smart mode filters
    if (typeof body.smartMinUserGrade === 'number') {
      updates.push(`"smartMinUserGrade" = $${paramIndex++}`);
      values.push(body.smartMinUserGrade);
    }
    if (typeof body.smartMinFinishRate === 'number') {
      updates.push(`"smartMinFinishRate" = $${paramIndex++}`);
      values.push(body.smartMinFinishRate);
    }
    if (typeof body.smartMinOrderCount === 'number') {
      updates.push(`"smartMinOrderCount" = $${paramIndex++}`);
      values.push(body.smartMinOrderCount);
    }
    if (typeof body.smartMinPositiveRate === 'number') {
      updates.push(`"smartMinPositiveRate" = $${paramIndex++}`);
      values.push(body.smartMinPositiveRate);
    }
    if (typeof body.smartRequireOnline === 'boolean') {
      updates.push(`"smartRequireOnline" = $${paramIndex++}`);
      values.push(body.smartRequireOnline);
    }
    if (typeof body.smartMinSurplus === 'number') {
      updates.push(`"smartMinSurplus" = $${paramIndex++}`);
      values.push(body.smartMinSurplus);
    }

    // Strategy
    if (typeof body.undercutCents === 'number') {
      updates.push(`"undercutCents" = $${paramIndex++}`);
      values.push(body.undercutCents);
    }
    if (typeof body.matchPrice === 'boolean') {
      updates.push(`"matchPrice" = $${paramIndex++}`);
      values.push(body.matchPrice);
    }

    // Auto-message
    if (typeof body.autoMessageEnabled === 'boolean') {
      updates.push(`"autoMessageEnabled" = $${paramIndex++}`);
      values.push(body.autoMessageEnabled);
    }
    if (body.autoMessageText !== undefined) {
      updates.push(`"autoMessageText" = $${paramIndex++}`);
      values.push(body.autoMessageText || null);
    }

    // Ignored advertisers (JSONB array)
    if (Array.isArray(body.ignoredAdvertisers)) {
      updates.push(`"ignoredAdvertisers" = $${paramIndex++}`);
      values.push(JSON.stringify(body.ignoredAdvertisers));
    }

    if (updates.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No updates provided' },
        { status: 400 }
      );
    }

    // Add updatedAt and updatedBy
    updates.push(`"updatedAt" = NOW()`);
    updates.push(`"updatedBy" = $${paramIndex++}`);
    values.push('Dashboard');

    // Ensure config exists first
    await pool.query(
      `INSERT INTO "BotConfig" (id, "releaseEnabled", "positioningEnabled", "positioningMode", "updatedAt")
       VALUES ('main', true, false, 'off', NOW())
       ON CONFLICT (id) DO NOTHING`
    );

    // Update config
    const query = `UPDATE "BotConfig" SET ${updates.join(', ')} WHERE id = 'main' RETURNING *`;
    const result = await pool.query(query, values);

    const config = result.rows[0];

    // Log the action
    const logId = `c${Date.now().toString(36)}${Math.random().toString(36).substring(2, 9)}`;
    await pool.query(
      `INSERT INTO "AuditLog" (id, action, details, success, "createdAt")
       VALUES ($1, 'bot_config_changed', $2, true, NOW())`,
      [logId, JSON.stringify(body)]
    );

    // Parse positioningConfigs from JSONB
    let positioningConfigs = {};
    if (config.positioningConfigs) {
      try {
        positioningConfigs = typeof config.positioningConfigs === 'string'
          ? JSON.parse(config.positioningConfigs)
          : config.positioningConfigs;
      } catch {
        positioningConfigs = {};
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Bot configuration updated',
      config: {
        releaseEnabled: config.releaseEnabled,
        positioningEnabled: config.positioningEnabled,
        positioningMode: config.positioningMode,
        followTargetNickName: config.followTargetNickName,
        followTargetUserNo: config.followTargetUserNo,
        sellMode: config.sellMode,
        sellFollowTarget: config.sellFollowTarget,
        buyMode: config.buyMode,
        buyFollowTarget: config.buyFollowTarget,
        positioningConfigs,
        smartMinUserGrade: config.smartMinUserGrade,
        smartMinFinishRate: config.smartMinFinishRate,
        smartMinOrderCount: config.smartMinOrderCount,
        smartMinPositiveRate: config.smartMinPositiveRate,
        smartRequireOnline: config.smartRequireOnline,
        smartMinSurplus: config.smartMinSurplus,
        undercutCents: config.undercutCents,
        matchPrice: config.matchPrice,
        autoMessageEnabled: config.autoMessageEnabled,
        autoMessageText: config.autoMessageText,
        updatedAt: config.updatedAt,
      },
    });
  } catch (error) {
    console.error('Error updating bot config:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update bot configuration' },
      { status: 500 }
    );
  }
}
