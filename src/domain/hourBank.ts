// Banco de horas — regras puras (CLT art. 59). Os créditos são consumidos na ordem PEPS:
// primeiro o que vence antes. Créditos vencidos não somem: ficam "vencidos — requerem pagamento/análise" (J-05).

import { addDays, addMonths } from './time.ts';

export type EntryKind = 'CREDITO' | 'DEBITO_COMPENSACAO' | 'DEBITO_FALTA' | 'PAGAMENTO' | 'ESTORNO' | 'AJUSTE';

export type LedgerEntry = {
  id: string;
  kind: EntryKind;
  minutes: number;
  entryDate: string;
  expiresOn: string | null;
  reversesEntryId: string | null;
};

export type Allocation = { debitEntryId: string; creditEntryId: string; minutes: number };

export type CreditLot = {
  id: string;
  entryDate: string;
  expiresOn: string;
  minutes: number;
  consumed: number;
  remaining: number;
  reversed: boolean;
  status: 'DISPONIVEL' | 'A_VENCER' | 'VENCIDO' | 'UTILIZADO' | 'ESTORNADO';
};

export function creditExpiry(entryDate: string, compensationMonths: number): string {
  return addMonths(entryDate, compensationMonths);
}

/** Prazo por regra coletiva: em meses a partir da data, ou em dias após o fim do mês da acumulação. */
export function expiryByRule(entryDate: string, rule: { modo: 'MESES' | 'DIAS_APOS_MES'; quantidade: number }): string {
  if (rule.modo === 'MESES') return addMonths(entryDate, rule.quantidade);
  const lastOfMonth = addDays(addMonths(`${entryDate.slice(0, 7)}-01`, 1), -1);
  return addDays(lastOfMonth, rule.quantidade);
}

/** Conversão coletiva (ex.: 1 h trabalhada = 1h30 de folga). Arredondamento ao minuto mais próximo. */
export function convertCreditMinutes(minutes: number, minutesOffPerHour: number): number {
  return Math.round((minutes * minutesOffPerHour) / 60);
}

export function buildLots(entries: LedgerEntry[], allocations: Allocation[], today: string, alertDays: number): CreditLot[] {
  const reversed = new Set(entries.filter((e) => e.kind === 'ESTORNO' && e.reversesEntryId).map((e) => e.reversesEntryId));
  const consumed = new Map<string, number>();
  for (const a of allocations) {
    if (reversed.has(a.debitEntryId)) continue; // débito estornado devolve os minutos ao crédito
    consumed.set(a.creditEntryId, (consumed.get(a.creditEntryId) ?? 0) + a.minutes);
  }
  const alertLimit = addDays(today, alertDays);
  return entries
    .filter((e) => e.kind === 'CREDITO')
    .map((e) => {
      const c = consumed.get(e.id) ?? 0;
      const isReversed = reversed.has(e.id);
      const remaining = isReversed ? 0 : Math.max(0, e.minutes - c);
      const expiresOn = e.expiresOn!;
      let status: CreditLot['status'];
      if (isReversed) status = 'ESTORNADO';
      else if (remaining === 0) status = 'UTILIZADO';
      else if (expiresOn < today) status = 'VENCIDO';
      else if (expiresOn <= alertLimit) status = 'A_VENCER';
      else status = 'DISPONIVEL';
      return { id: e.id, entryDate: e.entryDate, expiresOn, minutes: e.minutes, consumed: c, remaining, reversed: isReversed, status };
    })
    .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.entryDate.localeCompare(b.entryDate));
}

/**
 * Aloca `minutes` nos créditos elegíveis em `asOf` (adquiridos até a data e não vencidos), PEPS.
 * `includeExpired` é usado apenas para pagamento de créditos vencidos.
 */
export function allocateFifo(
  lots: CreditLot[],
  minutes: number,
  asOf: string,
  opts: { includeExpired?: boolean; onlyExpired?: boolean } = {},
): { allocations: { creditEntryId: string; minutes: number }[]; shortfall: number } {
  if (!Number.isInteger(minutes) || minutes <= 0) throw new Error('Quantidade de minutos inválida');
  const eligible = lots.filter((l) => {
    if (l.reversed || l.remaining <= 0 || l.entryDate > asOf) return false;
    const expired = l.expiresOn < asOf;
    if (opts.onlyExpired) return expired;
    return opts.includeExpired ? true : !expired;
  });
  let left = minutes;
  const allocations: { creditEntryId: string; minutes: number }[] = [];
  for (const lot of eligible) {
    if (left === 0) break;
    const take = Math.min(lot.remaining, left);
    allocations.push({ creditEntryId: lot.id, minutes: take });
    left -= take;
  }
  return { allocations, shortfall: left };
}

export type BankSummary = {
  balance: number; // soma algébrica de todos os lançamentos
  available: number; // créditos não vencidos e não utilizados
  expiringSoon: number; // parte de `available` que vence dentro do prazo de alerta
  expired: number; // créditos vencidos sem compensação: requerem pagamento/análise
  uncoveredDebits: number; // débitos sem crédito correspondente (saldo negativo), se o acordo admitir
};

export function summarize(entries: LedgerEntry[], allocations: Allocation[], today: string, alertDays: number): BankSummary {
  const lots = buildLots(entries, allocations, today, alertDays);
  const balance = entries.reduce((acc, e) => acc + e.minutes, 0);
  const available = lots.filter((l) => l.status === 'DISPONIVEL' || l.status === 'A_VENCER').reduce((a, l) => a + l.remaining, 0);
  const expiringSoon = lots.filter((l) => l.status === 'A_VENCER').reduce((a, l) => a + l.remaining, 0);
  const expired = lots.filter((l) => l.status === 'VENCIDO').reduce((a, l) => a + l.remaining, 0);
  return { balance, available, expiringSoon, expired, uncoveredDebits: Math.max(0, -balance) };
}

/**
 * Custo estimado (informativo) de minutos de banco: salário/divisor × (1 + adicional%) × horas.
 * Aritmética inteira em centavos (sem ponto flutuante). Retorna string decimal "1234.56".
 */
export function estimateCost(minutes: number, monthlySalary: string, divisorHours: number, premiumPercent: number): string {
  if (!/^\d+(\.\d{1,2})?$/.test(monthlySalary)) throw new Error('Salário inválido');
  const [int, frac = ''] = monthlySalary.split('.');
  const salaryCents = BigInt(int!) * 100n + BigInt(frac.padEnd(2, '0'));
  const num = salaryCents * BigInt(100 + premiumPercent) * BigInt(minutes);
  const den = BigInt(divisorHours) * 100n * 60n;
  const cents = (num * 2n + den) / (den * 2n); // arredondamento meio-para-cima
  const s = cents.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}
