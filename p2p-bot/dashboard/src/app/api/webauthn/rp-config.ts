import { NextRequest } from 'next/server';

/**
 * Get WebAuthn Relying Party configuration from request or environment.
 */
export function getRPConfig(request: NextRequest) {
  const host = request.headers.get('host') || 'localhost';
  const hostname = host.split(':')[0];
  const proto = request.headers.get('x-forwarded-proto') || (process.env.NODE_ENV === 'production' ? 'https' : 'http');

  const rpID = process.env.WEBAUTHN_RP_ID || hostname;
  const rpName = process.env.WEBAUTHN_RP_NAME || 'P2P Dashboard';
  const origin = process.env.WEBAUTHN_ORIGIN || `${proto}://${host}`;

  return { rpID, rpName, origin };
}
