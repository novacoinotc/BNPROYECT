'use client';

import { useState, useEffect } from 'react';
import { checkWebAuthnSupport, biometricRelease } from '@/lib/webauthn';

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
  const [hasPasskeys, setHasPasskeys] = useState<boolean | null>(null);
  const [webauthnSupported, setWebauthnSupported] = useState(false);
  const [useManualFallback, setUseManualFallback] = useState(false);

  // Check WebAuthn support and passkeys on mount
  useEffect(() => {
    const supported = checkWebAuthnSupport();
    setWebauthnSupported(supported);

    if (supported) {
      fetch('/api/webauthn/credentials')
        .then((res) => res.json())
        .then((data) => {
          setHasPasskeys(data.credentials && data.credentials.length > 0);
        })
        .catch(() => {
          setHasPasskeys(false);
        });
    } else {
      setHasPasskeys(false);
    }
  }, []);

  const showBiometric = webauthnSupported && hasPasskeys && !useManualFallback;

  const handleBiometricRelease = async () => {
    setLoading(true);
    setError(null);

    try {
      await biometricRelease(orderNumber);
      onSuccess();
      onClose();
    } catch (err: any) {
      // If user cancelled the biometric prompt
      if (err.name === 'NotAllowedError') {
        setError('Autenticacion cancelada');
      } else {
        setError(err.message || 'Error al liberar orden');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleManualRelease = async () => {
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
          {/* Loading state while checking passkeys */}
          {hasPasskeys === null && (
            <div className="flex items-center justify-center py-6">
              <div className="animate-spin h-5 w-5 border-2 border-primary-500 border-t-transparent rounded-full"></div>
            </div>
          )}

          {/* Biometric flow */}
          {showBiometric && (
            <>
              <button
                onClick={handleBiometricRelease}
                disabled={loading}
                className="w-full flex items-center justify-center gap-3 px-4 py-4 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full"></div>
                    Verificando...
                  </span>
                ) : (
                  <>
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 11.5V14m0-2.5v-1a1 1 0 011-1h1m-2 2H5.5a1.5 1.5 0 00-1.5 1.5v0a1.5 1.5 0 001.5 1.5H7m0-3h2m5 3v-1a1 1 0 00-1-1h-1m2 2h1.5a1.5 1.5 0 001.5-1.5v0a1.5 1.5 0 00-1.5-1.5H17m0 3h-2m-3-7V4.5A1.5 1.5 0 0113.5 3v0A1.5 1.5 0 0115 4.5V7m-3 0h3m-3 0H9m6 0v2m-9-2V4.5A1.5 1.5 0 017.5 3v0A1.5 1.5 0 019 4.5V7m0 0v2m3 8v1.5a1.5 1.5 0 01-1.5 1.5v0a1.5 1.5 0 01-1.5-1.5V17m3 0h-3m3 0h3m-6 0v-2" />
                    </svg>
                    Liberar con Face ID
                  </>
                )}
              </button>

              <button
                onClick={() => setUseManualFallback(true)}
                className="w-full text-center text-xs text-gray-500 hover:text-gray-300 transition py-1"
              >
                Usar codigo manual
              </button>
            </>
          )}

          {/* Manual code flow */}
          {hasPasskeys !== null && !showBiometric && (
            <>
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
                  onKeyDown={(e) => e.key === 'Enter' && handleManualRelease()}
                  placeholder="Ingresa el codigo"
                  className="w-full bg-[#0d1421] text-white rounded-xl px-3 py-2.5 border border-[#1e2a3e] focus:border-primary-500 focus:outline-none text-center text-lg tracking-widest"
                  autoFocus
                />
              </div>

              <div className="flex gap-3 pt-1">
                <button
                  onClick={onClose}
                  className="flex-1 px-4 py-2.5 bg-[#1e2a3e] text-gray-300 rounded-xl hover:bg-[#2a3a52] transition font-medium"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleManualRelease}
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

              {/* Show biometric switch if they have passkeys but chose manual */}
              {useManualFallback && (
                <button
                  onClick={() => setUseManualFallback(false)}
                  className="w-full text-center text-xs text-primary-400 hover:text-primary-300 transition py-1"
                >
                  Usar Face ID
                </button>
              )}

              {/* Link to setup passkeys if they don't have any */}
              {!hasPasskeys && webauthnSupported && (
                <a
                  href="/settings"
                  className="block w-full text-center text-xs text-primary-400 hover:text-primary-300 transition py-1"
                >
                  Configurar Face ID / Huella
                </a>
              )}
            </>
          )}

          {error && (
            <p className="text-sm text-red-400 text-center">{error}</p>
          )}
        </div>

        {/* Safe area padding for mobile */}
        <div className="h-[env(safe-area-inset-bottom)]" />
      </div>
    </div>
  );
}
