import { getServerSession } from 'next-auth';
import { authOptions } from './auth';

export interface MerchantContext {
  merchantId: string;
  isAdmin: boolean;
  email: string;
  name: string;
}

/**
 * Get the current merchant context from the session
 * Returns null if not authenticated
 */
export async function getMerchantContext(): Promise<MerchantContext | null> {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return null;
  }

  return {
    merchantId: session.user.id,
    isAdmin: session.user.isAdmin,
    email: session.user.email,
    name: session.user.name,
  };
}

/**
 * Build a WHERE clause filter based on merchant context
 * Admins can see all data, merchants only see their own
 */
export function getMerchantFilter(context: MerchantContext | null): { merchantId?: string } {
  if (!context) {
    return {}; // No filter if no context (will be rejected by auth)
  }

  if (context.isAdmin) {
    return {}; // Admins see all
  }

  return { merchantId: context.merchantId };
}

/**
 * Check if a merchant has access to a specific resource
 */
export function canAccessResource(
  context: MerchantContext | null,
  resourceMerchantId: string | null | undefined
): boolean {
  if (!context) return false;
  if (context.isAdmin) return true;
  return context.merchantId === resourceMerchantId;
}
