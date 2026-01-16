'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

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
  autoReplyMsg?: string;
  remarks?: string;
  buyerRegDaysLimit?: number;
  buyerBtcPositionLimit?: string;
}

interface AdsResponse {
  success: boolean;
  sellAds: AdData[];
  buyAds?: AdData[];
  merchant?: {
    monthFinishRate: number;
    monthOrderCount: number;
    onlineStatus: string;
  };
}

async function fetchAds(): Promise<AdsResponse & { error?: string }> {
  const response = await fetch('/api/ads');
  const data = await response.json();
  return data;
}

// Get status from various formats
function getAdStatus(ad: AdData): { isOnline: boolean; label: string } {
  // advStatus: 1 = online, 3 = offline
  if (ad.advStatus !== undefined) {
    return {
      isOnline: ad.advStatus === 1,
      label: ad.advStatus === 1 ? 'ONLINE' : 'OFFLINE'
    };
  }
  // Fallback to status string
  const isOnline = ad.status === 'ONLINE';
  return { isOnline, label: ad.status || 'UNKNOWN' };
}

export function AdInfo() {
  const [expandedAd, setExpandedAd] = useState<string | null>(null);
  const [showOffline, setShowOffline] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['ads'],
    queryFn: fetchAds,
    refetchInterval: 60000,
  });

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-3">
        <div className="h-4 bg-[#2d2640] rounded w-1/2"></div>
        <div className="h-4 bg-[#2d2640] rounded w-3/4"></div>
      </div>
    );
  }

  if (error || !data?.success) {
    const errorMessage = data?.error || (error as Error)?.message || 'Error desconocido';
    return (
      <div className="text-red-400 text-sm space-y-2">
        <p>Error al cargar anuncios</p>
        <p className="text-xs text-gray-500">{errorMessage}</p>
      </div>
    );
  }

  const sellAds = data.sellAds || [];
  const onlineAds = sellAds.filter(ad => getAdStatus(ad).isOnline);
  const offlineAds = sellAds.filter(ad => !getAdStatus(ad).isOnline);
  const displayAds = showOffline ? sellAds : onlineAds;

  if (sellAds.length === 0) {
    return (
      <div className="text-gray-400 text-sm">
        No hay anuncios de venta
      </div>
    );
  }

  const openBinanceAd = (advNo: string) => {
    window.open(`https://p2p.binance.com/es-LA/advertiserDetail?advertiserNo=${advNo}`, '_blank');
  };

  return (
    <div className="space-y-3">
      {/* Filter toggle */}
      {offlineAds.length > 0 && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-gray-500">
            {onlineAds.length} activo{onlineAds.length !== 1 ? 's' : ''}, {offlineAds.length} offline
          </span>
          <button
            onClick={() => setShowOffline(!showOffline)}
            className="text-blue-400 hover:text-blue-300"
          >
            {showOffline ? 'Solo activos' : 'Ver todos'}
          </button>
        </div>
      )}

      {displayAds.map((ad) => {
        const status = getAdStatus(ad);
        const isExpanded = expandedAd === ad.advNo;
        const minAmount = ad.minSingleTransAmount || ad.minAmount || '0';
        const maxAmount = ad.maxSingleTransAmount || ad.maxAmount || '0';
        const priceType = typeof ad.priceType === 'number'
          ? (ad.priceType === 1 ? 'FIXED' : 'FLOATING')
          : ad.priceType;

        return (
          <div
            key={ad.advNo}
            className={`p-3 bg-[#13111c] rounded-lg border ${
              status.isOnline ? 'border-green-500/30' : 'border-[#2d2640]'
            }`}
          >
            {/* Compact Header - Always visible */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-white">
                  {ad.asset}/{ad.fiatUnit}
                </span>
                <span
                  className={`px-1.5 py-0.5 rounded text-xs ${
                    status.isOnline
                      ? 'bg-green-500/20 text-green-400'
                      : 'bg-gray-500/20 text-gray-500'
                  }`}
                >
                  {status.label}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-white font-semibold">
                  ${parseFloat(ad.price).toLocaleString()}
                </span>
                <button
                  onClick={() => setExpandedAd(isExpanded ? null : ad.advNo)}
                  className="text-gray-400 hover:text-white p-1"
                >
                  <svg
                    className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Quick stats - Always visible */}
            <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
              <span>Min: ${parseFloat(minAmount).toLocaleString()}</span>
              <span>Max: ${parseFloat(maxAmount).toLocaleString()}</span>
              <span>{parseFloat(ad.surplusAmount).toLocaleString()} {ad.asset}</span>
            </div>

            {/* Expanded content */}
            {isExpanded && (
              <div className="mt-3 pt-3 border-t border-[#2d2640] space-y-3">
                {/* Price type */}
                <div className="text-xs">
                  <span className="text-gray-500">Tipo: </span>
                  <span className="text-white">
                    {priceType === 'FLOATING' ? (
                      <>Flotante <span className="text-yellow-400">{ad.priceFloatingRatio}%</span></>
                    ) : 'Fijo'}
                  </span>
                </div>

                {/* Payment methods */}
                <div>
                  <span className="text-xs text-gray-500">Metodos de pago</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {ad.tradeMethods.map((method, idx) => (
                      <span
                        key={idx}
                        className="px-2 py-0.5 bg-[#2d2640] rounded text-xs text-gray-300"
                      >
                        {method.identifier || method.payType}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Remarks */}
                {ad.remarks && (
                  <div>
                    <span className="text-xs text-gray-500">Descripcion</span>
                    <p className="text-xs text-gray-300 mt-1 whitespace-pre-wrap line-clamp-4">
                      {ad.remarks}
                    </p>
                  </div>
                )}

                {/* Edit button */}
                <div className="flex gap-2 pt-2">
                  <a
                    href={`https://p2p.binance.com/es-LA/myAds`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 text-center px-3 py-1.5 bg-primary-500/20 text-primary-400 rounded text-xs hover:bg-yellow-500/30 transition"
                  >
                    Editar en Binance
                  </a>
                  <button
                    onClick={() => navigator.clipboard.writeText(ad.advNo)}
                    className="px-3 py-1.5 bg-[#2d2640] text-gray-400 rounded text-xs hover:bg-[#1f1b2e] transition"
                    title="Copiar ID"
                  >
                    ID: ...{ad.advNo.slice(-6)}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Summary */}
      {onlineAds.length === 0 && (
        <p className="text-xs text-amber-500 text-center">
          No tienes anuncios activos. Activa uno en Binance P2P.
        </p>
      )}
    </div>
  );
}
