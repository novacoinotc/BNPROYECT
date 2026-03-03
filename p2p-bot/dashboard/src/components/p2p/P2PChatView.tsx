'use client';

import { useState, useEffect, useRef } from 'react';
import { ChatMessage } from '@/lib/order-utils';

interface P2PChatViewProps {
  orderNumber: string;
}

export function P2PChatView({ orderNumber }: P2PChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  // Auto-scroll to bottom when messages load
  useEffect(() => {
    if (scrollRef.current && messages.length > 0) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  if (loading) {
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
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Read-only banner */}
      <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg mb-3">
        <svg className="w-4 h-4 text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
        <span className="text-xs text-amber-400">Solo lectura - usa la pestaña Mensajes para copiar respuestas</span>
      </div>

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
                  <a href={msg.imageUrl} target="_blank" rel="noopener noreferrer" className="block">
                    <img
                      src={msg.thumbnailUrl}
                      alt="Imagen"
                      className="max-w-full rounded cursor-pointer hover:opacity-80"
                      style={{ maxHeight: '150px' }}
                    />
                    <span className="text-xs text-blue-400 mt-1 block">Ver imagen completa</span>
                  </a>
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
