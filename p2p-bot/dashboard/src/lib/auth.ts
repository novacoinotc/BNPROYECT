import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';

// Extend the session types
declare module 'next-auth' {
  interface User {
    id: string;
    name: string;
    email: string;
    isAdmin: boolean;
  }

  interface Session {
    user: {
      id: string;
      name: string;
      email: string;
      isAdmin: boolean;
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    isAdmin: boolean;
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          throw new Error('Email y password son requeridos');
        }

        try {
          const result = await pool.query(
            `SELECT id, name, email, "passwordHash", "isAdmin", "isActive"
             FROM "Merchant"
             WHERE email = $1`,
            [credentials.email]
          );

          const user = result.rows[0];

          if (!user) {
            throw new Error('Credenciales invalidas');
          }

          if (!user.isActive) {
            throw new Error('Cuenta desactivada');
          }

          const isPasswordValid = await bcrypt.compare(
            credentials.password,
            user.passwordHash
          );

          if (!isPasswordValid) {
            throw new Error('Credenciales invalidas');
          }

          // Update last login
          await pool.query(
            `UPDATE "Merchant" SET "lastLoginAt" = NOW() WHERE id = $1`,
            [user.id]
          );

          return {
            id: user.id,
            name: user.name,
            email: user.email,
            isAdmin: user.isAdmin,
          };
        } catch (error) {
          console.error('Auth error:', error);
          throw error;
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.isAdmin = user.isAdmin;
      }
      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id;
        session.user.isAdmin = token.isAdmin;
      }
      return session;
    },
  },
  pages: {
    signIn: '/login',
    error: '/login',
  },
  session: {
    strategy: 'jwt',
    maxAge: 7 * 24 * 60 * 60, // 7 days
  },
  secret: process.env.NEXTAUTH_SECRET,
};

// Helper to hash passwords
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

// Helper to verify passwords
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Helper to get merchant by ID
export async function getMerchantById(id: string) {
  const result = await pool.query(
    `SELECT id, name, email, "binanceNickname", "clabeAccount", "bankName",
            "isAdmin", "isActive", "createdAt", "lastLoginAt"
     FROM "Merchant" WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

// Helper to get merchant by email
export async function getMerchantByEmail(email: string) {
  const result = await pool.query(
    `SELECT id, name, email, "binanceNickname", "clabeAccount", "bankName",
            "isAdmin", "isActive", "createdAt", "lastLoginAt"
     FROM "Merchant" WHERE email = $1`,
    [email]
  );
  return result.rows[0] || null;
}

// Helper to create a new merchant
export async function createMerchant(data: {
  name: string;
  email: string;
  password: string;
  binanceNickname?: string;
  clabeAccount?: string;
  bankName?: string;
  isAdmin?: boolean;
}) {
  const id = `c${Date.now().toString(36)}${Math.random().toString(36).substring(2, 9)}`;
  const passwordHash = await hashPassword(data.password);

  const result = await pool.query(
    `INSERT INTO "Merchant" (id, name, email, "passwordHash", "binanceNickname",
                            "clabeAccount", "bankName", "isAdmin", "isActive",
                            "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NOW(), NOW())
     RETURNING id, name, email, "isAdmin", "isActive", "createdAt"`,
    [
      id,
      data.name,
      data.email,
      passwordHash,
      data.binanceNickname || null,
      data.clabeAccount || null,
      data.bankName || null,
      data.isAdmin || false,
    ]
  );

  return result.rows[0];
}

// Helper to list all merchants (for admin)
export async function listMerchants() {
  const result = await pool.query(
    `SELECT id, name, email, "binanceNickname", "clabeAccount", "bankName",
            "isAdmin", "isActive", "createdAt", "lastLoginAt"
     FROM "Merchant"
     ORDER BY "createdAt" DESC`
  );
  return result.rows;
}

// Helper to update merchant
export async function updateMerchant(
  id: string,
  data: {
    name?: string;
    email?: string;
    password?: string;
    binanceNickname?: string;
    clabeAccount?: string;
    bankName?: string;
    isAdmin?: boolean;
    isActive?: boolean;
  }
) {
  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (data.name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(data.name);
  }
  if (data.email !== undefined) {
    updates.push(`email = $${paramIndex++}`);
    values.push(data.email);
  }
  if (data.password !== undefined) {
    const passwordHash = await hashPassword(data.password);
    updates.push(`"passwordHash" = $${paramIndex++}`);
    values.push(passwordHash);
  }
  if (data.binanceNickname !== undefined) {
    updates.push(`"binanceNickname" = $${paramIndex++}`);
    values.push(data.binanceNickname);
  }
  if (data.clabeAccount !== undefined) {
    updates.push(`"clabeAccount" = $${paramIndex++}`);
    values.push(data.clabeAccount);
  }
  if (data.bankName !== undefined) {
    updates.push(`"bankName" = $${paramIndex++}`);
    values.push(data.bankName);
  }
  if (data.isAdmin !== undefined) {
    updates.push(`"isAdmin" = $${paramIndex++}`);
    values.push(data.isAdmin);
  }
  if (data.isActive !== undefined) {
    updates.push(`"isActive" = $${paramIndex++}`);
    values.push(data.isActive);
  }

  if (updates.length === 0) return null;

  updates.push(`"updatedAt" = NOW()`);
  values.push(id);

  const result = await pool.query(
    `UPDATE "Merchant" SET ${updates.join(', ')} WHERE id = $${paramIndex}
     RETURNING id, name, email, "isAdmin", "isActive"`,
    values
  );

  return result.rows[0];
}

// Helper to delete merchant
export async function deleteMerchant(id: string) {
  const result = await pool.query(
    `DELETE FROM "Merchant" WHERE id = $1 RETURNING id`,
    [id]
  );
  return result.rowCount && result.rowCount > 0;
}
