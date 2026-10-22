import { describe, expect, it } from 'vitest';
import { acquisitivePeriods, balances, validateVacation, VacationRuleError, type VacationInput } from '../../src/domain/vacation.ts';
import { buildRotation, computeOncall, oncallValues } from '../../src/domain/oncall.ts';
import { computeDay, deriveOccurrences } from '../../src/domain/journey.ts';
import { localToInstant } from '../../src/domain/time.ts';

const base: VacationInput = {
  admission: '2024-03-04', today: '2026-10-22', start: '2026-11-23', end: '2026-12-12', soldDays: 0,
  allocations: [], holidays: new Set(['2026-12-25']), minNoticeDays: 30,
};

describe('férias — períodos aquisitivo e concessivo', () => {
  it('calcula períodos a partir da admissão', () => {
    const p = acquisitivePeriods('2024-03-04', '2026-10-22');
    expect(p.map((x) => [x.start, x.end, x.concessiveEnd])).toEqual([
      ['2024-03-04', '2025-03-03', '2026-03-03'],
      ['2025-03-04', '2026-03-03', '2027-03-03'],
      ['2026-03-04', '2027-03-03', '2028-03-03'],
    ]);
  });
  it('situação: vencidas, disponível, em aquisição', () => {
    const b = balances(acquisitivePeriods('2024-03-04', '2026-10-22'), [], '2026-10-22');
    expect(b.map((x) => x.status)).toEqual(['VENCIDAS', 'DISPONIVEL', 'EM_AQUISICAO']);
    const q = balances(acquisitivePeriods('2024-03-04', '2026-10-22'), [{ periodStart: '2024-03-04', enjoyedDays: 30, soldDays: 0, startDate: '2025-06-02' }], '2026-10-22');
    expect(q[0]!.status).toBe('QUITADO');
  });
});

describe('férias — validação (CLT art. 134 e seguintes)', () => {
  const v = (o: Partial<VacationInput>) => validateVacation({ ...base, ...o });

  it('usa o período aquisitivo mais antigo com saldo; alerta de dobra quando fora do concessivo', () => {
    const r = v({});
    expect(r.days).toBe(20);
    expect(r.period.start).toBe('2024-03-04');
    expect(r.warnings.some((w) => w.includes('dobro'))).toBe(true);
  });
  it('mínimo de 5 dias', () => {
    expect(() => v({ start: '2026-11-23', end: '2026-11-26' })).toThrow(VacationRuleError);
  });
  it('um dos períodos deve ter 14 dias ou mais', () => {
    expect(v({ start: '2026-11-23', end: '2026-12-02' }).days).toBe(10); // restam 20: ainda cabe um período de 14
    const allocations = [{ periodStart: '2024-03-04', enjoyedDays: 10, soldDays: 0, startDate: '2025-05-05' }];
    expect(() => v({ allocations, start: '2026-11-23', end: '2026-12-02' })).toThrow('14 dias'); // restariam 10: impossível
  });
  it('saldo restante não pode ficar entre 1 e 4 dias', () => {
    expect(() => v({ start: '2026-11-23', end: '2026-12-18' })).toThrow('inferior a 5'); // 26 dias → restam 4
  });
  it('abono pecuniário de até 10 dias consome o saldo', () => {
    const r = v({ start: '2026-11-23', end: '2026-12-12', soldDays: 10 });
    expect(r.days).toBe(20);
    expect(() => v({ soldDays: 11 })).toThrow('Abono');
  });
  it('vedado iniciar nos 2 dias antes do domingo ou de feriado', () => {
    expect(() => v({ start: '2026-11-27', end: '2026-12-16' })).toThrow('art. 134, §3º'); // sexta
    expect(() => v({ start: '2026-11-28', end: '2026-12-17' })).toThrow('art. 134, §3º'); // sábado
    expect(() => v({ start: '2026-12-23', end: '2027-01-11' })).toThrow('art. 134, §3º'); // 2 dias antes do Natal
  });
  it('sem período aquisitivo completo', () => {
    expect(() => v({ admission: '2026-01-05' })).toThrow('período aquisitivo completo');
  });
  it('fracionamento: até 3 períodos; aviso com menos de 30 dias', () => {
    const allocations = [
      { periodStart: '2024-03-04', enjoyedDays: 14, soldDays: 0, startDate: '2025-05-05' },
      { periodStart: '2024-03-04', enjoyedDays: 6, soldDays: 0, startDate: '2025-08-04' },
    ];
    const r = v({ allocations, start: '2026-11-02', end: '2026-11-11' });
    expect(r.days).toBe(10);
    expect(r.warnings.some((w) => w.includes('art. 135'))).toBe(true);
    expect(() => v({ allocations, start: '2026-11-02', end: '2026-11-06' })).toThrow('terceiro período'); // deixaria 5 dias inutilizáveis
    const done = [...allocations, { periodStart: '2024-03-04', enjoyedDays: 10, soldDays: 0, startDate: '2025-10-06' }];
    expect(v({ allocations: done, start: '2026-11-23', end: '2026-12-12' }).period.start).toBe('2025-03-04'); // período 1 quitado → usa o 2
  });
  it('data no passado é recusada', () => {
    expect(() => v({ start: '2026-10-20', end: '2026-11-08' })).toThrow('futura');
  });
});

