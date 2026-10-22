import { NextResponse } from 'next/server';
import { getConfig } from '@/server/config.ts';
import { randomToken, signValue } from '@/server/crypto.ts';
import { buildAuthorizationUrl } from '@/server/auth/google.ts';
import { clientIp, rateLimit } from '@/server/ratelimit.ts';

export const dynamic = 'force-dynamic';

/** Inicia o login Google (authorization code + PKCE). state, nonce e verifier ficam em cookie assinado de curta duração. */
export async function GET(req: Request) {
  const cfg = getConfig();
  if (!rateLimit(`login:${clientIp(req)}`, 20, 60_000)) return new NextResponse('Muitas tentativas. Aguarde um minuto.', { status: 429 });
  if (!cfg.googleConfigured) return NextResponse.redirect(`${cfg.appUrl}/login?erro=google_nao_configurado`);
  const state = randomToken(24);
  const nonce = randomToken(24);
  const verifier = randomToken(48);
  const res = NextResponse.redirect(buildAuthorizationUrl(state, nonce, verifier));
  res.cookies.set('sgi_oauth', signValue(`${state}|${nonce}|${verifier}`), {
    httpOnly: true, secure: cfg.secureCookies, sameSite: 'lax', path: '/api/auth/google', maxAge: 600,
  });
  return res;
}
