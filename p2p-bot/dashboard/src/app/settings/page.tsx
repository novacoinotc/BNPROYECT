'use client';

import { useState, useEffect, useCallback } from 'react';
import { checkWebAuthnSupport, registerPasskey } from '@/lib/webauthn';

interface BotConfig {
  releaseEnabled: boolean;
  positioningEnabled: boolean;
  smartMinOrderCount: number;
  smartMinSurplus: number;
  undercutCents: number;
  matchPrice: boolean;
  releaseLastActive: string | null;
  positioningLastActive: string | null;
  updatedAt: string;
}

interface PasskeyInfo {
  id: string;
  deviceName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export default function SettingsPage() {
  const [config, setConfig] = useState<BotConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Passkey state
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [passkeysLoading, setPasskeysLoading] = useState(true);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [registeringPasskey, setRegisteringPasskey] = useState(false);
  const [webauthnSupported, setWebauthnSupported] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const response = await fetch('/api/bot-control');
      const data = await response.json();
      if (data.success) {
        setConfig(data.config);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchPasskeys = useCallback(async () => {
    try {
      const response = await fetch('/api/webauthn/credentials');
      const data = await response.json();
      if (data.success) {
        setPasskeys(data.credentials);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setPasskeysLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
    setWebauthnSupported(checkWebAuthnSupport());
    fetchPasskeys();
  }, [fetchConfig, fetchPasskeys]);

  const updateConfig = async (updates: any) => {
    setSaving(true);
    try {
      const response = await fetch('/api/bot-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await response.json();
      if (data.success) {
        setConfig(prev => prev ? { ...prev, ...data.config } : data.config);
        setSuccessMessage('Guardado');
        setTimeout(() => setSuccessMessage(null), 2000);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleRegisterPasskey = async () => {
    setRegisteringPasskey(true);
    setPasskeyError(null);

    try {
      // Detect device name
      const ua = navigator.userAgent;
      let deviceName = 'Dispositivo';
      if (/iPhone/.test(ua)) deviceName = 'iPhone';
      else if (/iPad/.test(ua)) deviceName = 'iPad';
      else if (/Macintosh/.test(ua)) deviceName = 'Mac';
      else if (/Android/.test(ua)) deviceName = 'Android';

      await registerPasskey(deviceName);
      await fetchPasskeys();
      setSuccessMessage('Passkey registrada');
      setTimeout(() => setSuccessMessage(null), 2000);
    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
        setPasskeyError('Registro cancelado');
      } else {
        setPasskeyError(err.message || 'Error al registrar');
      }
    } finally {
      setRegisteringPasskey(false);
    }
  };

  const handleDeletePasskey = async (id: string) => {
    setDeletingId(id);
    try {
      const response = await fetch('/api/webauthn/credentials', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await response.json();
      if (data.success) {
        setPasskeys(prev => prev.filter(p => p.id !== id));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setDeletingId(null);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Nunca';
    return new Date(dateStr).toLocaleString('es-MX', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin h-8 w-8 border-2 border-primary-500 border-t-transparent rounded-full"></div>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl sm:text-2xl font-bold text-white">Configuracion</h1>
        {successMessage && (
          <div className="px-3 py-1.5 bg-emerald-500/20 border border-emerald-500/30 rounded-lg text-emerald-400 text-sm">
            {successMessage}
          </div>
        )}
      </div>

      {/* Security — Passkeys */}
      {webauthnSupported && (
        <div className="card p-4">
          <h2 className="font-semibold text-white mb-1">Seguridad</h2>
          <p className="text-xs text-gray-500 mb-3">
            Usa Face ID o huella digital para liberar ordenes sin codigo
          </p>

          {passkeysLoading ? (
            <div className="flex items-center justify-center py-4">
              <div className="animate-spin h-5 w-5 border-2 border-primary-500 border-t-transparent rounded-full"></div>
            </div>
          ) : (
            <>
              {/* Registered passkeys list */}
              {passkeys.length > 0 && (
                <div className="space-y-2 mb-3">
                  {passkeys.map((pk) => (
                    <div key={pk.id} className="flex items-center justify-between p-2.5 bg-[#0d1421] rounded-xl border border-[#1e2a3e]">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <svg className="w-5 h-5 text-primary-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 11.5V14m0-2.5v-1a1 1 0 011-1h1m-2 2H5.5a1.5 1.5 0 00-1.5 1.5v0a1.5 1.5 0 001.5 1.5H7m0-3h2m5 3v-1a1 1 0 00-1-1h-1m2 2h1.5a1.5 1.5 0 001.5-1.5v0a1.5 1.5 0 00-1.5-1.5H17m0 3h-2m-3-7V4.5A1.5 1.5 0 0113.5 3v0A1.5 1.5 0 0115 4.5V7m-3 0h3m-3 0H9m6 0v2m-9-2V4.5A1.5 1.5 0 017.5 3v0A1.5 1.5 0 019 4.5V7m0 0v2m3 8v1.5a1.5 1.5 0 01-1.5 1.5v0a1.5 1.5 0 01-1.5-1.5V17m3 0h-3m3 0h3m-6 0v-2" />
                        </svg>
                        <div className="min-w-0">
                          <p className="text-sm text-white truncate">{pk.deviceName || 'Passkey'}</p>
                          <p className="text-[10px] text-gray-500">
                            Registrada: {formatDate(pk.createdAt)}
                            {pk.lastUsedAt && ` · Ultimo uso: ${formatDate(pk.lastUsedAt)}`}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeletePasskey(pk.id)}
                        disabled={deletingId === pk.id}
                        className="shrink-0 p-1.5 text-gray-500 hover:text-red-400 transition disabled:opacity-50"
                      >
                        {deletingId === pk.id ? (
                          <div className="animate-spin h-4 w-4 border-2 border-gray-500 border-t-transparent rounded-full"></div>
                        ) : (
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Register button */}
              <button
                onClick={handleRegisterPasskey}
                disabled={registeringPasskey}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary-500 hover:bg-primary-600 text-white rounded-xl font-medium text-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {registeringPasskey ? (
                  <>
                    <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"></div>
                    Registrando...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    {passkeys.length === 0 ? 'Agregar Face ID / Huella' : 'Agregar otro dispositivo'}
                  </>
                )}
              </button>

              {passkeyError && (
                <p className="text-xs text-red-400 text-center mt-2">{passkeyError}</p>
              )}

              {passkeys.length === 0 && (
                <p className="text-xs text-gray-500 text-center mt-2">
                  Registra tu Face ID o huella para liberar ordenes sin copiar codigos
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* Bot Controls */}
      <div className="grid grid-cols-1 gap-4">
        {/* Release Bot */}
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <h2 className="font-semibold text-white">Bot de Liberacion Automatica</h2>
              <p className="text-xs text-gray-500 mt-1">
                Libera automaticamente crypto cuando se verifica el pago
              </p>
              <p className="text-xs text-gray-600 mt-0.5">
                Ultima actividad: {formatDate(config?.releaseLastActive ?? null)}
              </p>
            </div>
            <button
              onClick={() => updateConfig({ releaseEnabled: !config?.releaseEnabled })}
              disabled={saving}
              className={`px-5 py-2.5 rounded-xl font-bold text-lg transition ${
                config?.releaseEnabled
                  ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/30'
                  : 'bg-gray-600 text-gray-300'
              }`}
            >
              {config?.releaseEnabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>

        {/* Positioning Bot - Link to Bot tab */}
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <h2 className="font-semibold text-white">Bot de Posicionamiento</h2>
              <p className="text-xs text-gray-500 mt-1">
                Ajusta precios automaticamente para mantener posicion competitiva
              </p>
              <p className="text-xs text-gray-600 mt-0.5">
                Ultima actividad: {formatDate(config?.positioningLastActive ?? null)}
              </p>
            </div>
            <a
              href="/positioning"
              className="px-4 py-2 bg-primary-500 hover:bg-primary-600 text-white rounded-xl font-medium text-sm transition flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              </svg>
              Configurar
            </a>
          </div>
        </div>
      </div>

      {/* App Info */}
      <div className="card p-4">
        <h2 className="font-semibold text-white mb-3">Informacion</h2>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-400">Version</span>
            <span className="text-white font-mono">1.0.0</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Ultima configuracion</span>
            <span className="text-white">{formatDate(config?.updatedAt ?? null)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Estado de conexion</span>
            <span className="text-emerald-400 flex items-center gap-1.5">
              <span className="w-2 h-2 bg-emerald-500 rounded-full"></span>
              Conectado
            </span>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="card p-4">
        <h2 className="font-semibold text-white mb-3">Acciones Rapidas</h2>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => window.location.reload()}
            className="p-3 bg-gray-700 hover:bg-gray-600 rounded-xl text-sm font-medium text-white transition flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refrescar
          </button>
          <a
            href="/"
            className="p-3 bg-gray-700 hover:bg-gray-600 rounded-xl text-sm font-medium text-white transition flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
            Inicio
          </a>
        </div>
      </div>
    </div>
  );
}
