'use client';

import { useState } from 'react';

interface VerificationStep {
  timestamp: string;
  status: string;
  message: string;
  details?: Record<string, any>;
}

interface Payment {
  transactionId: string;
  amount: string;
  senderName: string;
  status: string;
  matchedAt: string | null;
}

interface Order {
  orderNumber: string;
  status: string;
  totalPrice: string;
  asset: string;
  buyerNickName: string;
  buyerRealName: string | null;
  binanceCreateTime: string;
  verificationStatus: string | null;
  verificationTimeline: VerificationStep[] | null;
  payments: Payment[];
}

const statusColors: Record<string, string> = {
  TRADING: 'bg-blue-500/20 text-blue-400',
  PENDING: 'status-pending',
  PAID: 'status-paid',
  COMPLETED: 'status-completed',
  CANCELLED: 'status-cancelled',
  CANCELLED_SYSTEM: 'status-cancelled',
  CANCELLED_TIMEOUT: 'status-cancelled',
  APPEALING: 'bg-orange-500/20 text-orange-400',
};

const statusLabels: Record<string, string> = {
  TRADING: 'Esperando pago',
  PENDING: 'PENDING',
  PAID: 'PAID',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  CANCELLED_SYSTEM: 'CANCELLED',
  CANCELLED_TIMEOUT: 'CANCELLED',
  APPEALING: 'APPEAL',
};

const verificationStatusColors: Record<string, string> = {
  AWAITING_PAYMENT: 'bg-gray-500/20 text-gray-400',
  BUYER_MARKED_PAID: 'bg-yellow-500/20 text-yellow-400',
  BANK_PAYMENT_RECEIVED: 'bg-blue-500/20 text-blue-400',
  PAYMENT_MATCHED: 'bg-purple-500/20 text-purple-400',
  AMOUNT_VERIFIED: 'bg-green-500/20 text-green-400',
  AMOUNT_MISMATCH: 'bg-red-500/20 text-red-400',
  NAME_VERIFIED: 'bg-green-500/20 text-green-400',
  NAME_MISMATCH: 'bg-red-500/20 text-red-400',
  READY_TO_RELEASE: 'bg-emerald-500/20 text-emerald-400',
  RELEASED: 'bg-green-500/20 text-green-400',
  MANUAL_REVIEW: 'bg-orange-500/20 text-orange-400',
};

const verificationStatusLabels: Record<string, string> = {
  AWAITING_PAYMENT: 'Esperando pago',
  BUYER_MARKED_PAID: 'Marcado pagado',
  BANK_PAYMENT_RECEIVED: 'Pago recibido',
  PAYMENT_MATCHED: 'Pago vinculado',
  AMOUNT_VERIFIED: 'Monto OK',
  AMOUNT_MISMATCH: 'Monto diferente',
  NAME_VERIFIED: 'Nombre OK',
  NAME_MISMATCH: 'Nombre diferente',
  READY_TO_RELEASE: 'Listo para liberar',
  RELEASED: 'Liberado',
  MANUAL_REVIEW: 'Revision manual',
};

const stepEmojis: Record<string, string> = {
  AWAITING_PAYMENT: '⏳',
  BUYER_MARKED_PAID: '📝',
  BANK_PAYMENT_RECEIVED: '💰',
  PAYMENT_MATCHED: '🔗',
  AMOUNT_VERIFIED: '✅',
  AMOUNT_MISMATCH: '⚠️',
  NAME_VERIFIED: '✅',
  NAME_MISMATCH: '⚠️',
  READY_TO_RELEASE: '🚀',
  RELEASED: '✨',
  MANUAL_REVIEW: '👤',
};

