'use client';

interface P2PNewOrdersBannerProps {
  count: number;
  onShow: () => void;
}

export function P2PNewOrdersBanner({ count, onShow }: P2PNewOrdersBannerProps) {
  if (count === 0) return null;

  return (
    <div className="mx-2 mb-1">
      <button
        onClick={onShow}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-primary-500/15 border border-primary-500/30 rounded-lg text-xs text-primary-400 font-medium hover:bg-primary-500/25 transition-all duration-200"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
        </svg>
        {count} nueva{count !== 1 ? 's' : ''} orden{count !== 1 ? 'es' : ''}
        <span className="ml-1 px-1.5 py-0.5 bg-primary-500/20 rounded text-[10px]">Ver</span>
      </button>
    </div>
  );
}
