'use client';

import { useState, useEffect, useCallback } from 'react';

interface TrustedBuyer {
  id: string;
  counterPartNickName: string;
  realName: string | null;
  verifiedAt: string;
  verifiedBy: string | null;
  notes: string | null;
  ordersAutoReleased: number;
  totalAmountReleased: string;
  lastAutoReleaseAt: string | null;
  isActive: boolean;
}

export default function TrustedBuyersPage() {
  const [trustedBuyers, setTrustedBuyers] = useState<TrustedBuyer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const fetchTrustedBuyers = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/trusted-buyers?includeInactive=${showInactive}`);
      const data = await response.json();

      if (data.success) {
        setTrustedBuyers(data.trustedBuyers);
      } else {
        setError(data.error || 'Error loading trusted buyers');
      }
    } catch (err: any) {
      setError(err.message || 'Connection error');
    } finally {
      setLoading(false);
    }
  }, [showInactive]);

  useEffect(() => {
    fetchTrustedBuyers();
  }, [fetchTrustedBuyers]);

  const handleRemove = async (counterPartNickName: string) => {
    if (!confirm(`Remove "${counterPartNickName}" from trusted list?`)) return;

    try {
      const response = await fetch('/api/trusted-buyers', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ counterPartNickName }),
      });

      const data = await response.json();
      if (data.success) {
        fetchTrustedBuyers();
      } else {
        alert(data.error || 'Failed to remove');
      }
    } catch (err: any) {
      alert(err.message || 'Error');
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Compradores Confiables</h1>
          <p className="text-gray-400 text-sm mt-1">
            Compradores verificados manualmente para auto-release sin risk check
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-400">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="rounded bg-dark-card border-dark-border"
            />
            Mostrar inactivos
          </label>
          <button
            onClick={() => setShowAddModal(true)}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition font-medium"
          >
            + Agregar
          </button>
        </div>
      </div>

      {/* Info Card */}
      <div className="card p-4 border-l-4 border-l-primary-500">
        <div className="flex items-start gap-3">
          <span className="text-2xl">⭐</span>
          <div>
            <h3 className="font-medium text-white">Compradores de confianza</h3>
            <p className="text-sm text-gray-400 mt-1">
              Los compradores en esta lista <strong>omiten la verificacion de historial</strong> (risk check)
              pero <strong>siempre requieren</strong> coincidencia de nombre entre cuenta Binance y pago bancario.
              El limite maximo de auto-release sigue aplicando.
            </p>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-6 text-center">
            <div className="animate-spin h-8 w-8 border-2 border-primary-500 border-t-transparent rounded-full mx-auto"></div>
            <p className="text-gray-400 mt-2">Cargando...</p>
          </div>
        ) : error ? (
          <div className="p-6 text-center text-red-400">{error}</div>
        ) : trustedBuyers.length === 0 ? (
          <div className="p-6 text-center text-gray-500">
            No hay compradores confiables registrados
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-dark-hover text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-4 py-3 text-left">Nickname</th>
                <th className="px-4 py-3 text-left">Nombre Real</th>
                <th className="px-4 py-3 text-center">Auto-releases</th>
                <th className="px-4 py-3 text-right">Monto Total</th>
                <th className="px-4 py-3 text-center">Estado</th>
                <th className="px-4 py-3 text-right">Verificado</th>
                <th className="px-4 py-3 text-center">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dark-border">
              {trustedBuyers.map((buyer) => (
                <tr
                  key={buyer.id}
                  className={`hover:bg-dark-hover transition ${!buyer.isActive ? 'opacity-50' : ''}`}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">⭐</span>
                      <span className="text-white font-medium">{buyer.counterPartNickName}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-300">
                    {buyer.realName || <span className="text-gray-500">-</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className="text-primary-400 font-medium">{buyer.ordersAutoReleased}</span>
                  </td>
                  <td className="px-4 py-3 text-right text-white">
                    ${parseFloat(buyer.totalAmountReleased || '0').toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`px-2 py-1 rounded text-xs font-medium ${
                        buyer.isActive
                          ? 'bg-emerald-500/20 text-emerald-400'
                          : 'bg-gray-500/20 text-gray-500'
                      }`}
                    >
                      {buyer.isActive ? 'Activo' : 'Inactivo'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400 text-sm">
                    {new Date(buyer.verifiedAt).toLocaleDateString()}
                    {buyer.verifiedBy && (
                      <span className="text-gray-500 ml-1">por {buyer.verifiedBy}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {buyer.isActive && (
                      <button
                        onClick={() => handleRemove(buyer.counterPartNickName)}
                        className="text-red-400 hover:text-red-300 text-sm"
                      >
                        Remover
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Modal */}
      {showAddModal && (
        <AddTrustedBuyerModal
          onClose={() => setShowAddModal(false)}
          onSuccess={() => {
            setShowAddModal(false);
            fetchTrustedBuyers();
          }}
        />
      )}
    </div>
  );
}

// Add Modal Component
function AddTrustedBuyerModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [nickname, setNickname] = useState('');
  const [realName, setRealName] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nickname.trim()) {
      setError('Nickname es requerido');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/trusted-buyers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          counterPartNickName: nickname.trim(),
          realName: realName.trim() || null,
          notes: notes.trim() || null,
          verifiedBy: 'Dashboard',
        }),
      });

      const data = await response.json();
      if (data.success) {
        onSuccess();
      } else {
        setError(data.error || 'Error al agregar');
      }
    } catch (err: any) {
      setError(err.message || 'Error de conexion');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-dark-card rounded-xl p-6 w-full max-w-md border border-dark-border" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-white mb-4">Agregar Comprador Confiable</h3>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-2">Nickname de Binance *</label>
            <input
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="ej: Juan123"
              className="w-full bg-dark-bg text-white rounded-lg px-3 py-2 border border-dark-border focus:border-primary-500 focus:outline-none"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-2">Nombre Real (opcional)</label>
            <input
              type="text"
              value={realName}
              onChange={(e) => setRealName(e.target.value)}
              placeholder="ej: Juan Perez Garcia"
              className="w-full bg-dark-bg text-white rounded-lg px-3 py-2 border border-dark-border focus:border-primary-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-2">Notas (opcional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="ej: Verificado con INE, cliente recurrente"
              rows={2}
              className="w-full bg-dark-bg text-white rounded-lg px-3 py-2 border border-dark-border focus:border-primary-500 focus:outline-none resize-none"
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 bg-dark-hover text-gray-300 rounded-lg hover:bg-dark-border transition"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition disabled:opacity-50"
            >
              {loading ? 'Agregando...' : 'Agregar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
