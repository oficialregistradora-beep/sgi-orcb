// Regras do controle de caixa, sem acesso a banco: troco, cédulas, dinheiro esperado e resumos. Valores em centavos.

export type CashKind = 'ENTRADA' | 'SAIDA_REPASSE' | 'SAIDA_DESPESA' | 'SAIDA_DEVOLUCAO' | 'SUPRIMENTO' | 'SANGRIA' | 'ESTORNO';
export type CashMethod = 'DINHEIRO' | 'PIX' | 'CARTAO_DEBITO' | 'CARTAO_CREDITO' | 'DEPOSITO';

export const CASH_KIND_LABEL: Record<CashKind, string> = {
  ENTRADA: 'Entrada (cliente pagou)',
  SAIDA_REPASSE: 'Saída — repasse (valor de terceiro)',
  SAIDA_DESPESA: 'Saída — despesa da serventia',
  SAIDA_DEVOLUCAO: 'Saída — devolução ao cliente',
  SUPRIMENTO: 'Suprimento (reforço de troco)',
  SANGRIA: 'Sangria (retirada para cofre/depósito)',
  ESTORNO: 'Estorno',
};
export const CASH_METHOD_LABEL: Record<CashMethod, string> = {
  DINHEIRO: 'Dinheiro', PIX: 'PIX', CARTAO_DEBITO: 'Cartão de débito', CARTAO_CREDITO: 'Cartão de crédito', DEPOSITO: 'Depósito',
};

/** Cédulas e moedas em circulação (centavos), da maior para a menor. Para o real, o método guloso é ótimo. */
export const DENOMINATIONS: { cents: number; label: string; coin: boolean }[] = [
  { cents: 20000, label: 'R$ 200', coin: false }, { cents: 10000, label: 'R$ 100', coin: false }, { cents: 5000, label: 'R$ 50', coin: false },
  { cents: 2000, label: 'R$ 20', coin: false }, { cents: 1000, label: 'R$ 10', coin: false }, { cents: 500, label: 'R$ 5', coin: false },
  { cents: 200, label: 'R$ 2', coin: false }, { cents: 100, label: 'R$ 1', coin: true }, { cents: 50, label: 'R$ 0,50', coin: true },
  { cents: 25, label: 'R$ 0,25', coin: true }, { cents: 10, label: 'R$ 0,10', coin: true }, { cents: 5, label: 'R$ 0,05', coin: true },
  { cents: 1, label: 'R$ 0,01', coin: true },
];

export function changeBreakdown(changeCents: number): { label: string; coin: boolean; count: number }[] {
  if (!Number.isInteger(changeCents) || changeCents < 0) throw new Error('Troco inválido.');
  const out: { label: string; coin: boolean; count: number }[] = [];
  let rest = changeCents;
  for (const d of DENOMINATIONS) {
    const n = Math.floor(rest / d.cents);
    if (n > 0) { out.push({ label: d.label, coin: d.coin, count: n }); rest -= n * d.cents; }
  }
  return out;
}

/**
 * Valida um lançamento e calcula o troco. Entrada em dinheiro: o recebido não pode ser menor que o protocolo.
 * Demais formas: o recebido é igual ao protocolo (não há troco).
 */
export function checkEntry(e: { kind: Exclude<CashKind, 'ESTORNO'>; method: CashMethod; amount: number; received?: number | null; protocol?: string | null; payee?: string | null }):
  { received: number | null; change: number } {
  if (!Number.isInteger(e.amount) || e.amount <= 0) throw new Error('Informe o valor.');
  if (['ENTRADA', 'SAIDA_REPASSE', 'SAIDA_DEVOLUCAO'].includes(e.kind) && !e.protocol?.trim()) throw new Error('Informe o número do protocolo.');
  if (e.kind === 'SAIDA_DESPESA' && !e.payee?.trim()) throw new Error('Informe o favorecido da despesa (ex.: CASAN – água).');
  if ((e.kind === 'SUPRIMENTO' || e.kind === 'SANGRIA') && e.method !== 'DINHEIRO') throw new Error('Suprimento e sangria são sempre em dinheiro.');
  if (e.kind !== 'ENTRADA') return { received: null, change: 0 };
  if (e.method !== 'DINHEIRO') {
    if (e.received != null && e.received !== e.amount) throw new Error('Em PIX, cartão ou depósito, o valor recebido deve ser igual ao valor do protocolo.');
    return { received: e.amount, change: 0 };
  }
  const received = e.received ?? e.amount;
  if (received < e.amount) throw new Error('O valor recebido em dinheiro não pode ser menor que o valor do protocolo.');
  return { received, change: received - e.amount };
}

