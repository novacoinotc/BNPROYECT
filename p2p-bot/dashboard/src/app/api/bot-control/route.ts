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

    return NextResponse.json({
      success: true,
      config: {
        releaseEnabled: config.releaseEnabled,
        positioningEnabled: config.positioningEnabled,
        positioningMode: config.positioningMode,
        followTargetNickName: config.followTargetNickName,
        followTargetUserNo: config.followTargetUserNo,
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

// POST - Update bot configuration (kill switches)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      releaseEnabled,
      positioningEnabled,
      positioningMode,
      followTargetNickName,
      followTargetUserNo,
    } = body;

    // Build dynamic update query
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (typeof releaseEnabled === 'boolean') {
      updates.push(`"releaseEnabled" = $${paramIndex++}`);
      values.push(releaseEnabled);
    }

    if (typeof positioningEnabled === 'boolean') {
      updates.push(`"positioningEnabled" = $${paramIndex++}`);
      values.push(positioningEnabled);
    }

    if (typeof positioningMode === 'string') {
      updates.push(`"positioningMode" = $${paramIndex++}`);
      values.push(positioningMode);
    }

    if (followTargetNickName !== undefined) {
      updates.push(`"followTargetNickName" = $${paramIndex++}`);
      values.push(followTargetNickName || null);
    }

    if (followTargetUserNo !== undefined) {
      updates.push(`"followTargetUserNo" = $${paramIndex++}`);
      values.push(followTargetUserNo || null);
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
    const action = [];
    if (typeof releaseEnabled === 'boolean') {
      action.push(`release:${releaseEnabled ? 'ON' : 'OFF'}`);
    }
    if (typeof positioningEnabled === 'boolean') {
      action.push(`positioning:${positioningEnabled ? 'ON' : 'OFF'}`);
    }
    if (positioningMode) {
      action.push(`mode:${positioningMode}`);
    }

    const logId = `c${Date.now().toString(36)}${Math.random().toString(36).substring(2, 9)}`;
    await pool.query(
      `INSERT INTO "AuditLog" (id, action, details, success, "createdAt")
       VALUES ($1, 'bot_config_changed', $2, true, NOW())`,
      [logId, JSON.stringify({ changes: action.join(', '), ...body })]
    );

    return NextResponse.json({
      success: true,
      message: `Bot configuration updated: ${action.join(', ')}`,
      config: {
        releaseEnabled: config.releaseEnabled,
        positioningEnabled: config.positioningEnabled,
        positioningMode: config.positioningMode,
        followTargetNickName: config.followTargetNickName,
        followTargetUserNo: config.followTargetUserNo,
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
