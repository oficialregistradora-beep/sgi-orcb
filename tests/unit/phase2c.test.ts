import { describe, expect, it } from 'vitest';
import { entitlementForAbsences, validateVacation, type VacationInput } from '../../src/domain/vacation.ts';
import { convertCreditMinutes, expiryByRule } from '../../src/domain/hourBank.ts';

describe('J-13 — faixas do art. 130 (limites exatos)', () => {
  it.each([[0, 30], [5, 30], [6, 24], [14, 24], [15, 18], [23, 18], [24, 12], [32, 12], [33, 0], [100, 0]])('%i falta(s) → %i dias', (f, d) => {
    expect(entitlementForAbsences(f)).toBe(d);
  });
  it('rejeita quantidade inválida', () => {
    expect(() => entitlementForAbsences(-1)).toThrow();
    expect(() => entitlementForAbsences(1.5)).toThrow();
  });
});

describe('J-13 — férias com direito reduzido', () => {
  const base: VacationInput = {
    admission: '2024-03-04', today: '2026-10-22', start: '2026-11-23', end: '2026-12-12', soldDays: 0,
    allocations: [], holidays: new Set(), minNoticeDays: 30, entitlements: new Map([['2024-03-04', 24]]),
  };
  it('saldo segue o direito apurado (24 dias)', () => {
    expect(() => validateVacation({ ...base, end: '2026-12-22' })).toThrow('restam 24'); // 30 dias
    const r = validateVacation({ ...base, end: '2026-12-16' }); // 24 dias
    expect(r.days).toBe(24);
    expect(r.warnings.some((w) => w.includes('reduzido a 24'))).toBe(true);
  });
  it('abono limitado a 1/3 do direito (18 → 6 dias)', () => {
    const b18 = { ...base, entitlements: new Map([['2024-03-04', 18]]) };
    expect(() => validateVacation({ ...b18, end: '2026-12-03', soldDays: 7 })).toThrow('1/3');
    expect(validateVacation({ ...b18, end: '2026-12-04', soldDays: 6 }).days).toBe(12);
  });
  it('direito de 12 dias: período único que esgota o saldo', () => {
    const b12 = { ...base, entitlements: new Map([['2024-03-04', 12]]) };
    expect(() => validateVacation({ ...b12, end: '2026-11-29' })).toThrow('único período'); // 7 dias
    expect(validateVacation({ ...b12, end: '2026-12-04' }).days).toBe(12);
  });
  it('perda do direito (0 dias): usa o período seguinte, se houver', () => {
    const r = validateVacation({ ...base, entitlements: new Map([['2024-03-04', 0]]) });
    expect(r.period.start).toBe('2025-03-04');
  });
  it('regra coletiva validada: veda início em sábado, domingo ou feriado', () => {
    const sunday = { ...base, start: '2026-11-29', end: '2026-12-18', entitlements: new Map() };
    expect(validateVacation(sunday).days).toBe(20); // permitido pela CLT
    expect(() => validateVacation({ ...sunday, blockWeekendHolidayStart: true })).toThrow('convenção coletiva');
  });
});

describe('J-14 — banco de horas por regra coletiva (somente quando validada)', () => {
  it('prazo em dias após o fim do mês da acumulação', () => {
    expect(expiryByRule('2026-03-10', { modo: 'DIAS_APOS_MES', quantidade: 90 })).toBe('2026-06-29');
    expect(expiryByRule('2026-02-01', { modo: 'DIAS_APOS_MES', quantidade: 90 })).toBe('2026-05-29'); // 28/02 + 90
    expect(expiryByRule('2028-02-10', { modo: 'DIAS_APOS_MES', quantidade: 90 })).toBe('2028-05-29'); // bissexto: 29/02 + 90
    expect(expiryByRule('2026-03-10', { modo: 'MESES', quantidade: 6 })).toBe('2026-09-10');
  });
  it('conversão 1 h → 1h30', () => {
    expect(convertCreditMinutes(60, 90)).toBe(90);
    expect(convertCreditMinutes(50, 90)).toBe(75);
    expect(convertCreditMinutes(7, 90)).toBe(11); // 10,5 → 11
    expect(convertCreditMinutes(60, 60)).toBe(60);
  });
});
