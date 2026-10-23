import { describe, expect, it } from 'vitest';
import { backupStatus, complianceIndex, expiring, heatmap, riskBand, sequenceCode, vulnerabilityDue, type BackupRecord } from '../../src/domain/quality.ts';

describe('Matriz de riscos', () => {
  it('classifica pelas faixas da matriz 5×5 e recusa valores fora da escala', () => {
    expect(riskBand(1, 1)).toBe('BAIXO');
    expect(riskBand(2, 2)).toBe('BAIXO');
    expect(riskBand(1, 5)).toBe('MODERADO');
    expect(riskBand(3, 3)).toBe('MODERADO');
    expect(riskBand(2, 5)).toBe('ALTO');
    expect(riskBand(4, 4)).toBe('ALTO');
    expect(riskBand(4, 5)).toBe('CRITICO');
    expect(riskBand(5, 5)).toBe('CRITICO');
    expect(() => riskBand(0, 3)).toThrow();
    expect(() => riskBand(3, 6)).toThrow();
    expect(() => riskBand(2.5, 3)).toThrow();
  });

  it('todo produto possível cai em exatamente uma faixa, monotônica no nível', () => {
    const order = ['BAIXO', 'MODERADO', 'ALTO', 'CRITICO'];
    const byLevel = new Map<number, number>();
    for (let p = 1; p <= 5; p++) for (let i = 1; i <= 5; i++) {
      const b = order.indexOf(riskBand(p, i));
      if (byLevel.has(p * i)) expect(byLevel.get(p * i)).toBe(b);
      byLevel.set(p * i, b);
    }
    const levels = [...byLevel.keys()].sort((a, b) => a - b);
    for (let k = 1; k < levels.length; k++) expect(byLevel.get(levels[k]!)!).toBeGreaterThanOrEqual(byLevel.get(levels[k - 1]!)!);
  });

  it('mapa de calor: linha 0 = impacto 5, coluna 0 = probabilidade 1', () => {
    const g = heatmap([{ probability: 1, impact: 5 }, { probability: 1, impact: 5 }, { probability: 5, impact: 1 }, { probability: 3, impact: 3 }]);
    expect(g[0]![0]).toBe(2);
    expect(g[4]![4]).toBe(1);
    expect(g[2]![2]).toBe(1);
    expect(g.flat().reduce((a, b) => a + b, 0)).toBe(4);
  });
});

describe('Prazos e vencimentos', () => {
  const policy = { CRITICA: 7, ALTA: 30, MEDIA: 90, BAIXA: 180 };
  it('prazo de vulnerabilidade pela política', () => {
    expect(vulnerabilityDue('2026-01-30', 'CRITICA', policy)).toBe('2026-02-06');
    expect(vulnerabilityDue('2026-12-15', 'ALTA', policy)).toBe('2027-01-14');
    expect(vulnerabilityDue('2026-02-28', 'BAIXA', { ...policy, BAIXA: 0 })).toBe('2026-02-28');
  });

  it('vencimentos dentro do aviso, vencidos primeiro', () => {
    const r = expiring([{ id: 'a', expires: '2026-03-10' }, { id: 'b', expires: '2026-01-05' }, { id: 'c', expires: '2026-06-01' }, { id: 'd', expires: null }], '2026-01-10', 60);
    expect(r.map((x) => x.id)).toEqual(['b', 'a']);
    expect(r[0]!.daysLeft).toBe(-5);
    expect(r[1]!.daysLeft).toBe(59);
  });
});

describe('Backups', () => {
  const rec = (system: string, kind: BackupRecord['kind'], performed_on: string, result: BackupRecord['result'] = 'SUCESSO'): BackupRecord => ({ system, kind, performed_on, result });
  it('considera apenas o último teste de restauração bem-sucedido', () => {
    const s = backupStatus([
      rec('SGI', 'BACKUP', '2026-03-01'), rec('SGI', 'TESTE_RESTAURACAO', '2026-01-01'), rec('SGI', 'TESTE_RESTAURACAO', '2026-02-20', 'FALHA'),
      rec('Arquivos', 'BACKUP', '2026-03-01', 'PARCIAL'),
    ], '2026-03-02', 60);
    const sgi = s.find((x) => x.system === 'SGI')!;
    expect(sgi.lastRestoreOk).toBe('2026-01-01');
    expect(sgi.daysSinceRestore).toBe(60);
    expect(sgi.restoreOverdue).toBe(false);
    const arq = s.find((x) => x.system === 'Arquivos')!;
    expect(arq.lastBackupResult).toBe('PARCIAL');
    expect(arq.restoreOverdue).toBe(true); // nunca testado
    expect(backupStatus([rec('SGI', 'TESTE_RESTAURACAO', '2026-01-01')], '2026-03-03', 60)[0]!.restoreOverdue).toBe(true);
  });
});

describe('Índice de atendimento', () => {
  it('parcial vale meio; não aplicável sai do denominador; não avaliado conta contra', () => {
    expect(complianceIndex(['ATENDIDO', 'PARCIAL', 'NAO_ATENDIDO', 'NAO_APLICAVEL']).pct).toBe(50);
    expect(complianceIndex(['ATENDIDO', 'NAO_AVALIADO']).pct).toBe(50);
    expect(complianceIndex(['ATENDIDO', 'ATENDIDO', 'PARCIAL']).pct).toBe(83.3);
    expect(complianceIndex(['NAO_APLICAVEL']).pct).toBeNull();
    expect(complianceIndex([]).pct).toBeNull();
  });
  it('códigos sequenciais', () => {
    expect(sequenceCode('NC', 2026, 7)).toBe('NC-2026-007');
    expect(sequenceCode('INC', 2026, 1234)).toBe('INC-2026-1234');
  });
});
