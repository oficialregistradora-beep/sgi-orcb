import { describe, expect, it } from 'vitest';
import {
  allocateFifo,
  buildLots,
  creditExpiry,
  estimateCost,
  summarize,
  type Allocation,
  type LedgerEntry,
} from '../../src/domain/hourBank.ts';

const credit = (id: string, entryDate: string, minutes: number, months = 6): LedgerEntry => ({
  id, kind: 'CREDITO', minutes, entryDate, expiresOn: creditExpiry(entryDate, months), reversesEntryId: null,
});

describe('banco de horas — vencimento', () => {
  it('prazo de 6 meses a partir da competência do crédito', () => {
    expect(creditExpiry('2026-01-15', 6)).toBe('2026-07-15');
  });
  it('fim de mês: 31/08 + 6 meses = 28/02 (ano não bissexto)', () => {
    expect(creditExpiry('2026-08-31', 6)).toBe('2027-02-28');
  });
  it('ano bissexto: 31/08/2027 + 6 meses = 29/02/2028', () => {
    expect(creditExpiry('2027-08-31', 6)).toBe('2028-02-29');
  });
});

describe('banco de horas — consumo PEPS', () => {
  const entries = [credit('c2', '2026-03-10', 60), credit('c1', '2026-02-01', 30), credit('c3', '2026-04-01', 120)];

  it('consome primeiro o crédito que vence antes', () => {
    const lots = buildLots(entries, [], '2026-05-01', 30);
    const r = allocateFifo(lots, 70, '2026-05-01');
    expect(r).toEqual({ allocations: [{ creditEntryId: 'c1', minutes: 30 }, { creditEntryId: 'c2', minutes: 40 }], shortfall: 0 });
  });

  it('respeita consumos anteriores', () => {
    const allocs: Allocation[] = [{ debitEntryId: 'd1', creditEntryId: 'c1', minutes: 30 }];
    const lots = buildLots(entries, allocs, '2026-05-01', 30);
    expect(allocateFifo(lots, 10, '2026-05-01').allocations).toEqual([{ creditEntryId: 'c2', minutes: 10 }]);
  });

  it('não utiliza créditos vencidos na data da compensação nem créditos futuros', () => {
    const lots = buildLots(entries, [], '2026-09-05', 30);
    // c1 venceu em 01/08, c2 em 10/09 (ainda válido em 05/09), c3 em 01/10.
    const r = allocateFifo(lots, 500, '2026-09-05');
    expect(r.allocations.map((a) => a.creditEntryId)).toEqual(['c2', 'c3']);
    expect(r.shortfall).toBe(500 - 180);
    const before = allocateFifo(buildLots(entries, [], '2026-03-01', 30), 100, '2026-03-01');
    expect(before.allocations).toEqual([{ creditEntryId: 'c1', minutes: 30 }]);
  });

  it('pagamento pode alcançar apenas créditos vencidos', () => {
    const lots = buildLots(entries, [], '2026-09-05', 30);
    expect(allocateFifo(lots, 30, '2026-09-05', { onlyExpired: true }).allocations).toEqual([{ creditEntryId: 'c1', minutes: 30 }]);
  });

  it('rejeita quantidade inválida', () => {
    expect(() => allocateFifo([], 0, '2026-01-01')).toThrow();
    expect(() => allocateFifo([], 1.5, '2026-01-01')).toThrow();
  });
});

describe('banco de horas — resumo', () => {
  it('créditos vencidos permanecem visíveis como "requer pagamento/análise"', () => {
    const entries = [credit('c1', '2026-01-10', 90), credit('c2', '2026-06-20', 60)];
    const s = summarize(entries, [], '2026-08-01', 30);
    expect(s).toEqual({ balance: 150, available: 60, expiringSoon: 0, expired: 90, uncoveredDebits: 0 });
  });

  it('créditos a vencer dentro da janela de alerta', () => {
    const s = summarize([credit('c1', '2026-02-15', 45)], [], '2026-08-01', 30);
    expect(s.expiringSoon).toBe(45);
  });

  it('estorno zera o lote e o saldo algébrico', () => {
    const entries: LedgerEntry[] = [
      credit('c1', '2026-02-01', 60),
      { id: 'e1', kind: 'ESTORNO', minutes: -60, entryDate: '2026-02-05', expiresOn: null, reversesEntryId: 'c1' },
    ];
    const lots = buildLots(entries, [], '2026-03-01', 30);
    expect(lots[0]).toMatchObject({ status: 'ESTORNADO', remaining: 0 });
    expect(summarize(entries, [], '2026-03-01', 30).balance).toBe(0);
  });

  it('débito compensado reduz o saldo e o disponível', () => {
    const entries: LedgerEntry[] = [
      credit('c1', '2026-02-01', 120),
      { id: 'd1', kind: 'DEBITO_COMPENSACAO', minutes: -45, entryDate: '2026-02-20', expiresOn: null, reversesEntryId: null },
    ];
    const s = summarize(entries, [{ debitEntryId: 'd1', creditEntryId: 'c1', minutes: 45 }], '2026-03-01', 30);
    expect(s).toMatchObject({ balance: 75, available: 75 });
  });
});

describe('custo estimado (informativo)', () => {
  it('R$ 3.000,00 / 200h × 1,5 × 2h = R$ 45,00', () => {
    expect(estimateCost(120, '3000.00', 200, 50)).toBe('45.00');
  });
  it('arredondamento em centavos sem ponto flutuante', () => {
    expect(estimateCost(7, '2531.47', 220, 50)).toBe('2.01');
    expect(estimateCost(1, '0.01', 200, 0)).toBe('0.00');
  });
  it('rejeita salário malformado', () => {
    expect(() => estimateCost(10, '3.000,00', 200, 50)).toThrow();
  });
});