export type EntryLike = { kind: CashKind; method: CashMethod; amount: number; reversed?: { kind: CashKind; method: CashMethod; amount: number } | null };

/** Efeito de um lançamento na gaveta (só dinheiro conta): entrada/suprimento somam; saídas/sangria subtraem; estorno inverte o original. */
export function drawerEffect(e: EntryLike): number {
  if (e.kind === 'ESTORNO') return e.reversed ? -drawerEffect(e.reversed) : 0;
  if (e.method !== 'DINHEIRO') return 0;
  return e.kind === 'ENTRADA' || e.kind === 'SUPRIMENTO' ? e.amount : -e.amount;
}

export type DaySummary = {
  entradas: Record<CashMethod, number>; totalEntradas: number;
  repasses: number; despesas: number; devolucoes: number; suprimentos: number; sangrias: number;
  expectedCash: number;
};

/** Resumo do dia (estornos já anulam o original). Saídas somam todas as formas; o esperado na gaveta, só o dinheiro. */
export function summarizeDay(openingFloat: number, entries: EntryLike[]): DaySummary {
  const entradas: Record<CashMethod, number> = { DINHEIRO: 0, PIX: 0, CARTAO_DEBITO: 0, CARTAO_CREDITO: 0, DEPOSITO: 0 };
  const s = { repasses: 0, despesas: 0, devolucoes: 0, suprimentos: 0, sangrias: 0 };
  let drawer = openingFloat;
  for (const e of entries) {
    drawer += drawerEffect(e);
    const base = e.kind === 'ESTORNO' ? e.reversed : e;
    if (!base) continue;
    const sign = e.kind === 'ESTORNO' ? -1 : 1;
    const v = sign * base.amount;
    if (base.kind === 'ENTRADA') entradas[base.method] += v;
    else if (base.kind === 'SAIDA_REPASSE') s.repasses += v;
    else if (base.kind === 'SAIDA_DESPESA') s.despesas += v;
    else if (base.kind === 'SAIDA_DEVOLUCAO') s.devolucoes += v;
    else if (base.kind === 'SUPRIMENTO') s.suprimentos += v;
    else if (base.kind === 'SANGRIA') s.sangrias += v;
  }
  const totalEntradas = Object.values(entradas).reduce((a, b) => a + b, 0);
  return { entradas, totalEntradas, ...s, expectedCash: drawer };
}

/** DRE gerencial: receita de atos − repasses − devoluções = líquida; − despesas (caixa e financeiro) = resultado. */
export function dre(input: { entradas: number; repasses: number; devolucoes: number; despesasCaixa: number; despesasFinanceiro: { name: string; cents: number }[] }) {
  const liquida = input.entradas - input.repasses - input.devolucoes;
  const totalFin = input.despesasFinanceiro.reduce((a, b) => a + b.cents, 0);
  return {
    receitaBruta: input.entradas, repasses: input.repasses, devolucoes: input.devolucoes, receitaLiquida: liquida,
    despesasCaixa: input.despesasCaixa, despesasFinanceiro: input.despesasFinanceiro, totalDespesasFinanceiro: totalFin,
    resultado: liquida - input.despesasCaixa - totalFin,
  };
}

/** Só dígitos: "Prot. 12.345" ≡ "12345" para casar protocolos. */
export function normalizeProtocol(p: string | null | undefined): string {
  return (p ?? '').replace(/\D/g, '').replace(/^0+/, '');
}
