'use client';

import { useMerchantSelector } from '@/contexts/MerchantSelectorContext';

export function MerchantSelector() {
  const {
    merchants,
    selectedMerchantId,
    selectedMerchant,
    selectMerchant,
    isLoading,
    isAdmin,
  } = useMerchantSelector();

  // Only show for admins
  if (!isAdmin) return null;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-2 py-1 bg-gray-800 rounded-lg animate-pulse">
        <div className="w-20 h-4 bg-gray-700 rounded"></div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 hidden sm:inline">Viendo como:</span>
      <select
        value={selectedMerchantId || ''}
        onChange={(e) => selectMerchant(e.target.value || null)}
        className={`
          px-3 py-1.5 rounded-lg text-sm border transition-colors
          ${selectedMerchantId
            ? 'bg-blue-900/50 border-blue-500 text-blue-200'
            : 'bg-gray-800 border-gray-700 text-gray-400'
          }
          focus:outline-none focus:ring-2 focus:ring-blue-500
        `}
      >
        <option value="">-- Admin (todos) --</option>
        {merchants.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} {m.binanceNickname ? `(${m.binanceNickname})` : ''}
          </option>
        ))}
      </select>
      {selectedMerchant && (
        <span className="hidden lg:inline px-2 py-0.5 text-xs bg-blue-500/20 text-blue-300 rounded-full border border-blue-500/30">
          {selectedMerchant.name}
        </span>
      )}
    </div>
  );
}
