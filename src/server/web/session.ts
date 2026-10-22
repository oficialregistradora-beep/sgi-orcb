import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getConfig } from '../config.ts';
import { getPool } from '../db.ts';
import { loadPrincipal } from '../authz.ts';
import { validateSession, type SessionRow } from '../auth/session.ts';
import type { Ctx } from '../context.ts';

export function sessionCookieName(): string {
  // Prefixo __Host- exige HTTPS, path=/ e ausência de domínio: impede sobrescrita por subdomínios.
  return getConfig().secureCookies ? '__Host-sgi_sessao' : 'sgi_sessao';
}

export function sessionCookieOptions() {
  return { httpOnly: true, secure: getConfig().secureCookies, sameSite: 'lax' as const, path: '/' };
}

export async function clientInfo(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  // Atrás do balanceador do Cloud Run, o IP do cliente é o primeiro item de X-Forwarded-For.
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || null;
  return { ip, userAgent: h.get('user-agent') };
}

export type SessionState =
  | { status: 'ANONIMO' }
  | { status: 'MFA_PENDENTE'; session: SessionRow }
  | { status: 'AUTENTICADO'; session: SessionRow; ctx: Ctx };

/** Estado da sessão da requisição atual (memoizado por requisição). */
export const getSessionState = cache(async (): Promise<SessionState> => {
  const token = (await cookies()).get(sessionCookieName())?.value;
  if (!token) return { status: 'ANONIMO' };
  const db = getPool();
  const check = await validateSession(db, token);
  if (!check.ok) return { status: 'ANONIMO' };
  const s = check.session;
  if (!s.mfa_verified_at) return { status: 'MFA_PENDENTE', session: s };
  const principal = await loadPrincipal(db, s.user_id);
  if (!principal) return { status: 'ANONIMO' };
  const { ip, userAgent } = await clientInfo();
  return {
    status: 'AUTENTICADO',
    session: s,
    ctx: { principal, sessionId: s.id, authMethod: s.auth_method, mfaVerifiedAt: s.mfa_verified_at, stepUpAt: s.step_up_at, ip, userAgent },
  };
});

/** Para páginas: redireciona ao login ou ao segundo fator quando necessário. */
export async function requirePageCtx(): Promise<Ctx> {
  const st = await getSessionState();
  if (st.status === 'ANONIMO') redirect('/login');
  if (st.status === 'MFA_PENDENTE') redirect('/mfa');
  return st.ctx;
}

/** Proteção CSRF para rotas POST fora das Server Actions: exige Origin igual ao da aplicação. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  return origin === new URL(getConfig().appUrl).origin;
}
