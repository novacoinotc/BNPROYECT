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

export default function AutoSpeiPage() {
  const [dispatches, setDispatches] = useState<BuyDispatch[]>([]);
  const [config, setConfig] = useState<BotConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [toggleLoading, setToggleLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
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

  const pendingDispatches = dispatches.filter((d) => d.status === 'PENDING_APPROVAL');
  const historyDispatches = dispatches.filter((d) => d.status !== 'PENDING_APPROVAL');
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
            {pendingDispatches.map((d) => (
              <div key={d.id} className="card p-4 space-y-3">
                {/* Amount + Status */}
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-2xl font-bold text-white">{formatAmount(d.amount)}</p>
                    <p className="text-xs text-gray-500 mt-0.5">Orden: {d.orderNumber.slice(-10)}</p>
                  </div>
                  {statusBadge(d.status)}
                </div>

                {/* Payment details */}
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Beneficiario</span>
                    <span className="text-white font-medium">{d.beneficiaryName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Cuenta</span>
                    <span className="text-white font-mono text-xs">{maskAccount(d.beneficiaryAccount)}</span>
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
            ))}
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
                    <div className="text-right">
                      {statusBadge(d.status)}
                      <p className="text-[10px] text-gray-600 mt-1">{formatDate(d.dispatchedAt || d.detectedAt)}</p>
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
