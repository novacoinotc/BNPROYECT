'use client';

import { useState, useEffect, useRef } from 'react';

interface BuyerDocMeta {
  id: string;
  documentType: string;
  mimeType: string;
  originalSize: number | null;
  compressedSize: number | null;
  sourceOrderNumber: string | null;
  notes: string | null;
  uploadedBy: string | null;
  createdAt: string;
}

interface INEViewerProps {
  trustedBuyerId: string;
  buyerName: string;
  onClose: () => void;
}

export function INEViewer({ trustedBuyerId, buyerName, onClose }: INEViewerProps) {
  const [documents, setDocuments] = useState<BuyerDocMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchDocuments = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/buyer-documents?trustedBuyerId=${trustedBuyerId}`);
      const data = await res.json();
      if (data.success) {
        setDocuments(data.documents);
      }
    } catch {
      setError('Error al cargar documentos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDocuments();
  }, [trustedBuyerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setError('Solo se permiten archivos de imagen');
      return;
    }

    setUploading(true);
    setError(null);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');

      const res = await fetch('/api/buyer-documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trustedBuyerId,
          imageBase64: base64,
          documentType: 'INE',
          notes: 'Subida manual desde dashboard',
        }),
      });

      const data = await res.json();
      if (data.success) {
        fetchDocuments();
      } else {
        setError(data.error || 'Error al subir');
      }
    } catch {
      setError('Error de red al subir imagen');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDelete = async (docId: string) => {
    if (!confirm('Eliminar este documento?')) return;

    try {
      const res = await fetch('/api/buyer-documents', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: docId }),
      });
      const data = await res.json();
      if (data.success) {
        setDocuments(prev => prev.filter(d => d.id !== docId));
        if (selectedImage === docId) setSelectedImage(null);
      }
    } catch {
      setError('Error al eliminar');
    }
  };

  const formatSize = (bytes: number | null) => {
    if (!bytes) return '—';
    return bytes < 1024 ? `${bytes} B`
      : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-dark-card rounded-t-xl sm:rounded-xl w-full sm:max-w-lg max-h-[80vh] flex flex-col border border-dark-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 px-4 pt-3 pb-2 border-b border-dark-border flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-white">Documentos INE</h3>
            <p className="text-xs text-gray-400 mt-0.5">{buyerName}</p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-white transition">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {error && (
            <div className="mb-3 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400 flex items-center justify-between">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-300">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin h-6 w-6 border-2 border-gray-400 border-t-transparent rounded-full"></div>
            </div>
          ) : documents.length === 0 ? (
            <div className="text-center py-12">
              <svg className="w-12 h-12 mx-auto mb-3 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0" />
              </svg>
              <p className="text-sm text-gray-500">No hay documentos guardados</p>
              <p className="text-xs text-gray-600 mt-1">Sube una foto de INE o guardala desde el chat</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {documents.map((doc) => (
                <div key={doc.id} className="bg-[#151d2e] rounded-lg border border-[#1e2a3e] overflow-hidden group">
                  {/* Image thumbnail */}
                  <div
                    className="relative cursor-pointer"
                    onClick={() => setSelectedImage(selectedImage === doc.id ? null : doc.id)}
                  >
                    <img
                      src={`/api/buyer-documents/${doc.id}/image`}
                      alt={doc.documentType}
                      className="w-full h-32 object-cover hover:opacity-80 transition"
                    />
                    <div className="absolute top-1 left-1 bg-black/60 text-[10px] text-white px-1.5 py-0.5 rounded">
                      {doc.documentType}
                    </div>
                  </div>
                  {/* Meta info */}
                  <div className="p-2 text-xs">
                    <div className="text-gray-500">{new Date(doc.createdAt).toLocaleDateString()}</div>
                    <div className="text-gray-600 text-[10px]">{formatSize(doc.compressedSize)}</div>
                    {doc.sourceOrderNumber && (
                      <div className="text-gray-600 text-[10px] truncate">Orden: #{doc.sourceOrderNumber.slice(-8)}</div>
                    )}
                    {doc.uploadedBy && (
                      <div className="text-gray-600 text-[10px]">{doc.uploadedBy}</div>
                    )}
                  </div>
                  {/* Actions */}
                  <div className="px-2 pb-2 flex gap-2">
                    <a
                      href={`/api/buyer-documents/${doc.id}/image`}
                      download={`INE_${buyerName.replace(/\s+/g, '_')}_${doc.id.slice(-6)}.jpg`}
                      className="text-[10px] text-blue-400 hover:text-blue-300"
                    >
                      Descargar
                    </a>
                    <button
                      onClick={() => handleDelete(doc.id)}
                      className="text-[10px] text-red-400 hover:text-red-300"
                    >
                      Eliminar
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Full-size image viewer */}
          {selectedImage && (
            <div
              className="fixed inset-0 bg-black/80 flex items-center justify-center z-[60] p-4"
              onClick={() => setSelectedImage(null)}
            >
              <img
                src={`/api/buyer-documents/${selectedImage}/image`}
                alt="INE"
                className="max-w-full max-h-full object-contain rounded-lg"
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          )}
        </div>

        {/* Upload button */}
        <div className="shrink-0 px-4 py-3 border-t border-dark-border">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleUpload}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm font-medium disabled:opacity-50"
          >
            {uploading ? (
              <>
                <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"></div>
                Subiendo...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                Subir foto de INE
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
