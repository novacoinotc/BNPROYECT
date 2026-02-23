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
    const interval = setInterval(fetchPayments, 30000);
    return () => clearInterval(interval);
  }, [fetchPayments]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [payments]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) { newSet.delete(id); } else { newSet.add(id); }
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
      const transactionIds = payments.filter(p => selectedIds.has(p.id)).map(p => p.transactionId);
      const response = await fetch('/api/pending-payments', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionIds, resolvedBy: 'Dashboard', reason: 'Bulk discard' }),
      });
      const data = await response.json();
      if (data.success) { setShowBulkResolveModal(false); setSelectedIds(new Set()); fetchPayments(); }
      else { alert(data.error || 'Error al descartar pagos'); }
    } catch (err: any) { alert(err.message || 'Error'); } finally { setBulkResolving(false); }
  };

  const openMatchModal = async (payment: PendingPayment) => {
    setSelectedPayment(payment);
    setShowMatchModal(true);
    setLoadingOrders(true);
    try {
      const response = await fetch(`/api/pending-payments/orders?amount=${payment.amount}`);
      const data = await response.json();
      if (data.success) { setMatchableOrders(data.orders); }
    } catch (err) { console.error('Error fetching orders:', err); } finally { setLoadingOrders(false); }
  };

  const handleMatch = async (orderNumber: string) => {
    if (!selectedPayment) return;
    try {
      const response = await fetch('/api/pending-payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionId: selectedPayment.transactionId, orderNumber, resolvedBy: 'Dashboard' }),
      });
      const data = await response.json();
      if (data.success) { setShowMatchModal(false); setSelectedPayment(null); fetchPayments(); }
      else { alert(data.error || 'Error matching payment'); }
    } catch (err: any) { alert(err.message || 'Error'); }
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
        body: JSON.stringify({ transactionId: selectedPayment.transactionId, resolvedBy: 'Dashboard', reason: resolveReason || 'Resolved manually' }),
      });
      const data = await response.json();
      if (data.success) { setShowResolveModal(false); setSelectedPayment(null); fetchPayments(); }
      else { alert(data.error || 'Error resolving payment'); }
    } catch (err: any) { alert(err.message || 'Error'); }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('es-MX', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="card">
        <div className="px-4 pt-3 pb-3 flex items-center justify-between">
          <h1 className="text-lg font-bold text-white">Pagos Terceros</h1>
          <div className="flex items-center gap-2">
            {selectedIds.size > 0 && (
              <button
                onClick={() => setShowBulkResolveModal(true)}
                className="px-3 py-1.5 bg-red-600 text-white text-xs rounded-lg hover:bg-red-700 transition font-medium"
              >Descartar ({selectedIds.size})</button>
            )}
            <button
              onClick={fetchPayments}
              className="px-3 py-1.5 bg-[#2d2640] text-gray-300 text-xs rounded-lg hover:text-white hover:bg-[#3d3655] transition font-medium"
            >Actualizar</button>
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-primary-500"></div>
          </div>
        ) : error ? (
          <div className="p-6 text-center text-red-400">{error}</div>
        ) : payments.length === 0 ? (
          <div className="p-6 text-center text-gray-500">No hay pagos de terceros pendientes</div>
        ) : (
          <>
            {/* Mobile card layout */}
            <div className="sm:hidden divide-y divide-dark-border">
              {payments.map((payment) => (
                <div
                  key={payment.id}
                  className={`p-3 ${selectedIds.has(payment.id) ? 'bg-primary-500/10' : ''}`}
                >
                  <div className="flex items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(payment.id)}
                      onChange={() => toggleSelect(payment.id)}
                      className="w-4 h-4 mt-0.5 rounded border-gray-600 bg-dark-bg text-primary-600 focus:ring-primary-500 cursor-pointer"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-start">
                        <span className="text-white font-medium text-sm">${payment.amount.toLocaleString()} <span className="text-gray-500 text-xs">{payment.currency}</span></span>
                        <span className="text-xs text-gray-500 ml-2">{formatDate(payment.createdAt)}</span>
                      </div>
                      <p className="text-sm text-gray-400 mt-0.5 truncate">{payment.senderName}</p>
                      <div className="flex gap-3 mt-2">
                        <button onClick={() => openMatchModal(payment)} className="text-primary-400 text-xs font-medium">Vincular</button>
                        <button onClick={() => openResolveModal(payment)} className="text-gray-400 text-xs">Ignorar</button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              {payments.length > 1 && (
                <div className="p-3 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === payments.length}
                    onChange={toggleSelectAll}
                    className="w-4 h-4 rounded border-gray-600 bg-dark-bg text-primary-600 focus:ring-primary-500 cursor-pointer"
                  />
                  <span className="text-xs text-gray-500">Seleccionar todos</span>
                </div>
              )}
            </div>

            {/* Desktop table - simplified: 4 columns */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full">
                <thead className="bg-dark-hover text-gray-400 text-xs uppercase">
                  <tr>
                    <th className="px-4 py-3 text-center w-10">
                      <input
                        type="checkbox"
                        checked={payments.length > 0 && selectedIds.size === payments.length}
                        onChange={toggleSelectAll}
                        className="w-3.5 h-3.5 rounded border-gray-600 bg-dark-bg text-primary-600 focus:ring-primary-500 cursor-pointer"
                      />
                    </th>
                    <th className="px-4 py-3 text-left">Pago</th>
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
                          className="w-3.5 h-3.5 rounded border-gray-600 bg-dark-bg text-primary-600 focus:ring-primary-500 cursor-pointer"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-baseline gap-2">
                          <span className="text-white font-medium">${payment.amount.toLocaleString()}</span>
                          <span className="text-gray-500 text-xs">{payment.currency}</span>
                        </div>
                        <p className="text-sm text-gray-400">{payment.senderName}</p>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-400 text-sm">
                        {formatDate(payment.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <div className="flex items-center justify-center gap-3">
                          <button onClick={() => openMatchModal(payment)} className="text-primary-400 hover:text-primary-300 text-sm">Vincular</button>
                          <button onClick={() => openResolveModal(payment)} className="text-gray-400 hover:text-gray-300 text-sm">Ignorar</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Match Modal */}
      {showMatchModal && selectedPayment && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50" onClick={() => setShowMatchModal(false)}>
          <div className="bg-dark-card rounded-t-xl sm:rounded-xl p-5 w-full sm:max-w-lg border border-dark-border max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-3">Vincular Pago</h3>

            <div className="bg-dark-bg rounded-lg p-3 mb-3 flex justify-between items-center">
              <div>
                <span className="text-white font-medium">${selectedPayment.amount.toLocaleString()} {selectedPayment.currency}</span>
                <p className="text-gray-400 text-sm">{selectedPayment.senderName}</p>
              </div>
            </div>

            <p className="text-xs text-gray-500 mb-2">Ordenes con monto similar:</p>
            {loadingOrders ? (
              <div className="flex items-center justify-center py-6">
                <div className="animate-spin h-6 w-6 border-2 border-primary-500 border-t-transparent rounded-full"></div>
              </div>
            ) : matchableOrders.length === 0 ? (
              <div className="text-center py-4 text-gray-500 text-sm">Sin ordenes similares</div>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto mb-3">
                {matchableOrders.map((order) => (
                  <div key={order.orderNumber} className="bg-dark-hover rounded-lg p-3 flex items-center justify-between">
                    <div>
                      <span className="text-white font-medium text-sm">${parseFloat(order.totalPrice).toLocaleString()}</span>
                      <span className="text-gray-500 text-xs ml-2">{order.buyerRealName || order.buyerNickName}</span>
                    </div>
                    <button onClick={() => handleMatch(order.orderNumber)} className="px-2.5 py-1 bg-emerald-600 text-white text-xs rounded hover:bg-emerald-700 transition">Vincular</button>
                  </div>
                ))}
              </div>
            )}

            <div className="border-t border-dark-border pt-3">
              <p className="text-xs text-gray-500 mb-2">O ingresa orden manualmente:</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Numero de orden..."
                  className="flex-1 bg-dark-bg text-white rounded-lg px-3 py-2 border border-dark-border focus:border-primary-500 focus:outline-none text-base"
                  id="manualOrderInput"
                />
                <button
                  onClick={() => {
                    const input = document.getElementById('manualOrderInput') as HTMLInputElement;
                    if (input.value.trim()) { handleMatch(input.value.trim()); }
                  }}
                  className="px-3 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition text-sm"
                >Vincular</button>
              </div>
            </div>

            <button onClick={() => setShowMatchModal(false)} className="w-full mt-3 px-4 py-2.5 bg-dark-hover text-gray-300 rounded-lg hover:bg-dark-border transition">Cancelar</button>
          </div>
        </div>
      )}

      {/* Resolve Modal */}
      {showResolveModal && selectedPayment && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50" onClick={() => setShowResolveModal(false)}>
          <div className="bg-dark-card rounded-t-xl sm:rounded-xl p-5 w-full sm:max-w-md border border-dark-border" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-3">Ignorar Pago</h3>

            <div className="bg-dark-bg rounded-lg p-3 mb-3">
              <span className="text-white font-medium">${selectedPayment.amount.toLocaleString()} {selectedPayment.currency}</span>
              <p className="text-gray-400 text-sm">{selectedPayment.senderName}</p>
            </div>

            <div className="mb-3">
              <label className="block text-sm text-gray-400 mb-1">Razon (opcional):</label>
              <input
                type="text"
                value={resolveReason}
                onChange={(e) => setResolveReason(e.target.value)}
                placeholder="ej: Pago duplicado, devolucion..."
                className="w-full bg-dark-bg text-white rounded-lg px-3 py-2 border border-dark-border focus:border-primary-500 focus:outline-none text-base"
              />
            </div>

            <div className="flex gap-3">
              <button onClick={() => setShowResolveModal(false)} className="flex-1 px-4 py-2.5 bg-dark-hover text-gray-300 rounded-lg hover:bg-dark-border transition">Cancelar</button>
              <button onClick={handleResolve} className="flex-1 px-4 py-2.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition">Ignorar</button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Resolve Modal */}
      {showBulkResolveModal && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50" onClick={() => setShowBulkResolveModal(false)}>
          <div className="bg-dark-card rounded-t-xl sm:rounded-xl p-5 w-full sm:max-w-md border border-dark-border" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-3">Descartar {selectedIds.size} pago(s)</h3>

            <div className="bg-dark-bg rounded-lg p-3 mb-3 max-h-40 overflow-y-auto">
              {payments.filter(p => selectedIds.has(p.id)).map(p => (
                <div key={p.id} className="flex justify-between text-sm py-1 border-b border-dark-border last:border-0">
                  <span className="text-white">${p.amount.toLocaleString()}</span>
                  <span className="text-gray-500 truncate ml-2">{p.senderName}</span>
                </div>
              ))}
              <div className="flex justify-between text-sm pt-2 mt-1 border-t border-dark-border font-medium">
                <span className="text-gray-400">Total:</span>
                <span className="text-white">
                  ${payments.filter(p => selectedIds.has(p.id)).reduce((sum, p) => sum + p.amount, 0).toLocaleString()} MXN
                </span>
              </div>
            </div>

            <p className="text-xs text-red-400 mb-3">Seran marcados como ignorados permanentemente.</p>

            <div className="flex gap-3">
              <button onClick={() => setShowBulkResolveModal(false)} disabled={bulkResolving} className="flex-1 px-4 py-2.5 bg-dark-hover text-gray-300 rounded-lg hover:bg-dark-border transition disabled:opacity-50">Cancelar</button>
              <button onClick={handleBulkResolve} disabled={bulkResolving} className="flex-1 px-4 py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 transition disabled:opacity-50">
                {bulkResolving ? 'Procesando...' : `Descartar (${selectedIds.size})`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
