// =====================================================
// Multi-Tenant Setup Script
// Run this to create the initial admin account
// =====================================================

import pg from 'pg';
import bcrypt from 'bcryptjs';
import * as readline from 'readline';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function generateId(): string {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 15);
  return `c${timestamp}${randomPart}`;
}

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

async function createMerchant(
  name: string,
  email: string,
  password: string,
  isAdmin: boolean,
  clabeAccount?: string
) {
  const id = generateId();
  const passwordHash = await hashPassword(password);

  const result = await pool.query(
    `INSERT INTO "Merchant" (id, name, email, "passwordHash", "clabeAccount", "isAdmin", "isActive", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, true, NOW(), NOW())
     RETURNING id, name, email, "isAdmin"`,
    [id, name, email, passwordHash, clabeAccount || null, isAdmin]
  );

  return result.rows[0];
}

async function migrateExistingData(merchantId: string) {
  console.log('\nMigrating existing data to merchant:', merchantId);

  const tables = [
    'Order',
    'Payment',
    'ChatMessage',
    'PriceHistory',
    'DailyStats',
    'BuyerCache',
    'TrustedBuyer',
    'Alert',
    'AuditLog',
    'SupportRequest',
    'BotConfig',
  ];

  for (const table of tables) {
    try {
      const result = await pool.query(
        `UPDATE "${table}" SET "merchantId" = $1 WHERE "merchantId" IS NULL`,
        [merchantId]
      );
      console.log(`  - ${table}: ${result.rowCount} rows updated`);
    } catch (error) {
      console.log(`  - ${table}: skipped (may not have merchantId column yet)`);
    }
  }
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log('='.repeat(60));
  console.log('Multi-Tenant Setup Script');
  console.log('='.repeat(60));
  console.log('\nThis script will create your initial admin account.\n');

  try {
    // Check if Merchant table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'Merchant'
      )
    `);

    if (!tableCheck.rows[0].exists) {
      console.log('ERROR: Merchant table does not exist.');
      console.log('Please run the migration SQL first:');
      console.log('  npx prisma migrate deploy');
      console.log('  OR run the SQL file manually:');
      console.log('  prisma/migrations/20260119_multi_merchant/migration.sql');
      process.exit(1);
    }

    // Check if admin already exists
    const existingAdmin = await pool.query(
      `SELECT id, email FROM "Merchant" WHERE "isAdmin" = true LIMIT 1`
    );

    if (existingAdmin.rows.length > 0) {
      console.log('An admin account already exists:', existingAdmin.rows[0].email);
      const proceed = await question('Create another account anyway? (y/n): ');
      if (proceed.toLowerCase() !== 'y') {
        console.log('Exiting.');
        process.exit(0);
      }
    }

    // Get admin details
    console.log('\n--- Admin Account ---');
    const adminName = await question('Name: ');
    const adminEmail = await question('Email: ');
    const adminPassword = await question('Password: ');

    // Create admin
    const admin = await createMerchant(adminName, adminEmail, adminPassword, true);
    console.log('\nAdmin created successfully!');
    console.log('  ID:', admin.id);
    console.log('  Email:', admin.email);

    // Ask about first merchant
    const createMerchantAccount = await question('\nCreate first merchant account? (y/n): ');

    if (createMerchantAccount.toLowerCase() === 'y') {
      console.log('\n--- Merchant Account ---');
      const merchantName = await question('Name: ');
      const merchantEmail = await question('Email: ');
      const merchantPassword = await question('Password: ');
      const merchantClabe = await question('CLABE (18 digits, optional): ');

      const merchant = await createMerchant(
        merchantName,
        merchantEmail,
        merchantPassword,
        false,
        merchantClabe || undefined
      );
      console.log('\nMerchant created successfully!');
      console.log('  ID:', merchant.id);
      console.log('  Email:', merchant.email);

      // Ask about migrating existing data
      const migrateData = await question('\nMigrate existing data to this merchant? (y/n): ');
      if (migrateData.toLowerCase() === 'y') {
        await migrateExistingData(merchant.id);
      }

      console.log('\n='.repeat(60));
      console.log('IMPORTANT: Set this in your bot\'s Railway environment:');
      console.log(`  MERCHANT_ID=${merchant.id}`);
      console.log('='.repeat(60));
    }

    console.log('\n='.repeat(60));
    console.log('Setup complete!');
    console.log('\nNext steps:');
    console.log('1. Add NEXTAUTH_SECRET to your dashboard environment');
    console.log('2. Add NEXTAUTH_URL to your dashboard environment');
    console.log('3. Deploy the dashboard to Railway');
    console.log('4. Log in at /login with your admin credentials');
    console.log('='.repeat(60));
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    rl.close();
    await pool.end();
  }
}

main();