describe('plantão — sobreaviso x trabalho efetivo', () => {
  const s = localToInstant('2026-11-07', '08:00');
  const e = localToInstant('2026-11-07', '18:00');
  const call = (a: string, b: string, voided = false) => ({ attended: true, arrival: localToInstant('2026-11-07', a), departure: localToInstant('2026-11-07', b), voided });

  it('sem chamados: 10 h de sobreaviso', () => {
    expect(computeOncall(s, e, [])).toEqual({ shiftMinutes: 600, effectiveMinutes: 0, effectiveInsideMinutes: 0, standbyMinutes: 600 });
  });
  it('comparecimentos sobrepostos não são contados em dobro; anulados são ignorados', () => {
    const r = computeOncall(s, e, [call('10:00', '11:00'), call('10:30', '11:30'), call('14:00', '15:00', true)]);
    expect(r).toMatchObject({ effectiveMinutes: 90, standbyMinutes: 510 });
  });
  it('trabalho após o fim do plantão é efetivo, mas não reduz o sobreaviso além da janela', () => {
    const r = computeOncall(s, e, [call('17:30', '19:00')]);
    expect(r).toMatchObject({ effectiveMinutes: 90, effectiveInsideMinutes: 30, standbyMinutes: 570 });
  });
  it('valores estimados em centavos: 1/3 da hora no sobreaviso; efetivo com adicional', () => {
    // R$ 3.000 / 200 h = R$ 15/h; sobreaviso 600 min = 10 h × 15 / 3 = R$ 50; efetivo 60 min × 15 × 2 = R$ 30
    expect(oncallValues(600, 60, '3000.00', 200, 3, 100)).toEqual({ standby: '50.00', effectiveIfPaid: '30.00' });
  });
  it('dia de plantão não gera ocorrência de hora extra na apuração comum', () => {
    const r = computeDay({
      punches: [600, 660], schedule: null, holiday: false, absence: null, compensatedMinutes: 0,
      tolerance: { enabled: true, perMark: 5, daily: 10 }, maxDailyExtraMinutes: 120, restSincePreviousMinutes: null, oncall: true,
    });
    expect(r.alerts).toContain('DIA_DE_PLANTAO');
    expect(deriveOccurrences(r)).toEqual([]);
  });
});

describe('plantão — escala em rodízio', () => {
  it('distribui em rodízio, pula indisponíveis e define substituto', () => {
    const r = buildRotation(['d1', 'd2', 'd3', 'd4'], ['A', 'B', 'C'], (emp, d) => emp === 'B' && d === 'd2');
    expect(r).toEqual([
      { date: 'd1', employeeId: 'A', substituteId: 'B' },
      { date: 'd2', employeeId: 'C', substituteId: 'A' }, // B indisponível
      { date: 'd3', employeeId: 'A', substituteId: 'B' },
      { date: 'd4', employeeId: 'B', substituteId: 'C' },
    ]);
    for (const x of r) expect(x.employeeId).not.toBe(x.substituteId);
  });
  it('ninguém disponível → sem responsável', () => {
    expect(buildRotation(['d1'], ['A'], () => true)).toEqual([{ date: 'd1', employeeId: null, substituteId: null }]);
  });
});
