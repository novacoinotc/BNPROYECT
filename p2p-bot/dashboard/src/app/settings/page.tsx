'use client';

import { useState, useEffect, useCallback } from 'react';

interface BotConfig {
  releaseEnabled: boolean;
  positioningEnabled: boolean;
  positioningMode: string;
  followTargetNickName: string | null;
  followTargetUserNo: string | null;
  releaseLastActive: string | null;
  positioningLastActive: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export default function SettingsPage() {
  const [config, setConfig] = useState<BotConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const response = await fetch('/api/bot-control');
      const data = await response.json();

      if (data.success) {
        setConfig(data.config);
        setError(null);
      } else {
        setError(data.error || 'Error loading configuration');
      }
    } catch (err: any) {
      setError(err.message || 'Connection error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
    // Refresh every 10 seconds
    const interval = setInterval(fetchConfig, 10000);
    return () => clearInterval(interval);
  }, [fetchConfig]);

  const toggleRelease = async () => {
    if (!config) return;
    setUpdating('release');

    try {
      const response = await fetch('/api/bot-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ releaseEnabled: !config.releaseEnabled }),
      });

      const data = await response.json();
      if (data.success) {
        setConfig(data.config);
      } else {
        alert(data.error || 'Error updating');
      }
    } catch (err: any) {
      alert(err.message || 'Error');
    } finally {
      setUpdating(null);
    }
  };

  const togglePositioning = async () => {
    if (!config) return;
    setUpdating('positioning');

    try {
      const response = await fetch('/api/bot-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positioningEnabled: !config.positioningEnabled }),
      });

      const data = await response.json();
      if (data.success) {
        setConfig(data.config);
      } else {
        alert(data.error || 'Error updating');
      }
    } catch (err: any) {
      alert(err.message || 'Error');
    } finally {
      setUpdating(null);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleString('es-MX', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin h-8 w-8 border-2 border-primary-500 border-t-transparent rounded-full"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-6 text-center">
        <div className="text-red-400 mb-4">{error}</div>
        <button
          onClick={fetchConfig}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Bot Control</h1>
        <p className="text-gray-400 text-sm mt-1">
          Kill switches para controlar los bots - los cambios toman efecto inmediatamente
        </p>
      </div>

      {/* Kill Switches */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Release Bot */}
        <div className="card p-6">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-full ${config?.releaseEnabled ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`}></div>
                <h2 className="text-lg font-semibold text-white">Bot de Liberacion</h2>
              </div>
              <p className="text-gray-400 text-sm mt-2">
                Controla el proceso automatico de verificacion y liberacion de crypto cuando se reciben pagos.
              </p>
              <div className="mt-4 text-xs text-gray-500">
                Ultima actividad: {formatDate(config?.releaseLastActive ?? null)}
              </div>
            </div>
            <button
              onClick={toggleRelease}
              disabled={updating === 'release'}
              className={`
                relative w-16 h-8 rounded-full transition-colors duration-200 ease-in-out
                ${config?.releaseEnabled ? 'bg-emerald-600' : 'bg-gray-600'}
                ${updating === 'release' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:opacity-90'}
              `}
            >
              <span
                className={`
                  absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-transform duration-200 ease-in-out
                  ${config?.releaseEnabled ? 'translate-x-9' : 'translate-x-1'}
                `}
              />
            </button>
          </div>

          {/* Status */}
          <div className={`
            mt-4 p-3 rounded-lg border
            ${config?.releaseEnabled
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
              : 'bg-red-500/10 border-red-500/30 text-red-400'
            }
          `}>
            <div className="flex items-center gap-2">
              <span className="text-lg">{config?.releaseEnabled ? '✓' : '✕'}</span>
              <span className="font-medium">
                {config?.releaseEnabled ? 'ACTIVO' : 'DETENIDO'}
              </span>
            </div>
            <p className="text-sm mt-1 opacity-80">
              {config?.releaseEnabled
                ? 'El bot esta verificando pagos y liberando crypto automaticamente'
                : 'El bot NO esta liberando crypto - todas las ordenes requieren intervencion manual'
              }
            </p>
          </div>
        </div>

        {/* Positioning Bot */}
        <div className="card p-6">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-full ${config?.positioningEnabled ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`}></div>
                <h2 className="text-lg font-semibold text-white">Bot de Posicionamiento</h2>
              </div>
              <p className="text-gray-400 text-sm mt-2">
                Controla el ajuste automatico de precios para mantenerse competitivo en el mercado P2P.
              </p>
              <div className="mt-4 text-xs text-gray-500">
                Ultima actividad: {formatDate(config?.positioningLastActive ?? null)}
              </div>
            </div>
            <button
              onClick={togglePositioning}
              disabled={updating === 'positioning'}
              className={`
                relative w-16 h-8 rounded-full transition-colors duration-200 ease-in-out
                ${config?.positioningEnabled ? 'bg-emerald-600' : 'bg-gray-600'}
                ${updating === 'positioning' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:opacity-90'}
              `}
            >
              <span
                className={`
                  absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-transform duration-200 ease-in-out
                  ${config?.positioningEnabled ? 'translate-x-9' : 'translate-x-1'}
                `}
              />
            </button>
          </div>

          {/* Status */}
          <div className={`
            mt-4 p-3 rounded-lg border
            ${config?.positioningEnabled
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
              : 'bg-red-500/10 border-red-500/30 text-red-400'
            }
          `}>
            <div className="flex items-center gap-2">
              <span className="text-lg">{config?.positioningEnabled ? '✓' : '✕'}</span>
              <span className="font-medium">
                {config?.positioningEnabled ? 'ACTIVO' : 'DETENIDO'}
              </span>
            </div>
            <p className="text-sm mt-1 opacity-80">
              {config?.positioningEnabled
                ? `Modo: ${config?.positioningMode?.toUpperCase() || 'SMART'} - Ajustando precios automaticamente`
                : 'El bot NO esta ajustando precios - el precio permanece estatico'
              }
            </p>
          </div>
        </div>
      </div>

      {/* Warning Banner */}
      <div className="card p-4 border-l-4 border-l-amber-500">
        <div className="flex items-start gap-3">
          <span className="text-2xl">⚠️</span>
          <div>
            <h3 className="font-medium text-white">Kill Switch - Efecto Inmediato</h3>
            <p className="text-sm text-gray-400 mt-1">
              Los cambios en estos controles toman efecto en el proximo ciclo del bot (maximo 30 segundos).
              Desactivar el bot de liberacion <strong>NO</strong> afecta ordenes que ya estan en proceso de verificacion.
            </p>
          </div>
        </div>
      </div>

      {/* Last Update Info */}
      {config && (
        <div className="text-center text-xs text-gray-500">
          Ultima actualizacion: {formatDate(config.updatedAt)}
          {config.updatedBy && ` por ${config.updatedBy}`}
        </div>
      )}
    </div>
  );
}
