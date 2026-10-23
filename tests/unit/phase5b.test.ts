import { describe, expect, it } from 'vitest';
import { gradeAttempt, inAudience, scheduleDue, trainingExpiry, trainingSituation, weightedScore } from '../../src/domain/development.ts';

const rec = (status: string, completed_on: string | null, expires_on: string | null = null, document_version_id: string | null = null) => ({ status, completed_on, expires_on, document_version_id });

describe('Situação de treinamento', () => {
  it('considera a conclusão mais recente; anuladas e recusadas não contam', () => {
    expect(trainingSituation([], '2026-05-01', 30).situation).toBe('PENDENTE');
    expect(trainingSituation([rec('INSCRITO', null)], '2026-05-01', 30).situation).toBe('EM_ANDAMENTO');
    expect(trainingSituation([rec('PENDENTE_VALIDACAO', '2026-04-01')], '2026-05-01', 30).situation).toBe('EM_ANDAMENTO');
    expect(trainingSituation([rec('ANULADO', '2026-04-01'), rec('RECUSADO', '2026-04-02')], '2026-05-01', 30).situation).toBe('PENDENTE');
    expect(trainingSituation([rec('CONCLUIDO', '2025-01-01', '2026-01-01'), rec('CONCLUIDO', '2026-02-01', '2027-02-01')], '2026-05-01', 30))
      .toEqual({ situation: 'VALIDO', completedOn: '2026-02-01', expiresOn: '2027-02-01' });
  });
  it('vencimento e aviso de reciclagem (no dia do vencimento já está vencido)', () => {
    expect(trainingSituation([rec('CONCLUIDO', '2025-06-01', '2026-06-01')], '2026-05-01', 30).situation).toBe('VALIDO'); // 31 dias restantes
    expect(trainingSituation([rec('CONCLUIDO', '2025-06-01', '2026-06-01')], '2026-05-01', 31).situation).toBe('A_VENCER');
    expect(trainingSituation([rec('CONCLUIDO', '2025-06-01', '2026-06-01')], '2026-06-01', 30).situation).toBe('VENCIDO');
    expect(trainingSituation([rec('CONCLUIDO', '2020-01-01', null)], '2026-06-01', 30).situation).toBe('VALIDO');
  });
  it('estudo de POP: conclusão sobre versão anterior pede novo estudo', () => {
    expect(trainingSituation([rec('CONCLUIDO', '2026-01-01', null, 'v1')], '2026-05-01', 30, 'v2').situation).toBe('NOVA_VERSAO');
    expect(trainingSituation([rec('CONCLUIDO', '2026-01-01', null, 'v2')], '2026-05-01', 30, 'v2').situation).toBe('VALIDO');
  });
  it('validade em meses', () => {
    expect(trainingExpiry('2026-01-31', 1)).toBe('2026-02-28');
    expect(trainingExpiry('2026-03-10', null)).toBeNull();
  });
  it('público obrigatório', () => {
    const p = { sector_id: 'S1', job_title_id: 'J1' };
    expect(inAudience({ audience_type: 'TODOS', sectors: [], jobs: [] }, p)).toBe(true);
    expect(inAudience({ audience_type: 'SETORES', sectors: ['S2'], jobs: [] }, p)).toBe(false);
    expect(inAudience({ audience_type: 'SETORES', sectors: ['S1'], jobs: [] }, p)).toBe(true);
    expect(inAudience({ audience_type: 'CARGOS', sectors: ['S1'], jobs: ['J2'] }, p)).toBe(false);
  });
});

describe('Avaliação de aprendizagem e desempenho', () => {
  it('correção por percentual de acertos', () => {
    expect(gradeAttempt([1, 0, 2], [1, 0, 2])).toEqual({ score: 100, hits: 3 });
    expect(gradeAttempt([1, 0, 2], [1, 1, 1])).toEqual({ score: 33, hits: 1 });
    expect(() => gradeAttempt([1, 0], [1])).toThrow(/todas/);
  });
  it('média ponderada normalizada: mínimo = 0%, máximo = 100%', () => {
    expect(weightedScore([{ score: 1, weight: 2 }, { score: 1, weight: 1 }], 5)).toBe(0);
    expect(weightedScore([{ score: 5, weight: 2 }, { score: 5, weight: 1 }], 5)).toBe(100);
    // (4×2 + 3×1)/3 = 3,667 → (3,667−1)/4 = 66,67%
    expect(weightedScore([{ score: 4, weight: 2 }, { score: 3, weight: 1 }], 5)).toBe(66.67);
    expect(weightedScore([], 5)).toBeNull();
  });
});

describe('Programação de avaliações', () => {
  const adm = { trigger: 'DIAS_APOS_ADMISSAO' as const, days_after: 30, annual_month: null, annual_day: null, lead_days: 7 };
  it('por admissão: dentro da antecedência; uma referência única; sem retroativo antigo', () => {
    expect(scheduleDue(adm, '2026-03-01', '2026-03-20')).toBeNull();
    expect(scheduleDue(adm, '2026-03-01', '2026-03-24')).toEqual({ ref: 'ADM+30', due: '2026-03-31' });
    expect(scheduleDue(adm, '2026-03-01', '2026-04-30')).toEqual({ ref: 'ADM+30', due: '2026-03-31' });
    expect(scheduleDue(adm, '2026-03-01', '2026-05-01')).toBeNull();
  });
  it('anual: ocorrência do ano, somente após 6 meses de casa', () => {
    const an = { trigger: 'ANUAL' as const, days_after: null, annual_month: 3, annual_day: 15, lead_days: 10 };
    expect(scheduleDue(an, '2020-01-10', '2026-03-05')).toEqual({ ref: 'ANUAL-2026', due: '2026-03-15' });
    expect(scheduleDue(an, '2020-01-10', '2026-02-01')).toBeNull();
    expect(scheduleDue(an, '2025-12-01', '2026-03-05')).toBeNull();
    expect(scheduleDue({ ...an, annual_month: 1, annual_day: 2 }, '2020-01-10', '2025-12-28')).toEqual({ ref: 'ANUAL-2026', due: '2026-01-02' });
  });
});
