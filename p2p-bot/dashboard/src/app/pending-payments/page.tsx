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

  // Multi-select state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkResolveModal, setShowBulkResolveModal] = useState(false);
  const [bulkResolving, setBulkResolving] = useState(false);

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
      const response = await fetch('/api/pending-payments?status=THIRD_PARTY');
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

  // Clear selection when payments change
  useEffect(() => {
    setSelectedIds(new Set());
  }, [payments]);

  // Multi-select handlers
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === payments.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(payments.map(p => p.id)));
    }
  };

  const handleBulkResolve = async () => {
    if (selectedIds.size === 0) return;

    setBulkResolving(true);
    try {
      const transactionIds = payments
        .filter(p => selectedIds.has(p.id))
        .map(p => p.transactionId);

      const response = await fetch('/api/pending-payments', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transactionIds,
          resolvedBy: 'Dashboard',
          reason: 'Bulk discard',
        }),
      });

      const data = await response.json();
      if (data.success) {
        setShowBulkResolveModal(false);
        setSelectedIds(new Set());
        fetchPayments();
      } else {
        alert(data.error || 'Error al descartar pagos');
      }
    } catch (err: any) {
      alert(err.message || 'Error');
    } finally {
      setBulkResolving(false);
    }
  };

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
          <h1 className="text-2xl font-bold text-white">Pagos de Terceros</h1>
          <p className="text-gray-400 text-sm mt-1">
            Pagos recibidos que no coinciden con ningun comprador conocido
          </p>
        </div>
        <div className="flex items-center gap-3">
          {selectedIds.size > 0 && (
            <button
              onClick={() => setShowBulkResolveModal(true)}
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              Descartar ({selectedIds.size})
            </button>
          )}
          <button
            onClick={fetchPayments}
            className="px-4 py-2 bg-dark-hover text-gray-300 rounded-lg hover:bg-dark-border transition"
          >
            Actualizar
          </button>
        </div>
      </div>

      {/* Info Card */}
      <div className="card p-4 border-l-4 border-l-red-500">
        <div className="flex items-start gap-3">
          <span className="text-2xl">🚨</span>
          <div>
            <h3 className="font-medium text-white">Pagos de Terceros Detectados</h3>
            <p className="text-sm text-gray-400 mt-1">
              Estos pagos fueron recibidos de personas que <strong>no coinciden con ningun comprador</strong> conocido
              en ordenes abiertas. Podrian ser pagos de terceros no autorizados. Revisa cuidadosamente antes de vincular,
              o <strong>ignora</strong> si no corresponde a ninguna operacion.
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
            <span className="text-4xl block mb-2">🎉</span>
            No hay pagos de terceros detectados
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-dark-hover text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-4 py-3 text-center w-12">
                  <input
                    type="checkbox"
                    checked={payments.length > 0 && selectedIds.size === payments.length}
                    onChange={toggleSelectAll}
                    className="w-4 h-4 rounded border-gray-600 bg-dark-bg text-primary-600 focus:ring-primary-500 cursor-pointer"
                  />
                </th>
                <th className="px-4 py-3 text-left">Monto</th>
                <th className="px-4 py-3 text-left">Ordenante (SPEI)</th>
                <th className="px-4 py-3 text-left">Referencia</th>
                <th className="px-4 py-3 text-right">Recibido</th>
                <th className="px-4 py-3 text-center">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dark-border">
              {payments.map((payment) => (
                <tr
                  key={payment.id}
                  className={`hover:bg-dark-hover transition ${selectedIds.has(payment.id) ? 'bg-primary-500/10' : ''}`}
                >
                  <td className="px-4 py-3 text-center">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(payment.id)}
                      onChange={() => toggleSelect(payment.id)}
                      className="w-4 h-4 rounded border-gray-600 bg-dark-bg text-primary-600 focus:ring-primary-500 cursor-pointer"
                    />
                  </td>
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

      {/* Bulk Resolve Modal */}
      {showBulkResolveModal && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setShowBulkResolveModal(false)}
        >
          <div
            className="bg-dark-card rounded-xl p-6 w-full max-w-md border border-dark-border"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              Descartar Pagos Seleccionados
            </h3>

            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-4">
              <p className="text-red-400">
                Estas a punto de descartar <strong>{selectedIds.size} pago(s)</strong>.
              </p>
              <p className="text-red-400/80 text-sm mt-1">
                Estos pagos seran marcados como ignorados y no podran vincularse a ninguna orden.
              </p>
            </div>

            {/* Summary of selected payments */}
            <div className="bg-dark-bg rounded-lg p-3 mb-4 max-h-40 overflow-y-auto">
              <p className="text-gray-400 text-xs mb-2">Pagos seleccionados:</p>
              {payments
                .filter(p => selectedIds.has(p.id))
                .map(p => (
                  <div key={p.id} className="flex justify-between text-sm py-1 border-b border-dark-border last:border-0">
                    <span className="text-white">${p.amount.toLocaleString()}</span>
                    <span className="text-gray-500 truncate ml-2">{p.senderName}</span>
                  </div>
                ))}
              <div className="flex justify-between text-sm pt-2 mt-2 border-t border-dark-border font-medium">
                <span className="text-gray-400">Total:</span>
                <span className="text-white">
                  ${payments
                    .filter(p => selectedIds.has(p.id))
                    .reduce((sum, p) => sum + p.amount, 0)
                    .toLocaleString()} MXN
                </span>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowBulkResolveModal(false)}
                disabled={bulkResolving}
                className="flex-1 px-4 py-2 bg-dark-hover text-gray-300 rounded-lg hover:bg-dark-border transition disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleBulkResolve}
                disabled={bulkResolving}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {bulkResolving ? (
                  <>
                    <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"></div>
                    Procesando...
                  </>
                ) : (
                  <>Descartar {selectedIds.size} pago(s)</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
