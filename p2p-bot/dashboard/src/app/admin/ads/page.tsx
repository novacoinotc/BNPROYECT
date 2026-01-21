'use client';

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface Ad {
  advNo: string;
  asset: string;
  fiatUnit: string;
  price: string;
  minAmount: string;
  maxAmount: string;
  surplusAmount: string;
  status: string;
  tradeType: string;
  merchantId: string;
  merchantName: string;
}

interface MerchantAds {
  merchantId: string;
  merchantName: string;
  binanceNickname: string;
  sellAds: Ad[];
  buyAds: Ad[];
  error?: string;
}

interface AdsData {
  merchants: MerchantAds[];
  aggregated: {
    sellAds: Ad[];
    buyAds: Ad[];
    totalSell: number;
    totalBuy: number;
  };
}

export default function AdminAdsPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [data, setData] = useState<AdsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'byMerchant' | 'aggregated'>('byMerchant');

  useEffect(() => {
    if (status === 'loading') return;
    if (!session?.user?.isAdmin) {
      router.push('/dashboard');
      return;
    }
    fetchAds();
  }, [session, status, router]);

  async function fetchAds() {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/ads');
      const json = await res.json();
      if (json.success) {
        setData(json);
      } else {
        setError(json.error);
      }
    } catch (err) {
      setError('Failed to fetch ads');
    } finally {
      setLoading(false);
    }
  }

  if (status === 'loading' || loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-8">
        <div className="animate-pulse">Cargando anuncios de todos los merchants...</div>
      </div>
    );
  }

  if (!session?.user?.isAdmin) return null;

  const formatCurrency = (v: string | number) => {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n);
  };

  const renderAd = (ad: Ad, showMerchant: boolean = false) => (
    <div key={ad.advNo} className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <div className="flex justify-between items-start mb-2">
        <div>
          <span className={ad.tradeType === 'SELL' ? 'text-green-400 font-bold' : 'text-blue-400 font-bold'}>
            {ad.tradeType}
          </span>
          <span className="ml-2 text-white">{ad.asset}</span>
          {showMerchant && (
            <span className="ml-2 text-gray-500 text-sm">({ad.merchantName})</span>
          )}
        </div>
        <span className={'px-2 py-1 rounded text-xs ' + (ad.status === 'ONLINE' ? 'bg-green-900 text-green-200' : 'bg-red-900 text-red-200')}>
          {ad.status}
        </span>
      </div>

      <div className="text-2xl font-bold text-white mb-2">
        {formatCurrency(ad.price)}
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm text-gray-400">
        <div>
          <span className="text-gray-500">Min:</span> {formatCurrency(ad.minAmount)}
        </div>
        <div>
          <span className="text-gray-500">Max:</span> {formatCurrency(ad.maxAmount)}
        </div>
        <div className="col-span-2">
          <span className="text-gray-500">Disponible:</span>{' '}
          <span className="text-white">{parseFloat(ad.surplusAmount || '0').toFixed(2)} {ad.asset}</span>
        </div>
      </div>

      <div className="mt-2 text-xs text-gray-600 font-mono">
        {ad.advNo}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-6">
          <div>
            <Link href="/admin" className="text-gray-400 hover:text-white text-sm mb-2 inline-block">
              ← Volver al panel
            </Link>
            <h1 className="text-2xl font-bold">Anuncios de Todos los Merchants</h1>
            {data && (
              <p className="text-gray-400 text-sm">
                {data.aggregated.totalSell} SELL | {data.aggregated.totalBuy} BUY
              </p>
            )}
          </div>

          <div className="flex gap-4">
            <select
              value={viewMode}
              onChange={(e) => setViewMode(e.target.value as any)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2"
            >
              <option value="byMerchant">Por Merchant</option>
              <option value="aggregated">Todos Juntos</option>
            </select>

            <button
              onClick={fetchAds}
              className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg"
            >
              Actualizar
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-red-900/50 border border-red-500 text-red-200 p-4 rounded-lg mb-6">
            {error}
          </div>
        )}

        {data && viewMode === 'byMerchant' && (
          <div className="space-y-8">
            {data.merchants.map((merchant) => (
              <div key={merchant.merchantId} className="bg-gray-850 rounded-xl p-6 border border-gray-700">
                <div className="flex justify-between items-center mb-4">
                  <div>
                    <h2 className="text-xl font-bold">{merchant.merchantName}</h2>
                    <p className="text-gray-400 text-sm">{merchant.binanceNickname}</p>
                  </div>
                  {merchant.error && (
                    <span className="text-red-400 text-sm">{merchant.error}</span>
                  )}
                </div>

                {/* SELL Ads */}
                {merchant.sellAds.length > 0 && (
                  <div className="mb-6">
                    <h3 className="text-green-400 font-medium mb-3">
                      SELL ({merchant.sellAds.length})
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {merchant.sellAds.map((ad) => renderAd(ad))}
                    </div>
                  </div>
                )}

                {/* BUY Ads */}
                {merchant.buyAds.length > 0 && (
                  <div>
                    <h3 className="text-blue-400 font-medium mb-3">
                      BUY ({merchant.buyAds.length})
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {merchant.buyAds.map((ad) => renderAd(ad))}
                    </div>
                  </div>
                )}

                {merchant.sellAds.length === 0 && merchant.buyAds.length === 0 && !merchant.error && (
                  <p className="text-gray-500 text-center py-4">No hay anuncios activos</p>
                )}
              </div>
            ))}
          </div>
        )}

        {data && viewMode === 'aggregated' && (
          <div className="space-y-8">
            {/* All SELL Ads */}
            <div>
              <h2 className="text-xl font-bold text-green-400 mb-4">
                Todos los SELL ({data.aggregated.sellAds.length})
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {data.aggregated.sellAds.map((ad) => renderAd(ad, true))}
              </div>
            </div>

            {/* All BUY Ads */}
            <div>
              <h2 className="text-xl font-bold text-blue-400 mb-4">
                Todos los BUY ({data.aggregated.buyAds.length})
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {data.aggregated.buyAds.map((ad) => renderAd(ad, true))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
