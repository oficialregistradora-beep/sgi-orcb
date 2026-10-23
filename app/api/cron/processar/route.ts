import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { ensureProcessedAll } from '@/server/modules/timeclock.ts';
import { processReviewReminders } from '@/server/modules/repository.ts';
import { generateRoutineTasks } from '@/server/modules/routines.ts';
import { processTaskReminders } from '@/server/modules/tasks.ts';
import { processFinanceReminders } from '@/server/modules/finance.ts';
import { processQualityReminders } from '@/server/modules/security.ts';
import { dispatchOutbox, syncCalendar } from '@/server/modules/integrations.ts';
import { addDays, todayLocal } from '@/domain/time.ts';

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
  if (new URL(req.url).searchParams.get('somente') === 'integracoes') {
    const envio = await dispatchOutbox(500).catch((e) => ({ erro: String(e).slice(0, 200) }));
    const agenda = await syncCalendar().catch((e) => ({ erro: String(e).slice(0, 200) }));
    return NextResponse.json({ envio, agenda });
  }
  const n = await ensureProcessedAll();
  const revisoes = await processReviewReminders();
  const rotinas = await generateRoutineTasks(todayLocal(), addDays(todayLocal(), 1));
  const prazos = await processTaskReminders();
  const vencimentos = await processFinanceReminders();
  const qualidade = await processQualityReminders();
  // Integrações por último: falhas do Google não interrompem as rotinas internas.
  const envio = await dispatchOutbox(500).catch((e) => ({ erro: String(e).slice(0, 200) }));
  const agenda = await syncCalendar().catch((e) => ({ erro: String(e).slice(0, 200) }));
  return NextResponse.json({ processados: n, avisosDeRevisao: revisoes, tarefasDeRotina: rotinas, avisosDePrazo: prazos, avisosDeVencimento: vencimentos, avisosDeQualidade: qualidade, envio, agenda });
}
