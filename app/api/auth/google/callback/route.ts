import { NextResponse, type NextRequest } from 'next/server';
import { getConfig } from '@/server/config.ts';
import { getPool } from '@/server/db.ts';
import { safeEqual, verifySignedValue } from '@/server/crypto.ts';
import { exchangeCode, loginWithGoogleIdentity, verifyIdToken } from '@/server/auth/google.ts';
import { AppError } from '@/server/errors.ts';
import { sessionCookieName, sessionCookieOptions } from '@/server/web/session.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const fail = (code: string) => {
    const r = NextResponse.redirect(`${cfg.appUrl}/login?erro=${code}`);
    r.cookies.delete({ name: 'sgi_oauth', path: '/api/auth/google' });
    return r;
  };
  const url = req.nextUrl;
  if (url.searchParams.get('error')) return fail('cancelado');
  const raw = req.cookies.get('sgi_oauth')?.value;
  const value = raw ? verifySignedValue(raw) : null;
  const [state, nonce, verifier] = value?.split('|') ?? [];
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state') ?? '';
  if (!state || !nonce || !verifier || !code || !safeEqual(state, returnedState)) return fail('estado_invalido');
  try {
    const idToken = await exchangeCode(code, verifier);
    const identity = await verifyIdToken(idToken, nonce);
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const { token } = await loginWithGoogleIdentity(getPool(), identity, ip, req.headers.get('user-agent'));
    const res = NextResponse.redirect(`${cfg.appUrl}/mfa`);
    res.cookies.set(sessionCookieName(), token, sessionCookieOptions());
    res.cookies.delete({ name: 'sgi_oauth', path: '/api/auth/google' });
    return res;
  } catch (err) {
    if (err instanceof AppError && err.code === 'USUARIO_NAO_AUTORIZADO') return fail('nao_autorizado');
    if (err instanceof AppError && err.code === 'DOMINIO_NAO_AUTORIZADO') return fail('dominio');
    console.error('[auth] falha no retorno do Google', err);
    return fail('falha');
  }
}
