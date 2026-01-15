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
  const [syncResult, setSyncResult] = useState<string | null>(null);
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

  // Filter completed orders from all orders
  const completedOrders = allOrders?.filter((order: any) =>
    ['COMPLETED', 'CANCELLED', 'CANCELLED_SYSTEM', 'CANCELLED_TIMEOUT'].includes(order.status)
  ) || [];

  const handleSync = async () => {
    setIsSyncing(true);
    setSyncResult(null);

    try {
      const response = await fetch('/api/orders/sync', { method: 'POST' });
      const result = await response.json();

      if (result.success) {
        setSyncResult(`Sincronizado: ${result.updated} ordenes actualizadas de ${result.total}`);
        // Refresh orders
        queryClient.invalidateQueries({ queryKey: ['orders'] });
        queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      } else {
        setSyncResult(`Error: ${result.error}`);
      }
    } catch (error) {
      setSyncResult('Error al sincronizar');
    } finally {
      setIsSyncing(false);
    }
  };

  const isLoading = activeTab === 'active' ? loadingActive : loadingAll;
  const orders = activeTab === 'active' ? activeOrders : completedOrders;

  return (
    <div className="space-y-6">
      {/* Header with sync button */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Ordenes</h1>
        <button
          onClick={handleSync}
          disabled={isSyncing}
          className={`px-4 py-2 rounded-lg font-medium transition flex items-center gap-2 ${
            isSyncing
              ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
              : 'bg-primary-500 text-white hover:bg-primary-600'
          }`}
        >
          {isSyncing ? (
            <>
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              Sincronizando...
            </>
          ) : (
            <>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              Sincronizar con Binance
            </>
          )}
        </button>
      </div>

      {/* Sync result message */}
      {syncResult && (
        <div className={`p-3 rounded-lg ${
          syncResult.startsWith('Error')
            ? 'bg-red-500/10 border border-red-500/30 text-red-400'
            : 'bg-green-500/10 border border-green-500/30 text-green-400'
        }`}>
          {syncResult}
        </div>
      )}

      {/* Tabs */}
      <div className="card">
        <div className="border-b border-[#2b2f36]">
          <nav className="flex">
            <button
              onClick={() => setActiveTab('active')}
              className={`px-6 py-3 text-sm font-medium border-b-2 transition ${
                activeTab === 'active'
                  ? 'border-primary-500 text-primary-500'
                  : 'border-transparent text-gray-400 hover:text-white'
              }`}
            >
              Activas
              {activeOrders && !loadingActive && (
                <span className="ml-2 px-2 py-0.5 rounded-full bg-primary-500/20 text-primary-400 text-xs">
                  {activeOrders.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab('completed')}
              className={`px-6 py-3 text-sm font-medium border-b-2 transition ${
                activeTab === 'completed'
                  ? 'border-primary-500 text-primary-500'
                  : 'border-transparent text-gray-400 hover:text-white'
              }`}
            >
              Completadas
              {completedOrders && !loadingAll && (
                <span className="ml-2 px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-400 text-xs">
                  {completedOrders.length}
                </span>
              )}
            </button>
          </nav>
        </div>

        {/* Orders table */}
        <div className="card-body p-0">
          {isLoading ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary-500"></div>
            </div>
          ) : (
            <OrdersTable orders={orders || []} onRefresh={handleRefresh} />
          )}
        </div>
      </div>
    </div>
  );
}
