import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions, createMerchant, updateMerchant } from '@/lib/auth';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// GET - List all merchants with full details
export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized - Admin only' }, { status: 403 });
    }

    // Get merchants with additional stats
    const result = await pool.query(`
      SELECT
        m.id,
        m.name,
        m.email,
        m."binanceNickname",
        m."botApiUrl",
        m."clabeAccount",
        m."bankName",
        m."isAdmin",
        m."isActive",
        m."createdAt",
        m."lastLoginAt",
        (SELECT COUNT(*) FROM "Order" o WHERE o."merchantId" = m.id) as "totalOrders",
        (SELECT COUNT(*) FROM "Order" o WHERE o."merchantId" = m.id AND o.status = 'COMPLETED') as "completedOrders",
        (SELECT COALESCE(SUM(o."totalPrice"), 0) FROM "Order" o WHERE o."merchantId" = m.id AND o.status = 'COMPLETED') as "totalVolume",
        (SELECT COUNT(*) FROM "TrustedBuyer" tb WHERE tb."merchantId" = m.id) as "trustedBuyers",
        bc."positioningEnabled",
        bc."releaseEnabled",
        bc."sellMode",
        bc."buyMode"
      FROM "Merchant" m
      LEFT JOIN "BotConfig" bc ON bc."merchantId" = m.id
      ORDER BY m."createdAt" DESC
    `);

    return NextResponse.json({
      success: true,
      merchants: result.rows,
    });
  } catch (error) {
    console.error('Admin merchants GET error:', error);
    return NextResponse.json({ error: 'Failed to load merchants' }, { status: 500 });
  }
}

// POST - Create new merchant
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized - Admin only' }, { status: 403 });
    }

    const body = await request.json();
    const { name, email, password, binanceNickname, botApiUrl, clabeAccount, bankName } = body;

    if (!name || !email || !password) {
      return NextResponse.json(
        { error: 'name, email, and password are required' },
        { status: 400 }
      );
    }

    // Check if email already exists
    const existingResult = await pool.query(
      `SELECT id FROM "Merchant" WHERE email = $1`,
      [email]
    );

    if (existingResult.rows.length > 0) {
      return NextResponse.json(
        { error: 'Email already exists' },
        { status: 400 }
      );
    }

    // Create merchant
    const merchant = await createMerchant({
      name,
      email,
      password,
      binanceNickname,
      clabeAccount,
      bankName,
      isAdmin: false,
    });

    // Update botApiUrl if provided (createMerchant doesn't handle it)
    if (botApiUrl) {
      await pool.query(
        `UPDATE "Merchant" SET "botApiUrl" = $1 WHERE id = $2`,
        [botApiUrl, merchant.id]
      );
    }

    // Create default BotConfig for the new merchant
    await pool.query(`
      INSERT INTO "BotConfig" (id, "merchantId", "releaseEnabled", "positioningEnabled", "positioningMode", "updatedAt")
      VALUES ($1, $2, true, false, 'off', NOW())
    `, [`bc_${merchant.id}`, merchant.id]);

    return NextResponse.json({
      success: true,
      merchant,
    });
  } catch (error) {
    console.error('Admin merchants POST error:', error);
    return NextResponse.json({ error: 'Failed to create merchant' }, { status: 500 });
  }
}

// PUT - Update merchant
export async function PUT(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized - Admin only' }, { status: 403 });
    }

    const body = await request.json();
    const { id, name, email, password, binanceNickname, botApiUrl, clabeAccount, bankName, isActive } = body;

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    // Update merchant using auth helper
    const updated = await updateMerchant(id, {
      name,
      email,
      password,
      binanceNickname,
      clabeAccount,
      bankName,
      isActive,
    });

    // Update botApiUrl separately
    if (botApiUrl !== undefined) {
      await pool.query(
        `UPDATE "Merchant" SET "botApiUrl" = $1, "updatedAt" = NOW() WHERE id = $2`,
        [botApiUrl, id]
      );
    }

    return NextResponse.json({
      success: true,
      merchant: updated,
    });
  } catch (error) {
    console.error('Admin merchants PUT error:', error);
    return NextResponse.json({ error: 'Failed to update merchant' }, { status: 500 });
  }
}

// PATCH - Alias for PUT (backwards compatibility)
export async function PATCH(request: NextRequest) {
  return PUT(request);
}

// DELETE - Delete merchant (soft delete by setting isActive = false)
export async function DELETE(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized - Admin only' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    // Soft delete - just deactivate
    await pool.query(
      `UPDATE "Merchant" SET "isActive" = false, "updatedAt" = NOW() WHERE id = $1`,
      [id]
    );

    return NextResponse.json({
      success: true,
      message: 'Merchant deactivated',
    });
  } catch (error) {
    console.error('Admin merchants DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete merchant' }, { status: 500 });
  }
}
