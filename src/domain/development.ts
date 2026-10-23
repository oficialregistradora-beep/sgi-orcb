import { addDays, addMonths, diffDays } from './time.ts';

// Regras puras de treinamentos e avaliações (Fase 5b).

export type TrainingSituation = 'VALIDO' | 'A_VENCER' | 'VENCIDO' | 'PENDENTE' | 'EM_ANDAMENTO' | 'NOVA_VERSAO';

export type RecordLite = { status: string; completed_on: string | null; expires_on: string | null; document_version_id?: string | null };

/**
 * Situação de uma pessoa em um treinamento: considera a conclusão mais recente não anulada.
 * Para estudo de POP, conclusão sobre versão anterior do documento vigente pede novo estudo.
 */
export function trainingSituation(records: RecordLite[], today: string, noticeDays: number, currentDocVersionId?: string | null):
  { situation: TrainingSituation; completedOn: string | null; expiresOn: string | null } {
  const done = records.filter((r) => r.status === 'CONCLUIDO' && r.completed_on).sort((a, b) => b.completed_on!.localeCompare(a.completed_on!));
  const last = done[0];
  if (!last) {
    const open = records.some((r) => r.status === 'INSCRITO' || r.status === 'PENDENTE_VALIDACAO');
    return { situation: open ? 'EM_ANDAMENTO' : 'PENDENTE', completedOn: null, expiresOn: null };
  }
  const base = { completedOn: last.completed_on, expiresOn: last.expires_on };
  if (currentDocVersionId && last.document_version_id && last.document_version_id !== currentDocVersionId) return { situation: 'NOVA_VERSAO', ...base };
  if (last.expires_on) {
    if (last.expires_on <= today) return { situation: 'VENCIDO', ...base };
    if (diffDays(today, last.expires_on) <= noticeDays) return { situation: 'A_VENCER', ...base };
  }
  return { situation: 'VALIDO', ...base };
}

export const trainingExpiry = (completedOn: string, validityMonths: number | null) => (validityMonths ? addMonths(completedOn, validityMonths) : null);

/** O treinamento obrigatório alcança a pessoa? (todos, setores ou cargos). */
export function inAudience(t: { audience_type: string; sectors: string[]; jobs: string[] }, p: { sector_id: string; job_title_id: string }): boolean {
  if (t.audience_type === 'TODOS') return true;
  if (t.audience_type === 'SETORES') return t.sectors.includes(p.sector_id);
  return t.jobs.includes(p.job_title_id);
}

/** Correção da avaliação de aprendizagem: percentual de acertos (arredondado para baixo). */
export function gradeAttempt(correct: number[], answers: number[]): { score: number; hits: number } {
  if (answers.length !== correct.length) throw new Error('Responda todas as questões.');
  const hits = correct.filter((c, i) => answers[i] === c).length;
  return { score: correct.length ? Math.floor((hits * 100) / correct.length) : 0, hits };
}

/** Média ponderada normalizada para 0–100 (escala 1..max). */
export function weightedScore(items: { score: number; weight: number }[], scaleMax: number): number | null {
  const w = items.reduce((a, i) => a + i.weight, 0);
  if (!w) return null;
  const avg = items.reduce((a, i) => a + i.score * i.weight, 0) / w;
  return Math.round(((avg - 1) / (scaleMax - 1)) * 10000) / 100;
}

export type Schedule = { trigger: 'DIAS_APOS_ADMISSAO' | 'ANUAL'; days_after: number | null; annual_month: number | null; annual_day: number | null; lead_days: number };

/**
 * Avaliação programada devida para a pessoa até `today + lead`: retorna a data-base (referência única) e o prazo,
 * ou null. Por admissão: uma única vez. Anual: a ocorrência do ano corrente, a partir do segundo ano de casa
 * (pessoas admitidas há menos de 6 meses não entram no ciclo anual).
 */
export function scheduleDue(s: Schedule, admission: string, today: string): { ref: string; due: string } | null {
  const horizon = addDays(today, s.lead_days);
  if (s.trigger === 'DIAS_APOS_ADMISSAO') {
    const due = addDays(admission, s.days_after!);
    // Não cria retroativamente avaliações de mais de 30 dias atrás (cadastro tardio ou programação criada depois).
    return due <= horizon && diffDays(due, today) <= 30 ? { ref: `ADM+${s.days_after}`, due } : null;
  }
  const year = Number(today.slice(0, 4));
  for (const y of [year - 1, year, year + 1]) {
    const due = `${y}-${String(s.annual_month).padStart(2, '0')}-${String(s.annual_day).padStart(2, '0')}`;
    if (due > horizon || diffDays(due, today) > 30) continue;
    if (diffDays(admission, due) < 183) continue;
    return { ref: `ANUAL-${y}`, due };
  }
  return null;
}
