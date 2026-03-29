import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';
import { getMerchantContext } from '@/lib/merchant-context';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// POST - Update config for ALL merchants (admin only)
export async function POST(request: NextRequest) {
  try {
    const context = await getMerchantContext();
    if (!context?.isAdmin) {
      return NextResponse.json({ success: false, error: 'Admin only' }, { status: 403 });
    }

    const body = await request.json();
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    // Only allow specific global fields
    if (typeof body.smartMinMaxOrderLimit === 'number') {
      updates.push(`"smartMinMaxOrderLimit" = $${paramIndex++}`);
      values.push(body.smartMinMaxOrderLimit);
    }

    if (updates.length === 0) {
      return NextResponse.json({ success: false, error: 'No updates provided' }, { status: 400 });
    }

    updates.push(`"updatedAt" = NOW()`);

    const result = await pool.query(
      `UPDATE "BotConfig" SET ${updates.join(', ')} RETURNING "merchantId"`,
      values
    );

    // Log
    const logId = `c${Date.now().toString(36)}${Math.random().toString(36).substring(2, 9)}`;
    await pool.query(
      `INSERT INTO "AuditLog" (id, action, details, success, "createdAt")
       VALUES ($1, 'global_config_changed', $2, true, NOW())`,
      [logId, JSON.stringify(body)]
    );

    return NextResponse.json({
      success: true,
      updated: result.rowCount,
      message: `Updated ${result.rowCount} merchants`,
    });
  } catch (error: any) {
    console.error('Global config update error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
