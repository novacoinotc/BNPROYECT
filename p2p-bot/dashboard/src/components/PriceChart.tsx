'use client';

import { useQuery } from '@tanstack/react-query';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

interface PriceData {
  createdAt: string;
  ourPrice: number;
  bestCompetitor: number;
  referencePrice: number;
}

async function fetchPriceHistory(): Promise<PriceData[]> {
  const response = await fetch('/api/stats/price-history');
  return response.json();
}

export function PriceChart() {
  const { data, isLoading } = useQuery({
    queryKey: ['priceHistory'],
    queryFn: fetchPriceHistory,
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <div className="h-64 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-primary-500"></div>
      </div>
    );
  }

  const chartData = (data || []).map((item) => ({
    time: new Date(item.createdAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    }),
    'Our Price': Number(item.ourPrice),
    'Best Competitor': Number(item.bestCompetitor),
    Reference: Number(item.referencePrice),
  }));

  if (chartData.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-gray-500">
        No price data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2d2640" />
        <XAxis
          dataKey="time"
          stroke="#6b7280"
          fontSize={12}
        />
        <YAxis
          stroke="#6b7280"
          fontSize={12}
          tickFormatter={(value) => `$${value.toFixed(0)}`}
          domain={['dataMin - 0.5', 'dataMax + 0.5']}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: '#13111c',
            border: '1px solid #2d2640',
            borderRadius: '8px',
          }}
          labelStyle={{ color: '#9ca3af' }}
        />
        <Legend />
        <Line
          type="monotone"
          dataKey="Our Price"
          stroke="#8b5cf6"
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="Best Competitor"
          stroke="#f472b6"
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="Reference"
          stroke="#4b5563"
          strokeWidth={1}
          strokeDasharray="5 5"
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
