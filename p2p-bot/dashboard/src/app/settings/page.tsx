'use client';

import { useState, useEffect, useCallback } from 'react';

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

export default function SettingsPage() {
  const [config, setConfig] = useState<BotConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

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

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

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
            ✓ {successMessage}
          </div>
        )}
      </div>

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
