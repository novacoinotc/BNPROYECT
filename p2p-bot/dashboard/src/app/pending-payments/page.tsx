'use client';

import { useState, useEffect, useCallback } from 'react';

interface PendingPayment {
  id: string;
  transactionId: string;
  amount: number;
  currency: string;
  senderName: string;
  senderAccount: string | null;
  bankReference: string | null;
  bankTimestamp: string;
  createdAt: string;
  status: string;
}

interface MatchableOrder {
  orderNumber: string;
  totalPrice: string;
  buyerNickName: string;
  buyerRealName: string | null;
  status: string;
  createdAt: string;
}

export default function PendingPaymentsPage() {
  const [payments, setPayments] = useState<PendingPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal states
  const [showMatchModal, setShowMatchModal] = useState(false);
  const [showResolveModal, setShowResolveModal] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState<PendingPayment | null>(null);
  const [matchableOrders, setMatchableOrders] = useState<MatchableOrder[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [resolveReason, setResolveReason] = useState('');

  const fetchPayments = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/pending-payments');
      const data = await response.json();

      if (data.success) {
        setPayments(data.payments);
      } else {
        setError(data.error || 'Error loading payments');
      }
    } catch (err: any) {
      setError(err.message || 'Connection error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPayments();
    // Refresh every 30 seconds
    const interval = setInterval(fetchPayments, 30000);
    return () => clearInterval(interval);
  }, [fetchPayments]);

  const openMatchModal = async (payment: PendingPayment) => {
    setSelectedPayment(payment);
    setShowMatchModal(true);
    setLoadingOrders(true);

    try {
      const response = await fetch(`/api/pending-payments/orders?amount=${payment.amount}`);
      const data = await response.json();
      if (data.success) {
        setMatchableOrders(data.orders);
      }
    } catch (err) {
      console.error('Error fetching orders:', err);
    } finally {
      setLoadingOrders(false);
    }
  };

  const handleMatch = async (orderNumber: string) => {
    if (!selectedPayment) return;

    try {
      const response = await fetch('/api/pending-payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transactionId: selectedPayment.transactionId,
          orderNumber,
          resolvedBy: 'Dashboard',
        }),
      });

      const data = await response.json();
      if (data.success) {
        setShowMatchModal(false);
        setSelectedPayment(null);
        fetchPayments();
      } else {
        alert(data.error || 'Error matching payment');
      }
    } catch (err: any) {
      alert(err.message || 'Error');
    }
  };

  const openResolveModal = (payment: PendingPayment) => {
    setSelectedPayment(payment);
    setResolveReason('');
    setShowResolveModal(true);
  };

  const handleResolve = async () => {
    if (!selectedPayment) return;

    try {
      const response = await fetch('/api/pending-payments', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transactionId: selectedPayment.transactionId,
          resolvedBy: 'Dashboard',
          reason: resolveReason || 'Resolved manually',
        }),
      });

      const data = await response.json();
      if (data.success) {
        setShowResolveModal(false);
        setSelectedPayment(null);
        fetchPayments();
      } else {
        alert(data.error || 'Error resolving payment');
      }
    } catch (err: any) {
      alert(err.message || 'Error');
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('es-MX', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Pagos Pendientes</h1>
          <p className="text-gray-400 text-sm mt-1">
            Pagos recibidos que no han sido vinculados a ninguna orden
          </p>
        </div>
        <button
          onClick={fetchPayments}
          className="px-4 py-2 bg-dark-hover text-gray-300 rounded-lg hover:bg-dark-border transition"
        >
          Actualizar
        </button>
      </div>

      {/* Info Card */}
      <div className="card p-4 border-l-4 border-l-amber-500">
        <div className="flex items-start gap-3">
          <span className="text-2xl">💳</span>
          <div>
            <h3 className="font-medium text-white">Pagos sin vincular</h3>
            <p className="text-sm text-gray-400 mt-1">
              Estos pagos no coincidieron automaticamente con ninguna orden (nombre diferente).
              Puedes <strong>vincular manualmente</strong> a una orden si es un pago de tercero valido,
              o <strong>marcar como resuelto</strong> si no corresponde a ninguna operacion.
            </p>
          </div>
        </div>
      </div>

      {/* Payments List */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-6 text-center">
            <div className="animate-spin h-8 w-8 border-2 border-primary-500 border-t-transparent rounded-full mx-auto"></div>
            <p className="text-gray-400 mt-2">Cargando...</p>
          </div>
        ) : error ? (
          <div className="p-6 text-center text-red-400">{error}</div>
        ) : payments.length === 0 ? (
          <div className="p-6 text-center text-gray-500">
            <span className="text-4xl block mb-2">✅</span>
            No hay pagos pendientes de vincular
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-dark-hover text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-4 py-3 text-left">Monto</th>
                <th className="px-4 py-3 text-left">Ordenante (SPEI)</th>
                <th className="px-4 py-3 text-left">Referencia</th>
                <th className="px-4 py-3 text-right">Recibido</th>
                <th className="px-4 py-3 text-center">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dark-border">
              {payments.map((payment) => (
                <tr key={payment.id} className="hover:bg-dark-hover transition">
                  <td className="px-4 py-3">
                    <span className="text-white font-medium text-lg">
                      ${payment.amount.toLocaleString()}
                    </span>
                    <span className="text-gray-500 ml-1 text-sm">{payment.currency}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-white">{payment.senderName}</div>
                    {payment.senderAccount && (
                      <div className="text-gray-500 text-xs">{payment.senderAccount}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-gray-400 text-sm font-mono">
                      {payment.transactionId.length > 20
                        ? `${payment.transactionId.substring(0, 20)}...`
                        : payment.transactionId}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400 text-sm">
                    {formatDate(payment.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <button
                        onClick={() => openMatchModal(payment)}
                        className="px-3 py-1 bg-primary-600 text-white text-sm rounded hover:bg-primary-700 transition"
                      >
                        Vincular
                      </button>
                      <button
                        onClick={() => openResolveModal(payment)}
                        className="px-3 py-1 bg-gray-600 text-white text-sm rounded hover:bg-gray-700 transition"
                      >
                        Ignorar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Match Modal */}
      {showMatchModal && selectedPayment && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setShowMatchModal(false)}
        >
          <div
            className="bg-dark-card rounded-xl p-6 w-full max-w-2xl border border-dark-border max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-4">
              Vincular Pago a Orden
            </h3>

            {/* Payment Info */}
            <div className="bg-dark-bg rounded-lg p-4 mb-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-gray-400 text-sm">Monto:</span>
                  <span className="text-white ml-2 font-medium">
                    ${selectedPayment.amount.toLocaleString()} {selectedPayment.currency}
                  </span>
                </div>
                <div>
                  <span className="text-gray-400 text-sm">Ordenante:</span>
                  <span className="text-white ml-2">{selectedPayment.senderName}</span>
                </div>
              </div>
            </div>

            {/* Matchable Orders */}
            <div className="mb-4">
              <h4 className="text-sm text-gray-400 mb-2">
                Ordenes con monto similar (±5%):
              </h4>

              {loadingOrders ? (
                <div className="text-center py-4">
                  <div className="animate-spin h-6 w-6 border-2 border-primary-500 border-t-transparent rounded-full mx-auto"></div>
                </div>
              ) : matchableOrders.length === 0 ? (
                <div className="text-center py-4 text-gray-500">
                  No se encontraron ordenes con monto similar
                </div>
              ) : (
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {matchableOrders.map((order) => (
                    <div
                      key={order.orderNumber}
                      className="bg-dark-hover rounded-lg p-3 flex items-center justify-between"
                    >
                      <div>
                        <div className="text-white font-medium">
                          ${parseFloat(order.totalPrice).toLocaleString()} MXN
                        </div>
                        <div className="text-gray-400 text-sm">
                          {order.buyerRealName || order.buyerNickName}
                        </div>
                        <div className="text-gray-500 text-xs">
                          {order.orderNumber.slice(-8)} • {formatDate(order.createdAt)}
                        </div>
                      </div>
                      <button
                        onClick={() => handleMatch(order.orderNumber)}
                        className="px-3 py-1 bg-emerald-600 text-white text-sm rounded hover:bg-emerald-700 transition"
                      >
                        Vincular
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Manual Order Number Input */}
            <div className="border-t border-dark-border pt-4">
              <h4 className="text-sm text-gray-400 mb-2">
                O ingresa el numero de orden manualmente:
              </h4>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Numero de orden (ej: 22845...)"
                  className="flex-1 bg-dark-bg text-white rounded-lg px-3 py-2 border border-dark-border focus:border-primary-500 focus:outline-none"
                  id="manualOrderInput"
                />
                <button
                  onClick={() => {
                    const input = document.getElementById('manualOrderInput') as HTMLInputElement;
                    if (input.value.trim()) {
                      handleMatch(input.value.trim());
                    }
                  }}
                  className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition"
                >
                  Vincular
                </button>
              </div>
            </div>

            <div className="flex justify-end mt-4">
              <button
                onClick={() => setShowMatchModal(false)}
                className="px-4 py-2 bg-dark-hover text-gray-300 rounded-lg hover:bg-dark-border transition"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Resolve Modal */}
      {showResolveModal && selectedPayment && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setShowResolveModal(false)}
        >
          <div
            className="bg-dark-card rounded-xl p-6 w-full max-w-md border border-dark-border"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-4">
              Marcar Pago como Resuelto
            </h3>

            <div className="bg-dark-bg rounded-lg p-4 mb-4">
              <div className="text-white font-medium">
                ${selectedPayment.amount.toLocaleString()} {selectedPayment.currency}
              </div>
              <div className="text-gray-400 text-sm">{selectedPayment.senderName}</div>
            </div>

            <div className="mb-4">
              <label className="block text-sm text-gray-400 mb-2">
                Razon (opcional):
              </label>
              <textarea
                value={resolveReason}
                onChange={(e) => setResolveReason(e.target.value)}
                placeholder="ej: Pago duplicado, devolucion, etc."
                rows={2}
                className="w-full bg-dark-bg text-white rounded-lg px-3 py-2 border border-dark-border focus:border-primary-500 focus:outline-none resize-none"
              />
            </div>

            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-4">
              <p className="text-amber-400 text-sm">
                Este pago sera marcado como ignorado y no se vinculara a ninguna orden.
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowResolveModal(false)}
                className="flex-1 px-4 py-2 bg-dark-hover text-gray-300 rounded-lg hover:bg-dark-border transition"
              >
                Cancelar
              </button>
              <button
                onClick={handleResolve}
                className="flex-1 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition"
              >
                Marcar Resuelto
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
