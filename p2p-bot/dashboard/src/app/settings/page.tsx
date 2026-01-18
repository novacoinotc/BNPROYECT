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
  // SELL config (defaults)
  sellMode: string;
  sellFollowTarget: string | null;
  // BUY config (defaults)
  buyMode: string;
  buyFollowTarget: string | null;
  // Per-asset configs (overrides)
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

export default function SettingsPage() {
  const [config, setConfig] = useState<BotConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // SELL config state
  const [sellMode, setSellMode] = useState('smart');
  const [sellFollowTarget, setSellFollowTarget] = useState('');
  const [sellSellers, setSellSellers] = useState<Seller[]>([]);
  const [loadingSellSellers, setLoadingSellSellers] = useState(false);

  // BUY config state
  const [buyMode, setBuyMode] = useState('smart');
  const [buyFollowTarget, setBuyFollowTarget] = useState('');
  const [buySellers, setBuySellers] = useState<Seller[]>([]);
  const [loadingBuySellers, setLoadingBuySellers] = useState(false);

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

  // Per-asset configs (overrides)
  const [positioningConfigs, setPositioningConfigs] = useState<PositioningConfigsMap>({});
  const [newConfigKey, setNewConfigKey] = useState('');
  const [newConfigMode, setNewConfigMode] = useState<'smart' | 'follow'>('follow');
  const [newConfigTarget, setNewConfigTarget] = useState('');

  const ASSETS = ['USDT', 'BTC', 'ETH', 'USDC', 'BNB', 'FDUSD'];
  const TRADE_TYPES = ['SELL', 'BUY'];

  // Fetch sellers for SELL ads (looking for other sellers to compete with)
  const fetchSellSellers = useCallback(async () => {
    setLoadingSellSellers(true);
    try {
      // For SELL ads, we search with BUY to find other sellers
      const response = await fetch(`/api/sellers?asset=USDT&fiat=MXN&tradeType=BUY&rows=20`);
      const data = await response.json();
      if (data.success) setSellSellers(data.sellers);
    } catch (err) {
      console.error('Error fetching sell sellers:', err);
    } finally {
      setLoadingSellSellers(false);
    }
  }, []);

  // Fetch sellers for BUY ads (looking for other buyers to compete with)
  const fetchBuySellers = useCallback(async () => {
    setLoadingBuySellers(true);
    try {
      // For BUY ads, we search with SELL to find other buyers
      const response = await fetch(`/api/sellers?asset=USDT&fiat=MXN&tradeType=SELL&rows=20`);
      const data = await response.json();
      if (data.success) setBuySellers(data.sellers);
    } catch (err) {
      console.error('Error fetching buy sellers:', err);
    } finally {
      setLoadingBuySellers(false);
    }
  }, []);

  const fetchConfig = useCallback(async () => {
    try {
      const response = await fetch('/api/bot-control');
      const data = await response.json();

      if (data.success) {
        setConfig(data.config);
        // SELL config (defaults)
        setSellMode(data.config.sellMode || 'smart');
        setSellFollowTarget(data.config.sellFollowTarget || '');
        // BUY config (defaults)
        setBuyMode(data.config.buyMode || 'smart');
        setBuyFollowTarget(data.config.buyFollowTarget || '');
        // Per-asset configs
        setPositioningConfigs(data.config.positioningConfigs || {});
        // Smart filters
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

  // Fetch sellers when follow mode is selected
  useEffect(() => {
    if (sellMode === 'follow') fetchSellSellers();
  }, [sellMode, fetchSellSellers]);

  useEffect(() => {
    if (buyMode === 'follow') fetchBuySellers();
  }, [buyMode, fetchBuySellers]);

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

  const savePositioningConfig = () => {
    updateConfig({
      sellMode,
      sellFollowTarget: sellMode === 'follow' ? sellFollowTarget : null,
      buyMode,
      buyFollowTarget: buyMode === 'follow' ? buyFollowTarget : null,
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

  // Add per-asset config
  const addAssetConfig = () => {
    if (!newConfigKey) return;
    const key = newConfigKey.toUpperCase();
    setPositioningConfigs(prev => ({
      ...prev,
      [key]: {
        mode: newConfigMode,
        followTarget: newConfigMode === 'follow' ? newConfigTarget : null,
      },
    }));
    setNewConfigKey('');
    setNewConfigTarget('');
  };

  // Remove per-asset config
  const removeAssetConfig = (key: string) => {
    setPositioningConfigs(prev => {
      const newConfigs = { ...prev };
      delete newConfigs[key];
      return newConfigs;
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
        <button onClick={fetchConfig} className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition">
          Reintentar
        </button>
      </div>
    );
  }

  // Reusable seller list component
  const SellerList = ({
    sellers,
    loading,
    selectedTarget,
    onSelect,
    onRefresh,
  }: {
    sellers: Seller[];
    loading: boolean;
    selectedTarget: string;
    onSelect: (nick: string) => void;
    onRefresh: () => void;
  }) => (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-300">Seleccionar del mercado</h4>
        <button onClick={onRefresh} disabled={loading} className="text-xs text-primary-400 hover:text-primary-300 flex items-center gap-1">
          {loading ? <span className="animate-spin">&#8635;</span> : <span>&#8635;</span>} Actualizar
        </button>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-6">
          <div className="animate-spin h-5 w-5 border-2 border-primary-500 border-t-transparent rounded-full"></div>
        </div>
      ) : sellers.length > 0 ? (
        <div className="max-h-48 overflow-y-auto space-y-1.5 pr-2">
          {sellers.map((seller, index) => (
            <button
              key={seller.userNo}
              onClick={() => onSelect(seller.nickName)}
              className={`w-full text-left p-2 rounded-lg border transition-all text-sm ${
                selectedTarget === seller.nickName
                  ? 'bg-primary-500/20 border-primary-500/50'
                  : 'bg-gray-700/50 border-gray-600 hover:border-gray-500'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 text-xs w-4">#{index + 1}</span>
                  <span className="text-white font-medium">{seller.nickName}</span>
                  {seller.proMerchant && <span className="px-1 py-0.5 bg-amber-500/20 text-amber-400 text-[9px] rounded">PRO</span>}
                  {seller.isOnline && <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full"></span>}
                </div>
                <span className="text-white font-bold">${parseFloat(seller.price).toLocaleString()}</span>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="text-center py-3 text-gray-500 text-sm">No se encontraron vendedores</div>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Configuracion del Bot</h1>
          <p className="text-gray-400 text-sm mt-1">Kill switches y posicionamiento por VENTA/COMPRA y moneda</p>
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
          <div className={`mt-4 p-3 rounded-lg border ${
            config?.releaseEnabled ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-red-500/10 border-red-500/30 text-red-400'
          }`}>
            <span className="font-medium">{config?.releaseEnabled ? '&#10003; ACTIVO' : '&#10007; DETENIDO'}</span>
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
          <div className={`mt-4 p-3 rounded-lg border ${
            config?.positioningEnabled ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-red-500/10 border-red-500/30 text-red-400'
          }`}>
            <span className="font-medium">{config?.positioningEnabled ? '&#10003; ACTIVO' : '&#10007; DETENIDO'}</span>
          </div>
        </div>
      </div>

      {/* Positioning Configuration - Split SELL/BUY (Defaults) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* SELL Ads Configuration */}
        <div className="card p-6 border-l-4 border-l-emerald-500">
          <h2 className="text-lg font-semibold text-white mb-1 flex items-center gap-2">
            <span className="text-emerald-400">VENTA</span>
            <span className="text-gray-400 text-sm font-normal">(Default)</span>
          </h2>
          <p className="text-gray-500 text-xs mb-4">Aplica a todas las monedas sin config especifica</p>

          {/* Mode Selection */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-300 mb-2">Modo</label>
            <div className="flex gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="sellMode" value="smart" checked={sellMode === 'smart'} onChange={(e) => setSellMode(e.target.value)} className="w-4 h-4 text-primary-600" />
                <span className="text-white text-sm">Smart</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="sellMode" value="follow" checked={sellMode === 'follow'} onChange={(e) => setSellMode(e.target.value)} className="w-4 h-4 text-primary-600" />
                <span className="text-white text-sm">Follow</span>
              </label>
            </div>
          </div>

          {/* Follow Mode Config */}
          {sellMode === 'follow' && (
            <div className="space-y-3 p-3 bg-gray-800/50 rounded-lg">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Siguiendo a:</label>
                <input
                  type="text"
                  value={sellFollowTarget}
                  onChange={(e) => setSellFollowTarget(e.target.value)}
                  placeholder="NickName del vendedor"
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm"
                />
              </div>
              <SellerList
                sellers={sellSellers}
                loading={loadingSellSellers}
                selectedTarget={sellFollowTarget}
                onSelect={setSellFollowTarget}
                onRefresh={fetchSellSellers}
              />
            </div>
          )}

          {sellMode === 'smart' && (
            <div className="p-3 bg-gray-800/50 rounded-lg text-sm text-gray-400">
              Usa filtros inteligentes para encontrar el mejor precio (config compartida abajo)
            </div>
          )}
        </div>

        {/* BUY Ads Configuration */}
        <div className="card p-6 border-l-4 border-l-red-500">
          <h2 className="text-lg font-semibold text-white mb-1 flex items-center gap-2">
            <span className="text-red-400">COMPRA</span>
            <span className="text-gray-400 text-sm font-normal">(Default)</span>
          </h2>
          <p className="text-gray-500 text-xs mb-4">Aplica a todas las monedas sin config especifica</p>

          {/* Mode Selection */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-300 mb-2">Modo</label>
            <div className="flex gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="buyMode" value="smart" checked={buyMode === 'smart'} onChange={(e) => setBuyMode(e.target.value)} className="w-4 h-4 text-primary-600" />
                <span className="text-white text-sm">Smart</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="buyMode" value="follow" checked={buyMode === 'follow'} onChange={(e) => setBuyMode(e.target.value)} className="w-4 h-4 text-primary-600" />
                <span className="text-white text-sm">Follow</span>
              </label>
            </div>
          </div>

          {/* Follow Mode Config */}
          {buyMode === 'follow' && (
            <div className="space-y-3 p-3 bg-gray-800/50 rounded-lg">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Siguiendo a:</label>
                <input
                  type="text"
                  value={buyFollowTarget}
                  onChange={(e) => setBuyFollowTarget(e.target.value)}
                  placeholder="NickName del comprador"
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm"
                />
              </div>
              <SellerList
                sellers={buySellers}
                loading={loadingBuySellers}
                selectedTarget={buyFollowTarget}
                onSelect={setBuyFollowTarget}
                onRefresh={fetchBuySellers}
              />
            </div>
          )}

          {buyMode === 'smart' && (
            <div className="p-3 bg-gray-800/50 rounded-lg text-sm text-gray-400">
              Usa filtros inteligentes para encontrar el mejor precio (config compartida abajo)
            </div>
          )}
        </div>
      </div>

      {/* Per-Asset Configuration */}
      <div className="card p-6">
        <h2 className="text-lg font-semibold text-white mb-2">Configuracion por Moneda</h2>
        <p className="text-gray-400 text-sm mb-4">
          Configura diferentes estrategias por tipo de anuncio y moneda. Estas configuraciones tienen prioridad sobre los defaults de arriba.
        </p>

        {/* Existing per-asset configs */}
        {Object.keys(positioningConfigs).length > 0 && (
          <div className="space-y-2 mb-4">
            {Object.entries(positioningConfigs).map(([key, cfg]) => (
              <div key={key} className="flex items-center justify-between p-3 bg-gray-800/50 rounded-lg border border-gray-700">
                <div className="flex items-center gap-3">
                  <span className={`px-2 py-1 rounded text-xs font-medium ${
                    key.startsWith('SELL') ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                  }`}>
                    {key}
                  </span>
                  <span className="text-gray-300">
                    {cfg.mode === 'follow' ? (
                      <>Follow: <span className="text-white font-medium">{cfg.followTarget || 'No target'}</span></>
                    ) : (
                      <span className="text-amber-400">Smart Mode</span>
                    )}
                  </span>
                </div>
                <button
                  onClick={() => removeAssetConfig(key)}
                  className="text-red-400 hover:text-red-300 text-sm px-2 py-1"
                >
                  Eliminar
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add new per-asset config */}
        <div className="p-4 bg-gray-800/30 rounded-lg border border-gray-700">
          <h4 className="text-sm font-medium text-gray-300 mb-3">Agregar configuracion</h4>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Tipo:Moneda</label>
              <select
                value={newConfigKey}
                onChange={(e) => setNewConfigKey(e.target.value)}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm"
              >
                <option value="">Seleccionar...</option>
                {TRADE_TYPES.map(tt =>
                  ASSETS.map(asset => {
                    const key = `${tt}:${asset}`;
                    // Don't show if already configured
                    if (positioningConfigs[key]) return null;
                    return (
                      <option key={key} value={key}>
                        {tt === 'SELL' ? 'VENTA' : 'COMPRA'} - {asset}
                      </option>
                    );
                  })
                )}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Modo</label>
              <select
                value={newConfigMode}
                onChange={(e) => setNewConfigMode(e.target.value as 'smart' | 'follow')}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm"
              >
                <option value="smart">Smart</option>
                <option value="follow">Follow</option>
              </select>
            </div>
            {newConfigMode === 'follow' && (
              <div>
                <label className="block text-xs text-gray-400 mb-1">Seguir a</label>
                <input
                  type="text"
                  value={newConfigTarget}
                  onChange={(e) => setNewConfigTarget(e.target.value)}
                  placeholder="NickName"
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm"
                />
              </div>
            )}
            <div className="flex items-end">
              <button
                onClick={addAssetConfig}
                disabled={!newConfigKey || (newConfigMode === 'follow' && !newConfigTarget)}
                className="w-full px-4 py-2 bg-primary-600 text-white rounded hover:bg-primary-700 transition disabled:opacity-50 text-sm"
              >
                Agregar
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Smart Filters (Shared) */}
      <div className="card p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Filtros Smart (Compartidos)</h2>
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
      <button onClick={savePositioningConfig} disabled={saving} className="w-full px-6 py-3 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition disabled:opacity-50 font-medium">
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
