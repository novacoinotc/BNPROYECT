'use client';

import { useQuery } from '@tanstack/react-query';

interface TradeMethod {
  payType: string;
  payBank?: string;
}

interface AdData {
  advNo: string;
  asset: string;
  fiatUnit: string;
  price: string;
  priceType: string;
  priceFloatingRatio: number;
  minAmount: string;
  maxAmount: string;
  surplusAmount: string;
  tradeMethods: TradeMethod[];
  status: string;
  autoReplyMsg?: string;
  remarks?: string;
  buyerRegDaysLimit?: number;
  buyerBtcPositionLimit?: number;
  dynamicMaxSingleTransAmount?: string;
  dynamicMaxSingleTransQuantity?: string;
}

interface AdsResponse {
  success: boolean;
  sellAds: AdData[];
  merchant: {
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

export function AdInfo() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['ads'],
    queryFn: fetchAds,
    refetchInterval: 60000, // Refresh every minute
  });

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-3">
        <div className="h-4 bg-[#2b2f36] rounded w-1/2"></div>
        <div className="h-4 bg-[#2b2f36] rounded w-3/4"></div>
        <div className="h-4 bg-[#2b2f36] rounded w-2/3"></div>
      </div>
    );
  }

  if (error || !data?.success) {
    const errorMessage = data?.error || (error as Error)?.message || 'Error desconocido';
    return (
      <div className="text-red-400 text-sm space-y-2">
        <p>Error al cargar anuncios</p>
        <p className="text-xs text-gray-500">{errorMessage}</p>
        {errorMessage.includes('Missing') && (
          <p className="text-xs text-yellow-500">
            Verifica las variables de entorno en Vercel (BINANCE_API_KEY, BINANCE_API_SECRET)
          </p>
        )}
      </div>
    );
  }

  const sellAds = data.sellAds || [];

  if (sellAds.length === 0) {
    return (
      <div className="text-gray-400 text-sm">
        No hay anuncios de venta activos
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {sellAds.map((ad) => (
        <div
          key={ad.advNo}
          className="p-4 bg-[#1e2126] rounded-lg border border-[#2b2f36]"
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold text-white">
                {ad.asset}/{ad.fiatUnit}
              </span>
              <span
                className={`px-2 py-0.5 rounded text-xs ${
                  ad.status === 'ONLINE'
                    ? 'bg-green-500/20 text-green-400'
                    : 'bg-gray-500/20 text-gray-400'
                }`}
              >
                {ad.status}
              </span>
            </div>
            <span className="text-xs text-gray-500 font-mono">
              {ad.advNo.slice(-8)}
            </span>
          </div>

          {/* Price info */}
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <span className="text-xs text-gray-500">Precio</span>
              <div className="text-white font-semibold">
                ${parseFloat(ad.price).toLocaleString()} {ad.fiatUnit}
              </div>
            </div>
            <div>
              <span className="text-xs text-gray-500">Tipo</span>
              <div className="text-white">
                {ad.priceType === 'FLOATING' ? (
                  <span>
                    Flotante{' '}
                    <span className="text-yellow-400">
                      {ad.priceFloatingRatio > 0 ? '+' : ''}{ad.priceFloatingRatio}%
                    </span>
                  </span>
                ) : (
                  'Fijo'
                )}
              </div>
            </div>
          </div>

          {/* Limits */}
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div>
              <span className="text-xs text-gray-500">Minimo</span>
              <div className="text-white text-sm">
                ${parseFloat(ad.minAmount).toLocaleString()}
              </div>
            </div>
            <div>
              <span className="text-xs text-gray-500">Maximo</span>
              <div className="text-white text-sm">
                ${parseFloat(ad.maxAmount).toLocaleString()}
              </div>
            </div>
            <div>
              <span className="text-xs text-gray-500">Disponible</span>
              <div className="text-white text-sm">
                {parseFloat(ad.surplusAmount).toLocaleString()} {ad.asset}
              </div>
            </div>
          </div>

          {/* Payment methods */}
          <div className="mb-3">
            <span className="text-xs text-gray-500">Metodos de pago</span>
            <div className="flex flex-wrap gap-1 mt-1">
              {ad.tradeMethods.map((method, idx) => (
                <span
                  key={idx}
                  className="px-2 py-0.5 bg-[#2b2f36] rounded text-xs text-gray-300"
                >
                  {method.payType}
                  {method.payBank && ` - ${method.payBank}`}
                </span>
              ))}
            </div>
          </div>

          {/* Filters */}
          {(ad.buyerRegDaysLimit || ad.buyerBtcPositionLimit) && (
            <div className="pt-3 border-t border-[#2b2f36]">
              <span className="text-xs text-gray-500">Filtros</span>
              <div className="flex flex-wrap gap-2 mt-1">
                {ad.buyerRegDaysLimit && (
                  <span className="px-2 py-0.5 bg-blue-500/10 text-blue-400 rounded text-xs">
                    Registro: {ad.buyerRegDaysLimit}+ dias
                  </span>
                )}
                {ad.buyerBtcPositionLimit && (
                  <span className="px-2 py-0.5 bg-blue-500/10 text-blue-400 rounded text-xs">
                    Holding: {ad.buyerBtcPositionLimit}+ BTC
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Remarks */}
          {ad.remarks && (
            <div className="pt-3 border-t border-[#2b2f36]">
              <span className="text-xs text-gray-500">Terminos/Descripcion</span>
              <p className="text-sm text-gray-300 mt-1 whitespace-pre-wrap">
                {ad.remarks}
              </p>
            </div>
          )}

          {/* Auto reply */}
          {ad.autoReplyMsg && (
            <div className="pt-3 border-t border-[#2b2f36]">
              <span className="text-xs text-gray-500">Auto-respuesta</span>
              <p className="text-sm text-gray-400 mt-1 italic">
                "{ad.autoReplyMsg}"
              </p>
            </div>
          )}
        </div>
      ))}

      {/* Merchant stats */}
      {data.merchant && (
        <div className="p-3 bg-[#1e2126] rounded-lg text-sm">
          <div className="flex items-center justify-between text-gray-400">
            <span>Ordenes mes: {data.merchant.monthOrderCount}</span>
            <span>Completion: {(data.merchant.monthFinishRate * 100).toFixed(1)}%</span>
            <span className={data.merchant.onlineStatus === 'online' ? 'text-green-400' : 'text-gray-500'}>
              {data.merchant.onlineStatus === 'online' ? 'En linea' : 'Offline'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
