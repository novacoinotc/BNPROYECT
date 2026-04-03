'use client';

import { useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

interface OrderImage {
  id: string;
  orderNumber: string;
  documentType: string;
  compressedSize: number;
  amount: string | null;
  buyerName: string | null;
  merchantId: string | null;
  createdAt: string;
}

const TYPE_LABELS: Record<string, { label: string; color: string }> = {
  RECEIPT: { label: 'Comprobante', color: 'bg-blue-500/20 text-blue-400' },
  ID_INE: { label: 'INE', color: 'bg-emerald-500/20 text-emerald-400' },
  ID_PASSPORT: { label: 'Pasaporte', color: 'bg-purple-500/20 text-purple-400' },
  ID_LICENSE: { label: 'Licencia', color: 'bg-amber-500/20 text-amber-400' },
  UNKNOWN: { label: 'Otro', color: 'bg-gray-500/20 text-gray-400' },
  BYBIT_REFERENCE: { label: 'Bybit Ref', color: 'bg-orange-500/20 text-orange-400' },
  MANUAL: { label: 'Manual', color: 'bg-cyan-500/20 text-cyan-400' },
};

export default function DocumentsPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [nameSearch, setNameSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['order-images', page, search, nameSearch, typeFilter, dateFrom, dateTo, minAmount, maxAmount],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: '30' });
      if (search) params.set('orderNumber', search);
      if (nameSearch) params.set('buyerName', nameSearch);
      if (typeFilter) params.set('type', typeFilter);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      if (minAmount) params.set('minAmount', minAmount);
      if (maxAmount) params.set('maxAmount', maxAmount);
      const res = await fetch(`/api/order-images?${params}`);
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
    refetchInterval: 15000,
  });

  const images: OrderImage[] = data?.images || [];
  const totalPages = data?.totalPages || 1;
  const total = data?.total || 0;

  const clearFilters = () => {
    setSearch(''); setNameSearch(''); setTypeFilter('');
    setDateFrom(''); setDateTo(''); setMinAmount(''); setMaxAmount('');
    setPage(1);
  };

  const hasFilters = search || nameSearch || typeFilter || dateFrom || dateTo || minAmount || maxAmount;

  const handleUpload = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    const file = formData.get('file') as File;
    if (!file || file.size === 0) return;

    setUploading(true);
    setUploadResult(null);
    try {
      const res = await fetch('/api/order-images/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) {
        setUploadResult(`Guardado como ${data.documentType}${data.buyerNameDetected ? ' — ' + data.buyerNameDetected : ''}`);
        form.reset();
        queryClient.invalidateQueries({ queryKey: ['order-images'] });
        setTimeout(() => { setUploadResult(null); setShowUpload(false); }, 3000);
      } else {
        setUploadResult('Error: ' + data.error);
      }
    } catch (err: any) {
      setUploadResult('Error: ' + err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Documentos</h1>
          <p className="text-sm text-gray-400">
            {total} imagenes guardadas del chat
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowUpload(!showUpload)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
              showUpload ? 'bg-emerald-500/20 text-emerald-400' : 'bg-[#1e2a3e] text-gray-400'
            }`}
          >
            + Subir
          </button>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
              showFilters || hasFilters ? 'bg-primary-500/20 text-primary-400' : 'bg-[#1e2a3e] text-gray-400'
            }`}
          >
            Filtros {hasFilters ? '(activos)' : ''}
          </button>
        </div>
      </div>

      {/* Upload Form */}
      {showUpload && (
        <form onSubmit={handleUpload} className="bg-[#151d2e] rounded-xl border border-[#1e2a3e] p-4 space-y-3">
          <h3 className="text-sm font-semibold text-white">Subir documento</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <input
                ref={fileInputRef}
                type="file"
                name="file"
                accept="image/*"
                required
                className="w-full bg-[#1e2a3e] text-white rounded-lg px-3 py-2 text-sm border border-[#2a3a52] file:mr-3 file:py-1 file:px-3 file:rounded-lg file:border-0 file:bg-primary-500 file:text-white file:text-sm file:cursor-pointer"
              />
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-1 uppercase">Nombre del comprador</label>
              <input
                type="text"
                name="buyerName"
                placeholder="Ej: Juan Perez"
                className="w-full bg-[#1e2a3e] text-white rounded-lg px-3 py-2 text-sm border border-[#2a3a52]"
              />
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-1 uppercase"># Orden (opcional)</label>
              <input
                type="text"
                name="orderNumber"
                placeholder="Ej: 22869..."
                className="w-full bg-[#1e2a3e] text-white rounded-lg px-3 py-2 text-sm border border-[#2a3a52]"
              />
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-1 uppercase">Tipo de documento</label>
              <select name="documentType" className="w-full bg-[#1e2a3e] text-white rounded-lg px-3 py-2 text-sm border border-[#2a3a52]">
                <option value="">Auto-detectar</option>
                <option value="ID_INE">INE</option>
                <option value="ID_PASSPORT">Pasaporte</option>
                <option value="ID_LICENSE">Licencia</option>
                <option value="RECEIPT">Comprobante</option>
                <option value="UNKNOWN">Otro</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-1 uppercase">Monto (opcional)</label>
              <input
                type="text"
                name="amount"
                placeholder="Ej: 5000"
                className="w-full bg-[#1e2a3e] text-white rounded-lg px-3 py-2 text-sm border border-[#2a3a52]"
              />
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-1 uppercase">Notas</label>
              <input
                type="text"
                name="notes"
                placeholder="Ej: INE enviada por WhatsApp"
                className="w-full bg-[#1e2a3e] text-white rounded-lg px-3 py-2 text-sm border border-[#2a3a52]"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={uploading}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
            >
              {uploading ? 'Subiendo...' : 'Subir y clasificar'}
            </button>
            {uploadResult && (
              <span className={`text-sm ${uploadResult.startsWith('Error') ? 'text-red-400' : 'text-emerald-400'}`}>
                {uploadResult}
              </span>
            )}
          </div>
          <p className="text-[10px] text-gray-600">El OCR detecta automaticamente si es INE, pasaporte, licencia o comprobante</p>
        </form>
      )}

      {/* Search + Type (always visible) */}
      <div className="flex gap-3 flex-wrap">
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="# orden..."
          className="flex-1 min-w-[140px] bg-[#1e2a3e] text-white rounded-lg px-3 py-2 text-sm border border-[#2a3a52] focus:border-primary-500 focus:outline-none"
        />
        <input
          type="text"
          value={nameSearch}
          onChange={(e) => { setNameSearch(e.target.value); setPage(1); }}
          placeholder="Nombre comprador..."
          className="flex-1 min-w-[140px] bg-[#1e2a3e] text-white rounded-lg px-3 py-2 text-sm border border-[#2a3a52] focus:border-primary-500 focus:outline-none"
        />
        <select
          value={typeFilter}
          onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
          className="bg-[#1e2a3e] text-white rounded-lg px-3 py-2 text-sm border border-[#2a3a52]"
        >
          <option value="">Tipo</option>
          <option value="RECEIPT">Comprobantes</option>
          <option value="ID_INE">INE</option>
          <option value="ID_PASSPORT">Pasaporte</option>
          <option value="ID_LICENSE">Licencia</option>
          <option value="UNKNOWN">Otros</option>
        </select>
      </div>

      {/* Advanced Filters */}
      {showFilters && (
        <div className="bg-[#151d2e] rounded-xl border border-[#1e2a3e] p-4 space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className="block text-[10px] text-gray-500 mb-1 uppercase">Desde</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
                className="w-full bg-[#1e2a3e] text-white rounded-lg px-3 py-2 text-sm border border-[#2a3a52]"
              />
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-1 uppercase">Hasta</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
                className="w-full bg-[#1e2a3e] text-white rounded-lg px-3 py-2 text-sm border border-[#2a3a52]"
              />
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-1 uppercase">Monto min</label>
              <input
                type="number"
                value={minAmount}
                onChange={(e) => { setMinAmount(e.target.value); setPage(1); }}
                placeholder="$0"
                className="w-full bg-[#1e2a3e] text-white rounded-lg px-3 py-2 text-sm border border-[#2a3a52]"
              />
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-1 uppercase">Monto max</label>
              <input
                type="number"
                value={maxAmount}
                onChange={(e) => { setMaxAmount(e.target.value); setPage(1); }}
                placeholder="$999,999"
                className="w-full bg-[#1e2a3e] text-white rounded-lg px-3 py-2 text-sm border border-[#2a3a52]"
              />
            </div>
          </div>
          {hasFilters && (
            <button onClick={clearFilters} className="text-xs text-red-400 hover:text-red-300">
              Limpiar filtros
            </button>
          )}
        </div>
      )}

      {/* Image Grid */}
      {isLoading ? (
        <div className="text-center py-12 text-gray-500">Cargando...</div>
      ) : images.length === 0 ? (
        <div className="text-center py-12">
          <svg className="w-12 h-12 mx-auto text-gray-600 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <p className="text-gray-500 text-sm">
            {hasFilters ? 'No hay imagenes con estos filtros' : 'Aun no hay imagenes guardadas'}
          </p>
          <p className="text-gray-600 text-xs mt-1">Las imagenes se guardan automaticamente del chat</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {images.map((img) => {
            const typeInfo = TYPE_LABELS[img.documentType] || TYPE_LABELS.UNKNOWN;
            return (
              <div
                key={img.id}
                onClick={() => setSelectedImage(img.id)}
                className="bg-[#151d2e] rounded-xl border border-[#1e2a3e] overflow-hidden cursor-pointer hover:border-primary-500/50 transition"
              >
                <div className="aspect-[3/4] relative bg-[#0d1520]">
                  <img
                    src={`/api/order-images/${img.id}`}
                    alt={img.documentType}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                  <span className={`absolute top-1.5 left-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${typeInfo.color}`}>
                    {typeInfo.label}
                  </span>
                </div>
                <div className="p-2">
                  <p className="text-xs font-mono text-gray-300 truncate">#{img.orderNumber.slice(-8)}</p>
                  {img.amount && (
                    <p className="text-xs text-emerald-400 font-medium">
                      ${parseFloat(img.amount).toLocaleString('es-MX', { minimumFractionDigits: 2 })}
                    </p>
                  )}
                  {img.buyerName && (
                    <p className="text-[10px] text-gray-500 truncate">{img.buyerName}</p>
                  )}
                  <p className="text-[10px] text-gray-600 mt-0.5">
                    {new Date(img.createdAt).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1.5 bg-[#1e2a3e] text-gray-300 rounded-lg text-sm disabled:opacity-30"
          >
            Anterior
          </button>
          <span className="text-sm text-gray-400">{page} / {totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-1.5 bg-[#1e2a3e] text-gray-300 rounded-lg text-sm disabled:opacity-30"
          >
            Siguiente
          </button>
        </div>
      )}

      {/* Full-size Image Modal */}
      {selectedImage && (
        <div
          className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-[60] p-4"
          onClick={() => setSelectedImage(null)}
        >
          <div className="relative max-w-2xl max-h-[85vh] w-full" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setSelectedImage(null)}
              className="absolute -top-10 right-0 text-gray-400 hover:text-white transition"
            >
              <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <img
              src={`/api/order-images/${selectedImage}`}
              alt="Document"
              className="w-full h-auto max-h-[85vh] object-contain rounded-xl"
            />
          </div>
        </div>
      )}
    </div>
  );
}
