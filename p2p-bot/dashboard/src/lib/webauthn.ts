'use client';

import { startRegistration, startAuthentication } from '@simplewebauthn/browser';

export function checkWebAuthnSupport(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential;
}

/**
 * Register a new passkey (Face ID / Touch ID)
 */
export async function registerPasskey(deviceName?: string) {
  // Step 1: Get registration options from server
  const optionsRes = await fetch('/api/webauthn/register');
  if (!optionsRes.ok) {
    const err = await optionsRes.json();
    throw new Error(err.error || 'Failed to get registration options');
  }
  const options = await optionsRes.json();

  // Step 2: Start registration (triggers biometric prompt)
  const attestationResponse = await startRegistration({ optionsJSON: options });

  // Step 3: Send attestation to server for verification
  const verifyRes = await fetch('/api/webauthn/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attestationResponse, deviceName }),
  });

  if (!verifyRes.ok) {
    const err = await verifyRes.json();
    throw new Error(err.error || 'Registration verification failed');
  }

  return verifyRes.json();
}

/**
 * Authenticate with biometric and release an order
 */
export async function biometricRelease(orderNumber: string) {
  // Step 1: Get authentication options
  const optionsRes = await fetch('/api/webauthn/authenticate');
  if (!optionsRes.ok) {
    const err = await optionsRes.json();
    throw new Error(err.error || 'Failed to get authentication options');
  }
  const options = await optionsRes.json();

  // Step 2: Start authentication (triggers Face ID / fingerprint)
  const assertionResponse = await startAuthentication({ optionsJSON: options });

  // Step 3: Send to release endpoint with biometric flag
  const releaseRes = await fetch('/api/orders/release', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orderNumber,
      biometric: true,
      webauthnResponse: assertionResponse,
    }),
  });

  const data = await releaseRes.json();
  if (!releaseRes.ok || !data.success) {
    throw new Error(data.error || 'Release failed');
  }

  return data;
}
