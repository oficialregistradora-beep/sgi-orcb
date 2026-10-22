import { describe, expect, it } from 'vitest';
import { centsToDb, formatCents, parseBRL, pct, toCents } from '../../src/domain/money.ts';
import { budgetVsActual, cashFlow, contractAlerts, dueDateIn, monthsBetween, normalizeCnpj, projectOutflows } from '../../src/domain/finance.ts';

describe('Dinheiro em centavos', () => {
  it('converte do banco e para o banco sem erro de ponto flutuante', () => {
    expect(toCents('1234.56')).toBe(123456);
    expect(toCents('0.1')).toBe(10);
    expect(toCents('-10.05')).toBe(-1005);
    expect(centsToDb(123456)).toBe('1234.56');
    expect(centsToDb(5)).toBe('0.05');
    expect(centsToDb(-1005)).toBe('-10.05');
    // 0,1 + 0,2 em ponto flutuante = 0,30000000000000004; em centavos é exato.
    expect(centsToDb(toCents('0.10') + toCents('0.20'))).toBe('0.30');
    expect(() => toCents('1,50')).toThrow();
    expect(() => centsToDb(1.5)).toThrow();
  });

  it('interpreta a digitação brasileira e recusa formatos ambíguos ou inválidos', () => {
    expect(parseBRL('1.234,56')).toBe(123456);
    expect(parseBRL('R$ 1.234,5')).toBe(123450);
    expect(parseBRL('1234.56')).toBe(123456);
    expect(parseBRL('1.234')).toBe(123400);
    expect(parseBRL('10')).toBe(1000);
    expect(parseBRL('')).toBeNull();
    expect(() => parseBRL('12,345')).toThrow();
    expect(() => parseBRL('abc')).toThrow();
    expect(() => parseBRL('-5,00')).toThrow();
    expect(() => parseBRL('1000000000000,00')).toThrow(/limite/);
  });

  it('formata e calcula percentuais', () => {
    expect(formatCents(123456789)).toBe('R$ 1.234.567,89');
    expect(formatCents(-5)).toBe('-R$ 0,05');
    expect(pct(50, 200)).toBe(25);
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(10, 0)).toBeNull();
  });
});

describe('Fornecedores e vencimentos', () => {
  it('CNPJ com dígitos verificadores', () => {
    expect(normalizeCnpj('11.222.333/0001-81')).toBe('11222333000181');
    expect(normalizeCnpj('11.222.333/0001-82')).toBeNull();
    expect(normalizeCnpj('00000000000000')).toBeNull();
    expect(normalizeCnpj('123')).toBeNull();
  });

  it('vencimento no dia contratado, limitado ao último dia do mês', () => {
    expect(dueDateIn('2027-02', 31)).toBe('2027-02-28');
    expect(dueDateIn('2028-02-01', 30)).toBe('2028-02-29');
    expect(dueDateIn('2026-11', 10)).toBe('2026-11-10');
    expect(monthsBetween('2026-11-15', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });

  it('alertas de fim de contrato dentro do prazo de aviso', () => {
    const c = [
      { id: 'a', end_date: '2026-12-01', notice_days: 60, status: 'VIGENTE' },
      { id: 'b', end_date: '2027-06-01', notice_days: 60, status: 'VIGENTE' },
      { id: 'c', end_date: '2026-10-01', notice_days: 30, status: 'VIGENTE' },
      { id: 'd', end_date: '2026-11-01', notice_days: 60, status: 'ENCERRADO' },
      { id: 'e', end_date: null, notice_days: 60, status: 'VIGENTE' },
    ];
    const a = contractAlerts(c, '2026-10-22');
    expect(a.map((x) => [x.id, x.daysLeft])).toEqual([['a', 40], ['c', -21]]);
  });
});

describe('Fluxo de caixa, previsto × realizado e projeção', () => {
  it('fluxo por mês com saldo acumulado e a pagar pelo vencimento', () => {
    const f = cashFlow(['2026-10', '2026-11'],
      [{ received_on: '2026-10-05', cents: 100000 }, { received_on: '2026-11-05', cents: 50000 }, { received_on: '2026-11-06', cents: -10000 }],
      [{ paid_on: '2026-10-10', cents: 30000 }, { paid_on: '2026-11-10', cents: 80000 }],
      [{ due_date: '2026-11-20', cents: 7000 }], 1000);
    expect(f).toEqual([
      { month: '2026-10', inflow: 100000, outflow: 30000, net: 70000, balance: 71000, payable: 0 },
      { month: '2026-11', inflow: 40000, outflow: 80000, net: -40000, balance: 31000, payable: 7000 },
    ]);
  });

  it('previsto × realizado: pago, comprometido, disponível e percentual; despesa sem orçamento aparece', () => {
    const r = budgetVsActual(
      [{ cost_center_id: 'A', category_id: 'X', cents: 100000 }, { cost_center_id: 'A', category_id: 'X', cents: 100000 }],
      [
        { cost_center_id: 'A', category_id: 'X', cents: 150000, status: 'PAGA' },
        { cost_center_id: 'A', category_id: 'X', cents: 30000, status: 'APROVADA' },
        { cost_center_id: 'A', category_id: 'X', cents: 99999, status: 'SOLICITADA' },
        { cost_center_id: 'B', category_id: 'Y', cents: 5000, status: 'PAGA' },
      ]);
    const ax = r.find((x) => x.cost_center_id === 'A')!;
    expect(ax).toMatchObject({ budget: 200000, paid: 150000, committed: 30000, available: 20000, variance: -50000, usedPct: 90 });
    expect(r.find((x) => x.cost_center_id === 'B')).toMatchObject({ budget: 0, paid: 5000, available: -5000, usedPct: null });
  });

  it('projeção: maior entre orçamento e o já conhecido; mensalidade não é contada duas vezes', () => {
    const p = projectOutflows(['2026-11', '2026-12', '2027-01'],
      [{ month: '2026-11', cents: 50000 }, { month: '2026-12', cents: 10000 }],
      [{ id: 'k1', start_date: '2026-01-01', end_date: '2026-12-31', monthly_cents: 20000 }],
      [{ month: '2026-11', cents: 20000, contract_id: 'k1' }, { month: '2026-12', cents: 5000, contract_id: null }]);
    expect(p).toEqual([
      { month: '2026-11', budget: 50000, contractual: 0, scheduled: 20000, projected: 50000 },
      { month: '2026-12', budget: 10000, contractual: 20000, scheduled: 5000, projected: 25000 },
      { month: '2027-01', budget: 0, contractual: 0, scheduled: 0, projected: 0 },
    ]);
  });
});
