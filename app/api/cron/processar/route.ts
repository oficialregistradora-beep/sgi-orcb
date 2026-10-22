import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { ensureProcessedAll } from '@/server/modules/timeclock.ts';
import { processReviewReminders } from '@/server/modules/repository.ts';
import { generateRoutineTasks } from '@/server/modules/routines.ts';
import { processTaskReminders } from '@/server/modules/tasks.ts';
import { addDays, todayLocal } from '@/domain/time.ts';

export const dynamic = 'force-dynamic';

/**
 * Apuração diária de todos os funcionários e avisos de revisão documental (opcional: a apuração também ocorre sob demanda).
 * Destinado ao Cloud Scheduler com cabeçalho Authorization: Bearer <CRON_SECRET>. Sem CRON_SECRET, a rota fica desativada.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET ?? '';
  const auth = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  if (secret.length < 32 || auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
    return new NextResponse('Não autorizado', { status: 401 });
  }
  const n = await ensureProcessedAll();
  const revisoes = await processReviewReminders();
  const rotinas = await generateRoutineTasks(todayLocal(), addDays(todayLocal(), 1));
  const prazos = await processTaskReminders();
  return NextResponse.json({ processados: n, avisosDeRevisao: revisoes, tarefasDeRotina: rotinas, avisosDePrazo: prazos });
}
