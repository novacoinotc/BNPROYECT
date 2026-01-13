'use client';

interface Stats {
  todayOrders: number;
  todayVolume: number;
  activeOrders: number;
  pendingReleases: number;
  currentPrice: number;
  margin: number;
  completionRate: number;
  avgReleaseTime: number;
}

export function StatsCards({ stats }: { stats?: Stats }) {
  const cards = [
    {
      title: "Today's Orders",
      value: stats?.todayOrders || 0,
      subtitle: `${stats?.todayVolume?.toLocaleString() || 0} MXN volume`,
      color: 'text-blue-400',
    },
    {
      title: 'Active Orders',
      value: stats?.activeOrders || 0,
      subtitle: `${stats?.pendingReleases || 0} pending release`,
      color: 'text-yellow-400',
    },
    {
      title: 'Current Price',
      value: `$${(stats?.currentPrice || 0).toFixed(2)}`,
      subtitle: `${(stats?.margin || 0).toFixed(2)}% margin`,
      color: 'text-green-400',
    },
    {
      title: 'Completion Rate',
      value: `${((stats?.completionRate || 0) * 100).toFixed(1)}%`,
      subtitle: `${stats?.avgReleaseTime || 0}s avg release`,
      color: 'text-purple-400',
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card, index) => (
        <div key={index} className="card p-4">
          <p className="text-gray-400 text-sm">{card.title}</p>
          <p className={`text-2xl font-bold mt-1 ${card.color}`}>
            {card.value}
          </p>
          <p className="text-gray-500 text-xs mt-1">{card.subtitle}</p>
        </div>
      ))}
    </div>
  );
}
