'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getPool } from '@/server/db.ts';
import { publicMessage } from '@/server/errors.ts';
import { stepUp, confirmEnrollment, generateBackupCodes, requestEmailCode, verifyLoginMfa } from '@/server/auth/mfa.ts';
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

/** Envia o código ao e-mail pessoal (tela de código do login e diálogo de reautenticação). */
export async function emailCodeAction(): Promise<ActionState> {
  const st = await getSessionState();
  if (st.status === 'ANONIMO') return { ok: false, message: 'Sessão expirada. Entre novamente.', at: Date.now() };
  try {
    const to = await requestEmailCode(getPool(), st.session);
    return { ok: true, message: `Código enviado para ${to}. Ele vale 10 minutos.`, at: Date.now() };
  } catch (err) {
    return { ok: false, message: publicMessage(err), at: Date.now() };
  }
}

export type BackupCodesState = ActionState & { codes?: string[] };

export async function backupCodesAction(_prev: BackupCodesState, fd: FormData): Promise<BackupCodesState> {
  const st = await getSessionState();
  if (st.status !== 'AUTENTICADO') return { ok: false, message: 'Sessão expirada. Entre novamente.', at: Date.now() };
  try {
    const codes = await generateBackupCodes(getPool(), st.session, String(fd.get('code') ?? ''));
    return { ok: true, message: 'Novos códigos gerados. Os anteriores deixaram de valer.', codes, at: Date.now() };
  } catch (err) {
    return { ok: false, message: publicMessage(err), at: Date.now() };
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
