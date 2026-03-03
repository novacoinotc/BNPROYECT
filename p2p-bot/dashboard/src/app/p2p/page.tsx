'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { P2POrder } from '@/lib/order-utils';
import { P2PFilterTabs } from '@/components/p2p/P2PFilterTabs';
import { P2POrderCard } from '@/components/p2p/P2POrderCard';
import { P2PNewOrdersBanner } from '@/components/p2p/P2PNewOrdersBanner';
import { P2POrderModal } from '@/components/p2p/P2POrderModal';
import { P2PReleaseModal } from '@/components/p2p/P2PReleaseModal';

type FilterType = 'ALL' | 'SELL' | 'BUY';

export default function P2PPage() {
  const [filter, setFilter] = useState<FilterType>('ALL');
  const [displayedOrders, setDisplayedOrders] = useState<P2POrder[]>([]);
  const [pendingNewOrders, setPendingNewOrders] = useState<P2POrder[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<P2POrder | null>(null);
  const [releaseOrderNumber, setReleaseOrderNumber] = useState<string | null>(null);
  const [pendingVIP, setPendingVIP] = useState<{ orderNumber: string; buyerNickName: string; buyerUserNo: string; realName: string | null } | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const isInitialLoad = useRef(true);

  // Fetch orders via React Query
  const { data: fetchedOrders, refetch } = useQuery<P2POrder[]>({
    queryKey: ['p2p-orders'],
    queryFn: async () => {
      const res = await fetch('/api/orders?limit=50&skipSync=true');
      if (!res.ok) throw new Error('Failed to fetch orders');
      return res.json();
    },
    refetchInterval: 10000,
  });

  // Stable view: on data fetch, update existing in-place, buffer new orders
  useEffect(() => {
    if (!fetchedOrders) return;

    if (isInitialLoad.current) {
      // First load - show everything
      setDisplayedOrders(fetchedOrders);
      isInitialLoad.current = false;
      return;
    }

    const displayedSet = new Set(displayedOrders.map(o => o.orderNumber));
    const newOrders: P2POrder[] = [];
    const updatedDisplayed = [...displayedOrders];

    for (const fetched of fetchedOrders) {
      if (displayedSet.has(fetched.orderNumber)) {
        // Update existing order in-place
        const idx = updatedDisplayed.findIndex(o => o.orderNumber === fetched.orderNumber);
        if (idx !== -1) {
          updatedDisplayed[idx] = fetched;
        }
      } else {
        // New order - buffer it
        newOrders.push(fetched);
      }
    }

    // Remove orders that no longer exist in fetched data (e.g., dismissed)
    const fetchedSet = new Set(fetchedOrders.map(o => o.orderNumber));
    const filtered = updatedDisplayed.filter(o => fetchedSet.has(o.orderNumber));

    setDisplayedOrders(filtered);

    if (newOrders.length > 0) {
      setPendingNewOrders(prev => {
        const existingSet = new Set(prev.map(o => o.orderNumber));
        const deduped = newOrders.filter(o => !existingSet.has(o.orderNumber));
        return [...deduped, ...prev];
      });
    }

    // Update selected order if it's open
    if (selectedOrder) {
      const updated = fetchedOrders.find(o => o.orderNumber === selectedOrder.orderNumber);
      if (updated) {
        setSelectedOrder(updated);
      }
    }
  }, [fetchedOrders]); // eslint-disable-line react-hooks/exhaustive-deps

  // SSE for real-time updates
  useEffect(() => {
    const railwayUrl = process.env.NEXT_PUBLIC_RAILWAY_API_URL;
    if (!railwayUrl) return;

    const eventSource = new EventSource(`${railwayUrl}/api/events`);

    eventSource.onopen = () => {
      setSseConnected(true);
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (['payment_received', 'order_released', 'order_update', 'order_updated'].includes(data.type)) {
          refetch();
        }
      } catch {
        // ignore parse errors
      }
    };

    eventSource.onerror = () => {
      setSseConnected(false);
    };

    return () => {
      eventSource.close();
    };
  }, [refetch]);

  // Merge pending new orders into displayed
  const handleShowNewOrders = useCallback(() => {
    setDisplayedOrders(prev => [...pendingNewOrders, ...prev]);
    setPendingNewOrders([]);
  }, [pendingNewOrders]);

  // Apply client-side filter
  const filteredOrders = displayedOrders.filter(o => {
    if (filter === 'ALL') return true;
    return o.tradeType === filter;
  });

  // Counts for filter tabs
  const counts = {
    all: displayedOrders.length,
    sell: displayedOrders.filter(o => o.tradeType === 'SELL').length,
    buy: displayedOrders.filter(o => o.tradeType === 'BUY').length,
  };

  const handleOrderTap = (order: P2POrder) => {
    setSelectedOrder(order);
  };

  const handleRelease = (orderNumber: string) => {
    setReleaseOrderNumber(orderNumber);
  };

  const handleReleaseAndVIP = (orderNumber: string) => {
    const order = displayedOrders.find(o => o.orderNumber === orderNumber);
    if (order) {
      setPendingVIP({
        orderNumber,
        buyerNickName: order.buyerNickName,
        buyerUserNo: order.buyerUserNo,
        realName: order.buyerRealName,
      });
    }
    setReleaseOrderNumber(orderNumber);
  };

  const handleReleaseSuccess = async () => {
    // If this was a release+VIP, mark buyer as trusted
    if (pendingVIP) {
      try {
        await fetch('/api/trusted-buyers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            counterPartNickName: pendingVIP.buyerNickName,
            buyerUserNo: pendingVIP.buyerUserNo,
            realName: pendingVIP.realName,
            verifiedBy: 'P2P Dashboard',
            notes: `Marcado VIP al liberar orden ${pendingVIP.orderNumber}`,
          }),
        });
      } catch {
        // VIP marking is best-effort, don't block the release flow
      }
      setPendingVIP(null);
    }
    refetch();
    setReleaseOrderNumber(null);
  };

  return (
    <div className="min-h-screen pb-20 safe-area-bottom">
      {/* Header */}
      <div className="sticky top-0 z-40 bg-[#0d1421]/95 backdrop-blur-xl border-b border-[#1e2a3e]">
        <div className="px-4 pt-4 pb-2">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-bold text-white">P2P Ordenes</h1>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${sseConnected ? 'bg-green-500' : 'bg-gray-500'}`} />
              <span className="text-xs text-gray-500">
                {sseConnected ? 'Tiempo real' : 'Conectando...'}
              </span>
            </div>
          </div>
        </div>
        <P2PFilterTabs active={filter} onChange={setFilter} counts={counts} />
      </div>

      {/* New orders banner */}
      <P2PNewOrdersBanner count={pendingNewOrders.length} onShow={handleShowNewOrders} />

      {/* Order cards list */}
      <div className="px-2 space-y-1 mt-1">
        {filteredOrders.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-500">
            <svg className="w-12 h-12 mb-3 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            <p className="text-sm">
              {filter === 'ALL' ? 'No hay ordenes activas' : `No hay ordenes ${filter}`}
            </p>
          </div>
        ) : (
          filteredOrders.map((order) => (
            <P2POrderCard
              key={order.orderNumber}
              order={order}
              onTap={handleOrderTap}
            />
          ))
        )}
      </div>

      {/* Order detail modal */}
      {selectedOrder && (
        <P2POrderModal
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
          onRelease={handleRelease}
          onReleaseAndVIP={handleReleaseAndVIP}
          onRefresh={() => refetch()}
        />
      )}

      {/* Release crypto modal */}
      {releaseOrderNumber && (
        <P2PReleaseModal
          orderNumber={releaseOrderNumber}
          onClose={() => setReleaseOrderNumber(null)}
          onSuccess={handleReleaseSuccess}
        />
      )}
    </div>
  );
}
