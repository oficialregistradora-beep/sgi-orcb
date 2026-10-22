import { addDays, addMonths, diffDays } from './time.ts';

// Regras puras do financeiro gerencial: documentos de fornecedor, vencimentos, fluxo de caixa, previsto × realizado, projeção.

/** Valida CNPJ (dígitos verificadores). Retorna somente dígitos ou null. */
export function normalizeCnpj(input: string): string | null {
  const d = input.replace(/\D/g, '');
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return null;
  const calc = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = w.reduce((acc, x, i) => acc + x * Number(d[i]), 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]) ? d : null;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** Primeiro dia do mês ("2026-11-01") a partir de "2026-11" ou de uma data. */
export function competenceDate(monthOrDate: string): string {
  return `${monthOrDate.slice(0, 7)}-01`;
}

/** Vencimento no mês de competência: dia contratado ou o último dia do mês, se for mais curto. */
export function dueDateIn(competence: string, dueDay: number): string {
  const first = competenceDate(competence);
  const last = addDays(addMonths(first, 1), -1);
  const d = Math.min(dueDay, Number(last.slice(8)));
  return `${first.slice(0, 8)}${String(d).padStart(2, '0')}`;
}

/** Meses ("YYYY-MM") de from a to, inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = competenceDate(from); m <= competenceDate(to); m = addMonths(m, 1)) out.push(m.slice(0, 7));
  return out;
}

export type CashFlowRow = { month: string; inflow: number; outflow: number; net: number; balance: number; payable: number };

/**
 * Fluxo de caixa gerencial por mês (regime de caixa): entradas = receitas recebidas; saídas = pagamentos efetuados;
 * "a pagar" = despesas aprovadas/solicitadas ainda não pagas, pelo vencimento. Saldo acumulado a partir de `opening`.
 */
export function cashFlow(
  months: string[],
  revenues: { received_on: string; cents: number }[],
  payments: { paid_on: string; cents: number }[],
  payables: { due_date: string; cents: number }[],
  opening = 0,
): CashFlowRow[] {
  let balance = opening;
  return months.map((m) => {
    const inflow = revenues.filter((r) => monthOf(r.received_on) === m).reduce((a, r) => a + r.cents, 0);
    const outflow = payments.filter((p) => monthOf(p.paid_on) === m).reduce((a, p) => a + p.cents, 0);
    const payable = payables.filter((p) => monthOf(p.due_date) === m).reduce((a, p) => a + p.cents, 0);
    balance += inflow - outflow;
    return { month: m, inflow, outflow, net: inflow - outflow, balance, payable };
  });
}

export type BudgetKey = { cost_center_id: string; category_id: string };
export type BudgetRow = BudgetKey & { budget: number; paid: number; committed: number; available: number; variance: number; usedPct: number | null };

/**
 * Previsto × realizado por centro de custo e categoria, no período. Realizado = despesas pagas (por competência);
 * comprometido = aprovadas e não pagas; disponível = previsto − realizado − comprometido.
 */
export function budgetVsActual(
  budget: (BudgetKey & { cents: number })[],
  expenses: (BudgetKey & { cents: number; status: string })[],
): BudgetRow[] {
  const key = (k: BudgetKey) => `${k.cost_center_id}|${k.category_id}`;
  const rows = new Map<string, BudgetRow>();
  const get = (k: BudgetKey) => {
    let r = rows.get(key(k));
    if (!r) rows.set(key(k), (r = { cost_center_id: k.cost_center_id, category_id: k.category_id, budget: 0, paid: 0, committed: 0, available: 0, variance: 0, usedPct: null }));
    return r;
  };
  for (const b of budget) get(b).budget += b.cents;
  for (const e of expenses) {
    if (e.status === 'PAGA') get(e).paid += e.cents;
    else if (e.status === 'APROVADA') get(e).committed += e.cents;
  }
  for (const r of rows.values()) {
    r.available = r.budget - r.paid - r.committed;
    r.variance = r.paid - r.budget;
    r.usedPct = r.budget > 0 ? Math.round(((r.paid + r.committed) / r.budget) * 1000) / 10 : null;
  }
  return [...rows.values()];
}

export type ProjectionRow = { month: string; budget: number; contractual: number; scheduled: number; projected: number };

/**
 * Projeção de saídas para os próximos meses: maior entre o orçamento previsto e o já conhecido
 * (despesas lançadas no mês + mensalidades de contratos vigentes ainda não lançadas).
 */
export function projectOutflows(
  months: string[],
  budget: { month: string; cents: number }[],
  contracts: { id: string; start_date: string; end_date: string | null; monthly_cents: number }[],
  scheduled: { month: string; cents: number; contract_id: string | null }[],
): ProjectionRow[] {
  return months.map((m) => {
    const b = budget.filter((x) => x.month === m).reduce((a, x) => a + x.cents, 0);
    const sched = scheduled.filter((x) => x.month === m);
    const launched = new Set(sched.map((x) => x.contract_id).filter(Boolean));
    const contractual = contracts
      .filter((c) => !launched.has(c.id) && monthOf(c.start_date) <= m && (!c.end_date || monthOf(c.end_date) >= m))
      .reduce((a, c) => a + c.monthly_cents, 0);
    const scheduledSum = sched.reduce((a, x) => a + x.cents, 0);
    return { month: m, budget: b, contractual, scheduled: scheduledSum, projected: Math.max(b, scheduledSum + contractual) };
  });
}

/** Contratos vigentes que terminam dentro do prazo de aviso (ou já venceram sem encerramento). */
export function contractAlerts<T extends { end_date: string | null; notice_days: number; status: string }>(contracts: T[], today: string) {
  return contracts
    .filter((c) => c.status === 'VIGENTE' && c.end_date && diffDays(today, c.end_date) <= c.notice_days)
    .map((c) => ({ ...c, daysLeft: diffDays(today, c.end_date!) }));
}
