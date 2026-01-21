'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useSession } from 'next-auth/react';

interface Merchant {
  id: string;
  name: string;
  binanceNickname: string | null;
  isActive: boolean;
}

interface MerchantSelectorContextType {
  merchants: Merchant[];
  selectedMerchantId: string | null;
  selectedMerchant: Merchant | null;
  selectMerchant: (id: string | null) => void;
  isLoading: boolean;
  isAdmin: boolean;
}

const MerchantSelectorContext = createContext<MerchantSelectorContextType | undefined>(undefined);

export function MerchantSelectorProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [selectedMerchantId, setSelectedMerchantId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const isAdmin = session?.user?.isAdmin ?? false;

  // Load merchants list for admin
  useEffect(() => {
    if (!isAdmin) {
      setIsLoading(false);
      return;
    }

    async function fetchMerchants() {
      try {
        const res = await fetch('/api/admin/merchants');
        const data = await res.json();
        if (data.success && data.merchants) {
          // Filter to only non-admin merchants
          const merchantList = data.merchants.filter((m: any) => !m.isAdmin);
          setMerchants(merchantList);
        }
      } catch (error) {
        console.error('Failed to fetch merchants:', error);
      } finally {
        setIsLoading(false);
      }
    }

    fetchMerchants();
  }, [isAdmin]);

  // Load saved selection from localStorage
  useEffect(() => {
    if (!isAdmin) return;

    const saved = localStorage.getItem('adminSelectedMerchantId');
    if (saved) {
      setSelectedMerchantId(saved);
      // Also set cookie for server-side
      document.cookie = `selectedMerchantId=${saved}; path=/; max-age=86400`;
    }
  }, [isAdmin]);

  // Update selection
  const selectMerchant = (id: string | null) => {
    setSelectedMerchantId(id);

    if (id) {
      localStorage.setItem('adminSelectedMerchantId', id);
      const merchant = merchants.find(m => m.id === id);
      document.cookie = `selectedMerchantId=${id}; path=/; max-age=86400`;
      document.cookie = `selectedMerchantName=${encodeURIComponent(merchant?.name || '')}; path=/; max-age=86400`;
    } else {
      localStorage.removeItem('adminSelectedMerchantId');
      document.cookie = 'selectedMerchantId=; path=/; max-age=0';
      document.cookie = 'selectedMerchantName=; path=/; max-age=0';
    }

    // Force reload to refresh all data with new context
    window.location.reload();
  };

  const selectedMerchant = merchants.find(m => m.id === selectedMerchantId) || null;

  return (
    <MerchantSelectorContext.Provider
      value={{
        merchants,
        selectedMerchantId,
        selectedMerchant,
        selectMerchant,
        isLoading,
        isAdmin,
      }}
    >
      {children}
    </MerchantSelectorContext.Provider>
  );
}

export function useMerchantSelector() {
  const context = useContext(MerchantSelectorContext);
  if (context === undefined) {
    throw new Error('useMerchantSelector must be used within a MerchantSelectorProvider');
  }
  return context;
}
