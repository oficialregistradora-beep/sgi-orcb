import { revalidatePath } from 'next/cache';
import type { Ctx } from '../context.ts';
import { AppError, publicMessage } from '../errors.ts';
import { getSessionState } from './session.ts';

export type ActionState = {
  ok: boolean;
  message: string;
  stepUp?: boolean;
  at?: number; // força re-renderização de mensagens iguais em envios consecutivos
};

export const INITIAL_STATE: ActionState = { ok: true, message: '' };

/**
 * Executor padrão das Server Actions: exige sessão autenticada com MFA, converte erros em mensagens
 * seguras e sinaliza quando a operação exige reautenticação (o formulário abre o diálogo do código).
 */
export async function runAction(
  fn: (ctx: Ctx) => Promise<string | void>,
  revalidate: string | string[] = [],
): Promise<ActionState> {
  const st = await getSessionState();
  if (st.status === 'REDE_BLOQUEADA') return { ok: false, message: 'Acesso permitido apenas na rede da serventia.', at: Date.now() };
  if (st.status !== 'AUTENTICADO') return { ok: false, message: 'Sessão expirada. Entre novamente.', at: Date.now() };
  try {
    const message = (await fn(st.ctx)) || 'Operação concluída.';
    for (const p of Array.isArray(revalidate) ? revalidate : [revalidate]) revalidatePath(p);
    // Envio oportunista da fila de integrações (e-mail/Chat), sem esperar o Google: falhas ficam para a rotina agendada.
    void import('../modules/integrations.ts').then((m) => m.dispatchOutbox(20)).catch(() => undefined);
    return { ok: true, message, at: Date.now() };
  } catch (err) {
    if (!(err instanceof AppError) && !(err && typeof err === 'object' && 'issues' in err)) {
      console.error('[action] erro inesperado', err);
    }
    return {
      ok: false,
      message: publicMessage(err),
      stepUp: err instanceof AppError && err.code === 'REAUTENTICACAO_NECESSARIA',
      at: Date.now(),
    };
  }
}

export function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export function optStr(fd: FormData, key: string): string | undefined {
  const v = str(fd, key);
  return v === '' ? undefined : v;
}

export function int(fd: FormData, key: string): number {
  const v = Number(str(fd, key));
  return Number.isFinite(v) ? Math.trunc(v) : NaN;
}

/** Converte "HH:MM" (duração) em minutos. */
export function durationToMinutes(v: string): number {
  const m = /^(\d{1,3}):([0-5]\d)$/.exec(v.trim());
  if (!m) throw new AppError('Informe a duração no formato HH:MM.');
  return Number(m[1]) * 60 + Number(m[2]);
}
