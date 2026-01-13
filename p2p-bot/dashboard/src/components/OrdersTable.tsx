'use client';

interface Order {
  orderNumber: string;
  status: string;
  totalPrice: string;
  asset: string;
  buyerNickName: string;
  binanceCreateTime: string;
}

const statusColors: Record<string, string> = {
  PENDING: 'status-pending',
  PAID: 'status-paid',
  COMPLETED: 'status-completed',
  CANCELLED: 'status-cancelled',
  CANCELLED_SYSTEM: 'status-cancelled',
  CANCELLED_TIMEOUT: 'status-cancelled',
  APPEALING: 'bg-orange-500/20 text-orange-400',
};

export function OrdersTable({ orders }: { orders: Order[] }) {
  if (orders.length === 0) {
    return (
      <div className="p-6 text-center text-gray-500">
        No orders yet
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-[#2b2f36] text-gray-400 text-xs uppercase">
          <tr>
            <th className="px-4 py-3 text-left">Order</th>
            <th className="px-4 py-3 text-left">Buyer</th>
            <th className="px-4 py-3 text-right">Amount</th>
            <th className="px-4 py-3 text-center">Status</th>
            <th className="px-4 py-3 text-right">Time</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#2b2f36]">
          {orders.map((order) => (
            <tr
              key={order.orderNumber}
              className="hover:bg-[#2b2f36]/50 transition cursor-pointer"
            >
              <td className="px-4 py-3">
                <span className="font-mono text-sm text-gray-300">
                  {order.orderNumber.slice(-8)}
                </span>
              </td>
              <td className="px-4 py-3">
                <span className="text-sm text-white">
                  {order.buyerNickName}
                </span>
              </td>
              <td className="px-4 py-3 text-right">
                <span className="text-sm text-white">
                  ${parseFloat(order.totalPrice).toLocaleString()}
                </span>
                <span className="text-xs text-gray-500 ml-1">MXN</span>
              </td>
              <td className="px-4 py-3 text-center">
                <span
                  className={`px-2 py-1 rounded text-xs font-medium ${
                    statusColors[order.status] || 'bg-gray-500/20 text-gray-400'
                  }`}
                >
                  {order.status}
                </span>
              </td>
              <td className="px-4 py-3 text-right text-sm text-gray-400">
                {new Date(order.binanceCreateTime).toLocaleTimeString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
