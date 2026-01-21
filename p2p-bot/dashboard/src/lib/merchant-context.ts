import { getServerSession } from 'next-auth';
import { cookies, headers } from 'next/headers';
import { authOptions } from './auth';

export interface MerchantContext {
  merchantId: string;
  isAdmin: boolean;
  email: string;
  name: string;
  // When admin is viewing as a merchant
  isViewingAs?: boolean;
  viewingMerchantName?: string;
}

/**
 * Get the current merchant context from the session
 * For admins, checks if they have selected a specific merchant to view
 * Returns null if not authenticated
 */
export async function getMerchantContext(): Promise<MerchantContext | null> {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return null;
  }

  const baseContext: MerchantContext = {
    merchantId: session.user.id,
    isAdmin: session.user.isAdmin,
    email: session.user.email,
    name: session.user.name,
  };

  // If admin, check for selected merchant override
  if (session.user.isAdmin) {
    try {
      // Check header first (set by client)
      const headersList = await headers();
      const selectedMerchantId = headersList.get('x-selected-merchant-id');
      const selectedMerchantName = headersList.get('x-selected-merchant-name');

      // Also check cookie as fallback
      const cookieStore = await cookies();
      const cookieMerchantId = cookieStore.get('selectedMerchantId')?.value;
      const cookieMerchantName = cookieStore.get('selectedMerchantName')?.value;

      const finalMerchantId = selectedMerchantId || cookieMerchantId;
      const finalMerchantName = selectedMerchantName || cookieMerchantName;

      if (finalMerchantId && finalMerchantId !== session.user.id) {
        return {
          ...baseContext,
          merchantId: finalMerchantId,
          isViewingAs: true,
          viewingMerchantName: finalMerchantName || undefined,
        };
      }
    } catch {
      // headers/cookies might not be available in some contexts
    }
  }

  return baseContext;
}

/**
 * Build a WHERE clause filter based on merchant context
 * Admins see all by default, but when "viewing as" a merchant, filter by that merchant
 * Regular merchants only see their own data
 */
export function getMerchantFilter(context: MerchantContext | null): { merchantId?: string } {
  if (!context) {
    return {}; // No filter if no context (will be rejected by auth)
  }

  // If admin is viewing as a specific merchant, filter by that merchant
  if (context.isAdmin && context.isViewingAs) {
    return { merchantId: context.merchantId };
  }

  // Admins without viewAs see all
  if (context.isAdmin) {
    return {};
  }

  // Regular merchants only see their own
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
