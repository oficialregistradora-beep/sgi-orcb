import { NextResponse, type NextRequest } from 'next/server';

// Política de segurança de conteúdo com nonce por requisição e cabeçalhos de proteção.
// A autenticação é verificada no servidor (layouts, ações e rotas); aqui apenas se evita
// renderizar páginas internas para quem não tem cookie de sessão.

const PUBLIC_PREFIXES = ['/login', '/mfa', '/api/', '/_next/', '/favicon'];

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self'${isDev ? " 'unsafe-inline'" : ` 'nonce-${nonce}'`}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com",
    "frame-ancestors 'none'",
    ...(request.nextUrl.protocol === 'https:' ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  const path = request.nextUrl.pathname;
  const hasSession = request.cookies.has('__Host-sgi_sessao') || request.cookies.has('sgi_sessao');
  if (!hasSession && !PUBLIC_PREFIXES.some((p) => path.startsWith(p))) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image|favicon.ico).*)' }],
};
