'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { OrdersTable } from '@/components/OrdersTable';

type TabType = 'active' | 'completed';

async function fetchOrders(showAll: boolean) {
  const url = showAll
    ? '/api/orders?limit=100&showAll=true'
    : '/api/orders?limit=50';
  return fetch(url).then((r) => r.json());
}

export default function OrdersPage() {
  const [activeTab, setActiveTab] = useState<TabType>('active');
  const [isSyncing, setIsSyncing] = useState(false);
  const queryClient = useQueryClient();

  const { data: activeOrders, isLoading: loadingActive, refetch: refetchActive } = useQuery({
    queryKey: ['orders', 'active'],
    queryFn: () => fetchOrders(false),
    refetchInterval: 5000,
  });

  const { data: allOrders, isLoading: loadingAll, refetch: refetchAll } = useQuery({
    queryKey: ['orders', 'all'],
    queryFn: () => fetchOrders(true),
    refetchInterval: 5000,
  });

  const handleRefresh = () => {
    refetchActive();
    refetchAll();
  };

  const completedOrders = allOrders?.filter((order: any) =>
    ['COMPLETED', 'CANCELLED', 'CANCELLED_SYSTEM', 'CANCELLED_TIMEOUT'].includes(order.status)
  ) || [];

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const response = await fetch('/api/orders/sync', { method: 'POST' });
      const result = await response.json();
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: ['orders'] });
      }
    } catch { /* silent */ } finally {
      setIsSyncing(false);
    }
  };

  const isLoading = activeTab === 'active' ? loadingActive : loadingAll;
  const orders = activeTab === 'active' ? activeOrders : completedOrders;

  return (
    <div className="space-y-4">
      {/* Header + Tabs unified */}
      <div className="card">
        <div className="px-4 pt-3 pb-0 flex items-center justify-between">
          <h1 className="text-lg font-bold text-white">Ordenes</h1>
          <button
            onClick={handleSync}
            disabled={isSyncing}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 bg-[#2d2640] text-gray-300 hover:text-white hover:bg-[#3d3655] disabled:opacity-50"
          >
            <svg className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {isSyncing ? 'Sync...' : 'Sync'}
          </button>
        </div>

        <div className="border-b border-[#2b2f36] mt-2">
          <nav className="flex px-4">
            <button
              onClick={() => setActiveTab('active')}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition ${
                activeTab === 'active'
                  ? 'border-primary-500 text-primary-500'
                  : 'border-transparent text-gray-400 hover:text-white'
              }`}
            >
              Activas
              {activeOrders && !loadingActive && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-primary-500/20 text-primary-400 text-xs">
                  {activeOrders.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab('completed')}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition ${
                activeTab === 'completed'
                  ? 'border-primary-500 text-primary-500'
                  : 'border-transparent text-gray-400 hover:text-white'
              }`}
            >
              Completadas
              {completedOrders && !loadingAll && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-gray-500/20 text-gray-400 text-xs">
                  {completedOrders.length}
                </span>
              )}
            </button>
          </nav>
        </div>

        <div className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center h-48">
              <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-primary-500"></div>
            </div>
          ) : (
            <OrdersTable orders={orders || []} onRefresh={handleRefresh} />
          )}
        </div>
      </div>
    </div>
  );
}
