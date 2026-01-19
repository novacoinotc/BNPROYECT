'use client';

import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

interface TradeMethod {
  payType: string;
  payBank?: string;
  identifier?: string;
}

interface AdData {
  advNo: string;
  asset: string;
  fiatUnit: string;
  price: string;
  priceType: string | number;
  priceFloatingRatio: string | number;
  minSingleTransAmount?: string;
  maxSingleTransAmount?: string;
  minAmount?: string;
  maxAmount?: string;
  surplusAmount: string;
  tradeMethods: TradeMethod[];
  advStatus?: number;
  status?: string;
  tradeType?: string;
  autoReplyMsg?: string;
  remarks?: string;
}

interface Seller {
  userNo: string;
  nickName: string;
  price: string;
  surplusAmount: string;
  isOnline: boolean;
  monthOrderCount: number;
  proMerchant: boolean;
}

interface AdsResponse {
  success: boolean;
  sellAds: AdData[];
  buyAds?: AdData[];
}

interface BotConfig {
  positioningEnabled: boolean;
  positioningConfigs: Record<string, any>;
}

type FilterType = 'all' | 'active' | 'paused';
type AssetFilter = 'ALL' | 'USDT' | 'USDC' | 'BTC' | 'ETH' | 'BNB';
type ViewType = 'grid' | 'list';

async function fetchAds(): Promise<AdsResponse> {
  const response = await fetch('/api/ads');
  return response.json();
}

async function fetchConfig(): Promise<BotConfig> {
  const response = await fetch('/api/bot-control');
  const data = await response.json();
  return data.config;
}

function getAdStatus(ad: AdData): { isOnline: boolean; label: string } {
  if (ad.advStatus !== undefined) {
    return {
      isOnline: ad.advStatus === 1,
      label: ad.advStatus === 1 ? 'ACTIVO' : 'PAUSADO',
    };
  }
  const isOnline = ad.status === 'ONLINE';
  return { isOnline, label: isOnline ? 'ACTIVO' : 'PAUSADO' };
}

