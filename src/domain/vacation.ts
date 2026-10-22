// Férias — regras puras (CLT arts. 129 a 145). Dependentes de validação jurídica: J-13 (redução do art. 130
// por faltas injustificadas não é aplicada automaticamente) e J-14 (regras de convenção coletiva).

import { addDays, addMonths, diffDays, weekdayOf } from './time.ts';

export const ENTITLEMENT_DAYS = 30;
export const MAX_SOLD_DAYS = 10; // abono pecuniário: 1/3 (art. 143)

export type AcqPeriod = {
  index: number;
  start: string;
  end: string; // último dia do período aquisitivo
  concessiveEnd: string; // último dia para gozo sem dobra (art. 134 e 137)
};

/** Períodos aquisitivos desde a admissão, até o que contém `until`. */
export function acquisitivePeriods(admission: string, until: string): AcqPeriod[] {
  const out: AcqPeriod[] = [];
  for (let i = 0; ; i++) {
    const start = addMonths(admission, 12 * i);
    if (start > until) break;
    out.push({
      index: i + 1,
      start,
      end: addDays(addMonths(admission, 12 * (i + 1)), -1),
      concessiveEnd: addDays(addMonths(admission, 12 * (i + 2)), -1),
    });
  }
  return out;
}

export type Allocation = { periodStart: string; enjoyedDays: number; soldDays: number; startDate: string };

export type PeriodBalance = AcqPeriod & {
  enjoyed: number;
  sold: number;
  remaining: number;
  fractions: number;
  hasFraction14: boolean;
  status: 'EM_AQUISICAO' | 'DISPONIVEL' | 'A_VENCER' | 'VENCIDAS' | 'QUITADO';
};

export function balances(periods: AcqPeriod[], allocations: Allocation[], today: string, alertDays = 60): PeriodBalance[] {
  return periods.map((p) => {
    const mine = allocations.filter((a) => a.periodStart === p.start);
    const enjoyed = mine.reduce((s, a) => s + a.enjoyedDays, 0);
    const sold = mine.reduce((s, a) => s + a.soldDays, 0);
    const remaining = ENTITLEMENT_DAYS - enjoyed - sold;
    let status: PeriodBalance['status'];
    if (p.end >= today) status = 'EM_AQUISICAO';
    else if (remaining <= 0) status = 'QUITADO';
    else if (p.concessiveEnd < today) status = 'VENCIDAS';
    else if (diffDays(today, p.concessiveEnd) <= alertDays) status = 'A_VENCER';
    else status = 'DISPONIVEL';
    return {
      ...p, enjoyed, sold, remaining, fractions: mine.filter((a) => a.enjoyedDays > 0).length,
      hasFraction14: mine.some((a) => a.enjoyedDays >= 14), status,
    };
  });
}

export type VacationInput = {
  admission: string;
  today: string;
  start: string;
  end: string;
  soldDays: number;
  allocations: Allocation[];
  holidays: Set<string>;
  minNoticeDays: number;
};

export type VacationCheck = { period: PeriodBalance; days: number; warnings: string[] };

export class VacationRuleError extends Error {}

/** Valida uma solicitação de férias e escolhe o período aquisitivo mais antigo com saldo. */
export function validateVacation(i: VacationInput): VacationCheck {
  const fail = (m: string): never => {
    throw new VacationRuleError(m);
  };
  if (i.end < i.start) fail('A data final é anterior à inicial.');
  if (i.start <= i.today) fail('As férias devem começar em data futura.');
  if (!Number.isInteger(i.soldDays) || i.soldDays < 0 || i.soldDays > MAX_SOLD_DAYS) fail('Abono pecuniário: de 0 a 10 dias (art. 143).');
  const days = diffDays(i.start, i.end) + 1;
  if (days < 5) fail('Cada período de férias deve ter no mínimo 5 dias corridos (art. 134, §1º).');

  const all = balances(acquisitivePeriods(i.admission, i.start), i.allocations, i.today);
  const period = all.find((p) => p.end < i.start && p.remaining > 0);
  if (!period) fail('Não há período aquisitivo completo com saldo de férias.');
  const p = period!;
  if (i.soldDays > 0 && p.sold > 0) fail('O abono pecuniário já foi utilizado neste período aquisitivo.');
  const after = p.remaining - days - i.soldDays;
  if (after < 0) fail(`Saldo insuficiente no período aquisitivo ${p.index}: restam ${p.remaining} dia(s).`);
  if (p.fractions + 1 > 3) fail('As férias podem ser fracionadas em no máximo 3 períodos (art. 134, §1º).');
  if (p.fractions + 1 === 3 && after > 0) fail('O terceiro período de férias deve esgotar o saldo do período aquisitivo (máximo de 3 períodos).');
  if (after > 0 && after < 5) fail(`O saldo restante (${after} dia(s)) ficaria inferior a 5 dias, o que impede novo período.`);
  if (!p.hasFraction14 && days < 14 && (after < 14 || p.fractions + 1 === 3)) {
    fail('Um dos períodos de férias deve ter no mínimo 14 dias corridos (art. 134, §1º).');
  }
  // Art. 134, §3º: vedado o início nos dois dias que antecedem feriado ou repouso semanal (domingo).
  for (const d of [addDays(i.start, 1), addDays(i.start, 2)]) {
    if (weekdayOf(d) === 0 || i.holidays.has(d)) {
      fail('É vedado iniciar as férias nos dois dias que antecedem feriado ou o repouso semanal (art. 134, §3º).');
    }
  }
  const warnings: string[] = [];
  if (diffDays(i.today, i.start) < i.minNoticeDays) {
    warnings.push(`Comunicação com menos de ${i.minNoticeDays} dias de antecedência (art. 135): registre a concordância do funcionário.`);
  }
  if (i.end > p.concessiveEnd) {
    warnings.push(`Parte do gozo ocorre após o período concessivo (${p.concessiveEnd}): devido o pagamento em dobro (art. 137).`);
  }
  warnings.push('Verifique faltas injustificadas no período aquisitivo, que podem reduzir a duração das férias (art. 130).');
  return { period: p, days, warnings };
}
