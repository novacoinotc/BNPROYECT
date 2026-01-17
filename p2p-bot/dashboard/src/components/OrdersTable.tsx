'use client';

import { useState, useEffect, useCallback } from 'react';

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

interface ChatMessage {
  id: string;
  content: string;
  type: string;
  fromNickName: string;
  isSelf: boolean;
  imageUrl?: string;
  thumbnailUrl?: string;
  timestamp: number;
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
  PENDING: 'status-pending',
  PAID: 'status-paid',
  COMPLETED: 'status-completed',
  CANCELLED: 'status-cancelled',
  CANCELLED_SYSTEM: 'status-cancelled',
  CANCELLED_TIMEOUT: 'status-cancelled',
  APPEALING: 'bg-orange-500/20 text-orange-400',
};

const statusLabels: Record<string, string> = {
  PENDING: 'Esperando pago',
  PAID: 'PAID',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  CANCELLED_SYSTEM: 'CANCELLED',
  CANCELLED_TIMEOUT: 'CANCELLED',
  APPEALING: 'APPEAL',
};

const verificationStatusColors: Record<string, string> = {
  AWAITING_PAYMENT: 'bg-gray-500/20 text-gray-400',
  BUYER_MARKED_PAID: 'bg-yellow-500/20 text-primary-400',
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

/**
 * Calcula el estado descriptivo de la orden basándose en múltiples factores
 * Esto ayuda a entender claramente qué está pasando con cada orden
 */
function getDescriptiveStatus(order: Order): { emoji: string; label: string; color: string; description: string } {
  const hasPayment = order.payments.length > 0;
  const paymentMatched = order.payments.some(p => p.status === 'MATCHED');
  const binanceStatus = order.status;
  const verificationStatus = order.verificationStatus;

  // COMPLETED orders
  if (binanceStatus === 'COMPLETED') {
    return {
      emoji: '✨',
      label: 'Completada',
      color: 'bg-green-500/20 text-green-400',
      description: 'Orden finalizada exitosamente',
    };
  }

  // CANCELLED orders
  if (['CANCELLED', 'CANCELLED_SYSTEM', 'CANCELLED_TIMEOUT'].includes(binanceStatus)) {
    return {
      emoji: '❌',
      label: 'Cancelada',
      color: 'bg-red-500/20 text-red-400',
      description: binanceStatus === 'CANCELLED_TIMEOUT' ? 'Cancelada por timeout' : 'Orden cancelada',
    };
  }

  // APPEALING
  if (binanceStatus === 'APPEALING') {
    return {
      emoji: '⚖️',
      label: 'En disputa',
      color: 'bg-orange-500/20 text-orange-400',
      description: 'Orden en proceso de apelación',
    };
  }

  // Ready to release
  if (verificationStatus === 'READY_TO_RELEASE') {
    return {
      emoji: '🚀',
      label: 'Listo para liberar',
      color: 'bg-emerald-500/20 text-emerald-400',
      description: 'Todas las verificaciones pasaron - liberar crypto',
    };
  }

  // Manual review needed
  if (verificationStatus === 'MANUAL_REVIEW' || verificationStatus === 'NAME_MISMATCH') {
    return {
      emoji: '👤',
      label: 'Revisión manual',
      color: 'bg-orange-500/20 text-orange-400',
      description: verificationStatus === 'NAME_MISMATCH'
        ? 'Nombre del pagador no coincide - verificar manualmente'
        : 'Requiere verificación manual',
    };
  }

  // PAID status (buyer marked as paid)
  if (binanceStatus === 'PAID') {
    if (hasPayment && paymentMatched) {
      // Both: buyer marked paid AND bank payment received
      if (verificationStatus === 'AMOUNT_VERIFIED' || verificationStatus === 'NAME_VERIFIED') {
        return {
          emoji: '✅',
          label: 'Verificando',
          color: 'bg-blue-500/20 text-blue-400',
          description: 'Pago recibido y verificado - procesando liberación',
        };
      }
      return {
        emoji: '🔍',
        label: 'Verificando pago',
        color: 'bg-purple-500/20 text-purple-400',
        description: 'Pago recibido - verificando monto y nombre',
      };
    } else if (hasPayment) {
      // Has unmatched payment
      return {
        emoji: '🔗',
        label: 'Vinculando pago',
        color: 'bg-purple-500/20 text-purple-400',
        description: 'Pago bancario recibido - vinculando a orden',
      };
    } else {
      // Buyer marked paid but no bank payment yet
      return {
        emoji: '⏳',
        label: 'Esperando pago',
        color: 'bg-yellow-500/20 text-yellow-400',
        description: 'Comprador marcó pagado - esperando confirmación bancaria',
      };
    }
  }

  // PENDING status (order created, waiting for buyer to pay)
  if (binanceStatus === 'PENDING') {
    if (hasPayment) {
      // Payment arrived BEFORE buyer marked as paid
      return {
        emoji: '💰',
        label: 'Pago recibido',
        color: 'bg-blue-500/20 text-blue-400',
        description: 'Pago bancario recibido - esperando que comprador marque pagado',
      };
    } else {
      // Normal: waiting for buyer to pay
      return {
        emoji: '⏳',
        label: 'Esperando',
        color: 'bg-gray-500/20 text-gray-400',
        description: 'Esperando que comprador realice el pago',
      };
    }
  }

  // Default fallback
  return {
    emoji: '📋',
    label: verificationStatus || binanceStatus,
    color: 'bg-gray-500/20 text-gray-400',
    description: 'Estado desconocido',
  };
}

// Release Modal Component
function ReleaseModal({
  orderNumber,
  onClose,
  onSuccess
}: {
  orderNumber: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [authType, setAuthType] = useState('GOOGLE');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRelease = async () => {
    if (!code) {
      setError('Ingresa el codigo de verificacion');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/orders/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNumber, authType, code }),
      });

      const data = await response.json();

      if (data.success) {
        onSuccess();
        onClose();
      } else {
        setError(data.error || 'Error al liberar orden');
      }
    } catch (err: any) {
      setError(err.message || 'Error de conexion');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[#13111c] rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-white mb-4">Liberar Orden</h3>
        <p className="text-sm text-gray-400 mb-4">
          Orden: <span className="font-mono text-white">{orderNumber.slice(-8)}</span>
        </p>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-2">Tipo de verificacion</label>
            <select
              value={authType}
              onChange={(e) => setAuthType(e.target.value)}
              className="w-full bg-[#2d2640] text-white rounded px-3 py-2 border border-[#3d3655] focus:border-primary-500 focus:outline-none"
            >
              <option value="GOOGLE">Google Authenticator</option>
              <option value="SMS">SMS</option>
              <option value="FUND_PWD">Contrasena de fondos</option>
            </select>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-2">Codigo de verificacion</label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Ingresa el codigo"
              className="w-full bg-[#2d2640] text-white rounded px-3 py-2 border border-[#3d3655] focus:border-primary-500 focus:outline-none"
              autoFocus
            />
          </div>

          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 bg-[#2d2640] text-gray-300 rounded hover:bg-[#3d3655] transition"
            >
              Cancelar
            </button>
            <button
              onClick={handleRelease}
              disabled={loading}
              className="flex-1 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Liberando...' : 'Liberar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Chat Section Component
function ChatSection({ orderNumber }: { orderNumber: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchChat() {
      try {
        setLoading(true);
        setError(null);
        const response = await fetch(`/api/chat/${orderNumber}`);
        const data = await response.json();

        if (data.success) {
          setMessages(data.messages || []);
        } else {
          setError(data.error || 'Error al cargar chat');
        }
      } catch (err: any) {
        setError(err.message || 'Error de conexion');
      } finally {
        setLoading(false);
      }
    }

    fetchChat();
  }, [orderNumber]);

  if (loading) {
    return (
      <div className="p-3 bg-[#2d2640] rounded-lg">
        <div className="flex items-center gap-2 text-gray-400">
          <div className="animate-spin h-4 w-4 border-2 border-gray-400 border-t-transparent rounded-full"></div>
          <span className="text-sm">Cargando chat...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-3 bg-[#2d2640] rounded-lg">
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="p-3 bg-[#2d2640] rounded-lg">
        <p className="text-sm text-gray-500">No hay mensajes en el chat</p>
      </div>
    );
  }

  return (
    <div className="p-3 bg-[#2d2640] rounded-lg max-h-80 overflow-y-auto">
      <div className="space-y-2">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.isSelf ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] rounded-lg p-2 ${
                msg.isSelf
                  ? 'bg-blue-600/30 text-blue-100'
                  : 'bg-[#13111c] text-gray-200'
              }`}
            >
              {!msg.isSelf && (
                <div className="text-xs text-gray-400 mb-1">{msg.fromNickName}</div>
              )}
              {msg.type === 'IMAGE' && msg.thumbnailUrl ? (
                <a
                  href={msg.imageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block"
                >
                  <img
                    src={msg.thumbnailUrl}
                    alt="Imagen"
                    className="max-w-full rounded cursor-pointer hover:opacity-80"
                    style={{ maxHeight: '150px' }}
                  />
                  <span className="text-xs text-blue-400 mt-1 block">Ver imagen completa</span>
                </a>
              ) : (
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
              )}
              <div className="text-xs text-gray-500 mt-1 text-right">
                {new Date(msg.timestamp).toLocaleTimeString()}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Main OrdersTable Component
export function OrdersTable({ orders, onRefresh }: { orders: Order[]; onRefresh?: () => void }) {
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'verification' | 'chat'>('verification');
  const [releaseOrder, setReleaseOrder] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);

  // Connect to SSE for real-time updates
  useEffect(() => {
    const railwayUrl = process.env.NEXT_PUBLIC_RAILWAY_API_URL;
    if (!railwayUrl) return;

    const eventSource = new EventSource(`${railwayUrl}/api/events`);

    eventSource.onopen = () => {
      setSseConnected(true);
      console.log('SSE connected');
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('SSE event:', data);

        // Refresh orders on relevant events
        if (['payment_received', 'order_released', 'order_update', 'order_updated'].includes(data.type)) {
          onRefresh?.();
        }
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };

    eventSource.onerror = () => {
      setSseConnected(false);
      console.log('SSE disconnected');
    };

    return () => {
      eventSource.close();
    };
  }, [onRefresh]);

  const handleReleaseSuccess = useCallback(() => {
    onRefresh?.();
  }, [onRefresh]);

  if (orders.length === 0) {
    return (
      <div className="p-6 text-center text-gray-500">
        No orders yet
      </div>
    );
  }

  return (
    <>
      {/* SSE Connection Status */}
      <div className="px-4 py-2 border-b border-[#2d2640] flex items-center justify-between">
        <span className="text-xs text-gray-500">
          {orders.length} orden{orders.length !== 1 ? 'es' : ''}
        </span>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${sseConnected ? 'bg-green-500' : 'bg-gray-500'}`}></span>
          <span className="text-xs text-gray-500">
            {sseConnected ? 'Tiempo real' : 'Conectando...'}
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-[#2d2640] text-gray-400 text-xs uppercase">
            <tr>
              <th className="px-4 py-3 text-left">Order</th>
              <th className="px-4 py-3 text-left">Buyer</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3 text-center">Status</th>
              <th className="px-4 py-3 text-center">Verificacion</th>
              <th className="px-4 py-3 text-right">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#2d2640]">
            {orders.map((order) => (
              <>
                <tr
                  key={order.orderNumber}
                  className="hover:bg-[#2d2640]/50 transition cursor-pointer"
                  onClick={() => {
                    setExpandedOrder(
                      expandedOrder === order.orderNumber ? null : order.orderNumber
                    );
                    setActiveTab('verification');
                  }}
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
                    {(() => {
                      const descriptiveStatus = getDescriptiveStatus(order);
                      return (
                        <div className="group relative">
                          <span
                            className={`px-2 py-1 rounded text-xs font-medium cursor-help ${descriptiveStatus.color}`}
                          >
                            {descriptiveStatus.emoji} {descriptiveStatus.label}
                          </span>
                          {/* Tooltip with description */}
                          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-[#1a1625] border border-[#3d3655] rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10 whitespace-nowrap">
                            <p className="text-xs text-gray-300">{descriptiveStatus.description}</p>
                            <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-[#3d3655]"></div>
                          </div>
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-3 text-right text-sm text-gray-400">
                    {new Date(order.binanceCreateTime).toLocaleTimeString()}
                  </td>
                </tr>

                {/* Expanded section with tabs */}
                {expandedOrder === order.orderNumber && (
                  <tr key={`${order.orderNumber}-expanded`}>
                    <td colSpan={6} className="px-4 py-4 bg-[#0f0d16]">
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

                        {/* Tabs */}
                        <div className="flex gap-2 border-b border-[#2d2640]">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveTab('verification');
                            }}
                            className={`px-4 py-2 text-sm font-medium transition ${
                              activeTab === 'verification'
                                ? 'text-primary-400 border-b-2 border-yellow-400'
                                : 'text-gray-400 hover:text-gray-300'
                            }`}
                          >
                            Verificacion
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveTab('chat');
                            }}
                            className={`px-4 py-2 text-sm font-medium transition ${
                              activeTab === 'chat'
                                ? 'text-primary-400 border-b-2 border-yellow-400'
                                : 'text-gray-400 hover:text-gray-300'
                            }`}
                          >
                            Chat
                          </button>
                        </div>

                        {/* Tab content */}
                        {activeTab === 'verification' ? (
                          <>
                            {/* Payment info */}
                            {order.payments.length > 0 && (
                              <div className="p-3 bg-[#2d2640] rounded-lg">
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
                                      <span className={`${payment.status === 'MATCHED' ? 'text-green-400' : 'text-primary-400'}`}>
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
                                      className="flex items-start gap-3 p-2 bg-[#2d2640] rounded-lg"
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
                                <div className="text-sm text-gray-500 p-3 bg-[#2d2640] rounded-lg">
                                  No hay timeline de verificacion para esta orden
                                </div>
                              )}
                            </div>

                            {/* Release Button - Only show for PAID orders */}
                            {order.status === 'PAID' && (
                              <div className="pt-2">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setReleaseOrder(order.orderNumber);
                                  }}
                                  className="w-full px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-medium flex items-center justify-center gap-2"
                                >
                                  <span className="text-lg">🔓</span>
                                  Liberar Crypto
                                </button>
                              </div>
                            )}

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
                                  Usa el boton de arriba para liberar manualmente.
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

                            {/* Mark as Trusted Button - Show for COMPLETED orders */}
                            {order.status === 'COMPLETED' && (
                              <div className="pt-2">
                                <button
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    if (!confirm(`Agregar "${order.buyerNickName}" a compradores confiables?`)) return;
                                    try {
                                      const response = await fetch('/api/trusted-buyers', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                          counterPartNickName: order.buyerNickName,
                                          realName: order.buyerRealName,
                                          verifiedBy: 'Dashboard',
                                          notes: `Verificado en orden ${order.orderNumber}`,
                                        }),
                                      });
                                      const data = await response.json();
                                      if (data.success) {
                                        alert(`"${order.buyerNickName}" agregado a compradores confiables`);
                                      } else {
                                        alert(data.error || 'Error al agregar');
                                      }
                                    } catch (err: any) {
                                      alert(err.message || 'Error de conexion');
                                    }
                                  }}
                                  className="w-full px-4 py-2 bg-primary-500/20 text-primary-400 border border-primary-500/30 rounded-lg hover:bg-primary-500/30 transition font-medium flex items-center justify-center gap-2"
                                >
                                  <span>⭐</span>
                                  Marcar Confiable
                                </button>
                              </div>
                            )}

                            {/* Dismiss Button - Hide stale orders from dashboard */}
                            <div className="pt-2 border-t border-[#2d2640] mt-4">
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  if (!confirm(`¿Descartar orden ${order.orderNumber.slice(-8)} del dashboard?`)) return;
                                  try {
                                    const response = await fetch('/api/orders', {
                                      method: 'PATCH',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({
                                        orderNumber: order.orderNumber,
                                        dismissed: true,
                                      }),
                                    });
                                    const data = await response.json();
                                    if (data.success) {
                                      onRefresh?.();
                                    } else {
                                      alert(data.error || 'Error al descartar orden');
                                    }
                                  } catch (err: any) {
                                    alert(err.message || 'Error de conexion');
                                  }
                                }}
                                className="w-full px-4 py-2 bg-gray-500/10 text-gray-400 border border-gray-500/30 rounded-lg hover:bg-gray-500/20 hover:text-gray-300 transition text-sm flex items-center justify-center gap-2"
                              >
                                <span>🗑️</span>
                                Descartar orden
                              </button>
                              <p className="text-xs text-gray-500 text-center mt-1">
                                Oculta esta orden del dashboard (no la elimina)
                              </p>
                            </div>
                          </>
                        ) : (
                          /* Chat tab */
                          <div>
                            <h4 className="text-sm font-medium text-gray-300 mb-3">Chat de la Orden</h4>
                            <ChatSection orderNumber={order.orderNumber} />
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

      {/* Release Modal */}
      {releaseOrder && (
        <ReleaseModal
          orderNumber={releaseOrder}
          onClose={() => setReleaseOrder(null)}
          onSuccess={handleReleaseSuccess}
        />
      )}
    </>
  );
}
