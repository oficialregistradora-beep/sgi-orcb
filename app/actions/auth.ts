'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getPool } from '@/server/db.ts';
import { publicMessage } from '@/server/errors.ts';
import { stepUp, confirmEnrollment, verifyLoginMfa } from '@/server/auth/mfa.ts';
import { logout } from '@/server/auth/session.ts';
import { getSessionState, sessionCookieName } from '@/server/web/session.ts';
import type { ActionState } from '@/server/web/action.ts';

export async function stepUpAction(code: string): Promise<ActionState> {
  const st = await getSessionState();
  if (st.status !== 'AUTENTICADO') return { ok: false, message: 'Sessão expirada.' };
  try {
    await stepUp(getPool(), st.session, String(code));
    return { ok: true, message: 'Identidade confirmada.' };
  } catch (err) {
    return { ok: false, message: publicMessage(err) };
  }
}

export async function mfaAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const st = await getSessionState();
  if (st.status === 'ANONIMO') return { ok: false, message: 'Sessão expirada. Entre novamente.' };
  if (st.status === 'AUTENTICADO' || st.status === 'REDE_BLOQUEADA') redirect('/painel');
  const code = String(fd.get('code') ?? '').trim();
  try {
    if (fd.get('mode') === 'cadastro') await confirmEnrollment(getPool(), st.session, code);
    else await verifyLoginMfa(getPool(), st.session, code);
  } catch (err) {
    return { ok: false, message: publicMessage(err), at: Date.now() };
  }
  redirect('/painel');
}

export async function logoutAction(): Promise<void> {
  const st = await getSessionState();
  if (st.status !== 'ANONIMO') await logout(getPool(), st.session);
  (await cookies()).delete(sessionCookieName());
  redirect('/login');
}
