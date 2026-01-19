'use client';

import { useState, useEffect, useCallback } from 'react';

interface Seller {
  userNo: string;
  nickName: string;
  price: string;
  surplusAmount: string;
  isOnline: boolean;
  monthOrderCount: number;
  proMerchant: boolean;
}

interface AssetPositioningConfig {
  enabled: boolean;
  mode: 'smart' | 'follow';
  followTarget: string | null;
  matchPrice: boolean;
  undercutCents: number;
  // Per-asset smart filters
  smartMinOrderCount: number;
  smartMinSurplus: number;  // In FIAT (MXN) - calculated as price × crypto amount
}

type PositioningConfigsMap = Record<string, AssetPositioningConfig>;

interface BotConfig {
  releaseEnabled: boolean;
  positioningEnabled: boolean;
  positioningConfigs: PositioningConfigsMap;
  smartMinOrderCount: number;
  smartMinSurplus: number;
  undercutCents: number;
  matchPrice: boolean;
  releaseLastActive: string | null;
  positioningLastActive: string | null;
  updatedAt: string;
}

const ASSETS = ['USDT', 'BTC', 'ETH', 'USDC', 'BNB'];

export default function PositioningPage() {
  const [config, setConfig] = useState<BotConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [selectedAsset, setSelectedAsset] = useState('USDT');
  const [positioningConfigs, setPositioningConfigs] = useState<PositioningConfigsMap>({});

  // Sellers cache
  const [sellersCache, setSellersCache] = useState<Record<string, Seller[]>>({});
  const [loadingSellers, setLoadingSellers] = useState<Record<string, boolean>>({});

  // Global defaults for new configs
  const [globalMinOrderCount, setGlobalMinOrderCount] = useState(10);
  const [globalMinSurplus, setGlobalMinSurplus] = useState(100);

  const getAssetConfig = (asset: string, tradeType: 'SELL' | 'BUY'): AssetPositioningConfig => {
    const key = `${tradeType}:${asset}`;
    const stored = positioningConfigs[key];
    return stored || {
      enabled: true,
      mode: 'smart',
      followTarget: null,
      matchPrice: false,
      undercutCents: 1,
      smartMinOrderCount: globalMinOrderCount,
      smartMinSurplus: globalMinSurplus,
    };
  };

  const updateAssetConfig = (asset: string, tradeType: 'SELL' | 'BUY', updates: Partial<AssetPositioningConfig>) => {
    const key = `${tradeType}:${asset}`;
    setPositioningConfigs(prev => ({
      ...prev,
      [key]: { ...getAssetConfig(asset, tradeType), ...updates },
    }));
  };

  const fetchSellers = useCallback(async (asset: string, tradeType: 'SELL' | 'BUY') => {
    const searchType = tradeType === 'SELL' ? 'BUY' : 'SELL';
    const cacheKey = `${tradeType}:${asset}`;

    setLoadingSellers(prev => ({ ...prev, [cacheKey]: true }));
    try {
      const response = await fetch(`/api/sellers?asset=${asset}&fiat=MXN&tradeType=${searchType}&rows=10`);
      const data = await response.json();
      if (data.success) {
        setSellersCache(prev => ({ ...prev, [cacheKey]: data.sellers }));
      }
    } catch (err) {
      console.error(`Error fetching sellers:`, err);
    } finally {
      setLoadingSellers(prev => ({ ...prev, [cacheKey]: false }));
    }
  }, []);

  const fetchConfig = useCallback(async () => {
    try {
      const response = await fetch('/api/bot-control');
      const data = await response.json();
      if (data.success) {
        setConfig(data.config);
        setPositioningConfigs(data.config.positioningConfigs || {});
        setGlobalMinOrderCount(data.config.smartMinOrderCount ?? 10);
        setGlobalMinSurplus(data.config.smartMinSurplus ?? 100);
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

  // Auto-load sellers when Follow is selected
  useEffect(() => {
    const sellCfg = getAssetConfig(selectedAsset, 'SELL');
    const buyCfg = getAssetConfig(selectedAsset, 'BUY');
    const sellKey = `SELL:${selectedAsset}`;
    const buyKey = `BUY:${selectedAsset}`;

    if (sellCfg.mode === 'follow' && !sellersCache[sellKey] && !loadingSellers[sellKey]) {
      fetchSellers(selectedAsset, 'SELL');
    }
    if (buyCfg.mode === 'follow' && !sellersCache[buyKey] && !loadingSellers[buyKey]) {
      fetchSellers(selectedAsset, 'BUY');
    }
  }, [selectedAsset, positioningConfigs, sellersCache, loadingSellers, fetchSellers, getAssetConfig]);

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

  const saveAllConfig = () => {
    updateConfig({
      positioningConfigs,
      // Global defaults (used when per-asset not set)
      smartMinOrderCount: globalMinOrderCount,
      smartMinSurplus: globalMinSurplus,
    });
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

  // Trade Config Component
  const TradeConfig = ({ asset, tradeType }: { asset: string; tradeType: 'SELL' | 'BUY' }) => {
    const key = `${tradeType}:${asset}`;
    const cfg = getAssetConfig(asset, tradeType);
    const sellers = sellersCache[key] || [];
    const isLoading = loadingSellers[key] || false;
    const isSell = tradeType === 'SELL';
    const isEnabled = cfg.enabled !== false;

    const handleModeChange = (mode: 'smart' | 'follow') => {
      updateAssetConfig(asset, tradeType, { mode, followTarget: mode === 'smart' ? null : cfg.followTarget });
      if (mode === 'follow' && !sellers.length) {
        fetchSellers(asset, tradeType);
      }
    };

    const toggleEnabled = () => {
      updateAssetConfig(asset, tradeType, { enabled: !isEnabled });
    };

    return (
      <div className={`p-3 sm:p-4 rounded-xl border-2 ${
        !isEnabled
          ? 'border-gray-600/50 bg-gray-800/50 opacity-60'
          : isSell
            ? 'border-emerald-500/50 bg-emerald-500/5'
            : 'border-orange-500/50 bg-orange-500/5'
      }`}>
        {/* Header with toggle */}
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className={`text-base sm:text-lg font-bold ${isSell ? 'text-emerald-400' : 'text-orange-400'}`}>
              {isSell ? '💰 Venta' : '🛒 Compra'}
            </h3>
            <p className="text-[10px] text-gray-500">
              {isSell ? 'Vendemos crypto (busca en tab Comprar)' : 'Compramos crypto (busca en tab Vender)'}
            </p>
          </div>
          <button
            onClick={toggleEnabled}
            className={`px-3 py-1.5 rounded-lg font-bold text-sm transition ${
              isEnabled
                ? 'bg-emerald-600 text-white'
                : 'bg-gray-600 text-gray-300'
            }`}
          >
            {isEnabled ? 'ON' : 'OFF'}
          </button>
        </div>

        {!isEnabled && (
          <div className="text-center py-3 text-gray-500 text-sm">
            Desactivado para {isSell ? 'venta' : 'compra'}
          </div>
        )}

        {isEnabled && (
          <>
            {/* Mode Toggle */}
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => handleModeChange('smart')}
                className={`flex-1 py-2 px-3 rounded-lg font-medium transition text-sm ${
                  cfg.mode === 'smart'
                    ? 'bg-amber-500 text-black'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                🤖 Smart
              </button>
              <button
                onClick={() => handleModeChange('follow')}
                className={`flex-1 py-2 px-3 rounded-lg font-medium transition text-sm ${
                  cfg.mode === 'follow'
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                👤 Seguir
              </button>
            </div>

            {/* Follow Mode */}
            {cfg.mode === 'follow' && (
              <div className="space-y-2">
                {/* Current Target */}
                {cfg.followTarget && (
                  <div className="p-2 bg-blue-500/20 border border-blue-500/50 rounded-lg">
                    <div className="text-xs text-blue-300">Siguiendo:</div>
                    <div className="text-white font-bold">{cfg.followTarget}</div>
                  </div>
                )}

                {/* Seller List */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-400">Competidores:</span>
                    <button
                      onClick={() => fetchSellers(asset, tradeType)}
                      disabled={isLoading}
                      className="text-xs text-primary-400 hover:text-primary-300 px-2 py-1 bg-gray-700 rounded"
                    >
                      {isLoading ? '...' : '↻'}
                    </button>
                  </div>

                  {isLoading ? (
                    <div className="flex justify-center py-3">
                      <div className="animate-spin h-4 w-4 border-2 border-primary-500 border-t-transparent rounded-full"></div>
                    </div>
                  ) : sellers.length > 0 ? (
                    <div className="space-y-1 max-h-32 sm:max-h-40 overflow-y-auto">
                      {sellers.slice(0, 5).map((seller, idx) => (
                        <button
                          key={seller.userNo}
                          onClick={() => updateAssetConfig(asset, tradeType, { followTarget: seller.nickName })}
                          className={`w-full text-left p-2 rounded-lg transition text-sm ${
                            cfg.followTarget === seller.nickName
                              ? 'bg-blue-500/30 border border-blue-500'
                              : 'bg-gray-800 hover:bg-gray-700 border border-transparent'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              <span className="text-gray-500 text-xs">#{idx + 1}</span>
                              <span className="text-white font-medium truncate max-w-[100px]">{seller.nickName}</span>
                              {seller.isOnline && <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full"></span>}
                            </div>
                            <span className="text-white font-bold text-sm">${parseFloat(seller.price).toFixed(2)}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <button onClick={() => fetchSellers(asset, tradeType)} className="text-xs text-gray-500 hover:text-gray-400">
                      Cargar competidores
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Smart Mode - Filters */}
            {cfg.mode === 'smart' && (
              <div className="space-y-2">
                <div className="p-2 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-300">
                  Busca el mejor precio entre comerciantes verificados
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-1">Min. Ordenes</label>
                    <input
                      type="number"
                      value={cfg.smartMinOrderCount ?? globalMinOrderCount}
                      onChange={(e) => updateAssetConfig(asset, tradeType, { smartMinOrderCount: parseInt(e.target.value) || 10 })}
                      className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-white text-sm"
                      min="0"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-1">Min. Volumen (MXN)</label>
                    <input
                      type="number"
                      value={cfg.smartMinSurplus ?? globalMinSurplus}
                      onChange={(e) => updateAssetConfig(asset, tradeType, { smartMinSurplus: parseInt(e.target.value) || 100 })}
                      className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-white text-sm"
                      min="0"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Price Strategy */}
            <div className="mt-3 pt-3 border-t border-gray-700">
              <div className="text-xs text-gray-500 mb-2">Estrategia:</div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => updateAssetConfig(asset, tradeType, { matchPrice: true })}
                  className={`p-2 rounded-lg border text-left transition text-xs ${
                    cfg.matchPrice ? 'border-primary-500 bg-primary-500/10' : 'border-gray-600 hover:border-gray-500'
                  }`}
                >
                  <div className="font-medium text-white">🎯 Igualar</div>
                </button>
                <button
                  onClick={() => updateAssetConfig(asset, tradeType, { matchPrice: false })}
                  className={`p-2 rounded-lg border text-left transition text-xs ${
                    !cfg.matchPrice ? 'border-primary-500 bg-primary-500/10' : 'border-gray-600 hover:border-gray-500'
                  }`}
                >
                  <div className="font-medium text-white">📉 -{cfg.undercutCents}¢</div>
                </button>
              </div>

              {!cfg.matchPrice && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-gray-400">Centavos:</span>
                  <input
                    type="number"
                    value={cfg.undercutCents}
                    onChange={(e) => updateAssetConfig(asset, tradeType, { undercutCents: parseFloat(e.target.value) || 1 })}
                    className="w-16 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
                    min="0"
                    step="0.5"
                  />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4 pb-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl sm:text-2xl font-bold text-white">Bot de Posicionamiento</h1>
        {successMessage && (
          <div className="px-3 py-1.5 bg-emerald-500/20 border border-emerald-500/30 rounded-lg text-emerald-400 text-sm">
            ✓ {successMessage}
          </div>
        )}
      </div>

      {/* Master Switch */}
      <div className="card p-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-white">Estado del Bot</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {config?.positioningEnabled ? 'Activo' : 'Detenido'} • {formatDate(config?.positioningLastActive ?? null)}
            </p>
          </div>
          <button
            onClick={() => updateConfig({ positioningEnabled: !config?.positioningEnabled })}
            className={`px-6 py-3 rounded-xl font-bold text-lg transition ${
              config?.positioningEnabled
                ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/30'
                : 'bg-gray-600 text-gray-300'
            }`}
          >
            {config?.positioningEnabled ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {/* Asset Tabs - Scrollable on mobile */}
      <div className="overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0">
        <div className="flex gap-2 min-w-max sm:min-w-0 sm:flex-wrap">
          {ASSETS.map(asset => {
            const sellCfg = getAssetConfig(asset, 'SELL');
            const buyCfg = getAssetConfig(asset, 'BUY');
            const sellEnabled = sellCfg.enabled !== false;
            const buyEnabled = buyCfg.enabled !== false;
            const anyEnabled = sellEnabled || buyEnabled;

            return (
              <button
                key={asset}
                onClick={() => setSelectedAsset(asset)}
                className={`px-4 py-2.5 rounded-xl font-bold transition flex items-center gap-2 ${
                  selectedAsset === asset
                    ? 'bg-primary-600 text-white'
                    : anyEnabled
                    ? 'bg-gray-700 text-white hover:bg-gray-600'
                    : 'bg-gray-800 text-gray-500 hover:bg-gray-700'
                }`}
              >
                {asset}
                <div className="flex gap-0.5">
                  <span className={`w-2 h-2 rounded-full ${sellEnabled ? 'bg-emerald-500' : 'bg-gray-600'}`}></span>
                  <span className={`w-2 h-2 rounded-full ${buyEnabled ? 'bg-orange-500' : 'bg-gray-600'}`}></span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected Asset Config - Stack on mobile */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TradeConfig asset={selectedAsset} tradeType="SELL" />
        <TradeConfig asset={selectedAsset} tradeType="BUY" />
      </div>

      {/* Smart Filters Global Defaults - Collapsible on mobile */}
      <details className="card">
        <summary className="p-4 cursor-pointer flex items-center justify-between">
          <h2 className="font-semibold text-white">Filtros Smart (Defaults)</h2>
          <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </summary>
        <div className="px-4 pb-4 pt-0">
          <p className="text-xs text-gray-500 mb-3">
            Valores por defecto. Cada par puede tener sus propios filtros arriba.
          </p>
          <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Min. Ordenes</label>
            <input
              type="number"
              value={globalMinOrderCount}
              onChange={(e) => setGlobalMinOrderCount(parseInt(e.target.value) || 0)}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white"
              min="0"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Min. Volumen (MXN)</label>
            <input
              type="number"
              value={globalMinSurplus}
              onChange={(e) => setGlobalMinSurplus(parseInt(e.target.value) || 0)}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white"
              min="0"
            />
          </div>
        </div>
        </div>
      </details>

      {/* Save Button - Fixed at bottom on mobile */}
      <div className="sticky bottom-20 sm:relative sm:bottom-auto">
        <button
          onClick={saveAllConfig}
          disabled={saving}
          className="w-full py-3 sm:py-4 bg-primary-600 text-white rounded-xl hover:bg-primary-700 transition disabled:opacity-50 font-bold text-lg shadow-lg"
        >
          {saving ? 'Guardando...' : '💾 Guardar'}
        </button>
      </div>
    </div>
  );
}
