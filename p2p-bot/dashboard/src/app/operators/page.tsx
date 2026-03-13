'use client';

import { useState, useEffect, useCallback } from 'react';

interface OperatorCurrent {
  nickname: string;
  isAdOnline: boolean;
  surplusAmount: number | null;
  adPrice: number | null;
  lowFunds: boolean;
  lastChecked: string;
}

interface OperatorDaily {
  nickname: string;
  date: string;
  totalSnapshots: number;
  onlineSnapshots: number;
  lowFundsSnapshots: number;
  hoursOnline: number;
  hoursLowFunds: number;
  avgSurplus: number | null;
  minSurplus: number | null;
  coveragePct: number;
}

interface OperatorOrders {
  merchantId: string;
  merchantName: string;
  binanceNickname: string | null;
  sellOrders: number;
  buyOrders: number;
  sellVolume: number;
  buyVolume: number;
  totalOrders: number;
  totalVolume: number;
}

export default function OperatorsPage() {
  const [currentStatus, setCurrentStatus] = useState<OperatorCurrent[]>([]);
  const [dailyData, setDailyData] = useState<OperatorDaily[]>([]);
  const [orderData, setOrderData] = useState<OperatorOrders[]>([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState(7);
  const [selectedNickname, setSelectedNickname] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [currentRes, dailyRes, ordersRes] = await Promise.all([
        fetch('/api/operators?view=current'),
        fetch(`/api/operators?view=daily&range=${range}${selectedNickname ? `&nickname=${selectedNickname}` : ''}`),
        fetch(`/api/operators?view=orders&range=${range}`),
      ]);

      const currentData = await currentRes.json();
      const daily = await dailyRes.json();
      const orders = await ordersRes.json();

      if (currentData.operators) setCurrentStatus(currentData.operators);
      if (daily.data) setDailyData(daily.data);
      if (orders.data) setOrderData(orders.data);
    } catch (err) {
      console.error('Error fetching operator data:', err);
    } finally {
      setLoading(false);
    }
  }, [range, selectedNickname]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const uniqueNicknames = Array.from(new Set([
    ...currentStatus.map(o => o.nickname),
    ...dailyData.map(o => o.nickname),
  ])).sort();

  // Match operator nickname to merchant order data
  // Tries: exact merchantName match, then binanceNickname match
  const getOrdersForNick = (nick: string): OperatorOrders | null => {
    // 1. Exact match on merchantName (e.g. "ProcorpCrypto (Bybit)" = "ProcorpCrypto (Bybit)")
    const byName = orderData.find(o => o.merchantName === nick);
    if (byName) return byName;

    // 2. Match binanceNickname for Binance operators (no exchange suffix)
    if (!/\s*\((?:OKX|Bybit)\)$/.test(nick)) {
      const byBinance = orderData.find(o => o.binanceNickname === nick);
      if (byBinance) return byBinance;
    }

    // 3. Strip suffix and try merchantName contains base name
    const baseName = nick.replace(/\s*\((?:OKX|Bybit)\)$/, '');
    const byPartial = orderData.find(o =>
      o.merchantName.toLowerCase().includes(baseName.toLowerCase()) ||
      o.binanceNickname?.toLowerCase() === baseName.toLowerCase()
    );
    return byPartial || null;
  };

  // Group daily data by nickname for summary
  const nicknameSummaries = uniqueNicknames.map(nick => {
    const days = dailyData.filter(d => d.nickname === nick);
    const totalHoursOnline = days.reduce((s, d) => s + d.hoursOnline, 0);
    const totalHoursLowFunds = days.reduce((s, d) => s + d.hoursLowFunds, 0);
    const avgCoverage = days.length > 0
      ? Math.round(days.reduce((s, d) => s + d.coveragePct, 0) / days.length)
      : 0;
    const avgSurplus = days.filter(d => d.avgSurplus !== null).length > 0
      ? days.filter(d => d.avgSurplus !== null).reduce((s, d) => s + (d.avgSurplus || 0), 0) / days.filter(d => d.avgSurplus !== null).length
      : null;
    const bestDay = days.length > 0 ? days.reduce((best, d) => d.coveragePct > best.coveragePct ? d : best, days[0]) : null;
    const current = currentStatus.find(c => c.nickname === nick);
    const orders = getOrdersForNick(nick);

    return {
      nickname: nick,
      daysActive: days.length,
      totalHoursOnline,
      totalHoursLowFunds,
      avgCoverage,
      avgSurplus,
      bestDay,
      current,
      orders,
    };
  });

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('es-MX', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  const formatTime = (dateStr: string) => {
    return new Date(dateStr).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  };

  const formatMXN = (val: number) => {
    if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`;
    if (val >= 1_000) return `$${(val / 1_000).toFixed(0)}K`;
    return `$${val.toFixed(0)}`;
  };

  const getCoverageColor = (pct: number) => {
    if (pct >= 80) return 'text-emerald-400';
    if (pct >= 60) return 'text-yellow-400';
    return 'text-red-400';
  };

  const getCoverageBg = (pct: number) => {
    if (pct >= 80) return 'bg-emerald-500';
    if (pct >= 60) return 'bg-yellow-500';
    return 'bg-red-500';
  };

  const getRankStyle = (idx: number) => {
    if (idx === 0) return 'text-yellow-400';
    if (idx === 1) return 'text-gray-300';
    if (idx === 2) return 'text-amber-600';
    return 'text-gray-500';
  };

  const getRankBorder = (idx: number) => {
    if (idx === 0) return 'border-yellow-500/30 bg-yellow-500/5';
    return 'bg-gray-800/50';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin h-8 w-8 border-2 border-primary-500 border-t-transparent rounded-full"></div>
      </div>
    );
  }

  if (currentStatus.length === 0 && dailyData.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold text-white">Rendimiento de Operadores</h1>
        <div className="card p-6 text-center">
          <p className="text-gray-400">No hay datos de operadores disponibles.</p>
          <p className="text-gray-500 text-sm mt-2">
            Configura las variables <code className="text-primary-400">BINANCE_OPERATORS</code>,{' '}
            <code className="text-primary-400">OKX_OPERATORS</code>,{' '}
            <code className="text-primary-400">BYBIT_OPERATORS</code> en el servicio Monitor de Railway.
          </p>
        </div>
      </div>
    );
  }

  const sorted = nicknameSummaries
    .filter(s => !selectedNickname || s.nickname === selectedNickname)
    .sort((a, b) => b.totalHoursOnline - a.totalHoursOnline);

  return (
    <div className="space-y-4 pb-20">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg sm:text-2xl font-bold text-white">Rendimiento</h1>
        <div className="flex gap-1">
          {[1, 7, 14, 30].map(r => (
            <button
              key={r}
              onClick={() => { setRange(r); setLoading(true); }}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition ${
                range === r
                  ? 'bg-primary-600 text-white'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              {r === 1 ? 'Hoy' : `${r}d`}
            </button>
          ))}
        </div>
      </div>

      {/* Current Status — compact row */}
      {currentStatus.length > 0 && (
        <div className="card p-3">
          <h2 className="text-xs font-semibold text-gray-500 mb-2">EN VIVO</h2>
          <div className="flex flex-wrap gap-2">
            {currentStatus.map(op => (
              <button
                key={op.nickname}
                onClick={() => setSelectedNickname(selectedNickname === op.nickname ? null : op.nickname)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition border ${
                  op.isAdOnline
                    ? 'border-emerald-500/30 bg-emerald-500/5'
                    : 'border-red-500/30 bg-red-500/5'
                } ${selectedNickname === op.nickname ? 'ring-2 ring-primary-500' : ''}`}
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${op.isAdOnline ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                <span className="text-white font-medium truncate max-w-[120px]">{op.nickname}</span>
                {op.surplusAmount !== null && (
                  <span className={`${op.lowFunds ? 'text-red-400' : 'text-gray-500'}`}>
                    {op.surplusAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                )}
                {op.adPrice && (
                  <span className="text-gray-600">${op.adPrice.toFixed(2)}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Ranking */}
      {sorted.length > 0 && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-400">
              Ranking {range === 1 ? 'de Hoy' : range === 30 ? 'Mensual' : `${range} Dias`}
            </h2>
            {selectedNickname && (
              <button
                onClick={() => setSelectedNickname(null)}
                className="text-primary-400 hover:text-primary-300 text-xs"
              >
                ver todos
              </button>
            )}
          </div>
          <div className="space-y-3">
            {sorted.map((summary, idx) => {
              const workHoursTotal = summary.daysActive * 13;
              const hoursDisconnected = Math.max(0, workHoursTotal - summary.totalHoursOnline);
              return (
                <div
                  key={summary.nickname}
                  className={`p-3 rounded-xl border ${getRankBorder(idx)}`}
                  onClick={() => setSelectedNickname(selectedNickname === summary.nickname ? null : summary.nickname)}
                >
                  {/* Header: rank + name + coverage */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-lg font-bold ${getRankStyle(idx)}`}>
                        #{idx + 1}
                      </span>
                      <div>
                        <span className="text-white font-bold text-sm">{summary.nickname}</span>
                        {summary.current && (
                          <span className={`ml-1.5 inline-block w-1.5 h-1.5 rounded-full ${summary.current.isAdOnline ? 'bg-emerald-500' : 'bg-red-500'}`} />
                        )}
                      </div>
                    </div>
                    <span className={`text-lg font-bold ${getCoverageColor(summary.avgCoverage)}`}>
                      {summary.avgCoverage}%
                    </span>
                  </div>

                  {/* Coverage Bar */}
                  <div className="w-full h-1.5 bg-gray-700 rounded-full mb-3">
                    <div
                      className={`h-1.5 rounded-full transition-all ${getCoverageBg(summary.avgCoverage)}`}
                      style={{ width: `${Math.min(summary.avgCoverage, 100)}%` }}
                    />
                  </div>

                  {/* Stats Grid */}
                  <div className="grid grid-cols-3 gap-1.5 text-xs">
                    <div className="bg-gray-700/50 p-2 rounded-lg text-center">
                      <div className="text-gray-500 text-[10px]">Online</div>
                      <div className="text-emerald-400 font-bold">{summary.totalHoursOnline.toFixed(1)}h</div>
                    </div>
                    <div className="bg-gray-700/50 p-2 rounded-lg text-center">
                      <div className="text-gray-500 text-[10px]">Desconectado</div>
                      <div className="text-red-400 font-bold">{hoursDisconnected.toFixed(1)}h</div>
                    </div>
                    <div className="bg-gray-700/50 p-2 rounded-lg text-center">
                      <div className="text-gray-500 text-[10px]">Dias Activo</div>
                      <div className="text-white font-bold">{summary.daysActive}</div>
                    </div>
                    <div className="bg-gray-700/50 p-2 rounded-lg text-center">
                      <div className="text-gray-500 text-[10px]">Low Funds</div>
                      <div className={`font-bold ${summary.totalHoursLowFunds > 2 ? 'text-red-400' : 'text-white'}`}>
                        {summary.totalHoursLowFunds.toFixed(1)}h
                      </div>
                    </div>
                    <div className="bg-gray-700/50 p-2 rounded-lg text-center">
                      <div className="text-gray-500 text-[10px]">Avg USDT</div>
                      <div className="text-white font-bold">
                        {summary.avgSurplus !== null ? summary.avgSurplus.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}
                      </div>
                    </div>
                    {summary.bestDay && range > 1 && (
                      <div className="bg-gray-700/50 p-2 rounded-lg text-center">
                        <div className="text-gray-500 text-[10px]">Mejor Dia</div>
                        <div className="text-yellow-400 font-bold">{summary.bestDay.coveragePct}%</div>
                      </div>
                    )}
                  </div>

                  {/* Order Volume — show if available (Binance operators only) */}
                  {summary.orders && summary.orders.totalOrders > 0 && (
                    <div className="mt-2 pt-2 border-t border-gray-700/50">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-xs">
                        <div className="text-center">
                          <div className="text-gray-500 text-[10px]">Ventas</div>
                          <div className="text-emerald-400 font-bold">{summary.orders.sellOrders}</div>
                        </div>
                        <div className="text-center">
                          <div className="text-gray-500 text-[10px]">Vol. Venta</div>
                          <div className="text-emerald-400 font-bold">{formatMXN(summary.orders.sellVolume)}</div>
                        </div>
                        <div className="text-center">
                          <div className="text-gray-500 text-[10px]">Compras</div>
                          <div className="text-blue-400 font-bold">{summary.orders.buyOrders}</div>
                        </div>
                        <div className="text-center">
                          <div className="text-gray-500 text-[10px]">Vol. Compra</div>
                          <div className="text-blue-400 font-bold">{formatMXN(summary.orders.buyVolume)}</div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Daily Breakdown Table */}
      {dailyData.length > 0 && (
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-gray-400 mb-3">Detalle Diario</h2>
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full text-xs min-w-[500px]">
              <thead>
                <tr className="text-gray-500 border-b border-gray-700">
                  <th className="text-left py-2 pr-2">Operador</th>
                  <th className="text-left py-2 pr-2">Fecha</th>
                  <th className="text-right py-2 pr-2">Online</th>
                  <th className="text-right py-2 pr-2">Descon.</th>
                  <th className="text-right py-2 pr-2">Low $</th>
                  <th className="text-right py-2 pr-2">Cobertura</th>
                  <th className="text-right py-2">Avg USDT</th>
                </tr>
              </thead>
              <tbody>
                {dailyData
                  .filter(d => !selectedNickname || d.nickname === selectedNickname)
                  .map((day, i) => {
                    const hoursOff = Math.max(0, 13 - day.hoursOnline);
                    return (
                      <tr key={`${day.nickname}-${day.date}-${i}`} className="border-b border-gray-800 hover:bg-gray-800/30">
                        <td className="py-2 pr-2 text-white font-medium truncate max-w-[100px]">{day.nickname}</td>
                        <td className="py-2 pr-2 text-gray-400 whitespace-nowrap">{formatDate(day.date)}</td>
                        <td className="py-2 pr-2 text-right text-emerald-400">{day.hoursOnline}h</td>
                        <td className="py-2 pr-2 text-right text-red-400">
                          {hoursOff > 0 ? `${hoursOff.toFixed(1)}h` : '-'}
                        </td>
                        <td className={`py-2 pr-2 text-right ${day.hoursLowFunds > 1 ? 'text-red-400' : 'text-gray-400'}`}>
                          {day.hoursLowFunds > 0 ? `${day.hoursLowFunds}h` : '-'}
                        </td>
                        <td className="py-2 pr-2 text-right">
                          <span className={`font-bold ${getCoverageColor(day.coveragePct)}`}>
                            {day.coveragePct}%
                          </span>
                        </td>
                        <td className="py-2 text-right text-gray-400">
                          {day.avgSurplus !== null ? day.avgSurplus.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
