'use client';

import { useState } from 'react';
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

interface AdsResponse {
  success: boolean;
  sellAds: AdData[];
  buyAds?: AdData[];
}

type FilterType = 'all' | 'active' | 'paused';
type ViewType = 'grid' | 'list';

async function fetchAds(): Promise<AdsResponse> {
  const response = await fetch('/api/ads');
  return response.json();
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
  const [viewType, setViewType] = useState<ViewType>('grid');
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['ads'],
    queryFn: fetchAds,
    refetchInterval: 30000,
  });

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ['ads'] });
  };

  const allAds = data?.sellAds || [];
  const filteredAds = allAds.filter((ad) => {
    if (filter === 'all') return true;
    const status = getAdStatus(ad);
    if (filter === 'active') return status.isOnline;
    if (filter === 'paused') return !status.isOnline;
    return true;
  });

  const activeCount = allAds.filter((ad) => getAdStatus(ad).isOnline).length;
  const pausedCount = allAds.filter((ad) => !getAdStatus(ad).isOnline).length;

  return (
    <div className="space-y-6">
      {/* Header with Tabs and Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        {/* Filter Tabs */}
        <div className="flex items-center gap-1 bg-[#0f1520] rounded-xl p-1">
          <button
            onClick={() => setFilter('all')}
            className={`tab ${filter === 'all' ? 'tab-active' : 'tab-inactive'}`}
          >
            TODOS
          </button>
          <button
            onClick={() => setFilter('active')}
            className={`tab ${filter === 'active' ? 'tab-active' : 'tab-inactive'}`}
          >
            ACTIVOS
            {activeCount > 0 && (
              <span className="ml-1.5 text-xs text-emerald-400">({activeCount})</span>
            )}
          </button>
          <button
            onClick={() => setFilter('paused')}
            className={`tab ${filter === 'paused' ? 'tab-active' : 'tab-inactive'}`}
          >
            PAUSADOS
            {pausedCount > 0 && (
              <span className="ml-1.5 text-xs text-gray-500">({pausedCount})</span>
            )}
          </button>
        </div>

        {/* View Controls */}
        <div className="flex items-center gap-2">
          {/* View Type Toggle */}
          <div className="flex items-center bg-[#0f1520] rounded-xl p-1">
            <button
              onClick={() => setViewType('grid')}
              className={`p-2 rounded-lg transition-colors ${
                viewType === 'grid' ? 'bg-[#1e2a3e] text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
            </button>
            <button
              onClick={() => setViewType('list')}
              className={`p-2 rounded-lg transition-colors ${
                viewType === 'list' ? 'bg-[#1e2a3e] text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
              </svg>
            </button>
          </div>

          {/* Refresh Button */}
          <button
            onClick={handleRefresh}
            className="flex items-center gap-2 bg-primary-500 hover:bg-primary-600 text-white px-4 py-2.5 rounded-xl font-medium transition-all duration-200"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            REFRESCAR
          </button>
        </div>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
        <div className="card p-8 text-center">
          <p className="text-red-400 mb-2">Error al cargar anuncios</p>
          <button onClick={handleRefresh} className="text-primary-500 hover:underline text-sm">
            Reintentar
          </button>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && filteredAds.length === 0 && (
        <div className="card p-12 text-center">
          <div className="w-16 h-16 bg-[#1e2a3e] rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
          </div>
          <p className="text-gray-400 mb-1">No hay anuncios</p>
          <p className="text-gray-600 text-sm">
            {filter === 'all' ? 'Crea un anuncio en Binance P2P' : `No tienes anuncios ${filter === 'active' ? 'activos' : 'pausados'}`}
          </p>
        </div>
      )}

      {/* Ads Grid */}
      {!isLoading && !error && filteredAds.length > 0 && (
        <div className={`grid gap-4 ${
          viewType === 'grid'
            ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
            : 'grid-cols-1'
        }`}>
          {filteredAds.map((ad) => (
            <AdCard key={ad.advNo} ad={ad} viewType={viewType} />
          ))}
        </div>
      )}
    </div>
  );
}

function AdCard({ ad, viewType }: { ad: AdData; viewType: ViewType }) {
  const status = getAdStatus(ad);
  const minAmount = ad.minSingleTransAmount || ad.minAmount || '0';
  const maxAmount = ad.maxSingleTransAmount || ad.maxAmount || '0';
  const isSell = ad.tradeType === 'SELL' || !ad.tradeType; // Default to sell for merchant

  if (viewType === 'list') {
    return (
      <div className={`ad-card flex items-center justify-between ${status.isOnline ? 'active' : ''}`}>
        <div className="flex items-center gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold text-white">{ad.asset}</span>
              <span className="text-gray-500 text-sm">{ad.fiatUnit}</span>
              <span className={isSell ? 'badge-sell' : 'badge-buy'}>
                {isSell ? 'VENTA' : 'COMPRA'}
              </span>
            </div>
            <div className="flex items-center gap-4 mt-1 text-sm text-gray-500">
              <span>{parseFloat(minAmount).toLocaleString()} - {parseFloat(maxAmount).toLocaleString()} {ad.fiatUnit}</span>
              <span>{parseFloat(ad.surplusAmount).toLocaleString()} {ad.asset}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-2xl font-bold text-white">
            {parseFloat(ad.price).toLocaleString()}
          </span>
          <div className={`w-3 h-3 rounded-full ${status.isOnline ? 'bg-emerald-500' : 'bg-gray-600'}`}></div>
        </div>
      </div>
    );
  }

  return (
    <div className={`ad-card ${status.isOnline ? 'active' : ''}`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold text-white">{ad.asset}</span>
            <span className="text-gray-500">{ad.fiatUnit}</span>
          </div>
          <span className={`inline-block mt-2 ${isSell ? 'badge-sell' : 'badge-buy'}`}>
            {isSell ? 'VENTA' : 'COMPRA'}
          </span>
        </div>
        <span className="text-3xl font-bold text-white">
          {parseFloat(ad.price).toLocaleString()}
        </span>
      </div>

      {/* Stats */}
      <div className="space-y-3 mb-4">
        <div className="flex items-center justify-between">
          <div className="h-1.5 bg-[#1e2a3e] rounded-full flex-1 mr-3">
            <div
              className="h-full bg-gradient-to-r from-primary-500 to-primary-400 rounded-full"
              style={{ width: '60%' }}
            ></div>
          </div>
          <span className="text-sm text-gray-400">
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
          <span className="text-sm text-gray-500">
            {parseFloat(minAmount).toLocaleString()} - {parseFloat(maxAmount).toLocaleString()} {ad.fiatUnit}
          </span>
        </div>
      </div>

      {/* Payment Methods */}
      <div className="flex flex-wrap gap-1 mb-4">
        {ad.tradeMethods.slice(0, 3).map((method, idx) => (
          <span
            key={idx}
            className="px-2 py-0.5 bg-[#1e2a3e] rounded text-xs text-gray-400"
          >
            {method.identifier || method.payType}
          </span>
        ))}
        {ad.tradeMethods.length > 3 && (
          <span className="px-2 py-0.5 bg-[#1e2a3e] rounded text-xs text-gray-500">
            +{ad.tradeMethods.length - 3}
          </span>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-4 border-t border-[#1e2a3e]">
        <div className="flex items-center gap-2">
          <button className="btn-outline text-xs py-1.5 px-3 flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            TOP 1
          </button>
          <button className="btn-outline text-xs py-1.5 px-3 flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
