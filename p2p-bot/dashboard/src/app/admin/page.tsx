'use client';

import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import Link from 'next/link';

interface MerchantOverview {
  id: string;
  name: string;
  binanceNickname: string;
  totalOrders: string;
  completedOrders: string;
  activeOrders: string;
  totalVolume: string;
  botStatus: string;
}

interface OverviewData {
  merchants: MerchantOverview[];
  todayStats: { todayOrders: string; todayCompleted: string; todayVolume: string };
  activeOrders: Record<string, number>;
  recentAlerts: any[];
}

export default function AdminPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [overview, setOverview] = useState<OverviewData | null>(null);

  useEffect(() => {
    if (status === 'authenticated' && !session?.user?.isAdmin) {
      router.push('/');
    }
  }, [session, status, router]);

  useEffect(() => {
    if (session?.user?.isAdmin) {
      fetchOverview();
      const interval = setInterval(fetchOverview, 30000);
      return () => clearInterval(interval);
    }
  }, [session]);

  async function fetchOverview() {
    try {
      const res = await fetch('/api/admin/overview');
      const json = await res.json();
      if (json.success) setOverview(json);
    } catch (err) {
      console.error('Failed to fetch overview:', err);
    }
  }

  const formatCurrency = (v: string | number) => {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n);
  };

  const getBotStatusColor = (s: string) => {
    if (s === 'online') return 'bg-green-500';
    if (s === 'offline') return 'bg-red-500';
    if (s === 'error') return 'bg-yellow-500';
    return 'bg-gray-500';
  };

  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
      </div>
    );
  }

  if (!session?.user?.isAdmin) {
    return null;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Panel de Administracion</h1>
          <p className="text-gray-400 mt-1">Gestion del sistema multi-merchant</p>
        </div>
        <span className="px-3 py-1 bg-yellow-500/20 text-yellow-400 rounded-full text-sm">
          Admin
        </span>
      </div>

      {/* Admin Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Merchants */}
        <Link
          href="/admin/merchants"
          className="bg-gray-800 rounded-lg p-6 hover:bg-gray-750 transition-colors border border-gray-700 hover:border-blue-500"
        >
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-500/20 rounded-lg flex items-center justify-center">
              <svg className="w-6 h-6 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-white">Merchants</h3>
              <p className="text-gray-400 text-sm">Gestionar cuentas de merchants</p>
            </div>
          </div>
        </Link>

        {/* All Orders */}
        <Link
          href="/admin/orders"
          className="bg-gray-800 rounded-lg p-6 hover:bg-gray-750 transition-colors border border-gray-700 hover:border-green-500"
        >
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-green-500/20 rounded-lg flex items-center justify-center">
              <svg className="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-white">Todas las Ordenes</h3>
              <p className="text-gray-400 text-sm">Ver ordenes de todos los merchants</p>
            </div>
          </div>
        </Link>

        {/* Ads */}
        <Link
          href="/admin/ads"
          className="bg-gray-800 rounded-lg p-6 hover:bg-gray-750 transition-colors border border-gray-700 hover:border-purple-500"
        >
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-purple-500/20 rounded-lg flex items-center justify-center">
              <svg className="w-6 h-6 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" />
              </svg>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-white">Anuncios</h3>
              <p className="text-gray-400 text-sm">Ver anuncios de todos los merchants</p>
            </div>
          </div>
        </Link>
      </div>

      {/* Real-time Stats */}
      {overview && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
              <p className="text-gray-400 text-sm">Ordenes Hoy</p>
              <p className="text-2xl font-bold text-white">{overview.todayStats.todayOrders}</p>
            </div>
            <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
              <p className="text-gray-400 text-sm">Completadas Hoy</p>
              <p className="text-2xl font-bold text-green-400">{overview.todayStats.todayCompleted}</p>
            </div>
            <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
              <p className="text-gray-400 text-sm">Volumen Hoy</p>
              <p className="text-2xl font-bold text-blue-400">{formatCurrency(overview.todayStats.todayVolume)}</p>
            </div>
            <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
              <p className="text-gray-400 text-sm">Ordenes Activas</p>
              <p className="text-2xl font-bold text-yellow-400">
                {Object.values(overview.activeOrders).reduce((a, b) => a + b, 0)}
              </p>
            </div>
          </div>

          {/* Merchants Status */}
          <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
            <h2 className="text-lg font-semibold text-white mb-4">Estado de Merchants</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {overview.merchants.map((m) => (
                <div key={m.id} className="bg-gray-900 rounded-lg p-4">
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-medium text-white">{m.name}</span>
                    <span className={'w-3 h-3 rounded-full ' + getBotStatusColor(m.botStatus)}></span>
                  </div>
                  <p className="text-xs text-gray-400">{m.binanceNickname || 'Sin nickname'}</p>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div><span className="text-gray-500">Activas:</span> <span className="text-yellow-400">{m.activeOrders}</span></div>
                    <div><span className="text-gray-500">Completadas:</span> <span className="text-green-400">{m.completedOrders}</span></div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Alerts */}
          {overview.recentAlerts.length > 0 && (
            <div className="bg-gray-800 rounded-lg p-6 border border-red-900">
              <h2 className="text-lg font-semibold text-red-400 mb-4">Alertas Sin Atender ({overview.recentAlerts.length})</h2>
              <div className="space-y-2">
                {overview.recentAlerts.slice(0, 5).map((a: any) => (
                  <div key={a.id} className="bg-gray-900 rounded p-3 flex justify-between items-center">
                    <div>
                      <span className="text-sm text-white">{a.title}</span>
                      <span className="ml-2 text-xs text-gray-500">{a.merchantName}</span>
                    </div>
                    <span className="text-xs text-gray-400">{new Date(a.createdAt).toLocaleString('es-MX')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Quick Info */}
      <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
        <h2 className="text-lg font-semibold text-white mb-4">Informacion del Sistema</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-gray-900 rounded-lg p-4">
            <p className="text-gray-400 text-sm">Usuario</p>
            <p className="text-white font-medium">{session.user.name}</p>
          </div>
          <div className="bg-gray-900 rounded-lg p-4">
            <p className="text-gray-400 text-sm">Email</p>
            <p className="text-white font-medium">{session.user.email}</p>
          </div>
          <div className="bg-gray-900 rounded-lg p-4">
            <p className="text-gray-400 text-sm">Rol</p>
            <p className="text-yellow-400 font-medium">Administrador</p>
          </div>
          <div className="bg-gray-900 rounded-lg p-4">
            <p className="text-gray-400 text-sm">Merchant ID</p>
            <p className="text-white font-medium text-xs">{session.user.id}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
