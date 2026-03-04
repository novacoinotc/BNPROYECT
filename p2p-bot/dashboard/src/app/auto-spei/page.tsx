'use client';

import { useState, useEffect, useCallback } from 'react';

interface BuyDispatch {
  id: string;
  orderNumber: string;
  status: string;
  amount: number;
  beneficiaryName: string;
  beneficiaryAccount: string;
  bankName: string | null;
  sellerNick: string | null;
  selectedPayId: number;
  trackingKey: string | null;
  transactionId: string | null;
  error: string | null;
  detectedAt: string;
  approvedAt: string | null;
  dispatchedAt: string | null;
  approvedBy: string | null;
  transferStatus: string | null;
}

interface BotConfig {
  autoBuyAutoDispatch?: boolean;
  [key: string]: any;
}

function maskAccount(account: string): string {
  if (!account || account === 'N/A') return account;
  if (account.length <= 4) return account;
  return '*'.repeat(account.length - 4) + account.slice(-4);
}

function formatAmount(amount: number): string {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(amount);
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function statusBadge(status: string) {
  const styles: Record<string, string> = {
    PENDING_APPROVAL: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
    DISPATCHING: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
    COMPLETED: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30',
    FAILED: 'bg-red-500/20 text-red-400 border border-red-500/30',
    REJECTED: 'bg-gray-500/20 text-gray-400 border border-gray-500/30',
  };
  const labels: Record<string, string> = {
    PENDING_APPROVAL: 'Pendiente',
    DISPATCHING: 'Enviando...',
    COMPLETED: 'Completada',
    FAILED: 'Fallida',
    REJECTED: 'Rechazada',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] || 'bg-gray-700 text-gray-300'}`}>
      {labels[status] || status}
    </span>
  );
}

function transferStatusBadge(transferStatus: string | null) {
  if (!transferStatus) return null;
  const styles: Record<string, string> = {
    sent: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
    scattered: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30',
    canceled: 'bg-orange-500/20 text-orange-400 border border-orange-500/30',
    failed: 'bg-red-500/20 text-red-400 border border-red-500/30',
    returned: 'bg-red-500/20 text-red-400 border border-red-500/30',
  };
  const labels: Record<string, string> = {
    sent: 'SPEI Enviado',
    scattered: 'SPEI Liquidado',
    canceled: 'SPEI Cancelado',
    failed: 'SPEI Rechazado',
    returned: 'SPEI Devuelto',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${styles[transferStatus] || 'bg-gray-700 text-gray-300'}`}>
      {labels[transferStatus] || transferStatus}
    </span>
  );
}

