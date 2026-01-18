'use client';

import { useState, useEffect, useCallback } from 'react';

interface Seller {
  position: number;
  userNo: string;
  nickName: string;
  price: string;
  surplusAmount: string;
  minAmount: string;
  maxAmount: string;
  isOnline: boolean;
  userGrade: number;
  monthFinishRate: number;
  monthOrderCount: number;
  positiveRate: number;
  proMerchant: boolean;
}

// Per-asset positioning config
interface AssetPositioningConfig {
  mode: 'smart' | 'follow';
  followTarget: string | null;
}

// Map of "TRADE_TYPE:ASSET" -> config
type PositioningConfigsMap = Record<string, AssetPositioningConfig>;

interface BotConfig {
  releaseEnabled: boolean;
  positioningEnabled: boolean;
  positioningConfigs: PositioningConfigsMap;
  // Smart filters (shared)
  smartMinUserGrade: number;
  smartMinFinishRate: number;
  smartMinOrderCount: number;
  smartMinPositiveRate: number;
  smartRequireOnline: boolean;
  smartMinSurplus: number;
  // Strategy
  undercutCents: number;
  matchPrice: boolean;
  // Status
  releaseLastActive: string | null;
  positioningLastActive: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

const ASSETS = ['USDT', 'BTC', 'ETH', 'USDC', 'BNB'];

export default function SettingsPage() {
  const [config, setConfig] = useState<BotConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Selected asset tab
  const [selectedAsset, setSelectedAsset] = useState('USDT');

  // Per-asset configs
  const [positioningConfigs, setPositioningConfigs] = useState<PositioningConfigsMap>({});

  // Sellers cache per search key
  const [sellersCache, setSellersCache] = useState<Record<string, Seller[]>>({});
  const [loadingSellers, setLoadingSellers] = useState<Record<string, boolean>>({});

  // Smart filters (shared)
  const [smartFilters, setSmartFilters] = useState({
    minUserGrade: 2,
    minFinishRate: 90,
    minOrderCount: 10,
    minPositiveRate: 95,
    requireOnline: true,
    minSurplus: 100,
  });

  // Strategy
  const [undercutCents, setUndercutCents] = useState(1);
  const [matchPrice, setMatchPrice] = useState(false);

  // Get config for a specific asset and trade type
  const getAssetConfig = (asset: string, tradeType: 'SELL' | 'BUY'): AssetPositioningConfig => {
    const key = `${tradeType}:${asset}`;
    return positioningConfigs[key] || { mode: 'smart', followTarget: null };
  };

  // Update config for a specific asset and trade type
  const updateAssetConfig = (asset: string, tradeType: 'SELL' | 'BUY', updates: Partial<AssetPositioningConfig>) => {
    const key = `${tradeType}:${asset}`;
    setPositioningConfigs(prev => ({
      ...prev,
      [key]: {
        ...getAssetConfig(asset, tradeType),
        ...updates,
      },
    }));
  };

  // Fetch sellers for a specific asset and trade type
  const fetchSellers = useCallback(async (asset: string, tradeType: 'SELL' | 'BUY') => {
    // For SELL ads (we're selling), we search BUY to find other sellers
    // For BUY ads (we're buying), we search SELL to find other buyers
    const searchType = tradeType === 'SELL' ? 'BUY' : 'SELL';
    const cacheKey = `${tradeType}:${asset}`;

    setLoadingSellers(prev => ({ ...prev, [cacheKey]: true }));
    try {
      const response = await fetch(`/api/sellers?asset=${asset}&fiat=MXN&tradeType=${searchType}&rows=15`);
      const data = await response.json();
      if (data.success) {
        setSellersCache(prev => ({ ...prev, [cacheKey]: data.sellers }));
      }
    } catch (err) {
      console.error(`Error fetching sellers for ${cacheKey}:`, err);
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
        setSmartFilters({
          minUserGrade: data.config.smartMinUserGrade ?? 2,
          minFinishRate: Math.round((data.config.smartMinFinishRate ?? 0.90) * 100),
          minOrderCount: data.config.smartMinOrderCount ?? 10,
          minPositiveRate: Math.round((data.config.smartMinPositiveRate ?? 0.95) * 100),
          requireOnline: data.config.smartRequireOnline ?? true,
          minSurplus: data.config.smartMinSurplus ?? 100,
        });
        setUndercutCents(data.config.undercutCents ?? 1);
        setMatchPrice(data.config.matchPrice ?? false);
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
        setSuccessMessage('Configuracion guardada');
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

  const saveAllConfig = () => {
    updateConfig({
      positioningConfigs,
      smartMinUserGrade: smartFilters.minUserGrade,
      smartMinFinishRate: smartFilters.minFinishRate / 100,
      smartMinOrderCount: smartFilters.minOrderCount,
      smartMinPositiveRate: smartFilters.minPositiveRate / 100,
      smartRequireOnline: smartFilters.requireOnline,
      smartMinSurplus: smartFilters.minSurplus,
      undercutCents,
      matchPrice,
    } as Partial<BotConfig>);
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
        <button onClick={fetchConfig} className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition">
          Reintentar
        </button>
      </div>
    );
  }

  // Asset Config Card Component
  const AssetTradeConfig = ({ asset, tradeType }: { asset: string; tradeType: 'SELL' | 'BUY' }) => {
    const key = `${tradeType}:${asset}`;
    const cfg = getAssetConfig(asset, tradeType);
    const sellers = sellersCache[key] || [];
    const isLoading = loadingSellers[key] || false;
    const isSell = tradeType === 'SELL';

    return (
      <div className={`p-4 rounded-lg border ${isSell ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
        <div className="flex items-center justify-between mb-3">
          <h3 className={`font-semibold ${isSell ? 'text-emerald-400' : 'text-red-400'}`}>
            {isSell ? 'Nosotros Vender' : 'Nosotros Comprar'}
          </h3>
          <span className={`text-xs px-2 py-1 rounded ${isSell ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}`}>
            {isSell ? 'SELL' : 'BUY'}
          </span>
        </div>

        {/* Mode Selection */}
        <div className="flex gap-4 mb-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              checked={cfg.mode === 'smart'}
              onChange={() => updateAssetConfig(asset, tradeType, { mode: 'smart', followTarget: null })}
              className="w-4 h-4"
            />
            <span className="text-sm text-white">Smart</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              checked={cfg.mode === 'follow'}
              onChange={() => updateAssetConfig(asset, tradeType, { mode: 'follow' })}
              className="w-4 h-4"
            />
            <span className="text-sm text-white">Follow</span>
          </label>
        </div>

        {/* Follow Mode Config */}
        {cfg.mode === 'follow' && (
          <div className="space-y-2">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Siguiendo a:</label>
              <input
                type="text"
                value={cfg.followTarget || ''}
                onChange={(e) => updateAssetConfig(asset, tradeType, { followTarget: e.target.value })}
                placeholder="NickName"
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm"
              />
            </div>

            {/* Seller List */}
            <div className="mt-2">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-400">Seleccionar del mercado</span>
                <button
                  onClick={() => fetchSellers(asset, tradeType)}
                  disabled={isLoading}
                  className="text-xs text-primary-400 hover:text-primary-300"
                >
                  {isLoading ? '...' : '↻ Actualizar'}
                </button>
              </div>

              {isLoading ? (
                <div className="flex justify-center py-3">
                  <div className="animate-spin h-4 w-4 border-2 border-primary-500 border-t-transparent rounded-full"></div>
                </div>
              ) : sellers.length > 0 ? (
                <div className="max-h-32 overflow-y-auto space-y-1">
                  {sellers.map((seller, idx) => (
                    <button
                      key={seller.userNo}
                      onClick={() => updateAssetConfig(asset, tradeType, { followTarget: seller.nickName })}
                      className={`w-full text-left p-2 rounded text-xs transition ${
                        cfg.followTarget === seller.nickName
                          ? 'bg-primary-500/30 border border-primary-500/50'
                          : 'bg-gray-700/50 hover:bg-gray-700'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-gray-500">#{idx + 1}</span>
                          <span className="text-white">{seller.nickName}</span>
                          {seller.proMerchant && <span className="px-1 bg-amber-500/20 text-amber-400 text-[9px] rounded">PRO</span>}
                          {seller.isOnline && <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full"></span>}
                        </div>
                        <span className="text-white font-medium">${parseFloat(seller.price).toLocaleString()}</span>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <button
                  onClick={() => fetchSellers(asset, tradeType)}
                  className="w-full py-2 text-xs text-gray-500 hover:text-gray-400"
                >
                  Clic para cargar vendedores
                </button>
              )}
            </div>
          </div>
        )}

        {cfg.mode === 'smart' && (
          <div className="p-2 bg-gray-800/50 rounded text-xs text-gray-400">
            Usa filtros inteligentes compartidos
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
          <p className="text-gray-400 text-sm mt-1">Configura cada moneda independientemente</p>
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
                <h2 className="text-lg font-semibold text-white">Bot de Liberacion</h2>
              </div>
              <p className="text-gray-400 text-sm mt-2">Verifica pagos y libera crypto automaticamente.</p>
              <div className="mt-3 text-xs text-gray-500">Ultima actividad: {formatDate(config?.releaseLastActive ?? null)}</div>
            </div>
            <button
              onClick={toggleRelease}
              disabled={saving}
              className={`relative w-16 h-8 rounded-full transition-colors duration-200 ease-in-out ${
                config?.releaseEnabled ? 'bg-emerald-600' : 'bg-gray-600'
              } ${saving ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:opacity-90'}`}
            >
              <span className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-transform duration-200 ease-in-out ${
                config?.releaseEnabled ? 'translate-x-9' : 'translate-x-1'
              }`} />
            </button>
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
              <p className="text-gray-400 text-sm mt-2">Ajusta precios automaticamente cada 5 segundos.</p>
              <div className="mt-3 text-xs text-gray-500">Ultima actividad: {formatDate(config?.positioningLastActive ?? null)}</div>
            </div>
            <button
              onClick={togglePositioning}
              disabled={saving}
              className={`relative w-16 h-8 rounded-full transition-colors duration-200 ease-in-out ${
                config?.positioningEnabled ? 'bg-emerald-600' : 'bg-gray-600'
              } ${saving ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:opacity-90'}`}
            >
              <span className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-transform duration-200 ease-in-out ${
                config?.positioningEnabled ? 'translate-x-9' : 'translate-x-1'
              }`} />
            </button>
          </div>
        </div>
      </div>

      {/* Asset Tabs */}
      <div className="card p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Configuracion por Moneda</h2>

        {/* Tab Navigation */}
        <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
          {ASSETS.map(asset => (
            <button
              key={asset}
              onClick={() => setSelectedAsset(asset)}
              className={`px-4 py-2 rounded-lg font-medium text-sm transition whitespace-nowrap ${
                selectedAsset === asset
                  ? 'bg-primary-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              {asset}
            </button>
          ))}
        </div>

        {/* Selected Asset Config */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <AssetTradeConfig asset={selectedAsset} tradeType="SELL" />
          <AssetTradeConfig asset={selectedAsset} tradeType="BUY" />
        </div>

        {/* Quick Summary of All Configs */}
        <div className="mt-6 pt-4 border-t border-gray-700">
          <h4 className="text-sm font-medium text-gray-400 mb-3">Resumen de Configuraciones</h4>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-2">
            {ASSETS.map(asset => {
              const sellCfg = getAssetConfig(asset, 'SELL');
              const buyCfg = getAssetConfig(asset, 'BUY');
              return (
                <div
                  key={asset}
                  onClick={() => setSelectedAsset(asset)}
                  className={`p-2 rounded border cursor-pointer transition ${
                    selectedAsset === asset ? 'border-primary-500 bg-primary-500/10' : 'border-gray-700 hover:border-gray-600'
                  }`}
                >
                  <div className="font-medium text-white text-sm mb-1">{asset}</div>
                  <div className="text-xs space-y-0.5">
                    <div className="flex items-center gap-1">
                      <span className="text-emerald-400">V:</span>
                      <span className="text-gray-400 truncate">
                        {sellCfg.mode === 'follow' ? sellCfg.followTarget || '?' : 'Smart'}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-red-400">C:</span>
                      <span className="text-gray-400 truncate">
                        {buyCfg.mode === 'follow' ? buyCfg.followTarget || '?' : 'Smart'}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Smart Filters (Shared) */}
      <div className="card p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Filtros Smart (Compartidos)</h2>
        <p className="text-gray-400 text-sm mb-4">Estos filtros aplican a todas las monedas en modo Smart</p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Grade Minimo</label>
            <input type="number" value={smartFilters.minUserGrade} onChange={(e) => setSmartFilters(prev => ({ ...prev, minUserGrade: parseInt(e.target.value) || 0 }))} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm" min="0" max="5" />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Finish Rate Min (%)</label>
            <input type="number" value={smartFilters.minFinishRate} onChange={(e) => setSmartFilters(prev => ({ ...prev, minFinishRate: parseInt(e.target.value) || 0 }))} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm" min="0" max="100" />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Ordenes Min/Mes</label>
            <input type="number" value={smartFilters.minOrderCount} onChange={(e) => setSmartFilters(prev => ({ ...prev, minOrderCount: parseInt(e.target.value) || 0 }))} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm" min="0" />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Positive Rate Min (%)</label>
            <input type="number" value={smartFilters.minPositiveRate} onChange={(e) => setSmartFilters(prev => ({ ...prev, minPositiveRate: parseInt(e.target.value) || 0 }))} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm" min="0" max="100" />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Surplus Min (USDT)</label>
            <input type="number" value={smartFilters.minSurplus} onChange={(e) => setSmartFilters(prev => ({ ...prev, minSurplus: parseInt(e.target.value) || 0 }))} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm" min="0" />
          </div>
          <div className="flex items-center">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={smartFilters.requireOnline} onChange={(e) => setSmartFilters(prev => ({ ...prev, requireOnline: e.target.checked }))} className="w-4 h-4 text-primary-600 rounded" />
              <span className="text-sm text-gray-300">Solo Online</span>
            </label>
          </div>
        </div>
      </div>

      {/* Price Strategy */}
      <div className="card p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Estrategia de Precio</h2>
        <div className="flex gap-4 mb-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="priceStrategy" checked={matchPrice} onChange={() => setMatchPrice(true)} className="w-4 h-4 text-primary-600" />
            <span className="text-white">Igualar precio</span>
            <span className="text-xs text-gray-500">(mismo precio que competidor)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="priceStrategy" checked={!matchPrice} onChange={() => setMatchPrice(false)} className="w-4 h-4 text-primary-600" />
            <span className="text-white">Bajar centavos</span>
            <span className="text-xs text-gray-500">(competir por precio)</span>
          </label>
        </div>
        {!matchPrice && (
          <div className="flex items-center gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Centavos a bajar</label>
              <input type="number" value={undercutCents} onChange={(e) => setUndercutCents(parseFloat(e.target.value) || 0)} className="w-32 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm" min="0" step="0.5" />
            </div>
            <div className="text-sm text-gray-400">Tu precio = Competidor - ${undercutCents.toFixed(2)} MXN</div>
          </div>
        )}
        {matchPrice && (
          <div className="p-3 bg-primary-500/10 border border-primary-500/30 rounded-lg text-sm text-primary-400">
            Tu precio = Mismo precio que el competidor/target
          </div>
        )}
      </div>

      {/* Save Button */}
      <button onClick={saveAllConfig} disabled={saving} className="w-full px-6 py-3 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition disabled:opacity-50 font-medium">
        {saving ? 'Guardando...' : 'Guardar Configuracion'}
      </button>

      {/* Info */}
      {config && (
        <div className="text-center text-xs text-gray-500">
          Ultima actualizacion: {formatDate(config.updatedAt)} {config.updatedBy && ` por ${config.updatedBy}`}
        </div>
      )}
    </div>
  );
}
