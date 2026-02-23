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
  buyerUserNo: string;
  buyerNickName: string;
  buyerRealName: string | null;
  binanceCreateTime: string;
  verificationStatus: string | null;
  verificationTimeline: VerificationStep[] | null;
  payments: Payment[];
  isTrustedBuyer?: boolean;
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

  // Multi-select state
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());
  const [showBulkDismissModal, setShowBulkDismissModal] = useState(false);
  const [bulkDismissing, setBulkDismissing] = useState(false);

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

  // Clear selection when orders change
  useEffect(() => {
    setSelectedOrders(new Set());
  }, [orders]);

  // Multi-select handlers
  const toggleSelectOrder = (orderNumber: string) => {
    setSelectedOrders(prev => {
      const newSet = new Set(prev);
      if (newSet.has(orderNumber)) {
        newSet.delete(orderNumber);
      } else {
        newSet.add(orderNumber);
      }
      return newSet;
    });
  };

  const toggleSelectAll = () => {
    if (selectedOrders.size === orders.length) {
      setSelectedOrders(new Set());
    } else {
      setSelectedOrders(new Set(orders.map(o => o.orderNumber)));
    }
  };

  const handleBulkDismiss = async () => {
    if (selectedOrders.size === 0) return;

    setBulkDismissing(true);
    try {
      const response = await fetch('/api/orders', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderNumbers: Array.from(selectedOrders),
        }),
      });

      const data = await response.json();
      if (data.success) {
        setShowBulkDismissModal(false);
        setSelectedOrders(new Set());
        onRefresh?.();
      } else {
        alert(data.error || 'Error al descartar órdenes');
      }
    } catch (err: any) {
      alert(err.message || 'Error');
    } finally {
      setBulkDismissing(false);
    }
  };

  if (orders.length === 0) {
    return (
      <div className="p-6 text-center text-gray-500">
        No orders yet
      </div>
    );
  }

  return (
    <>
      {/* SSE Connection Status + Bulk Actions */}
      <div className="px-4 py-2 border-b border-[#2d2640] flex items-center justify-between">
        <div className="flex items-center gap-4">
          <span className="text-xs text-gray-500">
            {orders.length} orden{orders.length !== 1 ? 'es' : ''}
          </span>
          {selectedOrders.size > 0 && (
            <button
              onClick={() => setShowBulkDismissModal(true)}
              className="px-3 py-1 bg-red-600 text-white text-xs rounded hover:bg-red-700 transition flex items-center gap-1"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              Descartar ({selectedOrders.size})
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${sseConnected ? 'bg-green-500' : 'bg-gray-500'}`}></span>
          <span className="text-xs text-gray-500">
            {sseConnected ? 'Tiempo real' : 'Conectando...'}
          </span>
        </div>
      </div>

      {/* Mobile card layout */}
      <div className="sm:hidden divide-y divide-[#2d2640]">
        {orders.map((order) => {
          const descriptiveStatus = getDescriptiveStatus(order);
          return (
            <div key={`mobile-${order.orderNumber}`}>
              <div
                className={`p-3 cursor-pointer active:bg-[#2d2640]/50 transition ${selectedOrders.has(order.orderNumber) ? 'bg-primary-500/10' : ''}`}
                onClick={() => {
                  setExpandedOrder(expandedOrder === order.orderNumber ? null : order.orderNumber);
                  setActiveTab('verification');
                }}
              >
                {/* Row 1: checkbox + order ID + time */}
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedOrders.has(order.orderNumber)}
                      onChange={() => toggleSelectOrder(order.orderNumber)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-4 h-4 rounded border-gray-600 bg-[#13111c] text-primary-600 focus:ring-primary-500"
                    />
                    <span className="font-mono text-xs text-gray-400">#{order.orderNumber.slice(-8)}</span>
                  </div>
                  <span className="text-xs text-gray-500">
                    {new Date(order.binanceCreateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                {/* Row 2: buyer + amount */}
                <div className="flex justify-between items-center mt-1.5">
                  <span className="text-sm text-white truncate mr-2">
                    {order.isTrustedBuyer && <span>⭐ </span>}{order.buyerNickName}
                  </span>
                  <span className="text-sm font-medium text-white whitespace-nowrap">
                    ${parseFloat(order.totalPrice).toLocaleString()} <span className="text-xs text-gray-500">MXN</span>
                  </span>
                </div>
                {/* Row 3: status + verification */}
                <div className="flex gap-2 mt-1.5">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColors[order.status] || 'bg-gray-500/20 text-gray-400'}`}>
                    {statusLabels[order.status] || order.status}
                  </span>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${descriptiveStatus.color}`}>
                    {descriptiveStatus.emoji} {descriptiveStatus.label}
                  </span>
                </div>
              </div>
              {/* Expanded section (reuses same content) */}
              {expandedOrder === order.orderNumber && (
                <div className="px-3 pb-3 bg-[#0f0d16]">
                  <div className="space-y-4">
                    <div className="text-sm space-y-1">
                      <div><span className="text-gray-400">Orden: </span><span className="text-white font-mono text-xs">{order.orderNumber}</span></div>
                      <div><span className="text-gray-400">Comprador: </span><span className="text-white">{order.buyerRealName || order.buyerNickName}</span></div>
                      <div><span className="text-gray-400">Monto: </span><span className="text-white">${parseFloat(order.totalPrice).toLocaleString()} MXN</span></div>
                    </div>
                    <div className="flex gap-2 border-b border-[#2d2640]">
                      <button onClick={(e) => { e.stopPropagation(); setActiveTab('verification'); }} className={`px-4 py-2 text-sm font-medium transition ${activeTab === 'verification' ? 'text-primary-400 border-b-2 border-yellow-400' : 'text-gray-400 hover:text-gray-300'}`}>Verificacion</button>
                      <button onClick={(e) => { e.stopPropagation(); setActiveTab('chat'); }} className={`px-4 py-2 text-sm font-medium transition ${activeTab === 'chat' ? 'text-primary-400 border-b-2 border-yellow-400' : 'text-gray-400 hover:text-gray-300'}`}>Chat</button>
                    </div>
                    {activeTab === 'verification' ? (
                      <>
                        {order.payments.length > 0 && (
                          <div className="p-3 bg-[#2d2640] rounded-lg">
                            <h4 className="text-sm font-medium text-gray-300 mb-2">Pago Bancario</h4>
                            {order.payments.map((payment) => (
                              <div key={payment.transactionId} className="text-sm space-y-1">
                                <div className="flex justify-between"><span className="text-gray-400">ID:</span><span className="text-white font-mono text-xs">{payment.transactionId.slice(0, 16)}...</span></div>
                                <div className="flex justify-between"><span className="text-gray-400">Monto:</span><span className="text-white">${parseFloat(payment.amount).toLocaleString()}</span></div>
                                <div className="flex justify-between"><span className="text-gray-400">Nombre:</span><span className="text-white text-xs">{payment.senderName}</span></div>
                                <div className="flex justify-between"><span className="text-gray-400">Estado:</span><span className={payment.status === 'MATCHED' ? 'text-green-400' : 'text-yellow-400'}>{payment.status}</span></div>
                              </div>
                            ))}
                          </div>
                        )}
                        {order.verificationTimeline && order.verificationTimeline.length > 0 && (
                          <div className="space-y-2">
                            <h4 className="text-sm font-medium text-gray-300">Timeline</h4>
                            {order.verificationTimeline.map((step: VerificationStep, idx: number) => (
                              <div key={idx} className="flex items-start gap-2 text-sm">
                                <span>{stepEmojis[step.status] || '•'}</span>
                                <div className="flex-1 min-w-0">
                                  <span className="text-gray-300 break-words">{step.message}</span>
                                  <span className="text-gray-500 text-xs ml-2">{new Date(step.timestamp).toLocaleTimeString()}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        {['PAID', 'PENDING'].includes(order.status) && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setReleaseOrder(order.orderNumber); }}
                            className="w-full px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-medium"
                          >Liberar Crypto Manualmente</button>
                        )}
                        {order.status === 'COMPLETED' && (
                          <div className="pt-2">
                            {order.isTrustedBuyer ? (
                              <div className="w-full px-4 py-2 bg-green-500/20 text-green-400 border border-green-500/30 rounded-lg font-medium flex items-center justify-center gap-2">
                                <span>⭐</span> Ya es VIP
                              </div>
                            ) : (
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  if (!confirm(`Agregar "${order.buyerNickName}" a compradores confiables?`)) return;
                                  try {
                                    if (!order.buyerUserNo) { alert('buyerUserNo no disponible'); return; }
                                    const response = await fetch('/api/trusted-buyers', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ counterPartNickName: order.buyerNickName, buyerUserNo: order.buyerUserNo, realName: order.buyerRealName, verifiedBy: 'Dashboard', notes: `Verificado en orden ${order.orderNumber}` }),
                                    });
                                    const data = await response.json();
                                    if (data.success) { alert(`"${order.buyerNickName}" agregado a compradores confiables`); } else { alert(data.error || 'Error al agregar'); }
                                  } catch (err: any) { alert(err.message || 'Error de conexion'); }
                                }}
                                className="w-full px-4 py-2 bg-primary-500/20 text-primary-400 border border-primary-500/30 rounded-lg hover:bg-primary-500/30 transition font-medium flex items-center justify-center gap-2"
                              ><span>⭐</span> Marcar Confiable</button>
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      <div>
                        <h4 className="text-sm font-medium text-gray-300 mb-3">Chat de la Orden</h4>
                        <ChatSection orderNumber={order.orderNumber} />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Desktop table layout - simplified: merged Status+Verificacion into one column */}
      <div className="overflow-x-auto hidden sm:block">
        <table className="w-full">
          <thead className="bg-[#2d2640] text-gray-400 text-xs uppercase">
            <tr>
              <th className="px-3 py-3 text-center w-10">
                <input
                  type="checkbox"
                  checked={orders.length > 0 && selectedOrders.size === orders.length}
                  onChange={toggleSelectAll}
                  className="w-4 h-4 rounded border-gray-600 bg-[#13111c] text-primary-600 focus:ring-primary-500 cursor-pointer"
                />
              </th>
              <th className="px-4 py-3 text-left">Comprador</th>
              <th className="px-4 py-3 text-right">Monto</th>
              <th className="px-4 py-3 text-center">Estado</th>
              <th className="px-4 py-3 text-right">Hora</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#2d2640]">
            {orders.map((order) => (
              <>
                <tr
                  key={order.orderNumber}
                  className={`hover:bg-[#2d2640]/50 transition cursor-pointer ${selectedOrders.has(order.orderNumber) ? 'bg-primary-500/10' : ''}`}
                  onClick={() => {
                    setExpandedOrder(
                      expandedOrder === order.orderNumber ? null : order.orderNumber
                    );
                    setActiveTab('verification');
                  }}
                >
                  <td className="px-3 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedOrders.has(order.orderNumber)}
                      onChange={() => toggleSelectOrder(order.orderNumber)}
                      className="w-4 h-4 rounded border-gray-600 bg-[#13111c] text-primary-600 focus:ring-primary-500 cursor-pointer"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {order.isTrustedBuyer && <span title="Comprador VIP" className="text-xs">⭐</span>}
                      <div>
                        <span className="text-sm text-white">{order.buyerNickName}</span>
                        <span className="text-xs text-gray-500 ml-2">#{order.orderNumber.slice(-8)}</span>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="text-sm font-medium text-white">
                      ${parseFloat(order.totalPrice).toLocaleString()}
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
                          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-[#1a1625] border border-[#3d3655] rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10 whitespace-nowrap">
                            <p className="text-xs text-gray-300">{descriptiveStatus.description}</p>
                          </div>
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-3 text-right text-sm text-gray-400">
                    {new Date(order.binanceCreateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </td>
                </tr>

                {/* Expanded section - clean, no repeated info */}
                {expandedOrder === order.orderNumber && (
                  <tr key={`${order.orderNumber}-expanded`}>
                    <td colSpan={5} className="px-4 py-4 bg-[#0f0d16]">
                      <div className="space-y-3">
                        {/* Compact order info - only show what's NOT in the row */}
                        <div className="flex items-center gap-4 text-sm text-gray-400">
                          <span>Orden: <span className="text-white font-mono text-xs">{order.orderNumber}</span></span>
                          {order.buyerRealName && (
                            <span>Nombre: <span className="text-white">{order.buyerRealName}</span></span>
                          )}
                        </div>

                        {/* Tabs */}
                        <div className="flex gap-2 border-b border-[#2d2640]">
                          <button
                            onClick={(e) => { e.stopPropagation(); setActiveTab('verification'); }}
                            className={`px-4 py-2 text-sm font-medium transition ${activeTab === 'verification' ? 'text-primary-400 border-b-2 border-yellow-400' : 'text-gray-400 hover:text-gray-300'}`}
                          >Verificacion</button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setActiveTab('chat'); }}
                            className={`px-4 py-2 text-sm font-medium transition ${activeTab === 'chat' ? 'text-primary-400 border-b-2 border-yellow-400' : 'text-gray-400 hover:text-gray-300'}`}
                          >Chat</button>
                        </div>

                        {activeTab === 'verification' ? (
                          <>
                            {/* Payment info - compact */}
                            {order.payments.length > 0 && (
                              <div className="p-3 bg-[#2d2640] rounded-lg text-sm">
                                {order.payments.map((payment) => (
                                  <div key={payment.transactionId} className="flex flex-wrap gap-x-4 gap-y-1">
                                    <span className="text-gray-400">Pago: <span className="text-white">${parseFloat(payment.amount).toLocaleString()}</span></span>
                                    <span className="text-gray-400">De: <span className="text-white">{payment.senderName}</span></span>
                                    <span className={payment.status === 'MATCHED' ? 'text-green-400' : 'text-yellow-400'}>{payment.status === 'MATCHED' ? 'Vinculado' : 'Pendiente'}</span>
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Timeline - compact */}
                            {order.verificationTimeline && order.verificationTimeline.length > 0 && (
                              <div className="space-y-1">
                                {order.verificationTimeline.map((step, index) => (
                                  <div key={index} className="flex items-center gap-2 text-sm py-1">
                                    <span>{stepEmojis[step.status] || '📋'}</span>
                                    <span className={`flex-1 ${
                                      verificationStatusColors[step.status]?.includes('green') ? 'text-green-400' :
                                      verificationStatusColors[step.status]?.includes('red') ? 'text-red-400' : 'text-gray-300'
                                    }`}>{step.message}</span>
                                    <span className="text-xs text-gray-500">{new Date(step.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Action buttons */}
                            {order.status === 'PAID' && (
                              <button
                                onClick={(e) => { e.stopPropagation(); setReleaseOrder(order.orderNumber); }}
                                className="w-full px-4 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-medium flex items-center justify-center gap-2"
                              >Liberar Crypto</button>
                            )}

                            {order.verificationStatus === 'READY_TO_RELEASE' && (
                              <div className="p-2 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-sm text-emerald-400 text-center">
                                Verificacion completa - Listo para liberar
                              </div>
                            )}

                            {order.verificationStatus === 'MANUAL_REVIEW' && (
                              <div className="p-2 bg-orange-500/10 border border-orange-500/30 rounded-lg text-sm text-orange-400 text-center">
                                Requiere revision manual
                              </div>
                            )}

                            {/* Trusted + Dismiss - inline */}
                            <div className="flex gap-2 pt-2 border-t border-[#2d2640]">
                              {order.status === 'COMPLETED' && (
                                order.isTrustedBuyer ? (
                                  <div className="flex-1 px-3 py-2 bg-green-500/10 text-green-400 border border-green-500/30 rounded-lg text-sm flex items-center justify-center gap-1">
                                    <span>⭐</span> VIP
                                  </div>
                                ) : (
                                  <button
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      if (!confirm(`Agregar "${order.buyerNickName}" a compradores confiables?`)) return;
                                      try {
                                        if (!order.buyerUserNo) { alert('buyerUserNo no disponible'); return; }
                                        const response = await fetch('/api/trusted-buyers', {
                                          method: 'POST',
                                          headers: { 'Content-Type': 'application/json' },
                                          body: JSON.stringify({ counterPartNickName: order.buyerNickName, buyerUserNo: order.buyerUserNo, realName: order.buyerRealName, verifiedBy: 'Dashboard', notes: `Verificado en orden ${order.orderNumber}` }),
                                        });
                                        const data = await response.json();
                                        if (data.success) { alert(`"${order.buyerNickName}" agregado como VIP`); } else { alert(data.error || 'Error'); }
                                      } catch (err: any) { alert(err.message || 'Error'); }
                                    }}
                                    className="flex-1 px-3 py-2 bg-primary-500/10 text-primary-400 border border-primary-500/30 rounded-lg hover:bg-primary-500/20 transition text-sm flex items-center justify-center gap-1"
                                  ><span>⭐</span> Marcar VIP</button>
                                )
                              )}
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  if (!confirm(`Descartar orden #${order.orderNumber.slice(-8)}?`)) return;
                                  try {
                                    const response = await fetch('/api/orders', {
                                      method: 'PATCH',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ orderNumber: order.orderNumber, dismissed: true }),
                                    });
                                    const data = await response.json();
                                    if (data.success) { onRefresh?.(); } else { alert(data.error || 'Error'); }
                                  } catch (err: any) { alert(err.message || 'Error'); }
                                }}
                                className="px-3 py-2 bg-gray-500/10 text-gray-400 border border-gray-500/20 rounded-lg hover:bg-gray-500/20 transition text-sm"
                              >Descartar</button>
                            </div>
                          </>
                        ) : (
                          <ChatSection orderNumber={order.orderNumber} />
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

      {/* Bulk Dismiss Modal */}
      {showBulkDismissModal && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setShowBulkDismissModal(false)}
        >
          <div
            className="bg-[#13111c] rounded-xl p-6 w-full max-w-md border border-[#2d2640]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              Descartar Órdenes Seleccionadas
            </h3>

            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-4">
              <p className="text-red-400">
                Estás a punto de descartar <strong>{selectedOrders.size} orden(es)</strong>.
              </p>
              <p className="text-red-400/80 text-sm mt-1">
                Estas órdenes se ocultarán del dashboard pero no se eliminarán de la base de datos.
              </p>
            </div>

            {/* Summary of selected orders */}
            <div className="bg-[#2d2640] rounded-lg p-3 mb-4 max-h-40 overflow-y-auto">
              <p className="text-gray-400 text-xs mb-2">Órdenes seleccionadas:</p>
              {orders
                .filter(o => selectedOrders.has(o.orderNumber))
                .map(o => (
                  <div key={o.orderNumber} className="flex justify-between text-sm py-1 border-b border-[#3d3655] last:border-0">
                    <span className="text-gray-400 font-mono">{o.orderNumber.slice(-8)}</span>
                    <span className="text-white">${parseFloat(o.totalPrice).toLocaleString()}</span>
                    <span className="text-gray-500 truncate ml-2 max-w-[100px]">{o.buyerNickName}</span>
                  </div>
                ))}
              <div className="flex justify-between text-sm pt-2 mt-2 border-t border-[#3d3655] font-medium">
                <span className="text-gray-400">Total:</span>
                <span className="text-white">
                  ${orders
                    .filter(o => selectedOrders.has(o.orderNumber))
                    .reduce((sum, o) => sum + parseFloat(o.totalPrice), 0)
                    .toLocaleString()} MXN
                </span>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowBulkDismissModal(false)}
                disabled={bulkDismissing}
                className="flex-1 px-4 py-2 bg-[#2d2640] text-gray-300 rounded-lg hover:bg-[#3d3655] transition disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleBulkDismiss}
                disabled={bulkDismissing}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {bulkDismissing ? (
                  <>
                    <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"></div>
                    Procesando...
                  </>
                ) : (
                  <>Descartar {selectedOrders.size} orden(es)</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
