import { describe, expect, it } from 'vitest';
import { createsCycle, ganttBars, occursOn, routineOccurrences, type RoutineRule } from '../../src/domain/recurrence.ts';
import { weekdayOf } from '../../src/domain/time.ts';
import { taskAccess } from '../../src/server/modules/tasks.ts';
import { projectAccess } from '../../src/server/modules/projects.ts';
import type { Principal, Scope } from '../../src/server/context.ts';

const HOLIDAYS = new Set(['2026-11-02', '2026-11-20', '2026-12-25']);
const biz = (d: string) => weekdayOf(d) !== 0 && weekdayOf(d) !== 6 && !HOLIDAYS.has(d);
const base: RoutineRule = { frequency: 'DIARIA', times: [], weekdays: [], month_day: null, month: null, business_days_only: true, starts_on: '2026-01-01', ends_on: null };

describe('Rotinas — recorrência', () => {
  it('diária em dias úteis: não ocorre em fim de semana nem feriado', () => {
    expect(occursOn(base, '2026-11-03', biz)).toBe(true); // terça
    expect(occursOn(base, '2026-11-07', biz)).toBe(false); // sábado
    expect(occursOn(base, '2026-11-02', biz)).toBe(false); // Finados
    expect(occursOn({ ...base, business_days_only: false }, '2026-11-07', biz)).toBe(true);
  });

  it('verificação das centrais 4×/dia: quatro ocorrências com chaves únicas, ordenadas', () => {
    const r = { ...base, times: [960, 540, 660, 840, 540] };
    const o = routineOccurrences(r, '2026-11-03', biz);
    expect(o.map((x) => x.key)).toEqual(['2026-11-03T09:00', '2026-11-03T11:00', '2026-11-03T14:00', '2026-11-03T16:00']);
    expect(o.map((x) => x.dueTime)).toEqual([540, 660, 840, 960]);
    expect(routineOccurrences(r, '2026-11-07', biz)).toEqual([]);
  });

  it('semanal: dias escolhidos', () => {
    const r: RoutineRule = { ...base, frequency: 'SEMANAL', weekdays: [1, 5] };
    expect(occursOn(r, '2026-11-09', biz)).toBe(true); // segunda
    expect(occursOn(r, '2026-11-10', biz)).toBe(false);
    expect(occursOn(r, '2026-11-20', biz)).toBe(false); // sexta, feriado (Consciência Negra) em dia útil exigido
  });

  it('mensal no dia 31: último dia do mês; em dia não útil, adia ao próximo dia útil', () => {
    const r: RoutineRule = { ...base, frequency: 'MENSAL', month_day: 31 };
    expect(occursOn(r, '2026-11-30', biz)).toBe(true); // novembro tem 30 dias (segunda)
    expect(occursOn(r, '2026-10-31', biz)).toBe(false); // sábado
    expect(occursOn(r, '2026-11-02', biz)).toBe(false); // segunda, mas feriado
    expect(occursOn(r, '2026-11-03', biz)).toBe(true); // adiado de 31/10 (sáb) → 03/11
    const days = Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`).filter((d) => occursOn(r, d, biz));
    expect(days).toEqual(['2026-11-03', '2026-11-30']); // a ocorrência de outubro (adiada) e a de novembro
  });

  it('mensal sem exigência de dia útil ocorre no próprio dia', () => {
    const r: RoutineRule = { ...base, frequency: 'MENSAL', month_day: 31, business_days_only: false };
    expect(occursOn(r, '2026-10-31', biz)).toBe(true);
    expect(occursOn(r, '2026-11-03', biz)).toBe(false);
  });

  it('anual: dia e mês; adiamento atravessa o ano', () => {
    const r: RoutineRule = { ...base, frequency: 'ANUAL', month_day: 25, month: 12 };
    expect(occursOn(r, '2026-12-25', biz)).toBe(false); // Natal
    expect(occursOn(r, '2026-12-28', biz)).toBe(true); // 26 e 27 são fim de semana
    const ny: RoutineRule = { ...base, frequency: 'ANUAL', month_day: 31, month: 12 };
    expect(occursOn(ny, '2027-01-01', (d) => d !== '2026-12-31' && d !== '2027-01-01' ? biz(d) : false)).toBe(false);
    expect(occursOn(ny, '2027-01-04', (d) => d !== '2026-12-31' && d !== '2027-01-01' ? biz(d) : false)).toBe(true);
  });

  it('respeita início e término de vigência', () => {
    const r = { ...base, starts_on: '2026-11-04', ends_on: '2026-11-05' };
    expect(['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].map((d) => occursOn(r, d, biz))).toEqual([false, true, true, false]);
  });
});

describe('Dependências — detecção de ciclos', () => {
  const e = [{ task_id: 'B', depends_on_id: 'A' }, { task_id: 'C', depends_on_id: 'B' }];
  it('aceita cadeia nova e recusa ciclo direto, indireto e autodependência', () => {
    expect(createsCycle(e, 'D', 'C')).toBe(false);
    expect(createsCycle(e, 'A', 'B')).toBe(true);
    expect(createsCycle(e, 'A', 'C')).toBe(true);
    expect(createsCycle(e, 'A', 'A')).toBe(true);
    expect(createsCycle(e, 'C', 'A')).toBe(false); // redundante, mas não circular
  });
});

describe('Gantt — geometria', () => {
  it('posições proporcionais e recorte na janela', () => {
    const b = ganttBars([
      { id: 'a', start: '2026-11-01', end: '2026-11-10' },
      { id: 'b', start: '2026-10-20', end: '2026-11-05' },
      { id: 'c', start: '2026-12-01', end: '2026-12-02' },
      { id: 'd', start: null, end: '2026-11-30' },
      { id: 'e', start: null, end: null },
    ], '2026-11-01', '2026-11-30');
    expect(b.map((x) => x.id)).toEqual(['a', 'b', 'd']);
    expect(b[0]).toMatchObject({ left: 0, clippedStart: false });
    expect(b[0]!.width).toBeCloseTo((10 / 30) * 100);
    expect(b[1]).toMatchObject({ left: 0, clippedStart: true, clippedEnd: false });
    expect(b[2]!.left).toBeCloseTo((29 / 30) * 100);
  });
});

function principal(userId: string, grants: Record<string, Scope> = {}, sector: string | null = 'S1', owner = false): Principal {
  return {
    userId, email: `${userId}@x`, displayName: userId, isOwner: owner, employeeId: `e-${userId}`, employeeSectorId: sector,
    grants: new Map(Object.entries(grants).map(([k, s]) => [k, { scope: s, sectorIds: new Set(s === 'SETOR' && sector ? [sector] : []) }])),
  };
}
const task = { sector_id: 'S1', assignee_user_id: 'ana', created_by: 'bia', approver_user_id: 'chefe', escalated_to_user_id: null, member_role: null };

describe('Tarefas e projetos — acesso', () => {
  it('colaborador (escopo próprio) vê só o que lhe diz respeito', () => {
    const colab = { 'tarefas.ver': 'PROPRIO' as Scope, 'tarefas.criar': 'PROPRIO' as Scope };
    expect(taskAccess(principal('ana', colab), task)).toMatchObject({ read: true, work: true, edit: false, manage: false });
    expect(taskAccess(principal('bia', colab), task)).toMatchObject({ read: true, edit: true, work: true });
    expect(taskAccess(principal('chefe', colab), task)).toMatchObject({ read: true, work: false, comment: true });
    expect(taskAccess(principal('zeca', colab), task).read).toBe(false);
  });

  it('coordenação gere o próprio setor; não o de outro', () => {
    const coord = { 'tarefas.ver': 'SETOR' as Scope, 'tarefas.gerenciar': 'SETOR' as Scope };
    expect(taskAccess(principal('c', coord, 'S1'), task)).toMatchObject({ read: true, manage: true, edit: true });
    expect(taskAccess(principal('c', coord, 'S2'), task).read).toBe(false);
  });

  it('participação no projeto: gestor gere, membro comenta, leitor só lê', () => {
    expect(taskAccess(principal('x'), { ...task, member_role: 'GESTOR' })).toMatchObject({ manage: true });
    expect(taskAccess(principal('x'), { ...task, member_role: 'MEMBRO' })).toMatchObject({ read: true, comment: true, work: false });
    expect(taskAccess(principal('x'), { ...task, member_role: 'LEITOR' })).toMatchObject({ read: true, comment: false, work: false });
    expect(projectAccess(principal('x'), { sector_id: 'S1', member_role: 'LEITOR' })).toEqual({ read: true, manage: false, contribute: false });
    expect(projectAccess(principal('x'), { sector_id: 'S1', member_role: null }).read).toBe(false);
    expect(projectAccess(principal('of', {}, null, true), { sector_id: 'S1', member_role: null }).manage).toBe(true);
  });
});
