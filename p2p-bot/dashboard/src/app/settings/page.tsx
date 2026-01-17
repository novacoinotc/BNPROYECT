'use client';

import { useState, useEffect, useCallback } from 'react';

interface BotConfig {
  releaseEnabled: boolean;
  positioningEnabled: boolean;
  positioningMode: string;
  followTargetNickName: string | null;
  followTargetUserNo: string | null;
  smartMinUserGrade: number;
  smartMinFinishRate: number;
  smartMinOrderCount: number;
  smartMinPositiveRate: number;
  smartRequireOnline: boolean;
  smartMinSurplus: number;
  undercutCents: number;
  autoMessageEnabled: boolean;
  autoMessageText: string | null;
  releaseLastActive: string | null;
  positioningLastActive: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export default function SettingsPage() {
  const [config, setConfig] = useState<BotConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Form state for positioning config
  const [positioningMode, setPositioningMode] = useState('smart');
  const [followTarget, setFollowTarget] = useState('');
  const [smartFilters, setSmartFilters] = useState({
    minUserGrade: 2,
    minFinishRate: 90,
    minOrderCount: 10,
    minPositiveRate: 95,
    requireOnline: true,
    minSurplus: 100,
  });
  const [undercutCents, setUndercutCents] = useState(1);

  // Auto-message state
  const [autoMessageEnabled, setAutoMessageEnabled] = useState(false);
  const [autoMessageText, setAutoMessageText] = useState(
    '¡Gracias por tu confianza! 🙏\n\nSi tu experiencia de compra fue positiva y el proceso fue rápido y confiable, agradeceríamos mucho un comentario positivo ⭐\n\nEstamos para servirte en tus futuras compras.\n\n¿Necesitas ayuda adicional? Escribe: AYUDA\n\n¡Hasta pronto!'
  );

  const fetchConfig = useCallback(async () => {
    try {
      const response = await fetch('/api/bot-control');
      const data = await response.json();

      if (data.success) {
        setConfig(data.config);
        setPositioningMode(data.config.positioningMode || 'smart');
        setFollowTarget(data.config.followTargetNickName || '');
        setSmartFilters({
          minUserGrade: data.config.smartMinUserGrade ?? 2,
          minFinishRate: Math.round((data.config.smartMinFinishRate ?? 0.90) * 100),
          minOrderCount: data.config.smartMinOrderCount ?? 10,
          minPositiveRate: Math.round((data.config.smartMinPositiveRate ?? 0.95) * 100),
          requireOnline: data.config.smartRequireOnline ?? true,
          minSurplus: data.config.smartMinSurplus ?? 100,
        });
        setUndercutCents(data.config.undercutCents ?? 1);
        setAutoMessageEnabled(data.config.autoMessageEnabled ?? false);
        if (data.config.autoMessageText) {
          setAutoMessageText(data.config.autoMessageText);
        }
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
    const interval = setInterval(fetchConfig, 30000);
    return () => clearInterval(interval);
  }, [fetchConfig]);

  const updateConfig = async (updates: Partial<BotConfig>) => {
    setSaving(true);
    setSuccessMessage(null);
    try {
      const response = await fetch('/api/bot-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });

      const data = await response.json();
      if (data.success) {
        setConfig(prev => prev ? { ...prev, ...data.config } : data.config);
        setSuccessMessage('Configuración guardada');
        setTimeout(() => setSuccessMessage(null), 3000);
      } else {
        alert(data.error || 'Error updating');
      }
    } catch (err: any) {
      alert(err.message || 'Error');
    } finally {
      setSaving(false);
    }
  };

  const toggleRelease = () => {
    if (!config) return;
    updateConfig({ releaseEnabled: !config.releaseEnabled });
  };

  const togglePositioning = () => {
    if (!config) return;
    updateConfig({ positioningEnabled: !config.positioningEnabled });
  };

  const savePositioningConfig = () => {
    updateConfig({
      positioningMode,
      followTargetNickName: positioningMode === 'follow' ? followTarget : null,
      smartMinUserGrade: smartFilters.minUserGrade,
      smartMinFinishRate: smartFilters.minFinishRate / 100,
      smartMinOrderCount: smartFilters.minOrderCount,
      smartMinPositiveRate: smartFilters.minPositiveRate / 100,
      smartRequireOnline: smartFilters.requireOnline,
      smartMinSurplus: smartFilters.minSurplus,
      undercutCents,
    });
  };

  const saveAutoMessage = () => {
    updateConfig({
      autoMessageEnabled,
      autoMessageText,
    });
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Nunca';
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
          Reintentar
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Configuración del Bot</h1>
          <p className="text-gray-400 text-sm mt-1">
            Kill switches y configuración de posicionamiento
          </p>
        </div>
        {successMessage && (
          <div className="px-4 py-2 bg-emerald-500/20 border border-emerald-500/30 rounded-lg text-emerald-400 text-sm">
            {successMessage}
          </div>
        )}
      </div>

      {/* Kill Switches */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Release Bot */}
        <div className="card p-6">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-full ${config?.releaseEnabled ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`}></div>
                <h2 className="text-lg font-semibold text-white">Bot de Liberación</h2>
              </div>
              <p className="text-gray-400 text-sm mt-2">
                Verifica pagos y libera crypto automáticamente.
              </p>
              <div className="mt-3 text-xs text-gray-500">
                Última actividad: {formatDate(config?.releaseLastActive ?? null)}
              </div>
            </div>
            <button
              onClick={toggleRelease}
              disabled={saving}
              className={`relative w-16 h-8 rounded-full transition-colors duration-200 ease-in-out
                ${config?.releaseEnabled ? 'bg-emerald-600' : 'bg-gray-600'}
                ${saving ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:opacity-90'}`}
            >
              <span className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-transform duration-200 ease-in-out
                ${config?.releaseEnabled ? 'translate-x-9' : 'translate-x-1'}`} />
            </button>
          </div>
          <div className={`mt-4 p-3 rounded-lg border ${config?.releaseEnabled
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
            : 'bg-red-500/10 border-red-500/30 text-red-400'}`}>
            <span className="font-medium">{config?.releaseEnabled ? '✓ ACTIVO' : '✕ DETENIDO'}</span>
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
                Ajusta precios automáticamente cada 5 segundos.
              </p>
              <div className="mt-3 text-xs text-gray-500">
                Última actividad: {formatDate(config?.positioningLastActive ?? null)}
              </div>
            </div>
            <button
              onClick={togglePositioning}
              disabled={saving}
              className={`relative w-16 h-8 rounded-full transition-colors duration-200 ease-in-out
                ${config?.positioningEnabled ? 'bg-emerald-600' : 'bg-gray-600'}
                ${saving ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:opacity-90'}`}
            >
              <span className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-transform duration-200 ease-in-out
                ${config?.positioningEnabled ? 'translate-x-9' : 'translate-x-1'}`} />
            </button>
          </div>
          <div className={`mt-4 p-3 rounded-lg border ${config?.positioningEnabled
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
            : 'bg-red-500/10 border-red-500/30 text-red-400'}`}>
            <span className="font-medium">
              {config?.positioningEnabled ? `✓ ACTIVO - Modo ${positioningMode.toUpperCase()}` : '✕ DETENIDO'}
            </span>
          </div>
        </div>
      </div>

      {/* Positioning Configuration */}
      <div className="card p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Configuración del Posicionamiento</h2>

        {/* Mode Selection */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-300 mb-2">Modo</label>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="mode"
                value="smart"
                checked={positioningMode === 'smart'}
                onChange={(e) => setPositioningMode(e.target.value)}
                className="w-4 h-4 text-primary-600"
              />
              <span className="text-white">Smart</span>
              <span className="text-xs text-gray-500">(Filtra competidores)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="mode"
                value="follow"
                checked={positioningMode === 'follow'}
                onChange={(e) => setPositioningMode(e.target.value)}
                className="w-4 h-4 text-primary-600"
              />
              <span className="text-white">Follow</span>
              <span className="text-xs text-gray-500">(Sigue a un vendedor)</span>
            </label>
          </div>
        </div>

        {/* Smart Mode Config */}
        {positioningMode === 'smart' && (
          <div className="space-y-4 p-4 bg-gray-800/50 rounded-lg">
            <h3 className="text-sm font-medium text-gray-300">Filtros de Competidores</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Grade Mínimo</label>
                <input
                  type="number"
                  value={smartFilters.minUserGrade}
                  onChange={(e) => setSmartFilters(prev => ({ ...prev, minUserGrade: parseInt(e.target.value) || 0 }))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm"
                  min="0"
                  max="5"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Finish Rate Mín (%)</label>
                <input
                  type="number"
                  value={smartFilters.minFinishRate}
                  onChange={(e) => setSmartFilters(prev => ({ ...prev, minFinishRate: parseInt(e.target.value) || 0 }))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm"
                  min="0"
                  max="100"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Órdenes Mín/Mes</label>
                <input
                  type="number"
                  value={smartFilters.minOrderCount}
                  onChange={(e) => setSmartFilters(prev => ({ ...prev, minOrderCount: parseInt(e.target.value) || 0 }))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm"
                  min="0"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Positive Rate Mín (%)</label>
                <input
                  type="number"
                  value={smartFilters.minPositiveRate}
                  onChange={(e) => setSmartFilters(prev => ({ ...prev, minPositiveRate: parseInt(e.target.value) || 0 }))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm"
                  min="0"
                  max="100"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Surplus Mín (USDT)</label>
                <input
                  type="number"
                  value={smartFilters.minSurplus}
                  onChange={(e) => setSmartFilters(prev => ({ ...prev, minSurplus: parseInt(e.target.value) || 0 }))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm"
                  min="0"
                />
              </div>
              <div className="flex items-center">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={smartFilters.requireOnline}
                    onChange={(e) => setSmartFilters(prev => ({ ...prev, requireOnline: e.target.checked }))}
                    className="w-4 h-4 text-primary-600 rounded"
                  />
                  <span className="text-sm text-gray-300">Solo Online</span>
                </label>
              </div>
            </div>
          </div>
        )}

        {/* Follow Mode Config */}
        {positioningMode === 'follow' && (
          <div className="space-y-4 p-4 bg-gray-800/50 rounded-lg">
            <h3 className="text-sm font-medium text-gray-300">Vendedor a Seguir</h3>
            <div>
              <label className="block text-xs text-gray-400 mb-1">NickName del vendedor</label>
              <input
                type="text"
                value={followTarget}
                onChange={(e) => setFollowTarget(e.target.value)}
                placeholder="Ej: MerchantPro123"
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm"
              />
            </div>
          </div>
        )}

        {/* Undercut Strategy */}
        <div className="mt-4 p-4 bg-gray-800/50 rounded-lg">
          <h3 className="text-sm font-medium text-gray-300 mb-3">Estrategia de Precio</h3>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="block text-xs text-gray-400 mb-1">Centavos a bajar del mejor competidor</label>
              <input
                type="number"
                value={undercutCents}
                onChange={(e) => setUndercutCents(parseFloat(e.target.value) || 0)}
                className="w-32 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm"
                min="0"
                step="0.5"
              />
            </div>
            <div className="text-sm text-gray-400">
              Tu precio = Mejor competidor - ${undercutCents.toFixed(2)} MXN
            </div>
          </div>
        </div>

        <button
          onClick={savePositioningConfig}
          disabled={saving}
          className="mt-4 px-6 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition disabled:opacity-50"
        >
          {saving ? 'Guardando...' : 'Guardar Configuración'}
        </button>
      </div>

      {/* Auto-Message Configuration */}
      <div className="card p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Mensaje Automático al Liberar</h2>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoMessageEnabled}
              onChange={(e) => setAutoMessageEnabled(e.target.checked)}
              className="w-4 h-4 text-primary-600 rounded"
            />
            <span className="text-sm text-gray-300">Activado</span>
          </label>
        </div>

        <p className="text-gray-400 text-sm mb-4">
          Este mensaje se envía automáticamente al chat después de liberar crypto exitosamente.
        </p>

        <textarea
          value={autoMessageText}
          onChange={(e) => setAutoMessageText(e.target.value)}
          rows={6}
          className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm resize-none"
          placeholder="Escribe el mensaje de agradecimiento..."
        />

        <div className="mt-2 text-xs text-gray-500">
          Puedes usar emojis. El mensaje se enviará tal cual lo escribas.
        </div>

        <button
          onClick={saveAutoMessage}
          disabled={saving}
          className="mt-4 px-6 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition disabled:opacity-50"
        >
          {saving ? 'Guardando...' : 'Guardar Mensaje'}
        </button>
      </div>

      {/* Warning Banner */}
      <div className="card p-4 border-l-4 border-l-amber-500">
        <div className="flex items-start gap-3">
          <span className="text-2xl">⚠️</span>
          <div>
            <h3 className="font-medium text-white">Importante</h3>
            <p className="text-sm text-gray-400 mt-1">
              Los cambios en los kill switches toman efecto en el próximo ciclo del bot (máximo 30 segundos).
              Los cambios en la configuración del posicionamiento se aplican inmediatamente si el bot está activo.
            </p>
          </div>
        </div>
      </div>

      {/* Last Update Info */}
      {config && (
        <div className="text-center text-xs text-gray-500">
          Última actualización: {formatDate(config.updatedAt)}
          {config.updatedBy && ` por ${config.updatedBy}`}
        </div>
      )}
    </div>
  );
}
