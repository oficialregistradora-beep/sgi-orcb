import { writeFileSync, mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../src/server/db.ts';
import type { Ctx } from '../../src/server/context.ts';
import { addDependency, createTask, listTasks, reviewTask, setStatus, taskDashboard, updateTask } from '../../src/server/modules/tasks.ts';
import { createProject, getProject, setMember } from '../../src/server/modules/projects.ts';
import { generateRoutineTasks, listProcessInstances, saveProcessTemplate, saveRoutine, startProcess } from '../../src/server/modules/routines.ts';
import { verifyAuditChain } from '../../src/server/audit.ts';
import { addDays, eachDay, weekdayOf } from '../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../helpers.ts';

// RODADA 3 (Fase 4a) — 3 meses de operação: 5 rotinas (inclui centrais 4×/dia e bloco 16–17 h), um projeto com
// 30 tarefas encadeadas e 12 processos de 3 etapas. Verifica invariantes de contagem, ordem, segregação e encerramento.

const FROM = '2027-01-04';
const TO = '2027-04-02';
const metrics: Record<string, number> = {};
let seed = 47;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
let I: Awaited<ReturnType<typeof ids>>;
let cOwner: Ctx, cCoord: Ctx, cAna: Ctx, cBia: Ctx;

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  const o = await makePerson({ name: 'Oficial Simulada', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
  const c = await makePerson({ name: 'Coord Simulada', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }, { roleId: I.roles.COORDENACAO_SETOR }] });
  const a = await makePerson({ name: 'Ana Simulada', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
  const b = await makePerson({ name: 'Bia Simulada', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
  cOwner = await ctxFor(o.userId); cCoord = await ctxFor(c.userId); cAna = await ctxFor(a.userId); cBia = await ctxFor(b.userId);
});
afterAll(async () => {
  mkdirSync('docs/test-reports', { recursive: true });
  writeFileSync('docs/test-reports/rodada3-fase4a-metricas.json', JSON.stringify({ executadoEm: new Date().toISOString(), periodo: `${FROM} a ${TO}`, metricas: metrics }, null, 2));
  await closePool();
});

describe('Rodada 3 (4a) — três meses de rotinas, projeto e processos', () => {
  it('rotinas: número de tarefas geradas confere com o calendário calculado de forma independente', async () => {
    const R = I.sectors.RI;
    await saveRoutine(cOwner, { name: 'Centrais 4x', area: 'RI', sectorId: R, assigneeUserId: cAna.principal.userId, frequency: 'DIARIA', times: [540, 660, 840, 960], startsOn: FROM });
    await saveRoutine(cOwner, { name: 'Bloco notificações', area: 'RI', sectorId: R, frequency: 'DIARIA', blockStart: 960, blockEnd: 1020, startsOn: FROM });
    await saveRoutine(cOwner, { name: 'Reunião semanal', area: 'DIRETORIA', sectorId: R, frequency: 'SEMANAL', weekdays: [1, 3], startsOn: FROM });
    await saveRoutine(cOwner, { name: 'Fechamento mensal', area: 'PESSOAL', sectorId: R, frequency: 'MENSAL', monthDay: 31, startsOn: FROM });
    await saveRoutine(cOwner, { name: 'Inventário anual', area: 'ADMINISTRACAO', sectorId: R, frequency: 'ANUAL', monthDay: 15, month: 3, startsOn: FROM });
    // Gera em fatias (como a rotina diária faria), com repetições propositais.
    let generated = 0;
    for (let d = FROM; d <= TO; d = addDays(d, 7)) generated += await generateRoutineTasks(d, addDays(d, 9) > TO ? TO : addDays(d, 9));
    const holidays = new Set((await query<{ date: string }>(getPool(), 'SELECT date FROM holidays WHERE is_day_off')).map((h) => h.date));
    const biz = eachDay(FROM, TO).filter((d) => weekdayOf(d) !== 0 && weekdayOf(d) !== 6 && !holidays.has(d));
    const weekly = biz.filter((d) => [1, 3].includes(weekdayOf(d))).length;
    const expected = biz.length * 4 + biz.length + weekly + 3 /* jan, fev, mar (31 → último dia útil seguinte) */ + 1;
    metrics.dias_uteis = biz.length;
    metrics.tarefas_de_rotina = generated;
    expect(generated).toBe(expected);
    const perMonth = await query<{ due_date: string }>(getPool(), "SELECT due_date FROM tasks WHERE title = 'Fechamento mensal' ORDER BY due_date");
    expect(perMonth.map((r) => holidays.has(r.due_date) || [0, 6].includes(weekdayOf(r.due_date)))).toEqual([false, false, false]);
  });

  it('execução: ~90% das rotinas concluídas pelo responsável; nenhuma duplicidade', async () => {
    const mine = (await listTasks(cAna, { scope: 'minhas', limit: 2000 })).filter((t) => t.routine_id);
    let done = 0;
    for (const t of mine) if (rnd() < 0.9) { await setStatus(cAna, t.id, 'CONCLUIDA'); done++; }
    metrics.rotinas_concluidas = done;
    metrics.rotinas_em_aberto = mine.length - done;
    const dup = await query(getPool(), 'SELECT routine_id, occurrence_key FROM tasks WHERE routine_id IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1');
    expect(dup).toEqual([]);
  });

  it('projeto com 30 tarefas encadeadas: ordem respeitada, aprovações segregadas, progresso coerente', async () => {
    const pid = await createProject(cCoord, { name: 'Projeto simulado', sectorId: I.sectors.RI, startDate: FROM, dueDate: TO });
    await setMember(cCoord, pid, cAna.principal.userId, 'MEMBRO');
    await setMember(cCoord, pid, cBia.principal.userId, 'MEMBRO');
    const ids2: string[] = [];
    for (let i = 0; i < 30; i++) {
      const who = i % 2 ? cAna : cBia;
      const id = await createTask(cCoord, {
        title: `Etapa ${i + 1}`, projectId: pid, assigneeUserId: who.principal.userId, startDate: addDays(FROM, i * 2), dueDate: addDays(FROM, i * 2 + 3),
        requiresApproval: i % 5 === 4, approverUserId: i % 5 === 4 ? cCoord.principal.userId : null,
      });
      if (ids2.length) await addDependency(cCoord, id, ids2.at(-1)!);
      ids2.push(id);
    }
    let blockedAttempts = 0, approvals = 0, returns = 0;
    for (let i = 0; i < 30; i++) {
      const who = i % 2 ? cAna : cBia;
      if (i + 1 < 30) await setStatus(i % 2 ? cBia : cAna, ids2[i + 1]!, 'CONCLUIDA').catch(() => { blockedAttempts++; }); // tentativa fora de ordem
      const s = await setStatus(who, ids2[i]!, 'CONCLUIDA');
      if (s === 'EM_REVISAO') {
        if (rnd() < 0.3) { await reviewTask(cCoord, ids2[i]!, false, 'Ajustar (simulação)'); returns++; await setStatus(who, ids2[i]!, 'CONCLUIDA'); }
        await reviewTask(cCoord, ids2[i]!, true);
        approvals++;
      }
    }
    Object.assign(metrics, { projeto_tarefas: 30, tentativas_fora_de_ordem_bloqueadas: blockedAttempts, aprovacoes: approvals, devolucoes: returns });
    expect(blockedAttempts).toBe(29);
    const pr = await getProject(cCoord, pid);
    expect(pr.project.tasks_done).toBe(30);
    // Nenhuma tarefa concluída antes da predecessora.
    const order = await query(getPool(), `SELECT t.id FROM task_dependencies d JOIN tasks t ON t.id = d.task_id JOIN tasks p ON p.id = d.depends_on_id
                                           WHERE t.project_id = $1 AND t.completed_at < p.completed_at`, [pid]);
    expect(order).toEqual([]);
    const seg = await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM tasks WHERE approved_by IS NOT NULL AND (approved_by = completed_by OR approved_by = assignee_user_id)');
    expect(seg!.n).toBe(0);
  });

  it('12 processos de 3 etapas: encerramento automático exatamente quando todas as etapas terminam', async () => {
    const tpl = await saveProcessTemplate(cOwner, { name: 'Processo simulado', sectorId: I.sectors.RI, steps: [
      { title: 'Receber', slaDays: 1, responsibleRoleId: I.roles.COORDENACAO_SETOR }, { title: 'Conferir', slaDays: 2, requiresApproval: true }, { title: 'Arquivar', slaDays: 1 },
    ] });
    for (let k = 0; k < 12; k++) {
      const inst = await startProcess(cCoord, tpl, `Execução ${k + 1}`);
      const steps = await query<{ id: string }>(getPool(), 'SELECT id FROM tasks WHERE process_instance_id = $1 ORDER BY process_step', [inst]);
      const finish = k % 4 === 3 ? 2 : 3; // 3 dos 12 param antes da última etapa
      for (let s = 0; s < finish; s++) {
        if (s === 1) {
          // Etapa com aprovação: executada pela Ana; aprovada pela coordenação (quem iniciou), nunca por quem executou.
          await updateTask(cCoord, steps[s]!.id, { assigneeUserId: cAna.principal.userId });
          expect(await setStatus(cAna, steps[s]!.id, 'CONCLUIDA')).toBe('EM_REVISAO');
          await reviewTask(cCoord, steps[s]!.id, true);
        } else {
          await setStatus(cCoord, steps[s]!.id, 'CONCLUIDA');
        }
      }
    }
    const inst = (await listProcessInstances(cCoord)).filter((i) => i.template_name === 'Processo simulado');
    const consistent = inst.every((i) => (i.status === 'ENCERRADO') === (i.steps_done === i.steps));
    metrics.processos = inst.length;
    metrics.processos_encerrados = inst.filter((i) => i.status === 'ENCERRADO').length;
    expect(consistent).toBe(true);
    expect(metrics.processos).toBe(12);
    expect(metrics.processos_encerrados).toBe(9);
  });

  it('painel: contagens batem com o banco', async () => {
    const d = await taskDashboard(cOwner);
    const db = await queryOne<{ open: number; total: number }>(getPool(),
      "SELECT count(*) FILTER (WHERE status NOT IN ('CONCLUIDA','CANCELADA'))::int AS open, count(*)::int AS total FROM tasks");
    expect(d.open).toBe(db!.open);
    expect(Object.values(d.byStatus).reduce((a, b) => a + b, 0)).toBe(db!.total);
    metrics.tarefas_total = db!.total;
    metrics.tarefas_abertas = db!.open;
  });

  it('trilha de auditoria íntegra', async () => {
    const r = await verifyAuditChain(getPool());
    metrics.eventos_auditoria = r.total;
    expect(r.ok).toBe(true);
  });
});
