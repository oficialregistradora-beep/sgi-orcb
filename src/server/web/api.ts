import { NextResponse } from 'next/server';
import type { Ctx } from '../context.ts';
import { AppError, publicMessage } from '../errors.ts';
import { getSessionState, sameOrigin } from './session.ts';

/** Envoltório das rotas /api/v1: sessão com MFA, verificação de origem em escrita e erros padronizados. */
export async function apiHandler(req: Request, fn: (ctx: Ctx) => Promise<unknown>): Promise<NextResponse> {
  if (req.method !== 'GET' && !sameOrigin(req)) {
    return NextResponse.json({ erro: 'ORIGEM_INVALIDA', mensagem: 'Origem da requisição não autorizada.' }, { status: 403 });
  }
  const st = await getSessionState();
  if (st.status !== 'AUTENTICADO') {
    return NextResponse.json({ erro: 'NAO_AUTENTICADO', mensagem: 'Autenticação necessária.' }, { status: 401 });
  }
  try {
    const data = await fn(st.ctx);
    return NextResponse.json(data ?? { ok: true }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    const status = err instanceof AppError ? err.status : 'issues' in Object(err) ? 400 : 500;
    if (status === 500) console.error('[api] erro inesperado', err);
    return NextResponse.json({ erro: err instanceof AppError ? err.code : 'ERRO', mensagem: publicMessage(err) }, { status });
  }
}
