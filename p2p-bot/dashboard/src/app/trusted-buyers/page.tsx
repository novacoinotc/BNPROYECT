'use client';

import { useState, useEffect, useCallback } from 'react';

interface TrustedBuyer {
  id: string;
  counterPartNickName: string;
  buyerUserNo: string | null;
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
  const [editingBuyer, setEditingBuyer] = useState<TrustedBuyer | null>(null);

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

  const handleRemove = async (buyer: TrustedBuyer) => {
    const displayName = buyer.realName || buyer.counterPartNickName;
    if (!confirm(`Remover "${displayName}" de la lista?`)) return;
    try {
      const response = await fetch('/api/trusted-buyers', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: buyer.id }),
      });
      const data = await response.json();
      if (data.success) { fetchTrustedBuyers(); } else { alert(data.error || 'Error'); }
    } catch (err: any) { alert(err.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="card">
        <div className="px-4 pt-3 pb-3 flex items-center justify-between">
          <h1 className="text-lg font-bold text-white">Compradores VIP</h1>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
                className="rounded bg-dark-card border-dark-border w-3.5 h-3.5"
              />
              Inactivos
            </label>
            <button
              onClick={() => setShowAddModal(true)}
              className="px-3 py-1.5 bg-primary-600 text-white text-xs rounded-lg hover:bg-primary-700 transition font-medium"
            >+ Agregar</button>
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-primary-500"></div>
          </div>
        ) : error ? (
          <div className="p-6 text-center text-red-400">{error}</div>
        ) : trustedBuyers.length === 0 ? (
          <div className="p-6 text-center text-gray-500">No hay compradores VIP registrados</div>
        ) : (
          <>
            {/* Mobile card layout */}
            <div className="sm:hidden divide-y divide-dark-border">
              {trustedBuyers.map((buyer) => (
                <div
                  key={buyer.id}
                  className={`p-3 ${!buyer.isActive ? 'opacity-50' : ''}`}
                >
                  <div className="flex justify-between items-start">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm">⭐</span>
                        <span className="text-white font-medium text-sm">{buyer.counterPartNickName}</span>
                        {!buyer.isActive && (
                          <span className="px-1.5 py-0.5 rounded text-xs bg-gray-500/20 text-gray-500">Inactivo</span>
                        )}
                      </div>
                      {buyer.realName && (
                        <p className="text-xs text-gray-400 mt-0.5 truncate">{buyer.realName}</p>
                      )}
                    </div>
                    <div className="text-right ml-2">
                      <div className="text-sm text-white font-medium">{buyer.ordersAutoReleased} ops</div>
                      <div className="text-xs text-gray-500">${parseFloat(buyer.totalAmountReleased || '0').toLocaleString()}</div>
                    </div>
                  </div>
                  {buyer.isActive && (
                    <div className="flex gap-3 mt-2">
                      <button onClick={() => setEditingBuyer(buyer)} className="text-blue-400 text-xs">Editar</button>
                      <button onClick={() => handleRemove(buyer)} className="text-red-400 text-xs">Remover</button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Desktop table - simplified: 5 columns instead of 8 */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full">
                <thead className="bg-dark-hover text-gray-400 text-xs uppercase">
                  <tr>
                    <th className="px-4 py-3 text-left">Comprador</th>
                    <th className="px-4 py-3 text-center">Operaciones</th>
                    <th className="px-4 py-3 text-right">Monto Total</th>
                    <th className="px-4 py-3 text-center">Estado</th>
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
                          <span>⭐</span>
                          <div>
                            <span className="text-white font-medium">{buyer.counterPartNickName}</span>
                            {buyer.realName && (
                              <p className="text-xs text-gray-500">{buyer.realName}</p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="text-primary-400 font-medium">{buyer.ordersAutoReleased}</span>
                      </td>
                      <td className="px-4 py-3 text-right text-white">
                        ${parseFloat(buyer.totalAmountReleased || '0').toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-2 py-1 rounded text-xs font-medium ${
                          buyer.isActive ? 'bg-emerald-500/20 text-emerald-400' : 'bg-gray-500/20 text-gray-500'
                        }`}>
                          {buyer.isActive ? 'Activo' : 'Inactivo'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {buyer.isActive && (
                          <div className="flex items-center justify-center gap-3">
                            <button onClick={() => setEditingBuyer(buyer)} className="text-blue-400 hover:text-blue-300 text-sm">Editar</button>
                            <button onClick={() => handleRemove(buyer)} className="text-red-400 hover:text-red-300 text-sm">Remover</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {showAddModal && (
        <AddTrustedBuyerModal onClose={() => setShowAddModal(false)} onSuccess={() => { setShowAddModal(false); fetchTrustedBuyers(); }} />
      )}
      {editingBuyer && (
        <EditTrustedBuyerModal buyer={editingBuyer} onClose={() => setEditingBuyer(null)} onSuccess={() => { setEditingBuyer(null); fetchTrustedBuyers(); }} />
      )}
    </div>
  );
}

function AddTrustedBuyerModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [nickname, setNickname] = useState('');
  const [buyerUserNo, setBuyerUserNo] = useState('');
  const [realName, setRealName] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nickname.trim()) { setError('Nickname es requerido'); return; }
    if (!buyerUserNo.trim()) { setError('UserNo es requerido'); return; }
    setLoading(true); setError(null);
    try {
      const response = await fetch('/api/trusted-buyers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ counterPartNickName: nickname.trim(), buyerUserNo: buyerUserNo.trim(), realName: realName.trim() || null, notes: notes.trim() || null, verifiedBy: 'Dashboard' }),
      });
      const data = await response.json();
      if (data.success) { onSuccess(); } else { setError(data.error || 'Error'); }
    } catch (err: any) { setError(err.message || 'Error'); } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50" onClick={onClose}>
      <div className="bg-dark-card rounded-t-xl sm:rounded-xl p-5 w-full sm:max-w-md border border-dark-border" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-white mb-4">Agregar VIP</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Nickname *</label>
            <input type="text" value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="ej: Juan123"
              className="w-full bg-dark-bg text-white rounded-lg px-3 py-2 border border-dark-border focus:border-primary-500 focus:outline-none text-base" autoFocus />
          </div>
          <div>
            <label className="block text-sm text-amber-400 mb-1">UserNo * (ID unico de Binance)</label>
            <input type="text" value={buyerUserNo} onChange={(e) => setBuyerUserNo(e.target.value)} placeholder="ej: s7d8f9g0h1i2j3k..."
              className="w-full bg-dark-bg text-white rounded-lg px-3 py-2 border border-amber-500/50 focus:border-amber-500 focus:outline-none font-mono text-base" />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Nombre Real</label>
            <input type="text" value={realName} onChange={(e) => setRealName(e.target.value)} placeholder="ej: JUAN PEREZ GARCIA"
              className="w-full bg-dark-bg text-white rounded-lg px-3 py-2 border border-dark-border focus:border-primary-500 focus:outline-none text-base" />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Notas</label>
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ej: Cliente recurrente"
              className="w-full bg-dark-bg text-white rounded-lg px-3 py-2 border border-dark-border focus:border-primary-500 focus:outline-none text-base" />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 bg-dark-hover text-gray-300 rounded-lg hover:bg-dark-border transition">Cancelar</button>
            <button type="submit" disabled={loading} className="flex-1 px-4 py-2.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition disabled:opacity-50">{loading ? 'Agregando...' : 'Agregar'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditTrustedBuyerModal({ buyer, onClose, onSuccess }: { buyer: TrustedBuyer; onClose: () => void; onSuccess: () => void }) {
  const [realName, setRealName] = useState(buyer.realName || '');
  const [notes, setNotes] = useState(buyer.notes || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      const response = await fetch('/api/trusted-buyers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: buyer.id, realName: realName.trim() || null, notes: notes.trim() || null }),
      });
      const data = await response.json();
      if (data.success) { onSuccess(); } else { setError(data.error || 'Error'); }
    } catch (err: any) { setError(err.message || 'Error'); } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50" onClick={onClose}>
      <div className="bg-dark-card rounded-t-xl sm:rounded-xl p-5 w-full sm:max-w-md border border-dark-border" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-white mb-3">Editar: {buyer.counterPartNickName}</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Nombre Real</label>
            <input type="text" value={realName} onChange={(e) => setRealName(e.target.value)} placeholder="ej: JUAN PEREZ GARCIA"
              className="w-full bg-dark-bg text-white rounded-lg px-3 py-2 border border-dark-border focus:border-primary-500 focus:outline-none text-base" autoFocus />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Notas</label>
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ej: Cliente recurrente"
              className="w-full bg-dark-bg text-white rounded-lg px-3 py-2 border border-dark-border focus:border-primary-500 focus:outline-none text-base" />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 bg-dark-hover text-gray-300 rounded-lg hover:bg-dark-border transition">Cancelar</button>
            <button type="submit" disabled={loading} className="flex-1 px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50">{loading ? 'Guardando...' : 'Guardar'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