export default function Dashboard() {
  const [filter, setFilter] = useState<FilterType>('all');
  const [assetFilter, setAssetFilter] = useState<AssetFilter>('ALL');
  const [viewType, setViewType] = useState<ViewType>('grid');
  const [showFollowModal, setShowFollowModal] = useState<string | null>(null);
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [loadingSellers, setLoadingSellers] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['ads'],
    queryFn: fetchAds,
    refetchInterval: 30000,
  });

  const { data: config } = useQuery({
    queryKey: ['bot-config'],
    queryFn: fetchConfig,
    refetchInterval: 10000,
  });

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ['ads'] });
    queryClient.invalidateQueries({ queryKey: ['bot-config'] });
  };

  // Combine sell and buy ads
  const allAds = [...(data?.sellAds || []), ...(data?.buyAds || [])];

  // Get unique assets from ads
  const availableAssets = Array.from(new Set(allAds.map(ad => ad.asset)));

  const filteredAds = allAds.filter((ad) => {
    // Status filter
    if (filter !== 'all') {
      const status = getAdStatus(ad);
      if (filter === 'active' && !status.isOnline) return false;
      if (filter === 'paused' && status.isOnline) return false;
    }
    // Asset filter
    if (assetFilter !== 'ALL' && ad.asset !== assetFilter) return false;
    return true;
  });

  const activeCount = allAds.filter((ad) => getAdStatus(ad).isOnline).length;
  const pausedCount = allAds.filter((ad) => !getAdStatus(ad).isOnline).length;

  // Fetch sellers for follow modal
  const fetchSellersForAd = useCallback(async (ad: AdData) => {
    setLoadingSellers(true);
    const tradeType = ad.tradeType === 'SELL' ? 'BUY' : 'SELL';
    try {
      const response = await fetch(`/api/sellers?asset=${ad.asset}&fiat=${ad.fiatUnit}&tradeType=${tradeType}&rows=10`);
      const data = await response.json();
      if (data.success) {
        setSellers(data.sellers);
      }
    } catch (err) {
      console.error('Error fetching sellers:', err);
    } finally {
      setLoadingSellers(false);
    }
  }, []);

  // Handle TOP 1 action - Set to smart mode
  const handleTop1 = async (ad: AdData) => {
    setActionLoading(`top-${ad.advNo}`);
    try {
      const key = `${ad.tradeType || 'SELL'}:${ad.asset}`;
      const currentConfigs = config?.positioningConfigs || {};

      await fetch('/api/bot-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          positioningEnabled: true,
          positioningConfigs: {
            ...currentConfigs,
            [key]: {
              enabled: true,
              mode: 'smart',
              followTarget: null,
              matchPrice: false,
              undercutCents: 1,
            },
          },
        }),
      });
      queryClient.invalidateQueries({ queryKey: ['bot-config'] });
    } catch (err) {
      console.error('Error setting TOP 1:', err);
    } finally {
      setActionLoading(null);
    }
  };

  // Handle follow target selection
  const handleFollowSelect = async (ad: AdData, targetNickName: string) => {
    setActionLoading(`follow-${ad.advNo}`);
    try {
      const key = `${ad.tradeType || 'SELL'}:${ad.asset}`;
      const currentConfigs = config?.positioningConfigs || {};

      await fetch('/api/bot-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          positioningEnabled: true,
          positioningConfigs: {
            ...currentConfigs,
            [key]: {
              enabled: true,
              mode: 'follow',
              followTarget: targetNickName,
              matchPrice: true,
              undercutCents: 1,
            },
          },
        }),
      });
      queryClient.invalidateQueries({ queryKey: ['bot-config'] });
      setShowFollowModal(null);
    } catch (err) {
      console.error('Error setting follow:', err);
    } finally {
      setActionLoading(null);
    }
  };

  // Get current positioning config for an ad
  const getAdPositioning = (ad: AdData) => {
    const key = `${ad.tradeType || 'SELL'}:${ad.asset}`;
    return config?.positioningConfigs?.[key] || null;
  };

  return (
    <div className="space-y-4 pb-4">
      {/* Header with Tabs and Controls */}
      <div className="flex flex-col gap-3">
        {/* Status Filter Tabs */}
        <div className="flex items-center gap-1 bg-[#0f1520] rounded-xl p-1 overflow-x-auto">
          <button
            onClick={() => setFilter('all')}
            className={`tab whitespace-nowrap ${filter === 'all' ? 'tab-active' : 'tab-inactive'}`}
          >
            TODOS
          </button>
          <button
            onClick={() => setFilter('active')}
            className={`tab whitespace-nowrap ${filter === 'active' ? 'tab-active' : 'tab-inactive'}`}
          >
            ACTIVOS
            {activeCount > 0 && (
              <span className="ml-1 text-xs text-emerald-400">({activeCount})</span>
            )}
          </button>
          <button
            onClick={() => setFilter('paused')}
            className={`tab whitespace-nowrap ${filter === 'paused' ? 'tab-active' : 'tab-inactive'}`}
          >
            PAUSADOS
            {pausedCount > 0 && (
              <span className="ml-1 text-xs text-gray-500">({pausedCount})</span>
            )}
          </button>
        </div>

        {/* Asset Filter + View Controls */}
        <div className="flex items-center justify-between gap-2">
          {/* Asset Filter Chips - Scrollable */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 flex-1">
            <button
              onClick={() => setAssetFilter('ALL')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition ${
                assetFilter === 'ALL'
                  ? 'bg-primary-500 text-white'
                  : 'bg-[#1e2a3e] text-gray-400 hover:text-white'
              }`}
            >
              Todos
            </button>
            {(['USDT', 'USDC', 'BTC', 'ETH', 'BNB'] as AssetFilter[]).map(asset => {
              const count = allAds.filter(ad => ad.asset === asset).length;
              if (count === 0 && !availableAssets.includes(asset)) return null;
              return (
                <button
                  key={asset}
                  onClick={() => setAssetFilter(asset)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition ${
                    assetFilter === asset
                      ? 'bg-primary-500 text-white'
                      : 'bg-[#1e2a3e] text-gray-400 hover:text-white'
                  }`}
                >
                  {asset}
                  {count > 0 && <span className="ml-1 opacity-60">({count})</span>}
                </button>
              );
            })}
          </div>

          {/* View Controls */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* View Type Toggle */}
            <div className="flex items-center bg-[#0f1520] rounded-xl p-1">
              <button
                onClick={() => setViewType('grid')}
                className={`p-1.5 rounded-lg transition-colors ${
                  viewType === 'grid' ? 'bg-[#1e2a3e] text-white' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                </svg>
              </button>
              <button
                onClick={() => setViewType('list')}
                className={`p-1.5 rounded-lg transition-colors ${
                  viewType === 'list' ? 'bg-[#1e2a3e] text-white' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                </svg>
              </button>
            </div>

            {/* Refresh Button */}
            <button
              onClick={handleRefresh}
              className="flex items-center gap-1.5 bg-primary-500 hover:bg-primary-600 text-white px-3 py-2 rounded-xl font-medium transition-all duration-200 text-sm"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span className="hidden sm:inline">REFRESCAR</span>
            </button>
          </div>
        </div>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="ad-card animate-pulse">
              <div className="h-6 bg-[#1e2a3e] rounded w-1/3 mb-4"></div>
              <div className="h-10 bg-[#1e2a3e] rounded w-1/2 mb-4"></div>
              <div className="space-y-2">
                <div className="h-3 bg-[#1e2a3e] rounded w-2/3"></div>
                <div className="h-3 bg-[#1e2a3e] rounded w-1/2"></div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="card p-6 text-center">
          <p className="text-red-400 mb-2">Error al cargar anuncios</p>
          <button onClick={handleRefresh} className="text-primary-500 hover:underline text-sm">
            Reintentar
          </button>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && filteredAds.length === 0 && (
        <div className="card p-8 text-center">
          <div className="w-14 h-14 bg-[#1e2a3e] rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
          </div>
          <p className="text-gray-400 mb-1">No hay anuncios</p>
          <p className="text-gray-600 text-sm">
            {filter === 'all' && assetFilter === 'ALL'
              ? 'Crea un anuncio en Binance P2P'
              : 'No hay anuncios con estos filtros'}
          </p>
        </div>
      )}

      {/* Ads Grid */}
      {!isLoading && !error && filteredAds.length > 0 && (
        <div className={`grid gap-3 ${
          viewType === 'grid'
            ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
            : 'grid-cols-1'
        }`}>
          {filteredAds.map((ad) => (
            <AdCard
              key={ad.advNo}
              ad={ad}
              viewType={viewType}
              positioning={getAdPositioning(ad)}
              botEnabled={config?.positioningEnabled || false}
              onTop1={() => handleTop1(ad)}
              onFollow={() => {
                setShowFollowModal(ad.advNo);
                fetchSellersForAd(ad);
              }}
              actionLoading={actionLoading}
            />
          ))}
        </div>
      )}

      {/* Follow Modal */}
      {showFollowModal && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-[#151d2e] rounded-2xl w-full max-w-md max-h-[70vh] overflow-hidden">
            <div className="p-4 border-b border-[#1e2a3e] flex items-center justify-between">
              <h3 className="text-lg font-bold text-white">Seleccionar competidor</h3>
              <button
                onClick={() => setShowFollowModal(null)}
                className="text-gray-400 hover:text-white p-1"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-4 overflow-y-auto max-h-[50vh]">
              {loadingSellers ? (
                <div className="flex justify-center py-8">
                  <div className="animate-spin h-6 w-6 border-2 border-primary-500 border-t-transparent rounded-full"></div>
                </div>
              ) : sellers.length > 0 ? (
                <div className="space-y-2">
                  {sellers.map((seller, idx) => {
                    const ad = allAds.find(a => a.advNo === showFollowModal);
                    return (
                      <button
                        key={seller.userNo}
                        onClick={() => ad && handleFollowSelect(ad, seller.nickName)}
                        disabled={actionLoading !== null}
                        className="w-full text-left p-3 rounded-xl bg-gray-800 hover:bg-gray-700 transition disabled:opacity-50"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-gray-500 font-mono text-sm">#{idx + 1}</span>
                            <span className="text-white font-medium">{seller.nickName}</span>
                            {seller.proMerchant && (
                              <span className="px-1.5 py-0.5 bg-amber-500/30 text-amber-400 text-[10px] rounded font-bold">PRO</span>
                            )}
                            {seller.isOnline && <span className="w-2 h-2 bg-emerald-500 rounded-full"></span>}
                          </div>
                          <span className="text-white font-bold">${parseFloat(seller.price).toFixed(2)}</span>
                        </div>
                        <div className="flex gap-3 mt-1 text-xs text-gray-500">
                          <span>{seller.monthOrderCount} ordenes</span>
                          <span>{parseFloat(seller.surplusAmount).toLocaleString()} disponible</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  No se encontraron competidores
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface AdCardProps {
  ad: AdData;
  viewType: ViewType;
  positioning: any;
  botEnabled: boolean;
  onTop1: () => void;
  onFollow: () => void;
  actionLoading: string | null;
}

function AdCard({ ad, viewType, positioning, botEnabled, onTop1, onFollow, actionLoading }: AdCardProps) {
  const status = getAdStatus(ad);
  const minAmount = ad.minSingleTransAmount || ad.minAmount || '0';
  const maxAmount = ad.maxSingleTransAmount || ad.maxAmount || '0';
  const isSell = ad.tradeType === 'SELL' || !ad.tradeType;

  // Positioning status
  const isPositioningActive = botEnabled && positioning?.enabled !== false;
  const positioningMode = positioning?.mode;
  const followTarget = positioning?.followTarget;

  if (viewType === 'list') {
    return (
      <div className={`ad-card flex items-center justify-between gap-3 ${status.isOnline ? 'active' : ''}`}>
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-lg font-bold text-white">{ad.asset}</span>
              <span className="text-gray-500 text-sm">{ad.fiatUnit}</span>
              <span className={isSell ? 'badge-sell' : 'badge-buy'}>
                {isSell ? 'VENTA' : 'COMPRA'}
              </span>
              {isPositioningActive && (
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                  positioningMode === 'smart' ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400'
                }`}>
                  {positioningMode === 'smart' ? '🤖' : `👤 ${followTarget?.slice(0, 8)}...`}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
              <span>{parseFloat(minAmount).toLocaleString()} - {parseFloat(maxAmount).toLocaleString()}</span>
              <span>{parseFloat(ad.surplusAmount).toLocaleString()} {ad.asset}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="text-xl sm:text-2xl font-bold text-white">
            {parseFloat(ad.price).toLocaleString()}
          </span>
          <div className={`w-3 h-3 rounded-full flex-shrink-0 ${status.isOnline ? 'bg-emerald-500' : 'bg-gray-600'}`}></div>
        </div>
      </div>
    );
  }

  return (
    <div className={`ad-card ${status.isOnline ? 'active' : ''}`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-lg sm:text-xl font-bold text-white">{ad.asset}</span>
            <span className="text-gray-500 text-sm">{ad.fiatUnit}</span>
          </div>
          <span className={`inline-block mt-1.5 ${isSell ? 'badge-sell' : 'badge-buy'}`}>
            {isSell ? 'VENTA' : 'COMPRA'}
          </span>
        </div>
        <span className="text-2xl sm:text-3xl font-bold text-white">
          {parseFloat(ad.price).toLocaleString()}
        </span>
      </div>

      {/* Positioning Status */}
      {isPositioningActive && (
        <div className={`mb-3 p-2 rounded-lg text-xs ${
          positioningMode === 'smart' ? 'bg-amber-500/10 border border-amber-500/30' : 'bg-blue-500/10 border border-blue-500/30'
        }`}>
          <div className="flex items-center gap-2">
            <span>{positioningMode === 'smart' ? '🤖 Smart Mode' : '👤 Siguiendo'}</span>
            {followTarget && <span className="font-bold text-white">{followTarget}</span>}
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="space-y-2 mb-3">
        <div className="flex items-center justify-between">
          <div className="h-1.5 bg-[#1e2a3e] rounded-full flex-1 mr-3">
            <div
              className="h-full bg-gradient-to-r from-primary-500 to-primary-400 rounded-full"
              style={{ width: '60%' }}
            ></div>
          </div>
          <span className="text-xs text-gray-400">
            {parseFloat(ad.surplusAmount).toLocaleString()} {ad.asset}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <div className="h-1.5 bg-[#1e2a3e] rounded-full flex-1 mr-3">
            <div
              className="h-full bg-gradient-to-r from-gray-600 to-gray-500 rounded-full"
              style={{ width: '40%' }}
            ></div>
          </div>
          <span className="text-xs text-gray-500">
            {parseFloat(minAmount).toLocaleString()} - {parseFloat(maxAmount).toLocaleString()} {ad.fiatUnit}
          </span>
        </div>
      </div>

      {/* Payment Methods */}
      <div className="flex flex-wrap gap-1 mb-3">
        {ad.tradeMethods.slice(0, 3).map((method, idx) => (
          <span
            key={idx}
            className="px-2 py-0.5 bg-[#1e2a3e] rounded text-[10px] text-gray-400"
          >
            {method.identifier || method.payType}
          </span>
        ))}
        {ad.tradeMethods.length > 3 && (
          <span className="px-2 py-0.5 bg-[#1e2a3e] rounded text-[10px] text-gray-500">
            +{ad.tradeMethods.length - 3}
          </span>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-3 border-t border-[#1e2a3e]">
        <div className="flex items-center gap-2">
          <button
            onClick={onTop1}
            disabled={actionLoading === `top-${ad.advNo}`}
            className={`btn-outline text-xs py-1.5 px-2.5 flex items-center gap-1 ${
              positioningMode === 'smart' && isPositioningActive ? 'border-amber-500/50 text-amber-400' : ''
            }`}
          >
            {actionLoading === `top-${ad.advNo}` ? (
              <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin"></div>
            ) : (
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            )}
            TOP 1
          </button>
          <button
            onClick={onFollow}
            disabled={actionLoading !== null}
            className={`btn-outline text-xs py-1.5 px-2.5 flex items-center gap-1 ${
              positioningMode === 'follow' && isPositioningActive ? 'border-blue-500/50 text-blue-400' : ''
            }`}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
            FOLLOW
          </button>
        </div>
        <div className={`w-3 h-3 rounded-full ${status.isOnline ? 'bg-emerald-500' : 'bg-gray-600'}`}></div>
      </div>
    </div>
  );
}
