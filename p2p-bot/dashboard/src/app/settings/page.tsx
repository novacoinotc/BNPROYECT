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
  mode: 'smart' | 'follow';
  followTarget: string | null;
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

export default function SettingsPage() {
  const [config, setConfig] = useState<BotConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [selectedAsset, setSelectedAsset] = useState('USDT');
  const [positioningConfigs, setPositioningConfigs] = useState<PositioningConfigsMap>({});

  // Sellers cache
  const [sellersCache, setSellersCache] = useState<Record<string, Seller[]>>({});
  const [loadingSellers, setLoadingSellers] = useState<Record<string, boolean>>({});

  // Smart filters (simplified)
  const [minOrderCount, setMinOrderCount] = useState(10);
  const [minSurplus, setMinSurplus] = useState(100);

  // Strategy
  const [undercutCents, setUndercutCents] = useState(1);
  const [matchPrice, setMatchPrice] = useState(false);

  const getAssetConfig = (asset: string, tradeType: 'SELL' | 'BUY'): AssetPositioningConfig => {
    const key = `${tradeType}:${asset}`;
    return positioningConfigs[key] || { mode: 'smart', followTarget: null };
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
        setMinOrderCount(data.config.smartMinOrderCount ?? 10);
        setMinSurplus(data.config.smartMinSurplus ?? 100);
        setUndercutCents(data.config.undercutCents ?? 1);
        setMatchPrice(data.config.matchPrice ?? false);
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
  }, [selectedAsset, positioningConfigs, sellersCache, loadingSellers, fetchSellers]);

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
      smartMinOrderCount: minOrderCount,
      smartMinSurplus: minSurplus,
      undercutCents,
      matchPrice,
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

    const handleModeChange = (mode: 'smart' | 'follow') => {
      updateAssetConfig(asset, tradeType, { mode, followTarget: mode === 'smart' ? null : cfg.followTarget });
      if (mode === 'follow' && !sellers.length) {
        fetchSellers(asset, tradeType);
      }
    };

    return (
      <div className={`p-4 rounded-lg border-2 ${isSell ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-orange-500/50 bg-orange-500/5'}`}>
        <h3 className={`text-lg font-bold mb-3 ${isSell ? 'text-emerald-400' : 'text-orange-400'}`}>
          {isSell ? '💰 Nosotros Vendemos' : '🛒 Nosotros Compramos'}
        </h3>

        {/* Mode Toggle */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => handleModeChange('smart')}
            className={`flex-1 py-2 px-4 rounded-lg font-medium transition ${
              cfg.mode === 'smart'
                ? 'bg-amber-500 text-black'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            🤖 Smart
          </button>
          <button
            onClick={() => handleModeChange('follow')}
            className={`flex-1 py-2 px-4 rounded-lg font-medium transition ${
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
          <div className="space-y-3">
            {/* Current Target */}
            {cfg.followTarget && (
              <div className="p-3 bg-blue-500/20 border border-blue-500/50 rounded-lg">
                <div className="text-xs text-blue-300 mb-1">Siguiendo a:</div>
                <div className="text-white font-bold text-lg">{cfg.followTarget}</div>
              </div>
            )}

            {/* Seller List */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-400">Competidores en el mercado:</span>
                <button
                  onClick={() => fetchSellers(asset, tradeType)}
                  disabled={isLoading}
                  className="text-xs text-primary-400 hover:text-primary-300 px-2 py-1 bg-gray-700 rounded"
                >
                  {isLoading ? 'Cargando...' : '↻ Actualizar'}
                </button>
              </div>

              {isLoading ? (
                <div className="flex justify-center py-4">
                  <div className="animate-spin h-5 w-5 border-2 border-primary-500 border-t-transparent rounded-full"></div>
                </div>
              ) : sellers.length > 0 ? (
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {sellers.map((seller, idx) => (
                    <button
                      key={seller.userNo}
                      onClick={() => updateAssetConfig(asset, tradeType, { followTarget: seller.nickName })}
                      className={`w-full text-left p-3 rounded-lg transition ${
                        cfg.followTarget === seller.nickName
                          ? 'bg-blue-500/30 border-2 border-blue-500'
                          : 'bg-gray-800 hover:bg-gray-700 border-2 border-transparent'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-gray-500 font-mono">#{idx + 1}</span>
                          <span className="text-white font-medium">{seller.nickName}</span>
                          {seller.proMerchant && <span className="px-1.5 py-0.5 bg-amber-500/30 text-amber-400 text-[10px] rounded font-bold">PRO</span>}
                          {seller.isOnline && <span className="w-2 h-2 bg-emerald-500 rounded-full"></span>}
                        </div>
                        <span className="text-white font-bold">${parseFloat(seller.price).toLocaleString()}</span>
                      </div>
                      <div className="flex gap-3 mt-1 text-xs text-gray-500">
                        <span>{seller.monthOrderCount} ordenes</span>
                        <span>{parseFloat(seller.surplusAmount).toLocaleString()} {asset}</span>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="text-center py-4 text-gray-500">
                  <button onClick={() => fetchSellers(asset, tradeType)} className="hover:text-gray-400">
                    Clic para cargar competidores
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Smart Mode */}
        {cfg.mode === 'smart' && (
          <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-sm text-amber-300">
            Busca automaticamente el mejor precio basado en volumen y ordenes completadas
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Configuracion del Bot</h1>
        </div>
        {successMessage && (
          <div className="px-4 py-2 bg-emerald-500/20 border border-emerald-500/30 rounded-lg text-emerald-400">
            ✓ {successMessage}
          </div>
        )}
      </div>

      {/* Kill Switches */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-white">Bot de Liberacion</h2>
              <p className="text-xs text-gray-500 mt-1">{formatDate(config?.releaseLastActive ?? null)}</p>
            </div>
            <button
              onClick={() => updateConfig({ releaseEnabled: !config?.releaseEnabled })}
              className={`px-4 py-2 rounded-lg font-medium ${
                config?.releaseEnabled ? 'bg-emerald-600 text-white' : 'bg-gray-600 text-gray-300'
              }`}
            >
              {config?.releaseEnabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-white">Bot de Posicionamiento</h2>
              <p className="text-xs text-gray-500 mt-1">{formatDate(config?.positioningLastActive ?? null)}</p>
            </div>
            <button
              onClick={() => updateConfig({ positioningEnabled: !config?.positioningEnabled })}
              className={`px-4 py-2 rounded-lg font-medium ${
                config?.positioningEnabled ? 'bg-emerald-600 text-white' : 'bg-gray-600 text-gray-300'
              }`}
            >
              {config?.positioningEnabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
      </div>

      {/* Asset Selection */}
      <div className="card p-6">
        {/* Tabs */}
        <div className="flex gap-2 mb-6 flex-wrap">
          {ASSETS.map(asset => {
            const sellCfg = getAssetConfig(asset, 'SELL');
            const buyCfg = getAssetConfig(asset, 'BUY');
            const hasConfig = sellCfg.followTarget || buyCfg.followTarget || sellCfg.mode === 'follow' || buyCfg.mode === 'follow';

            return (
              <button
                key={asset}
                onClick={() => setSelectedAsset(asset)}
                className={`px-5 py-3 rounded-lg font-bold text-lg transition ${
                  selectedAsset === asset
                    ? 'bg-primary-600 text-white'
                    : hasConfig
                    ? 'bg-gray-700 text-white border-2 border-primary-500/50'
                    : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                }`}
              >
                {asset}
              </button>
            );
          })}
        </div>

        {/* Selected Asset Config */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <TradeConfig asset={selectedAsset} tradeType="SELL" />
          <TradeConfig asset={selectedAsset} tradeType="BUY" />
        </div>
      </div>

      {/* Smart Filters - Simplified */}
      <div className="card p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Filtros Smart</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm text-gray-400 mb-2">Ordenes minimas completadas</label>
            <input
              type="number"
              value={minOrderCount}
              onChange={(e) => setMinOrderCount(parseInt(e.target.value) || 0)}
              className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white text-lg"
              min="0"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-2">Volumen minimo disponible</label>
            <input
              type="number"
              value={minSurplus}
              onChange={(e) => setMinSurplus(parseInt(e.target.value) || 0)}
              className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white text-lg"
              min="0"
            />
          </div>
        </div>
      </div>

      {/* Price Strategy */}
      <div className="card p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Estrategia de Precio</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <button
            onClick={() => setMatchPrice(true)}
            className={`p-4 rounded-lg border-2 text-left transition ${
              matchPrice ? 'border-primary-500 bg-primary-500/10' : 'border-gray-600 hover:border-gray-500'
            }`}
          >
            <div className="font-bold text-white mb-1">🎯 Igualar Precio</div>
            <div className="text-sm text-gray-400">Mismo precio que el competidor</div>
          </button>
          <button
            onClick={() => setMatchPrice(false)}
            className={`p-4 rounded-lg border-2 text-left transition ${
              !matchPrice ? 'border-primary-500 bg-primary-500/10' : 'border-gray-600 hover:border-gray-500'
            }`}
          >
            <div className="font-bold text-white mb-1">📉 Bajar Centavos</div>
            <div className="text-sm text-gray-400">Competidor - ${undercutCents} MXN</div>
          </button>
        </div>

        {!matchPrice && (
          <div className="mt-4">
            <label className="block text-sm text-gray-400 mb-2">Centavos a bajar:</label>
            <input
              type="number"
              value={undercutCents}
              onChange={(e) => setUndercutCents(parseFloat(e.target.value) || 0)}
              className="w-32 px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white"
              min="0"
              step="0.5"
            />
          </div>
        )}
      </div>

      {/* Save */}
      <button
        onClick={saveAllConfig}
        disabled={saving}
        className="w-full py-4 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition disabled:opacity-50 font-bold text-lg"
      >
        {saving ? 'Guardando...' : '💾 Guardar Configuracion'}
      </button>
    </div>
  );
}
