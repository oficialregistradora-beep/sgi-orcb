import { ensureProcessedAll } from './timeclock.ts';
import { processReviewReminders } from './repository.ts';
import { generateRoutineTasks } from './routines.ts';
import { processTaskReminders } from './tasks.ts';
import { processFinanceReminders } from './finance.ts';
import { processQualityReminders } from './security.ts';
import { processTrainingReminders } from './training.ts';
import { generateScheduledEvaluations, processEvaluationReminders } from './evaluations.ts';
import { runAutomations } from './automation.ts';
import { dispatchOutbox, syncCalendar } from './integrations.ts';
import { addDays, todayLocal } from '../../domain/time.ts';

/** Envio da fila de e-mail/Chat e sincronização da agenda; falhas do Google não interrompem quem chamou. */
export async function runIntegrations() {
  const envio = await dispatchOutbox(500).catch((e) => ({ erro: String(e).slice(0, 200) }));
  const agenda = await syncCalendar().catch((e) => ({ erro: String(e).slice(0, 200) }));
  return { envio, agenda };
}

/** Rotina diária: apuração, avisos de todos os módulos, tarefas de rotina, avaliações programadas, automações e integrações. */
export async function runDailyRoutine() {
  const today = todayLocal();
  const out = {
    processados: await ensureProcessedAll(),
    avisosDeRevisao: await processReviewReminders(),
    tarefasDeRotina: await generateRoutineTasks(today, addDays(today, 1)),
    avisosDePrazo: await processTaskReminders(),
    avisosDeVencimento: await processFinanceReminders(),
    avisosDeQualidade: await processQualityReminders(),
    avisosDeTreinamento: await processTrainingReminders(),
    avaliacoesGeradas: await generateScheduledEvaluations(),
    avisosDeAvaliacao: await processEvaluationReminders(),
    automacoes: await runAutomations(),
  };
  // Integrações por último: falhas do Google não interrompem as rotinas internas.
  return { ...out, ...(await runIntegrations()) };
}
