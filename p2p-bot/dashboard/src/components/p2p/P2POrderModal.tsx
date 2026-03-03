'use client';

import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { P2POrder, getDescriptiveStatus, formatPrice, copyToClipboard, stepEmojis, VerificationStep } from '@/lib/order-utils';
import { P2PChatView, chatQueryOptions } from './P2PChatView';
import { P2PTemplateMessages } from './P2PTemplateMessages';

type ModalTab = 'chat' | 'verificacion' | 'mensajes';

interface P2POrderModalProps {
  order: P2POrder;
  onClose: () => void;
  onRelease: (orderNumber: string) => void;
  onReleaseAndVIP: (orderNumber: string) => void;
  onRefresh: () => void;
}

export function P2POrderModal({ order, onClose, onRelease, onReleaseAndVIP, onRefresh }: P2POrderModalProps) {
  const [activeTab, setActiveTab] = useState<ModalTab>('chat');
  const [orderCopied, setOrderCopied] = useState(false);
  const queryClient = useQueryClient();
  const descriptive = getDescriptiveStatus(order);
  const isSell = order.tradeType === 'SELL';
  const canRelease = ['PAID', 'PENDING'].includes(order.status);

  // Prefetch chat on modal mount
  useEffect(() => {
    queryClient.prefetchQuery(chatQueryOptions(order.orderNumber));
  }, [queryClient, order.orderNumber]);

  const handleCopyOrderNumber = async () => {
    const ok = await copyToClipboard(order.orderNumber);
    if (ok) {
      setOrderCopied(true);
      setTimeout(() => setOrderCopied(false), 2000);
    }
  };

  const tabs: { key: ModalTab; label: string }[] = [
    { key: 'chat', label: 'Chat' },
    { key: 'verificacion', label: 'Verificacion' },
    { key: 'mensajes', label: 'Mensajes' },
  ];

  return (
    <div className="modal-backdrop flex items-center justify-center p-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]" onClick={onClose}>
      <div
        className="w-full max-h-[75vh] sm:max-w-lg rounded-2xl bg-[#0d1421] flex flex-col overflow-hidden border border-[#1e2a3e] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 px-4 pt-4 pb-3 border-b border-[#1e2a3e]">
          {/* Top row: close + trade badge + order# */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button onClick={onClose} className="p-1 -ml-1 text-gray-400 hover:text-white transition">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <span className={`px-2 py-0.5 rounded-md text-xs font-bold uppercase ${
                isSell ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/20 text-emerald-400'
              }`}>
                {order.tradeType}
              </span>
              <span className="font-mono text-xs text-gray-400">
                #{order.orderNumber.slice(-8)}
              </span>
            </div>
            <span className={`px-2 py-1 rounded text-xs font-medium ${descriptive.color}`}>
              {descriptive.emoji} {descriptive.label}
            </span>
          </div>

          {/* Order details grid */}
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
            <div>
              <span className="text-gray-500 text-xs">Comprador</span>
              <p className="text-white truncate">
                {order.isTrustedBuyer && <span className="mr-1">&#11088;</span>}
                {order.buyerNickName}
              </p>
            </div>
            <div className="text-right">
              <span className="text-gray-500 text-xs">Total</span>
              <p className="text-white font-semibold">{formatPrice(order.totalPrice)} <span className="text-xs text-gray-500 font-normal">{order.fiatUnit || 'MXN'}</span></p>
            </div>
            <div>
              <span className="text-gray-500 text-xs">Crypto</span>
              <p className="text-white">{parseFloat(order.amount).toFixed(4)} {order.asset}</p>
            </div>
            <div className="text-right">
              <span className="text-gray-500 text-xs">Precio</span>
              <p className="text-white">{formatPrice(order.unitPrice)}</p>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="shrink-0 flex border-b border-[#1e2a3e]">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-1 px-4 py-2.5 text-sm font-medium transition-all ${
                activeTab === tab.key
                  ? 'text-primary-400 border-b-2 border-primary-400'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-4 scroll-touch">
          {activeTab === 'chat' && (
            <P2PChatView orderNumber={order.orderNumber} />
          )}

          {activeTab === 'verificacion' && (
            <div className="space-y-4">
              {/* Payments */}
              {order.payments.length > 0 && (
                <div className="p-3 bg-[#151d2e] rounded-xl border border-[#1e2a3e]">
                  <h4 className="text-sm font-medium text-gray-300 mb-2">Pago Bancario</h4>
                  {order.payments.map((payment) => (
                    <div key={payment.transactionId} className="text-sm space-y-1">
                      <div className="flex justify-between">
                        <span className="text-gray-500">ID:</span>
                        <span className="text-white font-mono text-xs">{payment.transactionId.slice(0, 16)}...</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Monto:</span>
                        <span className="text-white">{formatPrice(payment.amount)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Nombre:</span>
                        <span className="text-white text-xs">{payment.senderName}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Estado:</span>
                        <span className={payment.status === 'MATCHED' ? 'text-green-400' : 'text-yellow-400'}>
                          {payment.status}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Verification timeline */}
              {order.verificationTimeline && order.verificationTimeline.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-gray-300">Timeline</h4>
                  {order.verificationTimeline.map((step: VerificationStep, idx: number) => (
                    <div key={idx} className="flex items-start gap-2 text-sm">
                      <span className="shrink-0">{stepEmojis[step.status] || '\u2022'}</span>
                      <div className="flex-1 min-w-0">
                        <span className="text-gray-300 break-words">{step.message}</span>
                        <span className="text-gray-500 text-xs ml-2">
                          {new Date(step.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {order.payments.length === 0 && (!order.verificationTimeline || order.verificationTimeline.length === 0) && (
                <div className="flex items-center justify-center py-8">
                  <p className="text-sm text-gray-500">Sin datos de verificacion aun</p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'mensajes' && (
            <P2PTemplateMessages />
          )}
        </div>

        {/* Sticky bottom actions */}
        <div className="shrink-0 px-4 py-3 border-t border-[#1e2a3e] bg-[#0d1421] p2p-modal-actions">
          {/* Dual release buttons */}
          {canRelease && (
            <div className="flex gap-2 mb-2">
              <button
                onClick={() => onReleaseAndVIP(order.orderNumber)}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl font-medium transition-all text-sm bg-gradient-to-r from-emerald-600 to-amber-600 text-white hover:from-emerald-700 hover:to-amber-700"
              >
                <span>&#11088;</span>
                Liberar+VIP
              </button>
              <button
                onClick={() => onRelease(order.orderNumber)}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition font-medium text-sm"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                Liberar
              </button>
            </div>
          )}
          {/* Copy order button (secondary) */}
          <button
            onClick={handleCopyOrderNumber}
            className={`w-full flex items-center justify-center gap-2 px-4 py-2 rounded-xl font-medium transition-all text-xs ${
              orderCopied
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'bg-[#1e2a3e] text-gray-400 hover:bg-[#2a3a52]'
            }`}
          >
            {orderCopied ? (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Copiado
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                Copiar # orden
              </>
            )}
          </button>
          {/* Safe area */}
          <div className="h-[env(safe-area-inset-bottom)]" />
        </div>
      </div>
    </div>
  );
}
