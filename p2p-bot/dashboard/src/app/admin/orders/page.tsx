'use client';

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface Order {
  id: string;
  orderNumber: string;
  tradeType: string;
  asset: string;
  amount: string;
  totalPrice: string;
  unitPrice: string;
  status: string;
  buyerNickName: string;
  buyerRealName: string;
  verificationStatus: string;
  binanceCreateTime: string;
  paidAt: string;
  releasedAt: string;
  merchantId: string;
  merchantName: string;
  merchantNickname: string;
  payments: any[];
}

interface OrdersData {
  orders: Order[];
  total: number;
  statusCounts: Record<string, number>;
}

export default function AdminOrdersPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [data, setData] = useState<OrdersData | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [merchantFilter, setMerchantFilter] = useState('all');

  useEffect(() => {
    if (status === 'loading') return;
    if (!session?.user?.isAdmin) {
      router.push('/dashboard');
      return;
    }
    fetchOrders();
    const interval = setInterval(fetchOrders, 10000);
    return () => clearInterval(interval);
  }, [session, status, router, statusFilter, merchantFilter]);

  async function fetchOrders() {
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.append('status', statusFilter);
      if (merchantFilter !== 'all') params.append('merchantId', merchantFilter);
      params.append('limit', '100');

      const res = await fetch('/api/admin/orders?' + params.toString());
      const json = await res.json();
      if (json.success) {
        setData(json);
      }
    } catch (err) {
      console.error('Failed to fetch orders:', err);
    } finally {
      setLoading(false);
    }
  }

  if (status === 'loading' || loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-8">
        <div className="animate-pulse">Cargando ordenes...</div>
      </div>
    );
  }

  if (!session?.user?.isAdmin) return null;

  const formatCurrency = (v: string | number) => {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n);
  };

  const getStatusColor = (s: string) => {
    switch (s) {
      case 'COMPLETED': return 'bg-green-900 text-green-200';
      case 'PAID': return 'bg-yellow-900 text-yellow-200';
      case 'PENDING': return 'bg-blue-900 text-blue-200';
      case 'CANCELLED': case 'CANCELLED_SYSTEM': case 'CANCELLED_TIMEOUT': return 'bg-red-900 text-red-200';
      case 'APPEALING': return 'bg-orange-900 text-orange-200';
      default: return 'bg-gray-700 text-gray-300';
    }
  };

  const uniqueMerchants = data ? Array.from(new Set(data.orders.map(o => o.merchantName))).filter(Boolean) : [];

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-6">
          <div>
            <Link href="/admin" className="text-gray-400 hover:text-white text-sm mb-2 inline-block">
              ← Volver al panel
            </Link>
            <h1 className="text-2xl font-bold">Todas las Ordenes</h1>
            <p className="text-gray-400 text-sm">
              {data?.total || 0} ordenes en total
            </p>
          </div>
        </div>

        {/* Filters */}
        <div className="flex gap-4 mb-6">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white"
          >
            <option value="all">Todos los estados</option>
            <option value="PENDING">PENDING</option>
            <option value="PAID">PAID</option>
            <option value="COMPLETED">COMPLETED</option>
            <option value="CANCELLED">CANCELLED</option>
            <option value="APPEALING">APPEALING</option>
          </select>

          <select
            value={merchantFilter}
            onChange={(e) => setMerchantFilter(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white"
          >
            <option value="all">Todos los merchants</option>
            {uniqueMerchants.map((m) => (
              <option key={m} value={data?.orders.find(o => o.merchantName === m)?.merchantId}>
                {m}
              </option>
            ))}
          </select>

          <button
            onClick={fetchOrders}
            className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg"
          >
            Actualizar
          </button>
        </div>

        {/* Status Summary */}
        {data?.statusCounts && (
          <div className="flex gap-4 mb-6 flex-wrap">
            {Object.entries(data.statusCounts).map(([st, count]) => (
              <div key={st} className="bg-gray-800 rounded-lg px-4 py-2">
                <span className="text-gray-400 text-sm">{st}:</span>
                <span className="ml-2 font-bold">{count}</span>
              </div>
            ))}
          </div>
        )}

        {/* Orders Table */}
        <div className="bg-gray-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-700">
                <tr>
                  <th className="px-4 py-3 text-left text-sm">Merchant</th>
                  <th className="px-4 py-3 text-left text-sm">Orden</th>
                  <th className="px-4 py-3 text-left text-sm">Tipo</th>
                  <th className="px-4 py-3 text-left text-sm">Comprador</th>
                  <th className="px-4 py-3 text-left text-sm">Monto</th>
                  <th className="px-4 py-3 text-left text-sm">Estado</th>
                  <th className="px-4 py-3 text-left text-sm">Verificacion</th>
                  <th className="px-4 py-3 text-left text-sm">Fecha</th>
                </tr>
              </thead>
              <tbody>
                {data?.orders.map((order) => (
                  <tr key={order.id} className="border-t border-gray-700 hover:bg-gray-750">
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium">{order.merchantName || 'N/A'}</div>
                      <div className="text-xs text-gray-500">{order.merchantNickname}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs">{order.orderNumber}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={order.tradeType === 'SELL' ? 'text-green-400' : 'text-blue-400'}>
                        {order.tradeType}
                      </span>
                      <span className="ml-1 text-gray-400">{order.asset}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-sm">{order.buyerNickName}</div>
                      {order.buyerRealName && (
                        <div className="text-xs text-gray-500">{order.buyerRealName}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{formatCurrency(order.totalPrice)}</div>
                      <div className="text-xs text-gray-500">{parseFloat(order.amount).toFixed(2)} {order.asset}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={'px-2 py-1 rounded text-xs ' + getStatusColor(order.status)}>
                        {order.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-gray-400">{order.verificationStatus || '-'}</span>
                      {order.payments?.length > 0 && (
                        <div className="text-xs text-green-400">
                          {order.payments.length} pago(s)
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-400">
                      {new Date(order.binanceCreateTime).toLocaleString('es-MX')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {data?.orders.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            No hay ordenes con los filtros seleccionados
          </div>
        )}
      </div>
    </div>
  );
}
