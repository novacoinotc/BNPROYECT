'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChatMessage } from '@/lib/order-utils';

interface P2PChatViewProps {
  orderNumber: string;
  buyerNickName?: string;
  buyerUserNo?: string | null;
}

async function fetchChat(orderNumber: string): Promise<ChatMessage[]> {
  const response = await fetch(`/api/chat/${orderNumber}`);
  const data = await response.json();
  if (!data.success) throw new Error(data.error || 'Error al cargar chat');
  return data.messages || [];
}

export const chatQueryOptions = (orderNumber: string) => ({
  queryKey: ['p2p-chat', orderNumber] as const,
  queryFn: () => fetchChat(orderNumber),
  staleTime: 60_000,
});

export function P2PChatView({ orderNumber, buyerNickName, buyerUserNo }: P2PChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [savingImageId, setSavingImageId] = useState<string | null>(null);
  const [savedImageIds, setSavedImageIds] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);

  const { data: rawMessages = [], isLoading, error } = useQuery(chatQueryOptions(orderNumber));

  // Filter out Binance system messages (raw JSON like {"type":"c2c_extend_pay_time_..."})
  const messages = rawMessages.filter((msg) => {
    const text = msg.content?.trim();
    if (!text) return false;
    if (text.startsWith('{') && text.endsWith('}')) {
      try { const obj = JSON.parse(text); return !obj.type; } catch { return true; }
    }
    return true;
  });

  // Auto-scroll to bottom when messages load
  useEffect(() => {
    if (scrollRef.current && messages.length > 0) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSaveAsINE = async (msg: ChatMessage) => {
    if (!msg.imageUrl) return;

    setSavingImageId(msg.id);
    setSaveError(null);

    try {
      // Find TrustedBuyer for this buyer
      const query = buyerUserNo ? `buyerUserNo=${encodeURIComponent(buyerUserNo)}` : '';
      const tbRes = await fetch(`/api/trusted-buyers?${query}`);
      const tbData = await tbRes.json();

      let trustedBuyerId: string | null = null;

      if (tbData.success && tbData.trustedBuyers?.length > 0) {
        // Find by userNo first, then by nickname
        const match = buyerUserNo
          ? tbData.trustedBuyers.find((tb: any) => tb.buyerUserNo === buyerUserNo)
          : tbData.trustedBuyers.find((tb: any) => tb.counterPartNickName === buyerNickName);
        if (match) trustedBuyerId = match.id;
      }

      if (!trustedBuyerId) {
        setSaveError('Comprador no es VIP. Primero agrega como VIP para guardar su INE.');
        return;
      }

      // Save image from chat URL
      const saveRes = await fetch('/api/buyer-documents/from-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trustedBuyerId,
          imageUrl: msg.imageUrl,
          orderNumber,
          chatMessageId: msg.id,
        }),
      });

      const saveData = await saveRes.json();
      if (!saveData.success) {
        setSaveError(saveData.error || 'Error al guardar');
        return;
      }

      setSavedImageIds(prev => new Set(prev).add(msg.id));
    } catch {
      setSaveError('Error de red al guardar INE');
    } finally {
      setSavingImageId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="flex items-center gap-2 text-gray-400">
          <div className="animate-spin h-4 w-4 border-2 border-gray-400 border-t-transparent rounded-full"></div>
          <span className="text-sm">Cargando chat...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-center">
        <p className="text-sm text-red-400">{(error as Error).message}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Read-only banner */}
      <div className="flex items-center gap-1.5 px-2 py-1 bg-amber-500/10 border border-amber-500/20 rounded mb-2">
        <svg className="w-3 h-3 text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
        <span className="text-[10px] text-amber-400">Solo lectura</span>
      </div>

      {/* Save error toast */}
      {saveError && (
        <div className="px-2 py-1.5 mb-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400 flex items-center justify-between">
          <span>{saveError}</span>
          <button onClick={() => setSaveError(null)} className="text-red-400 hover:text-red-300 ml-2">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Chat messages */}
      {messages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-gray-500">No hay mensajes en el chat</p>
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-2 scroll-touch">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.isSelf ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-xl px-3 py-2 ${
                  msg.isSelf
                    ? 'bg-primary-500/20 text-blue-100 rounded-br-sm'
                    : 'bg-[#1a2438] text-gray-200 rounded-bl-sm'
                }`}
              >
                {!msg.isSelf && (
                  <div className="text-[10px] text-gray-400 mb-0.5 font-medium">{msg.fromNickName}</div>
                )}
                {msg.type === 'IMAGE' && msg.thumbnailUrl ? (
                  <div>
                    <a href={msg.imageUrl} target="_blank" rel="noopener noreferrer" className="block">
                      <img
                        src={msg.thumbnailUrl}
                        alt="Imagen"
                        className="max-w-full rounded cursor-pointer hover:opacity-80"
                        style={{ maxHeight: '150px' }}
                      />
                      <span className="text-xs text-blue-400 mt-1 block">Ver imagen completa</span>
                    </a>
                    {/* Save as INE button — only for buyer images */}
                    {!msg.isSelf && msg.imageUrl && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleSaveAsINE(msg); }}
                        disabled={savingImageId === msg.id || savedImageIds.has(msg.id)}
                        className={`mt-1 flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-all ${
                          savedImageIds.has(msg.id)
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            : savingImageId === msg.id
                              ? 'bg-gray-700/50 text-gray-400 cursor-wait'
                              : 'bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20'
                        }`}
                      >
                        {savedImageIds.has(msg.id) ? (
                          <>
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                            INE guardada
                          </>
                        ) : savingImageId === msg.id ? (
                          <>
                            <div className="animate-spin h-3 w-3 border border-gray-400 border-t-transparent rounded-full"></div>
                            Guardando...
                          </>
                        ) : (
                          <>
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0" />
                            </svg>
                            Guardar INE
                          </>
                        )}
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
                )}
                <div className="text-[10px] text-gray-500 mt-1 text-right">
                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
