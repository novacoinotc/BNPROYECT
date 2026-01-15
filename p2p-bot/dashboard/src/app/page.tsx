'use client';

import { useQuery } from '@tanstack/react-query';
import { StatsCards } from '@/components/StatsCards';
import { OrdersTable } from '@/components/OrdersTable';
import { PriceChart } from '@/components/PriceChart';
import { AlertsList } from '@/components/AlertsList';
import { AdInfo } from '@/components/AdInfo';

async function fetchDashboardData() {
  const [stats, orders, alerts] = await Promise.all([
    fetch('/api/stats').then((r) => r.json()),
    fetch('/api/orders?limit=10').then((r) => r.json()),
    fetch('/api/alerts').then((r) => r.json()),
  ]);
  return { stats, orders, alerts };
}

export default function Dashboard() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: fetchDashboardData,
    // Fallback polling in case SSE disconnects
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary-500"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-6 text-center">
        <p className="text-red-400">Error loading dashboard data</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <StatsCards stats={data?.stats} />

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Orders Table - 2 columns */}
        <div className="lg:col-span-2">
          <div className="card">
            <div className="card-header flex items-center justify-between">
              <h2 className="text-lg font-semibold">Recent Orders</h2>
              <a href="/orders" className="text-primary-500 text-sm hover:underline">
                View all
              </a>
            </div>
            <div className="card-body p-0">
              <OrdersTable orders={data?.orders || []} onRefresh={refetch} />
            </div>
          </div>
        </div>

        {/* Alerts - 1 column */}
        <div className="lg:col-span-1">
          <div className="card">
            <div className="card-header">
              <h2 className="text-lg font-semibold">Alerts</h2>
            </div>
            <div className="card-body p-0">
              <AlertsList alerts={data?.alerts || []} />
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Grid: Ad Info and Price Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Ad Info - 1 column */}
        <div className="lg:col-span-1">
          <div className="card">
            <div className="card-header">
              <h2 className="text-lg font-semibold">Mi Anuncio</h2>
            </div>
            <div className="card-body">
              <AdInfo />
            </div>
          </div>
        </div>

        {/* Price Chart - 2 columns */}
        <div className="lg:col-span-2">
          <div className="card">
            <div className="card-header">
              <h2 className="text-lg font-semibold">Price History</h2>
            </div>
            <div className="card-body">
              <PriceChart />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
