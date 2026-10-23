import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { runDailyRoutine, runIntegrations } from '@/server/modules/daily.ts';

export const dynamic = 'force-dynamic';

/**
 * Rotina diária: apuração, avisos (revisão documental, prazos, vencimentos), tarefas de rotina e integrações.
 * `?somente=integracoes` executa apenas o envio da fila e a sincronização da agenda (agendar a cada 5–15 min).
 * Destinado ao Cloud Scheduler com cabeçalho Authorization: Bearer <CRON_SECRET>. Sem CRON_SECRET, a rota fica desativada.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET ?? '';
  const auth = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  if (secret.length < 32 || auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
    return new NextResponse('Não autorizado', { status: 401 });
  }
  if (new URL(req.url).searchParams.get('somente') === 'integracoes') return NextResponse.json(await runIntegrations());
  return NextResponse.json(await runDailyRoutine());
}
