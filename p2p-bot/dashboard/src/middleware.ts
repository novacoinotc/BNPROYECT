import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';

// Paths that don't require authentication
const publicPaths = [
  '/login',
  '/api/auth',
  '/api/webhook', // Bank webhooks don't need auth
];

// Paths that require admin role
const adminPaths = ['/admin'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Check if it's a public path
  const isPublicPath = publicPaths.some(
    (path) => pathname.startsWith(path) || pathname === path
  );

  if (isPublicPath) {
    return NextResponse.next();
  }

  // Get token from session
  const token = await getToken({
    req: request,
    secret: process.env.NEXTAUTH_SECRET,
  });

  // If no token, redirect to login
  if (!token) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Check admin routes
  const isAdminPath = adminPaths.some((path) => pathname.startsWith(path));
  if (isAdminPath && !token.isAdmin) {
    // Non-admin trying to access admin route - redirect to dashboard
    return NextResponse.redirect(new URL('/', request.url));
  }

  // Add user info to headers for API routes
  const response = NextResponse.next();
  response.headers.set('x-merchant-id', token.id as string);
  response.headers.set('x-is-admin', String(token.isAdmin));

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files (images, etc)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.jpg$|.*\\.svg$).*)',
  ],
};
