'use client';

import { P2POrder, getDescriptiveStatus, formatOrderTime, formatPrice } from '@/lib/order-utils';

interface P2POrderCardProps {
  order: P2POrder;
  onTap: (order: P2POrder) => void;
  reasonTag?: { tag: string; emoji: string } | null;
}

export function P2POrderCard({ order, onTap, reasonTag }: P2POrderCardProps) {
  const descriptive = getDescriptiveStatus(order);
  const isSell = order.tradeType === 'SELL';

  return (
    <div
      onClick={() => onTap(order)}
      className="p2p-card p-1.5 px-2 cursor-pointer active:scale-[0.97] transition-all duration-150"
    >
      {/* Row 1: Badge + amount + time */}
      <div className="flex items-center gap-1">
        <span className={`shrink-0 w-4 h-4 flex items-center justify-center rounded text-[9px] font-bold ${
          isSell ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/20 text-emerald-400'
        }`}>
          {isSell ? 'S' : 'B'}
        </span>
        <span className="text-[13px] font-semibold text-white">
          {formatPrice(order.totalPrice)}
        </span>
        <span className="ml-auto text-[9px] text-gray-500 shrink-0">
          {formatOrderTime(order.binanceCreateTime)}
        </span>
      </div>

      {/* Row 2: Buyer nickname + real name */}
      <div className="mt-0.5 truncate text-[11px] text-gray-400">
        {order.isTrustedBuyer && <span className="mr-0.5">&#11088;</span>}
        {order.buyerNickName}
        {order.buyerRealName && (
          <span className="text-gray-500 ml-1">({order.buyerRealName})</span>
        )}
      </div>

      {/* Row 3: Status + reason tag */}
      <div className="mt-0.5 flex items-center gap-1 flex-wrap">
        <span className={`inline-flex items-center gap-0.5 px-1 py-px rounded text-[9px] font-medium leading-tight ${descriptive.color}`}>
          {descriptive.emoji} {descriptive.label}
        </span>
        {reasonTag && (
          <span className="text-[9px] text-orange-400/80">
            {reasonTag.emoji} {reasonTag.tag}
          </span>
        )}
      </div>
    </div>
  );
}