export default function AutoSpeiPage() {
  const [dispatches, setDispatches] = useState<BuyDispatch[]>([]);
  const [config, setConfig] = useState<BotConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [toggleLoading, setToggleLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showConflicts, setShowConflicts] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const fetchDispatches = useCallback(async () => {
    try {
      const response = await fetch('/api/auto-buy/dispatches');
      const data = await response.json();
      if (data.success) {
        setDispatches(data.dispatches || []);
      }
    } catch {
      // Silent refresh error
    }
  }, []);

  const fetchConfig = useCallback(async () => {
    try {
      const response = await fetch('/api/bot-control');
      const data = await response.json();
      if (data.success) {
        setConfig(data.config);
      }
    } catch {
      // Silent
    }
  }, []);

  // Initial load
  useEffect(() => {
    Promise.all([fetchDispatches(), fetchConfig()]).finally(() => setLoading(false));
  }, [fetchDispatches, fetchConfig]);

  // Auto-refresh every 5 seconds
  useEffect(() => {
    const interval = setInterval(fetchDispatches, 5000);
    return () => clearInterval(interval);
  }, [fetchDispatches]);

  const toggleAutoDispatch = async () => {
    setToggleLoading(true);
    try {
      const newValue = !config?.autoBuyAutoDispatch;
      const response = await fetch('/api/bot-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoBuyAutoDispatch: newValue }),
      });
      const data = await response.json();
      if (data.success) {
        setConfig((prev) => ({ ...prev, autoBuyAutoDispatch: newValue }));
        setSuccessMsg(newValue ? 'Auto-dispersion activada' : 'Auto-dispersion desactivada');
        setTimeout(() => setSuccessMsg(null), 3000);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setToggleLoading(false);
    }
  };

  const approveDispatch = async (id: string) => {
    setActionLoading(id);
    setError(null);
    try {
      const response = await fetch(`/api/auto-buy/dispatches/${id}/approve`, { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        setSuccessMsg('SPEI enviado correctamente');
        setTimeout(() => setSuccessMsg(null), 5000);
        await fetchDispatches();
      } else {
        setError(data.error || 'Error al aprobar');
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActionLoading(null);
    }
  };

  const rejectDispatch = async (id: string) => {
    setActionLoading(id + '-reject');
    setError(null);
    try {
      const response = await fetch(`/api/auto-buy/dispatches/${id}/reject`, { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        await fetchDispatches();
      } else {
        setError(data.error || 'Error al rechazar');
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActionLoading(null);
    }
  };

  const retryDispatch = async (id: string) => {
    if (!confirm('Verifica con administrador que tu pago no se haya enviado para evitar duplicados.\n\n¿Deseas continuar con el reintento?')) {
      return;
    }
    setActionLoading(id + '-retry');
    setError(null);
    try {
      const response = await fetch(`/api/auto-buy/dispatches/${id}/retry`, { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        setSuccessMsg('SPEI reenviado correctamente');
        setTimeout(() => setSuccessMsg(null), 5000);
        await fetchDispatches();
      } else {
        setError(data.error || 'Error al reintentar');
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActionLoading(null);
    }
  };

  const rescanChat = async (id: string) => {
    setActionLoading(id + '-rescan');
    setError(null);
    try {
      const response = await fetch(`/api/auto-buy/dispatches/${id}/rescan-chat`, { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        setSuccessMsg('CLABE encontrada en chat, SPEI enviado');
        setTimeout(() => setSuccessMsg(null), 5000);
        await fetchDispatches();
      } else {
        setError(data.error || 'No se encontro CLABE en el chat');
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActionLoading(null);
    }
  };

  // Conflict transfers: bank transfer issues (returned/failed/canceled) OR bot dispatch failed (no CLABE, SPEI error, etc.)
  const conflictDispatches = dispatches.filter(
    (d) =>
      (d.transferStatus && ['returned', 'failed', 'canceled'].includes(d.transferStatus)) ||
      d.status === 'FAILED'
  );

  // Pending approval: manual dispatches waiting for authorization
  const pendingDispatches = dispatches.filter((d) => d.status === 'PENDING_APPROVAL');

  // History: everything else (excluding conflicts and pending)
  const historyDispatches = dispatches.filter(
    (d) => d.status !== 'PENDING_APPROVAL' && d.status !== 'FAILED' &&
      !(d.transferStatus && ['returned', 'failed', 'canceled'].includes(d.transferStatus))
  );

  const autoMode = config?.autoBuyAutoDispatch ?? false;

  if (loading) {
    return (
      <div className="p-4 max-w-2xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-700 rounded w-1/3" />
          <div className="h-20 bg-gray-700 rounded" />
          <div className="h-32 bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4 pb-24">
      {/* Header */}
      <h1 className="text-xl font-bold text-white">Auto-SPEI</h1>

      {/* Auto-dispatch toggle */}
      <div className="card p-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-white">Auto-dispersion</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {autoMode
                ? 'Automatico — se dispersa al detectar orden'
                : 'Manual — cada dispersion requiere tu aprobacion'}
            </p>
          </div>
          <button
            onClick={toggleAutoDispatch}
            disabled={toggleLoading}
            className={`px-6 py-3 rounded-xl font-bold text-lg transition ${
              autoMode
                ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/30'
                : 'bg-gray-600 text-gray-300'
            } ${toggleLoading ? 'opacity-50' : ''}`}
          >
            {toggleLoading ? '...' : autoMode ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {/* Messages */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}
      {successMsg && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 px-4 py-3 rounded-lg text-sm">
          {successMsg}
        </div>
      )}

      {/* Conflict transfers */}
      {conflictDispatches.length > 0 && (
        <div>
          <button
            onClick={() => setShowConflicts(!showConflicts)}
            className="w-full text-left text-sm font-semibold text-red-400 uppercase tracking-wider flex items-center gap-2 mb-2"
          >
            <span className={`transition-transform ${showConflicts ? 'rotate-90' : ''}`}>&#9654;</span>
            Transferencias en conflicto ({conflictDispatches.length})
          </button>

          {showConflicts && (
            <div className="space-y-3">
              {conflictDispatches.map((d) => (
                <div key={d.id} className="border border-red-500/30 bg-red-500/5 rounded-xl p-4 space-y-3">
                  {/* Amount + Status */}
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-2xl font-bold text-white">{formatAmount(d.amount)}</p>
                      <p className="text-xs text-gray-500 mt-0.5">Orden: {d.orderNumber.slice(-10)}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      {statusBadge(d.status)}
                      {transferStatusBadge(d.transferStatus)}
                    </div>
                  </div>

                  {/* Conflict reason */}
                  <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                    <p className="text-xs text-red-300 font-medium">
                      {d.transferStatus === 'returned' && 'La transferencia fue devuelta por el banco receptor (limite excedido, cuenta invalida, etc.)'}
                      {d.transferStatus === 'failed' && 'La transferencia fue rechazada por el sistema bancario'}
                      {d.transferStatus === 'canceled' && 'La transferencia fue cancelada por OPM/Banxico'}
                      {d.status === 'FAILED' && !d.transferStatus && (
                        d.error || 'Error en el envio del SPEI'
                      )}
                    </p>
                  </div>

                  {/* Payment details */}
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Beneficiario</span>
                      <span className="text-white font-medium">{d.beneficiaryName}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Cuenta</span>
                      <span className="text-white font-mono text-xs">{d.beneficiaryAccount}</span>
                    </div>
                    {d.bankName && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">Banco</span>
                        <span className="text-white">{d.bankName}</span>
                      </div>
                    )}
                    {d.trackingKey && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">Tracking</span>
                        <span className="text-gray-400 font-mono text-xs">{d.trackingKey}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-gray-500">Enviada</span>
                      <span className="text-gray-400 text-xs">{formatDate(d.dispatchedAt)}</span>
                    </div>
                  </div>

                  {d.error && (
                    <p className="text-xs text-red-400">{d.error}</p>
                  )}

                  {/* Actions for conflicts */}
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => retryDispatch(d.id)}
                      disabled={actionLoading === d.id + '-retry'}
                      className="flex-1 py-2 bg-yellow-600/20 hover:bg-yellow-600/40 text-yellow-400 text-sm font-bold rounded-lg transition border border-yellow-600/30 disabled:opacity-50"
                    >
                      {actionLoading === d.id + '-retry' ? 'Reintentando...' : 'Reintentar envio'}
                    </button>
                    <button
                      onClick={() => rescanChat(d.id)}
                      disabled={actionLoading === d.id + '-rescan'}
                      className="flex-1 py-2 bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 text-sm font-bold rounded-lg transition border border-blue-600/30 disabled:opacity-50"
                    >
                      {actionLoading === d.id + '-rescan' ? 'Buscando...' : 'Buscar CLABE en chat'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Pending dispatches */}
      <div>
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-2">
          Pendientes de aprobacion ({pendingDispatches.length})
        </h2>

        {pendingDispatches.length === 0 ? (
          <div className="card p-6 text-center text-gray-500 text-sm">
            {autoMode
              ? 'En modo automatico, las dispersiones se procesan al instante'
              : 'No hay dispersiones pendientes'}
          </div>
        ) : (
          <div className="space-y-3">
            {pendingDispatches.map((d) => {
              const isHighAmount = d.amount > 120000;
              return (
                <div key={d.id} className={`card p-4 space-y-3 ${isHighAmount ? 'border border-orange-500/30' : ''}`}>
                  {/* High amount badge */}
                  {isHighAmount && (
                    <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-1.5">
                      <p className="text-xs text-orange-400 font-medium">
                        Monto mayor a $120,000 — requiere autorizacion manual
                      </p>
                    </div>
                  )}

                  {/* Amount + Status */}
                  <div className="flex items-start justify-between">
                    <div>
                      <p className={`text-2xl font-bold ${isHighAmount ? 'text-orange-400' : 'text-white'}`}>{formatAmount(d.amount)}</p>
                      <p className="text-xs text-gray-500 mt-0.5">Orden: {d.orderNumber.slice(-10)}</p>
                    </div>
                    {statusBadge(d.status)}
                  </div>

                  {/* Payment details — always visible for pending */}
                  <div className="bg-gray-800/50 rounded-lg px-3 py-2 space-y-1.5">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Datos obtenidos</p>
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between">
                        <span className="text-gray-500">Beneficiario</span>
                        <span className="text-white font-medium">{d.beneficiaryName}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Cuenta</span>
                        <span className="text-white font-mono text-xs">{d.beneficiaryAccount}</span>
                      </div>
                      {d.bankName && (
                        <div className="flex justify-between">
                          <span className="text-gray-500">Banco</span>
                          <span className="text-white">{d.bankName}</span>
                        </div>
                      )}
                      {d.sellerNick && (
                        <div className="flex justify-between">
                          <span className="text-gray-500">Vendedor</span>
                          <span className="text-white">{d.sellerNick}</span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span className="text-gray-500">Detectada</span>
                        <span className="text-gray-400 text-xs">{formatDate(d.detectedAt)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => approveDispatch(d.id)}
                      disabled={actionLoading === d.id}
                      className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg transition disabled:opacity-50"
                    >
                      {actionLoading === d.id ? 'Enviando SPEI...' : 'Autorizar'}
                    </button>
                    <button
                      onClick={() => rejectDispatch(d.id)}
                      disabled={actionLoading === d.id + '-reject'}
                      className="px-4 py-2.5 bg-red-600/20 hover:bg-red-600/40 text-red-400 font-bold rounded-lg transition border border-red-600/30 disabled:opacity-50"
                    >
                      {actionLoading === d.id + '-reject' ? '...' : 'Rechazar'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* History */}
      {historyDispatches.length > 0 && (
        <div>
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="w-full text-left text-sm font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2"
          >
            <span className={`transition-transform ${showHistory ? 'rotate-90' : ''}`}>&#9654;</span>
            Historial ({historyDispatches.length})
          </button>

          {showHistory && (
            <div className="space-y-2 mt-2">
              {historyDispatches.map((d) => (
                <div key={d.id} className="card p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-white font-bold">{formatAmount(d.amount)}</p>
                      <p className="text-xs text-gray-500">{d.beneficiaryName}</p>
                    </div>
                    <div className="text-right flex flex-col items-end gap-1">
                      {statusBadge(d.status)}
                      {transferStatusBadge(d.transferStatus)}
                      <p className="text-[10px] text-gray-600 mt-0.5">{formatDate(d.dispatchedAt || d.detectedAt)}</p>
                    </div>
                  </div>
                  {d.trackingKey && (
                    <p className="text-[10px] text-gray-600 mt-1 font-mono">TK: {d.trackingKey}</p>
                  )}
                  {d.error && (
                    <p className="text-xs text-red-400 mt-1">{d.error}</p>
                  )}
                  {d.status === 'FAILED' && (
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={() => rescanChat(d.id)}
                        disabled={actionLoading === d.id + '-rescan'}
                        className="flex-1 py-1.5 bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 text-xs font-bold rounded-lg transition border border-blue-600/30 disabled:opacity-50"
                      >
                        {actionLoading === d.id + '-rescan' ? 'Buscando...' : 'Buscar en chat'}
                      </button>
                      <button
                        onClick={() => retryDispatch(d.id)}
                        disabled={actionLoading === d.id + '-retry'}
                        className="flex-1 py-1.5 bg-yellow-600/20 hover:bg-yellow-600/40 text-yellow-400 text-xs font-bold rounded-lg transition border border-yellow-600/30 disabled:opacity-50"
                      >
                        {actionLoading === d.id + '-retry' ? 'Reintentando...' : 'Reintentar'}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
