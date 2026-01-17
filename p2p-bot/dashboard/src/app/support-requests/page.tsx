'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

interface SupportRequest {
  id: string;
  orderNumber: string;
  buyerNickName: string;
  buyerRealName: string | null;
  amount: number;
  message: string | null;
  status: 'PENDING' | 'ATTENDED' | 'CLOSED';
  createdAt: string;
  attendedAt: string | null;
  attendedBy: string | null;
  closedAt: string | null;
  notes: string | null;
}

interface SupportRequestsResponse {
  supportRequests: SupportRequest[];
  counts: {
    PENDING: number;
    ATTENDED: number;
    CLOSED: number;
  };
}

async function fetchSupportRequests(status?: string): Promise<SupportRequestsResponse> {
  const url = status ? `/api/support-requests?status=${status}` : '/api/support-requests';
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch support requests');
  return res.json();
}

async function updateSupportRequest(data: {
  id: string;
  status: string;
  attendedBy?: string;
  notes?: string;
}) {
  const res = await fetch('/api/support-requests', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update support request');
  return res.json();
}

export default function SupportRequestsPage() {
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const [selectedRequest, setSelectedRequest] = useState<SupportRequest | null>(null);
  const [notes, setNotes] = useState('');
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['support-requests', filter],
    queryFn: () => fetchSupportRequests(filter),
    refetchInterval: 10000, // Refresh every 10 seconds
  });

  const updateMutation = useMutation({
    mutationFn: updateSupportRequest,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-requests'] });
      setSelectedRequest(null);
      setNotes('');
    },
  });

  const handleStatusUpdate = (id: string, newStatus: string) => {
    updateMutation.mutate({
      id,
      status: newStatus,
      attendedBy: 'Admin', // TODO: Get from session
      notes: notes || undefined,
    });
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('es-MX', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'PENDING':
        return <span className="px-2 py-1 text-xs rounded-full bg-yellow-500/20 text-yellow-400">Pendiente</span>;
      case 'ATTENDED':
        return <span className="px-2 py-1 text-xs rounded-full bg-blue-500/20 text-blue-400">Atendido</span>;
      case 'CLOSED':
        return <span className="px-2 py-1 text-xs rounded-full bg-gray-500/20 text-gray-400">Cerrado</span>;
      default:
        return null;
    }
  };

  const getTimeSince = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary-500"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-6 text-center">
        <p className="text-red-400">Error loading support requests</p>
      </div>
    );
  }

  const counts = data?.counts || { PENDING: 0, ATTENDED: 0, CLOSED: 0 };
  const supportRequests = data?.supportRequests || [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Solicitudes de Ayuda</h1>
          <p className="text-gray-400 text-sm mt-1">
            Compradores que escribieron AYUDA en el chat
          </p>
        </div>
        {counts.PENDING > 0 && (
          <div className="flex items-center gap-2 bg-yellow-500/20 text-yellow-400 px-4 py-2 rounded-lg">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-yellow-500"></span>
            </span>
            <span className="font-medium">{counts.PENDING} pendiente{counts.PENDING !== 1 ? 's' : ''}</span>
          </div>
        )}
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-2">
        <button
          onClick={() => setFilter(undefined)}
          className={`px-4 py-2 rounded-lg text-sm transition-colors ${
            filter === undefined
              ? 'bg-primary-500 text-white'
              : 'bg-dark-700 text-gray-400 hover:text-white'
          }`}
        >
          Todos ({counts.PENDING + counts.ATTENDED + counts.CLOSED})
        </button>
        <button
          onClick={() => setFilter('PENDING')}
          className={`px-4 py-2 rounded-lg text-sm transition-colors ${
            filter === 'PENDING'
              ? 'bg-yellow-500 text-white'
              : 'bg-dark-700 text-gray-400 hover:text-white'
          }`}
        >
          Pendientes ({counts.PENDING})
        </button>
        <button
          onClick={() => setFilter('ATTENDED')}
          className={`px-4 py-2 rounded-lg text-sm transition-colors ${
            filter === 'ATTENDED'
              ? 'bg-blue-500 text-white'
              : 'bg-dark-700 text-gray-400 hover:text-white'
          }`}
        >
          Atendidos ({counts.ATTENDED})
        </button>
        <button
          onClick={() => setFilter('CLOSED')}
          className={`px-4 py-2 rounded-lg text-sm transition-colors ${
            filter === 'CLOSED'
              ? 'bg-gray-500 text-white'
              : 'bg-dark-700 text-gray-400 hover:text-white'
          }`}
        >
          Cerrados ({counts.CLOSED})
        </button>
      </div>

      {/* Support Requests List */}
      <div className="card">
        {supportRequests.length === 0 ? (
          <div className="p-8 text-center text-gray-400">
            <svg className="w-16 h-16 mx-auto mb-4 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
            <p>No hay solicitudes de ayuda {filter ? 'con este estado' : ''}</p>
          </div>
        ) : (
          <div className="divide-y divide-dark-600">
            {supportRequests.map((request) => (
              <div
                key={request.id}
                className={`p-4 hover:bg-dark-700/50 transition-colors ${
                  request.status === 'PENDING' ? 'bg-yellow-500/5' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  {/* Left side - Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-2">
                      {getStatusBadge(request.status)}
                      <span className="text-sm text-gray-400">{getTimeSince(request.createdAt)} ago</span>
                    </div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium">{request.buyerNickName}</span>
                      {request.buyerRealName && (
                        <span className="text-gray-400 text-sm">({request.buyerRealName})</span>
                      )}
                    </div>
                    <div className="text-sm text-gray-400 space-y-1">
                      <p>
                        Orden:{' '}
                        <a
                          href={`/orders/${request.orderNumber}`}
                          className="text-primary-400 hover:underline"
                        >
                          {request.orderNumber}
                        </a>
                      </p>
                      <p>Monto: <span className="text-white">${request.amount.toLocaleString('es-MX')} MXN</span></p>
                      {request.message && (
                        <p>Mensaje: <span className="text-gray-300">&quot;{request.message}&quot;</span></p>
                      )}
                      {request.notes && (
                        <p className="text-blue-400">Notas: {request.notes}</p>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-2">
                      Creado: {formatDate(request.createdAt)}
                      {request.attendedAt && ` | Atendido: ${formatDate(request.attendedAt)}`}
                      {request.closedAt && ` | Cerrado: ${formatDate(request.closedAt)}`}
                    </div>
                  </div>

                  {/* Right side - Actions */}
                  <div className="flex flex-col gap-2">
                    {request.status === 'PENDING' && (
                      <button
                        onClick={() => {
                          setSelectedRequest(request);
                          handleStatusUpdate(request.id, 'ATTENDED');
                        }}
                        disabled={updateMutation.isPending}
                        className="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white text-sm rounded transition-colors disabled:opacity-50"
                      >
                        Marcar Atendido
                      </button>
                    )}
                    {request.status === 'ATTENDED' && (
                      <button
                        onClick={() => setSelectedRequest(request)}
                        disabled={updateMutation.isPending}
                        className="px-3 py-1.5 bg-gray-600 hover:bg-gray-500 text-white text-sm rounded transition-colors disabled:opacity-50"
                      >
                        Cerrar
                      </button>
                    )}
                    {request.status === 'CLOSED' && (
                      <button
                        onClick={() => handleStatusUpdate(request.id, 'PENDING')}
                        disabled={updateMutation.isPending}
                        className="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-500 text-white text-sm rounded transition-colors disabled:opacity-50"
                      >
                        Reabrir
                      </button>
                    )}
                    <a
                      href={`https://p2p.binance.com/trade/detail/${request.orderNumber}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3 py-1.5 bg-dark-600 hover:bg-dark-500 text-gray-300 text-sm rounded transition-colors text-center"
                    >
                      Ver en Binance
                    </a>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Close Modal */}
      {selectedRequest && selectedRequest.status === 'ATTENDED' && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="card w-full max-w-md mx-4">
            <div className="card-header">
              <h3 className="text-lg font-semibold">Cerrar Solicitud</h3>
            </div>
            <div className="card-body space-y-4">
              <p className="text-gray-400">
                Cerrando solicitud de <span className="text-white">{selectedRequest.buyerNickName}</span>
              </p>
              <div>
                <label className="block text-sm text-gray-400 mb-2">Notas (opcional)</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Describe cómo se resolvió..."
                  className="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-primary-500"
                  rows={3}
                />
              </div>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => {
                    setSelectedRequest(null);
                    setNotes('');
                  }}
                  className="px-4 py-2 bg-dark-600 hover:bg-dark-500 text-gray-300 rounded-lg transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => handleStatusUpdate(selectedRequest.id, 'CLOSED')}
                  disabled={updateMutation.isPending}
                  className="px-4 py-2 bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors disabled:opacity-50"
                >
                  {updateMutation.isPending ? 'Guardando...' : 'Cerrar Solicitud'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