export function OrdersTable({ orders }: { orders: Order[] }) {
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);

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
            <th className="px-4 py-3 text-center">Verificacion</th>
            <th className="px-4 py-3 text-right">Time</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#2b2f36]">
          {orders.map((order) => (
            <>
              <tr
                key={order.orderNumber}
                className="hover:bg-[#2b2f36]/50 transition cursor-pointer"
                onClick={() => setExpandedOrder(
                  expandedOrder === order.orderNumber ? null : order.orderNumber
                )}
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
                    {statusLabels[order.status] || order.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-center">
                  {order.verificationStatus ? (
                    <span
                      className={`px-2 py-1 rounded text-xs font-medium ${
                        verificationStatusColors[order.verificationStatus] || 'bg-gray-500/20 text-gray-400'
                      }`}
                    >
                      {stepEmojis[order.verificationStatus] || '📋'}{' '}
                      {verificationStatusLabels[order.verificationStatus] || order.verificationStatus}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-500">-</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right text-sm text-gray-400">
                  {new Date(order.binanceCreateTime).toLocaleTimeString()}
                </td>
              </tr>

              {/* Expanded verification timeline */}
              {expandedOrder === order.orderNumber && (
                <tr key={`${order.orderNumber}-expanded`}>
                  <td colSpan={6} className="px-4 py-4 bg-[#1a1d24]">
                    <div className="space-y-4">
                      {/* Order details */}
                      <div className="flex items-center justify-between text-sm">
                        <div>
                          <span className="text-gray-400">Orden: </span>
                          <span className="text-white font-mono">{order.orderNumber}</span>
                        </div>
                        <div>
                          <span className="text-gray-400">Comprador: </span>
                          <span className="text-white">{order.buyerRealName || order.buyerNickName}</span>
                        </div>
                        <div>
                          <span className="text-gray-400">Monto: </span>
                          <span className="text-white">${parseFloat(order.totalPrice).toLocaleString()} MXN</span>
                        </div>
                      </div>

                      {/* Payment info */}
                      {order.payments.length > 0 && (
                        <div className="p-3 bg-[#2b2f36] rounded-lg">
                          <h4 className="text-sm font-medium text-gray-300 mb-2">Pago Bancario</h4>
                          {order.payments.map((payment) => (
                            <div key={payment.transactionId} className="text-sm">
                              <div className="flex justify-between">
                                <span className="text-gray-400">ID:</span>
                                <span className="text-white font-mono">{payment.transactionId.slice(0, 20)}...</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-gray-400">Monto:</span>
                                <span className="text-white">${parseFloat(payment.amount).toLocaleString()}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-gray-400">Pagador:</span>
                                <span className="text-white">{payment.senderName}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-gray-400">Estado:</span>
                                <span className={`${payment.status === 'MATCHED' ? 'text-green-400' : 'text-yellow-400'}`}>
                                  {payment.status}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Verification timeline */}
                      <div>
                        <h4 className="text-sm font-medium text-gray-300 mb-3">Timeline de Verificacion</h4>
                        {order.verificationTimeline && order.verificationTimeline.length > 0 ? (
                          <div className="space-y-2">
                            {order.verificationTimeline.map((step, index) => (
                              <div
                                key={index}
                                className="flex items-start gap-3 p-2 bg-[#2b2f36] rounded-lg"
                              >
                                <span className="text-lg">
                                  {stepEmojis[step.status] || '📋'}
                                </span>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center justify-between">
                                    <span className={`text-sm font-medium ${
                                      verificationStatusColors[step.status]?.includes('green')
                                        ? 'text-green-400'
                                        : verificationStatusColors[step.status]?.includes('red')
                                        ? 'text-red-400'
                                        : 'text-white'
                                    }`}>
                                      {step.message}
                                    </span>
                                    <span className="text-xs text-gray-500">
                                      {new Date(step.timestamp).toLocaleTimeString()}
                                    </span>
                                  </div>
                                  {step.details && (
                                    <div className="mt-1 text-xs text-gray-400 space-y-0.5">
                                      {step.details.receivedAmount !== undefined && (
                                        <div>Recibido: ${step.details.receivedAmount}</div>
                                      )}
                                      {step.details.expectedAmount !== undefined && (
                                        <div>Esperado: ${step.details.expectedAmount}</div>
                                      )}
                                      {step.details.senderName && (
                                        <div>Pagador: {step.details.senderName}</div>
                                      )}
                                      {step.details.buyerName && (
                                        <div>Comprador: {step.details.buyerName}</div>
                                      )}
                                      {step.details.matchScore !== undefined && (
                                        <div>Similitud nombre: {(step.details.matchScore * 100).toFixed(0)}%</div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-sm text-gray-500 p-3 bg-[#2b2f36] rounded-lg">
                            No hay timeline de verificacion para esta orden
                          </div>
                        )}
                      </div>

                      {/* Recommendation */}
                      {order.verificationStatus === 'READY_TO_RELEASE' && (
                        <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
                          <div className="flex items-center gap-2">
                            <span className="text-lg">🚀</span>
                            <span className="text-emerald-400 font-medium">
                              Verificacion completa - Listo para liberar
                            </span>
                          </div>
                          <p className="text-sm text-gray-400 mt-1">
                            Auto-release esta deshabilitado. Libera manualmente en Binance.
                          </p>
                        </div>
                      )}

                      {order.verificationStatus === 'MANUAL_REVIEW' && (
                        <div className="p-3 bg-orange-500/10 border border-orange-500/30 rounded-lg">
                          <div className="flex items-center gap-2">
                            <span className="text-lg">👤</span>
                            <span className="text-orange-400 font-medium">
                              Requiere revision manual
                            </span>
                          </div>
                          <p className="text-sm text-gray-400 mt-1">
                            Revisa los detalles arriba antes de liberar.
                          </p>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}
