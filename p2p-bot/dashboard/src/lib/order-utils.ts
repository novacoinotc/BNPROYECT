export interface VerificationStep {
  timestamp: string;
  status: string;
  message: string;
  details?: Record<string, any>;
}

export interface Payment {
  transactionId: string;
  amount: string;
  senderName: string;
  status: string;
  matchedAt: string | null;
}

export interface ChatMessage {
  id: string;
  content: string;
  type: string;
  fromNickName: string;
  isSelf: boolean;
  imageUrl?: string;
  thumbnailUrl?: string;
  timestamp: number;
}

export interface P2POrder {
  orderNumber: string;
  tradeType: 'BUY' | 'SELL';
  status: string;
  totalPrice: string;
  asset: string;
  fiatUnit: string;
  amount: string;
  unitPrice: string;
  buyerUserNo: string;
  buyerNickName: string;
  buyerRealName: string | null;
  binanceCreateTime: string;
  paidAt: string | null;
  releasedAt: string | null;
  verificationStatus: string | null;
  verificationTimeline: VerificationStep[] | null;
  payments: Payment[];
  isTrustedBuyer?: boolean;
}

export const statusColors: Record<string, string> = {
  PENDING: 'status-pending',
  PAID: 'status-paid',
  COMPLETED: 'status-completed',
  CANCELLED: 'status-cancelled',
  CANCELLED_SYSTEM: 'status-cancelled',
  CANCELLED_TIMEOUT: 'status-cancelled',
  APPEALING: 'bg-orange-500/20 text-orange-400',
};

export const statusLabels: Record<string, string> = {
  PENDING: 'Esperando pago',
  PAID: 'PAID',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  CANCELLED_SYSTEM: 'CANCELLED',
  CANCELLED_TIMEOUT: 'CANCELLED',
  APPEALING: 'APPEAL',
};

export const verificationStatusColors: Record<string, string> = {
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

export const verificationStatusLabels: Record<string, string> = {
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

export const stepEmojis: Record<string, string> = {
  AWAITING_PAYMENT: '\u23F3',
  BUYER_MARKED_PAID: '\uD83D\uDCDD',
  BANK_PAYMENT_RECEIVED: '\uD83D\uDCB0',
  PAYMENT_MATCHED: '\uD83D\uDD17',
  AMOUNT_VERIFIED: '\u2705',
  AMOUNT_MISMATCH: '\u26A0\uFE0F',
  NAME_VERIFIED: '\u2705',
  NAME_MISMATCH: '\u26A0\uFE0F',
  READY_TO_RELEASE: '\uD83D\uDE80',
  RELEASED: '\u2728',
  MANUAL_REVIEW: '\uD83D\uDC64',
};

export function getDescriptiveStatus(order: P2POrder): { emoji: string; label: string; color: string; description: string } {
  const hasPayment = order.payments.length > 0;
  const paymentMatched = order.payments.some(p => p.status === 'MATCHED');
  const binanceStatus = order.status;
  const verificationStatus = order.verificationStatus;

  if (binanceStatus === 'COMPLETED') {
    return { emoji: '\u2728', label: 'Completada', color: 'bg-green-500/20 text-green-400', description: 'Orden finalizada exitosamente' };
  }

  if (['CANCELLED', 'CANCELLED_SYSTEM', 'CANCELLED_TIMEOUT'].includes(binanceStatus)) {
    return { emoji: '\u274C', label: 'Cancelada', color: 'bg-red-500/20 text-red-400', description: binanceStatus === 'CANCELLED_TIMEOUT' ? 'Cancelada por timeout' : 'Orden cancelada' };
  }

  if (binanceStatus === 'APPEALING') {
    return { emoji: '\u2696\uFE0F', label: 'En disputa', color: 'bg-orange-500/20 text-orange-400', description: 'Orden en proceso de apelacion' };
  }

  if (verificationStatus === 'READY_TO_RELEASE') {
    return { emoji: '\uD83D\uDE80', label: 'Listo para liberar', color: 'bg-emerald-500/20 text-emerald-400', description: 'Todas las verificaciones pasaron - liberar crypto' };
  }

  if (verificationStatus === 'MANUAL_REVIEW' || verificationStatus === 'NAME_MISMATCH') {
    return {
      emoji: '\uD83D\uDC64', label: 'Revision manual', color: 'bg-orange-500/20 text-orange-400',
      description: verificationStatus === 'NAME_MISMATCH' ? 'Nombre del pagador no coincide - verificar manualmente' : 'Requiere verificacion manual',
    };
  }

  if (binanceStatus === 'PAID') {
    if (hasPayment && paymentMatched) {
      if (verificationStatus === 'AMOUNT_VERIFIED' || verificationStatus === 'NAME_VERIFIED') {
        return { emoji: '\u2705', label: 'Verificando', color: 'bg-blue-500/20 text-blue-400', description: 'Pago recibido y verificado - procesando liberacion' };
      }
      return { emoji: '\uD83D\uDD0D', label: 'Verificando pago', color: 'bg-purple-500/20 text-purple-400', description: 'Pago recibido - verificando monto y nombre' };
    } else if (hasPayment) {
      return { emoji: '\uD83D\uDD17', label: 'Vinculando pago', color: 'bg-purple-500/20 text-purple-400', description: 'Pago bancario recibido - vinculando a orden' };
    } else {
      return { emoji: '\u23F3', label: 'Esperando pago', color: 'bg-yellow-500/20 text-yellow-400', description: 'Comprador marco pagado - esperando confirmacion bancaria' };
    }
  }

  if (binanceStatus === 'PENDING') {
    if (hasPayment) {
      return { emoji: '\uD83D\uDCB0', label: 'Pago recibido', color: 'bg-blue-500/20 text-blue-400', description: 'Pago bancario recibido - esperando que comprador marque pagado' };
    } else {
      return { emoji: '\u23F3', label: 'Esperando', color: 'bg-gray-500/20 text-gray-400', description: 'Esperando que comprador realice el pago' };
    }
  }

  return { emoji: '\uD83D\uDCCB', label: verificationStatus || binanceStatus, color: 'bg-gray-500/20 text-gray-400', description: 'Estado desconocido' };
}

export function getManualReviewReason(order: P2POrder): { tag: string; emoji: string } | null {
  if (order.verificationStatus !== 'MANUAL_REVIEW' && order.verificationStatus !== 'NAME_MISMATCH') {
    return null;
  }

  if (!order.verificationTimeline || order.verificationTimeline.length === 0) {
    return { tag: 'Revisión manual', emoji: '🔍' };
  }

  // Find the last MANUAL_REVIEW step in the timeline
  const manualSteps = order.verificationTimeline.filter(s => s.status === 'MANUAL_REVIEW');
  const lastManualStep = manualSteps[manualSteps.length - 1];

  if (!lastManualStep?.details) {
    return { tag: 'Revisión manual', emoji: '🔍' };
  }

  const d = lastManualStep.details;

  if (d.reason === 'exceeds_limit') {
    return { tag: 'Supera límite', emoji: '💰' };
  }

  if (d.nameVerified === false || order.verificationStatus === 'NAME_MISMATCH') {
    return { tag: 'Posible tercero', emoji: '👤' };
  }

  if (d.failedCriteria || d.recommendation === 'MANUAL_VERIFICATION') {
    return { tag: 'Poco historial', emoji: '⚠️' };
  }

  return { tag: 'Revisión manual', emoji: '🔍' };
}

export function formatOrderTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatPrice(price: string): string {
  return `$${parseFloat(price).toLocaleString()}`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }
}
