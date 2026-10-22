import { NextResponse, type NextRequest } from 'next/server';
import { getConfig } from '@/server/config.ts';
import { getPool } from '@/server/db.ts';
import { loginDev } from '@/server/auth/google.ts';
import { sameOrigin, sessionCookieName, sessionCookieOptions } from '@/server/web/session.ts';
import { clientIp, rateLimit } from '@/server/ratelimit.ts';

export const dynamic = 'force-dynamic';

/** Login de desenvolvimento/homologação (usuários fictícios). Inexistente quando AUTH_DEV_LOGIN=false. */
export async function POST(req: NextRequest) {
  const cfg = getConfig();
  if (!cfg.devLogin) return new NextResponse('Não encontrado', { status: 404 });
  if (!sameOrigin(req)) return new NextResponse('Origem inválida', { status: 403 });
  if (!rateLimit(`login:${clientIp(req)}`, 20, 60_000)) return new NextResponse('Muitas tentativas.', { status: 429 });
  const form = await req.formData();
  const userId = String(form.get('userId') ?? '');
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '127.0.0.1';
    const { token } = await loginDev(getPool(), userId, ip, req.headers.get('user-agent'));
    const res = NextResponse.redirect(`${cfg.appUrl}/mfa`, 303);
    res.cookies.set(sessionCookieName(), token, sessionCookieOptions());
    return res;
  } catch {
    return NextResponse.redirect(`${cfg.appUrl}/login?erro=nao_autorizado`, 303);
  }
}
