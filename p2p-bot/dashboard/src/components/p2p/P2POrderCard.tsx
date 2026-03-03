'use client';

import { useState } from 'react';
import { P2POrder, getDescriptiveStatus, formatOrderTime, formatPrice, copyToClipboard } from '@/lib/order-utils';

interface P2POrderCardProps {
  order: P2POrder;
  onTap: (order: P2POrder) => void;
}

export function P2POrderCard({ order, onTap }: P2POrderCardProps) {
  const [copyFlash, setCopyFlash] = useState(false);
  const descriptive = getDescriptiveStatus(order);
  const isSell = order.tradeType === 'SELL';

  const handleCopyOrder = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyToClipboard(order.orderNumber);
    if (ok) {
      setCopyFlash(true);
      setTimeout(() => setCopyFlash(false), 1500);
    }
  };

  return (
    <div
      onClick={() => onTap(order)}
      className="p2p-card p-3 cursor-pointer active:scale-[0.98] transition-all duration-150"
    >
      {/* Row 1: Trade type badge + order# + time */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`shrink-0 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide ${
            isSell ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/20 text-emerald-400'
          }`}>
            {order.tradeType}
          </span>
          <button
            onClick={handleCopyOrder}
            className={`flex items-center gap-1 font-mono text-xs truncate transition-colors ${
              copyFlash ? 'text-emerald-400' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            #{order.orderNumber.slice(-8)}
            {copyFlash ? (
              <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-3 h-3 shrink-0 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>
        </div>
        <span className="text-xs text-gray-500 shrink-0">
          {formatOrderTime(order.binanceCreateTime)}
        </span>
      </div>

      {/* Row 2: Buyer + total amount */}
      <div className="flex items-center justify-between mt-2">
        <span className="text-sm text-white truncate mr-2">
          {order.isTrustedBuyer && <span className="mr-1">&#11088;</span>}
          {order.buyerNickName}
        </span>
        <span className="text-sm font-semibold text-white whitespace-nowrap">
          {formatPrice(order.totalPrice)} <span className="text-xs text-gray-500 font-normal">{order.fiatUnit || 'MXN'}</span>
        </span>
      </div>

      {/* Row 3: Descriptive status */}
      <div className="mt-1.5">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${descriptive.color}`}>
          {descriptive.emoji} {descriptive.label}
        </span>
      </div>
    </div>
  );
}
