'use client';

import { useState, useEffect, Suspense } from 'react';
import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

type LoginStep = 'credentials' | '2fa' | 'setup-passkey';

function LoginForm() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') || '/';
  const error = searchParams.get('error');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState(error || '');
  const [step, setStep] = useState<LoginStep>('credentials');
  const [merchantId, setMerchantId] = useState<string | null>(null);
  const [webauthnSupported, setWebauthnSupported] = useState(false);

  useEffect(() => {
    async function checkSupport() {
      if (typeof window === 'undefined' || !window.PublicKeyCredential) {
        setWebauthnSupported(false);
        return;
      }
      try {
        const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        setWebauthnSupported(available);
      } catch {
        setWebauthnSupported(true); // fallback: assume supported, let WebAuthn ceremony decide
      }
    }
    checkSupport();
  }, []);

  // Step 1: Validate email + password
  const handleCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMessage('');

    try {
      const res = await fetch('/api/auth/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data.error || 'Credenciales invalidas');
        setIsLoading(false);
        return;
      }

      setMerchantId(data.merchantId);

      if (!webauthnSupported) {
        // No biometric support — login directly
        await completeLogin();
        return;
      }

      if (data.requires2fa) {
        // Has passkeys — go to 2FA step
        setStep('2fa');
        setIsLoading(false);
        // Auto-trigger Face ID
        setTimeout(() => handle2FA(), 300);
      } else {
        // No passkeys — force setup
        setStep('setup-passkey');
        setIsLoading(false);
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Error de conexion');
      setIsLoading(false);
    }
  };

  // Step 2a: Verify with existing passkey (2FA)
  const handle2FA = async () => {
    setIsLoading(true);
    setErrorMessage('');

    try {
      // Get authentication options (needs session for merchant-scoped credentials)
      // We use the login-specific endpoint that doesn't require session
      const authUrl = merchantId ? `/api/auth/webauthn?merchantId=${merchantId}` : '/api/auth/webauthn';
      const optionsRes = await fetch(authUrl);
      if (!optionsRes.ok) throw new Error('Error al obtener opciones');
      const options = await optionsRes.json();

      const assertionResponse = await startAuthentication({ optionsJSON: options });

      const verifyRes = await fetch('/api/auth/webauthn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assertionResponse }),
      });
      const verifyData = await verifyRes.json();

      if (!verifyRes.ok || !verifyData.success) {
        throw new Error(verifyData.error || 'Verificacion fallida');
      }

      await completeLogin();
    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
        setErrorMessage('Autenticacion cancelada');
      } else {
        setErrorMessage(err.message || 'Error de verificacion');
      }
      setIsLoading(false);
    }
  };

  // Step 2b: Register new passkey (first time setup)
  const handleSetupPasskey = async () => {
    setIsLoading(true);
    setErrorMessage('');

    try {
      // First, create a temporary session so the register endpoint works
      const loginResult = await signIn('credentials', {
        email,
        password,
        redirect: false,
      });

      if (loginResult?.error) {
        throw new Error(loginResult.error);
      }

      // Poll until session is active (max 5 attempts, 500ms apart)
      let sessionReady = false;
      for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const sessionRes = await fetch('/api/auth/session');
        const sessionData = await sessionRes.json();
        if (sessionData?.user) {
          sessionReady = true;
          break;
        }
      }
      if (!sessionReady) {
        throw new Error('No se pudo establecer la sesion — intenta de nuevo');
      }

      // Now we have a session — register passkey
      const optionsRes = await fetch('/api/webauthn/register');
      if (!optionsRes.ok) throw new Error('Error al obtener opciones de registro');
      const options = await optionsRes.json();

      const attestationResponse = await startRegistration({ optionsJSON: options });

      // Detect device name
      const ua = navigator.userAgent;
      let deviceName = 'Dispositivo';
      if (/iPhone/.test(ua)) deviceName = 'iPhone';
      else if (/iPad/.test(ua)) deviceName = 'iPad';
      else if (/Macintosh/.test(ua)) deviceName = 'Mac';
      else if (/Android/.test(ua)) deviceName = 'Android';

      const verifyRes = await fetch('/api/webauthn/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attestationResponse, deviceName }),
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.json();
        throw new Error(err.error || 'Error al registrar passkey');
      }

      // Already logged in from signIn above — redirect
      window.location.href = callbackUrl;
    } catch (err: any) {
      // If registration failed (not user cancellation), try authenticating
      // with an existing passkey as fallback — covers the case where the
      // passkey exists on the device AND in the DB but validate didn't detect it
      if (err.name !== 'NotAllowedError') {
        try {
          const authOptRes = await fetch('/api/auth/webauthn');
          if (authOptRes.ok) {
            const authOpts = await authOptRes.json();
            const assertionResponse = await startAuthentication({ optionsJSON: authOpts });
            const authVerifyRes = await fetch('/api/auth/webauthn', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ assertionResponse }),
            });
            const authData = await authVerifyRes.json();
            if (authVerifyRes.ok && authData.success) {
              // Passkey works — complete login via credentials + redirect
              await completeLogin();
              return;
            }
          }
        } catch {
          // Auth fallback failed — fall through to show registration error
        }
      }

      if (err.name === 'NotAllowedError') {
        setErrorMessage('Registro cancelado — intenta de nuevo');
      } else if (err.name === 'InvalidStateError') {
        setErrorMessage('Este dispositivo ya tiene una passkey registrada. Intenta iniciar sesion de nuevo.');
      } else if (err.message?.includes('credential manager')) {
        setErrorMessage('Error con el autenticador. Intenta de nuevo o usa otro dispositivo.');
      } else {
        setErrorMessage(err.message || 'Error al registrar');
      }
      setIsLoading(false);
    }
  };

  // Complete login with email + password
  const completeLogin = async () => {
    const result = await signIn('credentials', {
      email,
      password,
      redirect: false,
      callbackUrl,
    });

    if (result?.error) {
      setErrorMessage(result.error);
      setIsLoading(false);
    } else if (result?.ok) {
      window.location.href = callbackUrl;
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 px-4">
      <div className="max-w-md w-full space-y-8">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-3xl font-bold text-white">P2P Bot Terminal</h1>
          <p className="mt-2 text-gray-400">
            {step === 'credentials' && 'Inicia sesion para continuar'}
            {step === '2fa' && 'Verifica tu identidad'}
            {step === 'setup-passkey' && 'Configura tu acceso biometrico'}
          </p>
        </div>

        {/* Error Message */}
        {errorMessage && (
          <div className="bg-red-900/50 border border-red-500 text-red-200 px-4 py-3 rounded-lg">
            {errorMessage}
          </div>
        )}

        {/* Step 1: Email + Password */}
        {step === 'credentials' && (
          <form onSubmit={handleCredentials} className="mt-8 space-y-6">
            <div className="space-y-4">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-300">Email</label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 block w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="tu@email.com"
                />
              </div>
              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-300">Password</label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-1 block w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="••••••••"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={isLoading}
              className="w-full flex justify-center py-3 px-4 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isLoading ? (
                <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              ) : 'Continuar'}
            </button>
          </form>
        )}

        {/* Step 2a: Face ID / Fingerprint verification */}
        {step === '2fa' && (
          <div className="space-y-6">
            <div className="text-center py-4">
              <div className="mx-auto w-16 h-16 rounded-full bg-blue-500/20 flex items-center justify-center mb-4">
                <svg className="w-8 h-8 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 11.5V14m0-2.5v-1a1 1 0 011-1h1m-2 2H5.5a1.5 1.5 0 00-1.5 1.5v0a1.5 1.5 0 001.5 1.5H7m0-3h2m5 3v-1a1 1 0 00-1-1h-1m2 2h1.5a1.5 1.5 0 001.5-1.5v0a1.5 1.5 0 00-1.5-1.5H17m0 3h-2m-3-7V4.5A1.5 1.5 0 0113.5 3v0A1.5 1.5 0 0115 4.5V7m-3 0h3m-3 0H9m6 0v2m-9-2V4.5A1.5 1.5 0 017.5 3v0A1.5 1.5 0 019 4.5V7m0 0v2m3 8v1.5a1.5 1.5 0 01-1.5 1.5v0a1.5 1.5 0 01-1.5-1.5V17m3 0h-3m3 0h3m-6 0v-2" />
                </svg>
              </div>
              <p className="text-white font-medium">Confirma con Face ID o huella</p>
              <p className="text-sm text-gray-500 mt-1">Usa tu biometria para completar el inicio de sesion</p>
            </div>
            <button
              onClick={handle2FA}
              disabled={isLoading}
              className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-lg text-white font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {isLoading ? (
                <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              ) : 'Verificar identidad'}
            </button>
            <button
              onClick={() => { setStep('credentials'); setErrorMessage(''); }}
              className="w-full text-sm text-gray-500 hover:text-gray-300 transition"
            >
              Volver
            </button>
          </div>
        )}

        {/* Step 2b: Setup passkey (first time) */}
        {step === 'setup-passkey' && (
          <div className="space-y-6">
            <div className="text-center py-4">
              <div className="mx-auto w-16 h-16 rounded-full bg-amber-500/20 flex items-center justify-center mb-4">
                <svg className="w-8 h-8 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <p className="text-white font-medium">Configura tu acceso biometrico</p>
              <p className="text-sm text-gray-500 mt-1">
                Por seguridad, necesitas registrar Face ID o huella digital para iniciar sesion
              </p>
            </div>
            <button
              onClick={handleSetupPasskey}
              disabled={isLoading}
              className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-lg text-white font-medium bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 disabled:opacity-50 transition"
            >
              {isLoading ? (
                <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              ) : 'Registrar Face ID / Huella'}
            </button>
            <button
              onClick={() => { setStep('credentials'); setErrorMessage(''); }}
              className="w-full text-sm text-gray-500 hover:text-gray-300 transition"
            >
              Volver
            </button>
          </div>
        )}

        {/* Footer */}
        <p className="text-center text-sm text-gray-500">
          P2P Bot Multi-Merchant System
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
      </div>
    }>
      <LoginForm />
    </Suspense>
  );
}
