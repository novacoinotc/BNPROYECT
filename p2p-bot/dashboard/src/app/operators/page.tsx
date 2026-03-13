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

export default function OperatorsPage() {
  const [currentStatus, setCurrentStatus] = useState<OperatorCurrent[]>([]);
  const [dailyData, setDailyData] = useState<OperatorDaily[]>([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState(7);
  const [selectedNickname, setSelectedNickname] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [currentRes, dailyRes] = await Promise.all([
        fetch('/api/operators?view=current'),
        fetch(`/api/operators?view=daily&range=${range}${selectedNickname ? `&nickname=${selectedNickname}` : ''}`),
      ]);

      const currentData = await currentRes.json();
      const daily = await dailyRes.json();

      if (currentData.operators) setCurrentStatus(currentData.operators);
      if (daily.data) setDailyData(daily.data);
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
    const current = currentStatus.find(c => c.nickname === nick);

    return {
      nickname: nick,
      daysActive: days.length,
      totalHoursOnline,
      totalHoursLowFunds,
      avgCoverage,
      avgSurplus,
      current,
    };
  });

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('es-MX', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  const formatTime = (dateStr: string) => {
    return new Date(dateStr).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
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
          <div className="text-4xl mb-3">📊</div>
          <p className="text-gray-400">No hay datos de operadores disponibles.</p>
          <p className="text-gray-500 text-sm mt-2">
            Configura la variable <code className="text-primary-400">OPERATOR_NICKNAMES</code> en Railway
            con los nicknames de los operadores separados por coma.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl sm:text-2xl font-bold text-white">Rendimiento</h1>
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

      {/* Current Status */}
      {currentStatus.length > 0 && (
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-gray-400 mb-3">Estado Actual</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {currentStatus.map(op => (
              <div
                key={op.nickname}
                onClick={() => setSelectedNickname(selectedNickname === op.nickname ? null : op.nickname)}
                className={`p-3 rounded-xl border cursor-pointer transition ${
                  op.isAdOnline
                    ? 'border-emerald-500/30 bg-emerald-500/5'
                    : 'border-red-500/30 bg-red-500/5'
                } ${selectedNickname === op.nickname ? 'ring-2 ring-primary-500' : ''}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className={`w-2.5 h-2.5 rounded-full ${op.isAdOnline ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`}></span>
                    <span className="text-white font-bold text-sm">{op.nickname}</span>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    op.isAdOnline ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                  }`}>
                    {op.isAdOnline ? 'Online' : 'Offline'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <div>
                    {op.surplusAmount !== null && (
                      <span className={op.lowFunds ? 'text-red-400' : 'text-gray-400'}>
                        {op.lowFunds ? '⚠️ ' : ''}{op.surplusAmount.toLocaleString()} USDT
                      </span>
                    )}
                  </div>
                  {op.adPrice && (
                    <span className="text-gray-500">${op.adPrice.toFixed(2)}</span>
                  )}
                </div>
                <div className="text-[10px] text-gray-600 mt-1">
                  {formatTime(op.lastChecked)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Operator Summary Cards */}
      {nicknameSummaries.length > 0 && (
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-gray-400 mb-3">
            Resumen {range === 1 ? 'de Hoy' : `${range} Dias`}
            {selectedNickname && (
              <button
                onClick={() => setSelectedNickname(null)}
                className="ml-2 text-primary-400 hover:text-primary-300 text-xs"
              >
                (ver todos)
              </button>
            )}
          </h2>
          <div className="space-y-3">
            {nicknameSummaries
              .filter(s => !selectedNickname || s.nickname === selectedNickname)
              .map(summary => (
              <div key={summary.nickname} className="p-3 bg-gray-800/50 rounded-xl">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-white font-bold">{summary.nickname}</span>
                  <span className={`text-lg font-bold ${getCoverageColor(summary.avgCoverage)}`}>
                    {summary.avgCoverage}%
                  </span>
                </div>

                {/* Coverage Bar */}
                <div className="w-full h-2 bg-gray-700 rounded-full mb-3">
                  <div
                    className={`h-2 rounded-full transition-all ${getCoverageBg(summary.avgCoverage)}`}
                    style={{ width: `${Math.min(summary.avgCoverage, 100)}%` }}
                  ></div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div className="bg-gray-700/50 p-2 rounded-lg">
                    <div className="text-gray-500">Horas Online</div>
                    <div className="text-white font-bold">{summary.totalHoursOnline.toFixed(1)}h</div>
                  </div>
                  <div className="bg-gray-700/50 p-2 rounded-lg">
                    <div className="text-gray-500">Dias Activo</div>
                    <div className="text-white font-bold">{summary.daysActive}</div>
                  </div>
                  <div className="bg-gray-700/50 p-2 rounded-lg">
                    <div className="text-gray-500">Low Funds</div>
                    <div className={`font-bold ${summary.totalHoursLowFunds > 2 ? 'text-red-400' : 'text-white'}`}>
                      {summary.totalHoursLowFunds.toFixed(1)}h
                    </div>
                  </div>
                  <div className="bg-gray-700/50 p-2 rounded-lg">
                    <div className="text-gray-500">Avg Fondos</div>
                    <div className="text-white font-bold">
                      {summary.avgSurplus !== null ? `${summary.avgSurplus.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '-'}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Daily Breakdown Table */}
      {dailyData.length > 0 && (
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-gray-400 mb-3">Detalle Diario</h2>
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-700">
                  <th className="text-left py-2 pr-2">Operador</th>
                  <th className="text-left py-2 pr-2">Fecha</th>
                  <th className="text-right py-2 pr-2">Online</th>
                  <th className="text-right py-2 pr-2">Low $</th>
                  <th className="text-right py-2 pr-2">Cobertura</th>
                  <th className="text-right py-2">Avg USDT</th>
                </tr>
              </thead>
              <tbody>
                {dailyData
                  .filter(d => !selectedNickname || d.nickname === selectedNickname)
                  .map((day, i) => (
                  <tr key={`${day.nickname}-${day.date}-${i}`} className="border-b border-gray-800 hover:bg-gray-800/30">
                    <td className="py-2 pr-2 text-white font-medium">{day.nickname}</td>
                    <td className="py-2 pr-2 text-gray-400">{formatDate(day.date)}</td>
                    <td className="py-2 pr-2 text-right text-white">{day.hoursOnline}h</td>
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
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
