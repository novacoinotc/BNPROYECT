'use client';

import { useState } from 'react';
import { biometricRelease } from '@/lib/webauthn';

interface P2PReleaseModalProps {
  orderNumber: string;
  onClose: () => void;
  onSuccess: () => void;
}

export function P2PReleaseModal({ orderNumber, onClose, onSuccess }: P2PReleaseModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRelease = async () => {
    setLoading(true);
    setError(null);

    try {
      await biometricRelease(orderNumber);
      onSuccess();
      onClose();
    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
        setError('Autenticacion cancelada');
      } else {
        setError(err.message || 'Error al liberar orden');
      }
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
          {/* Biometric icon */}
          <div className="text-center py-2">
            <div className="mx-auto w-14 h-14 rounded-full bg-emerald-500/20 flex items-center justify-center mb-3">
              <svg className="w-7 h-7 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 11.5V14m0-2.5v-1a1 1 0 011-1h1m-2 2H5.5a1.5 1.5 0 00-1.5 1.5v0a1.5 1.5 0 001.5 1.5H7m0-3h2m5 3v-1a1 1 0 00-1-1h-1m2 2h1.5a1.5 1.5 0 001.5-1.5v0a1.5 1.5 0 00-1.5-1.5H17m0 3h-2m-3-7V4.5A1.5 1.5 0 0113.5 3v0A1.5 1.5 0 0115 4.5V7m-3 0h3m-3 0H9m6 0v2m-9-2V4.5A1.5 1.5 0 017.5 3v0A1.5 1.5 0 019 4.5V7m0 0v2m3 8v1.5a1.5 1.5 0 01-1.5 1.5v0a1.5 1.5 0 01-1.5-1.5V17m3 0h-3m3 0h3m-6 0v-2" />
              </svg>
            </div>
            <p className="text-xs text-gray-500">Confirma con tu biometria para liberar</p>
          </div>

          {/* Release button */}
          <button
            onClick={handleRelease}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 px-4 py-4 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full"></div>
                Verificando...
              </span>
            ) : (
              'Liberar con Face ID'
            )}
          </button>

          {/* Cancel */}
          <button
            onClick={onClose}
            className="w-full px-4 py-2.5 bg-[#1e2a3e] text-gray-300 rounded-xl hover:bg-[#2a3a52] transition font-medium"
          >
            Cancelar
          </button>

          {error && (
            <p className="text-sm text-red-400 text-center">{error}</p>
          )}
        </div>

        <div className="h-[env(safe-area-inset-bottom)]" />
      </div>
    </div>
  );
}
