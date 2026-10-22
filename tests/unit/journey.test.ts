import { describe, expect, it } from 'vitest';
import { computeDay, deriveOccurrences, nextPunchKind, type DayInput, type ScheduleDay } from '../../src/domain/journey.ts';
import { parseHHMM as t } from '../../src/domain/time.ts';

const STD: ScheduleDay = { start: t('08:00'), breakStart: t('12:00'), breakEnd: t('13:00'), end: t('17:00') };
const TOL = { enabled: true, perMark: 5, daily: 10 };

function day(punches: string[], over: Partial<DayInput> = {}) {
  return computeDay({
    punches: punches.map(t),
    schedule: STD,
    holiday: false,
    absence: null,
    compensatedMinutes: 0,
    tolerance: TOL,
    maxDailyExtraMinutes: 120,
    restSincePreviousMinutes: null,
    ...over,
  });
}

describe('apuração diária — jornada padrão 08–12/13–17', () => {
  it('jornada exata: 480 min, sem diferença', () => {
    const r = day(['08:00', '12:00', '13:00', '17:00']);
    expect(r).toMatchObject({ kind: 'UTIL', expected: 480, worked: 480, rawDiff: 0, diff: 0, incomplete: false });
    expect(deriveOccurrences(r)).toEqual([]);
  });

  it('tolerância art. 58 §1º: variações ≤5 min/marcação e ≤10 min/dia não são computadas', () => {
    const r = day(['08:04', '12:00', '13:00', '17:05']); // -4 + 5 = +1 min bruto; desvios 4+5 = 9
    expect(r.rawDiff).toBe(1);
    expect(r.diff).toBe(0);
    expect(r.toleranceApplied).toBe(true);
  });

  it('Súmula 366: ultrapassado 5 min em uma marcação, computa-se a totalidade', () => {
    const r = day(['08:00', '12:00', '13:00', '17:06']);
    expect(r.diff).toBe(6);
    expect(r.toleranceApplied).toBe(false);
    expect(deriveOccurrences(r)).toEqual([{ type: 'HORA_EXTRA', minutes: 6 }]);
  });

  it('Súmula 366: soma diária acima de 10 min computa a totalidade, mesmo com marcações ≤5', () => {
    const r = day(['07:55', '12:04', '12:57', '17:05']); // desvios 5+4+3+5 = 17
    expect(r.rawDiff).toBe(5 + 4 + 3 + 5);
    expect(r.diff).toBe(17);
  });

  it('atraso relevante gera diferença negativa pendente de análise (nunca débito automático)', () => {
    const r = day(['08:40', '12:00', '13:00', '17:00']);
    expect(r.diff).toBe(-40);
    expect(deriveOccurrences(r)).toEqual([{ type: 'DIFERENCA_NEGATIVA', minutes: 40 }]);
  });

  it('tolerância desabilitada computa qualquer variação', () => {
    const r = day(['08:02', '12:00', '13:00', '17:00'], { tolerance: { ...TOL, enabled: false } });
    expect(r.diff).toBe(-2);
  });

  it('marcações ímpares: dia incompleto, apenas ocorrência de marcação incompleta', () => {
    const r = day(['08:00', '12:00', '13:00']);
    expect(r.incomplete).toBe(true);
    expect(r.worked).toBe(240);
    expect(deriveOccurrences(r)).toEqual([{ type: 'MARCACAO_INCOMPLETA', minutes: 0 }]);
    expect(r.alerts).toContain('MARCACAO_INCOMPLETA');
  });

  it('ausência de marcações em dia útil: falta integral pendente de análise', () => {
    const r = day([]);
    expect(r.diff).toBe(-480);
    expect(deriveOccurrences(r)).toEqual([{ type: 'DIFERENCA_NEGATIVA', minutes: 480 }]);
  });

  it('marcações fora de ordem são ordenadas', () => {
    expect(day(['17:00', '08:00', '13:00', '12:00']).worked).toBe(480);
  });

  it('jornada sem intervalo acima de 6h gera alerta do art. 71', () => {
    const r = day(['08:00', '17:00']);
    expect(r.worked).toBe(540);
    expect(r.alerts).toContain('INTERVALO_INSUFICIENTE');
    expect(r.diff).toBe(60);
  });

  it('intervalo de 30 min em jornada de 8h gera alerta do art. 71', () => {
    expect(day(['08:00', '12:00', '12:30', '16:30']).alerts).toContain('INTERVALO_INSUFICIENTE');
  });

  it('intervalo de 57 min fica dentro da tolerância por marcação; sem tolerância, gera alerta', () => {
    expect(day(['08:00', '12:02', '12:59', '17:00']).alerts).not.toContain('INTERVALO_INSUFICIENTE');
    expect(day(['08:00', '12:02', '12:59', '17:00'], { tolerance: { ...TOL, enabled: false } }).alerts).toContain('INTERVALO_INSUFICIENTE');
  });

  it('horas extras acima de 2h/dia e jornada acima de 10h geram alertas', () => {
    const r = day(['07:00', '12:00', '13:00', '19:30']);
    expect(r.worked).toBe(690); // 5h + 6h30
    expect(r.diff).toBe(210);
    expect(r.alerts).toEqual(expect.arrayContaining(['HORAS_EXTRAS_ACIMA_LIMITE', 'JORNADA_ACIMA_10H']));
  });

  it('feriado: jornada esperada zero; trabalho no feriado é extra com alerta', () => {
    const r = day(['08:00', '12:00'], { holiday: true });
    expect(r).toMatchObject({ kind: 'FERIADO', expected: 0, diff: 240 });
    expect(r.alerts).toContain('TRABALHO_EM_DIA_NAO_UTIL');
  });

  it('descanso semanal sem marcações: nada a apurar', () => {
    const r = day([], { schedule: null });
    expect(r).toMatchObject({ kind: 'DESCANSO', expected: 0, diff: 0 });
    expect(deriveOccurrences(r)).toEqual([]);
  });

  it('ausência abonada (férias/atestado): esperado zero, sem diferença', () => {
    const r = day([], { absence: { countsAsWorked: true } });
    expect(r).toMatchObject({ kind: 'AUSENCIA_ABONADA', expected: 0, diff: 0 });
  });

  it('ausência não abonada mantém a jornada esperada', () => {
    expect(day([], { absence: { countsAsWorked: false } }).diff).toBe(-480);
  });

  it('folga compensada integral: compensação cobre a jornada', () => {
    const r = day([], { compensatedMinutes: 480 });
    expect(r).toMatchObject({ compensated: 480, diff: 0 });
  });

  it('saída antecipada compensada (2h) com variação dentro da tolerância diária', () => {
    const r = day(['08:00', '12:00', '13:00', '15:03'], { compensatedMinutes: 120 });
    expect(r.rawDiff).toBe(3);
    expect(r.diff).toBe(0);
  });

  it('compensação não pode exceder a jornada esperada do dia', () => {
    expect(day([], { compensatedMinutes: 900 }).compensated).toBe(480);
  });

  it('interjornada inferior a 11h gera alerta', () => {
    expect(day(['08:00', '12:00', '13:00', '17:00'], { restSincePreviousMinutes: 600 }).alerts).toContain(
      'INTERJORNADA_INFERIOR_11H',
    );
  });

  it('sugestão do tipo da próxima marcação', () => {
    expect([0, 1, 2, 3, 4, 7].map(nextPunchKind)).toEqual([
      'ENTRADA', 'SAIDA_INTERVALO', 'RETORNO_INTERVALO', 'SAIDA', 'ADICIONAL', 'ADICIONAL',
    ]);
  });
});
