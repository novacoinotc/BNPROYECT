'use client';

import { useState } from 'react';

interface P2PReleaseModalProps {
  orderNumber: string;
  onClose: () => void;
  onSuccess: () => void;
}

export function P2PReleaseModal({ orderNumber, onClose, onSuccess }: P2PReleaseModalProps) {
  const [authType, setAuthType] = useState('GOOGLE');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRelease = async () => {
    if (!code) {
      setError('Ingresa el codigo de verificacion');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/orders/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNumber, authType, code }),
      });

      const data = await response.json();

      if (data.success) {
        onSuccess();
        onClose();
      } else {
        setError(data.error || 'Error al liberar orden');
      }
    } catch (err: any) {
      setError(err.message || 'Error de conexion');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-[60]" onClick={onClose}>
      <div
        className="bg-[#151d2e] rounded-t-2xl sm:rounded-2xl p-5 w-full sm:max-w-md border border-[#1e2a3e]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">Liberar Crypto</h3>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-300 transition">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-gray-400 mb-4">
          Orden: <span className="font-mono text-white">#{orderNumber.slice(-8)}</span>
        </p>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-2">Tipo de verificacion</label>
            <select
              value={authType}
              onChange={(e) => setAuthType(e.target.value)}
              className="w-full bg-[#0d1421] text-white rounded-xl px-3 py-2.5 border border-[#1e2a3e] focus:border-primary-500 focus:outline-none"
            >
              <option value="GOOGLE">Google Authenticator</option>
              <option value="SMS">SMS</option>
              <option value="FUND_PWD">Contrasena de fondos</option>
            </select>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-2">Codigo de verificacion</label>
            <input
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRelease()}
              placeholder="Ingresa el codigo"
              className="w-full bg-[#0d1421] text-white rounded-xl px-3 py-2.5 border border-[#1e2a3e] focus:border-primary-500 focus:outline-none text-center text-lg tracking-widest"
              autoFocus
            />
          </div>

          {error && (
            <p className="text-sm text-red-400 text-center">{error}</p>
          )}

          <div className="flex gap-3 pt-1">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-[#1e2a3e] text-gray-300 rounded-xl hover:bg-[#2a3a52] transition font-medium"
            >
              Cancelar
            </button>
            <button
              onClick={handleRelease}
              disabled={loading}
              className="flex-1 px-4 py-2.5 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"></div>
                  Liberando...
                </span>
              ) : (
                'Liberar'
              )}
            </button>
          </div>
        </div>

        {/* Safe area padding for mobile */}
        <div className="h-[env(safe-area-inset-bottom)]" />
      </div>
    </div>
  );
}
