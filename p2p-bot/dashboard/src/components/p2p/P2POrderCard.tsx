'use client';

import { P2POrder, getDescriptiveStatus, formatOrderTime, formatPrice } from '@/lib/order-utils';

interface P2POrderCardProps {
  order: P2POrder;
  onTap: (order: P2POrder) => void;
}

export function P2POrderCard({ order, onTap }: P2POrderCardProps) {
  const descriptive = getDescriptiveStatus(order);
  const isSell = order.tradeType === 'SELL';

  return (
    <div
      onClick={() => onTap(order)}
      className="p2p-card p-2 px-3 cursor-pointer active:scale-[0.98] transition-all duration-150"
    >
      {/* Row 1: Badge + buyer + amount + time */}
      <div className="flex items-center gap-1.5">
        <span className={`shrink-0 w-5 h-5 flex items-center justify-center rounded text-[10px] font-bold ${
          isSell ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/20 text-emerald-400'
        }`}>
          {isSell ? 'S' : 'B'}
        </span>
        <span className="text-sm text-white truncate min-w-0">
          {order.isTrustedBuyer && <span className="mr-0.5">&#11088;</span>}
          {order.buyerNickName}
        </span>
        <span className="ml-auto text-sm font-semibold text-white whitespace-nowrap">
          {formatPrice(order.totalPrice)}
        </span>
        <span className="text-[10px] text-gray-500 shrink-0">
          {formatOrderTime(order.binanceCreateTime)}
        </span>
      </div>

      {/* Row 2: Status */}
      <div className="mt-1">
        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium ${descriptive.color}`}>
          {descriptive.emoji} {descriptive.label}
        </span>
      </div>
    </div>
  );
}
