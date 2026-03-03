'use client';

type FilterType = 'ALL' | 'SELL' | 'BUY';

interface P2PFilterTabsProps {
  active: FilterType;
  onChange: (filter: FilterType) => void;
  counts: { all: number; sell: number; buy: number };
}

const tabs: { key: FilterType; label: string; activeClass: string }[] = [
  { key: 'ALL', label: 'Todas', activeClass: 'bg-[#1e2a3e] text-white' },
  { key: 'SELL', label: 'SELL', activeClass: 'bg-red-500/20 text-red-400' },
  { key: 'BUY', label: 'BUY', activeClass: 'bg-emerald-500/20 text-emerald-400' },
];

export function P2PFilterTabs({ active, onChange, counts }: P2PFilterTabsProps) {
  const countMap: Record<FilterType, number> = {
    ALL: counts.all,
    SELL: counts.sell,
    BUY: counts.buy,
  };

  return (
    <div className="flex gap-2 p-3">
      {tabs.map((tab) => {
        const isActive = active === tab.key;
        const count = countMap[tab.key];
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200 ${
              isActive ? tab.activeClass : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {tab.label}
            {count > 0 && (
              <span className={`ml-1.5 text-xs ${isActive ? 'opacity-80' : 'opacity-60'}`}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
