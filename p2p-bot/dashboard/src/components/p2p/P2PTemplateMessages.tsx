'use client';

import { useState } from 'react';
import { copyToClipboard } from '@/lib/order-utils';

const templates = [
  'Necesito tu CLABE para enviar tu pago',
  'Necesito ver tu INE/identificacion',
  'Ya libere tu crypto. Gracias!',
  'El nombre no coincide con tu cuenta Binance',
  'Aun no veo reflejado tu pago. Envia comprobante',
  'Envia el pago desde una cuenta a TU nombre',
  'Ya confirme tu pago. Estoy liberando tu crypto',
];

export function P2PTemplateMessages() {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const handleCopy = async (text: string, idx: number) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 2000);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1 mb-3">
        <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span className="text-xs text-gray-500">Toca para copiar y pegar en Binance</span>
      </div>
      {templates.map((msg, idx) => {
        const isCopied = copiedIdx === idx;
        return (
          <button
            key={idx}
            onClick={() => handleCopy(msg, idx)}
            className={`p2p-template w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all duration-200 flex items-center gap-3 ${
              isCopied
                ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-400'
                : 'bg-[#1a2438] border border-[#1e2a3e] text-gray-300 hover:bg-[#1e2a3e] active:scale-[0.98]'
            }`}
          >
            <span className="flex-1">{msg}</span>
            {isCopied ? (
              <svg className="w-5 h-5 text-emerald-400 shrink-0 copy-flash" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4 text-gray-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );
}
