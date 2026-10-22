import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import {
  addAttachment, addComment, addDependency, createTask, escalate, getTask, listTasks, reviewTask, setStatus, updateTask,
} from '../../../src/server/modules/tasks.ts';
import { addCost, createProject, getProject, setMember } from '../../../src/server/modules/projects.ts';
import { generateRoutineTasks, saveProcessTemplate, saveRoutine, startProcess } from '../../../src/server/modules/routines.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { todayLocal } from '../../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';

let I: Awaited<ReturnType<typeof ids>>;
let cOwner: Ctx, cCoord: Ctx, cAna: Ctx, cAtd: Ctx;
let anaId: string, coordId: string, atdId: string;

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  const o = await makePerson({ name: 'Oficial Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
  const c = await makePerson({ name: 'Coord RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }, { roleId: I.roles.COORDENACAO_SETOR }] });
  const a = await makePerson({ name: 'Ana RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
  const t = await makePerson({ name: 'Atendente', sectorId: I.sectors.ATD, jobId: I.jobs.atendente, roles: [{ roleId: I.roles.COLABORADOR }] });
  cOwner = await ctxFor(o.userId); cCoord = await ctxFor(c.userId); cAna = await ctxFor(a.userId); cAtd = await ctxFor(t.userId);
  anaId = a.userId; coordId = c.userId; atdId = t.userId;
});
afterAll(closePool);

describe('Rodada 2 (4a) — integridade no banco', () => {
  it('comentários, histórico, anexos e custos são imutáveis; tarefas e projetos não se excluem', async () => {
    const id = await createTask(cAna, { title: 'Imutabilidade' });
    await addComment(cAna, id, 'texto original');
    await addAttachment(cAna, id, { name: 'a.txt', bytes: new TextEncoder().encode('fictício') });
    for (const sql of [
      "UPDATE task_comments SET body = 'adulterado' WHERE task_id = $1", 'DELETE FROM task_comments WHERE task_id = $1',
      "UPDATE task_events SET event = 'X' WHERE task_id = $1", 'DELETE FROM task_events WHERE task_id = $1',
      'DELETE FROM task_attachments WHERE task_id = $1', 'DELETE FROM tasks WHERE id = $1',
    ]) await expect(query(getPool(), sql, [id]), sql).rejects.toThrow();
    const pid = await createProject(cCoord, { name: 'Projeto imutável', sectorId: I.sectors.RI });
    await addCost(cCoord, pid, { description: 'Custo fictício', amount: 10, spentOn: todayLocal() });
    await expect(query(getPool(), 'UPDATE project_costs SET amount = 1 WHERE project_id = $1', [pid])).rejects.toThrow();
    await expect(query(getPool(), 'DELETE FROM projects WHERE id = $1', [pid])).rejects.toThrow();
  });

  it('restrições de consistência barram estados inválidos mesmo por fora do sistema', async () => {
    const id = await createTask(cCoord, { title: 'Consistência', assigneeUserId: anaId });
    await expect(query(getPool(), "UPDATE tasks SET status = 'CONCLUIDA' WHERE id = $1", [id])).rejects.toThrow(/check/); // sem data de conclusão
    await expect(query(getPool(), "UPDATE tasks SET status = 'BLOQUEADA' WHERE id = $1", [id])).rejects.toThrow(/check/); // sem motivo
    await expect(query(getPool(), 'UPDATE tasks SET requires_approval = true, approver_user_id = assignee_user_id WHERE id = $1', [id])).rejects.toThrow(/check/);
    await expect(query(getPool(), "UPDATE tasks SET status = 'CONCLUIDA', completed_at = now(), approved_by = assignee_user_id WHERE id = $1", [id])).rejects.toThrow(/check/);
  });
});

describe('Rodada 2 (4a) — autorização (IDOR) e segregação', () => {
  it('pessoa de outro setor não lê, não altera, não comenta, não anexa, não encaminha', async () => {
    const id = await createTask(cCoord, { title: 'Tarefa do RI', assigneeUserId: anaId });
    for (const op of [
      () => getTask(cAtd, id), () => setStatus(cAtd, id, 'EM_ANDAMENTO'), () => addComment(cAtd, id, 'x'), () => updateTask(cAtd, id, { title: 'Invadida' }),
      () => addAttachment(cAtd, id, { name: 'a.txt', bytes: new TextEncoder().encode('x') }), () => escalate(cAtd, id, 'OFICIAL', 'tentativa indevida'),
    ]) await expect(op()).rejects.toThrow(/não encontrada/);
    expect((await listTasks(cAtd, { status: 'TODAS' })).some((t) => t.id === id)).toBe(false);
  });

  it('responsável não reatribui a terceiros nem se torna aprovador da própria tarefa', async () => {
    const id = await createTask(cAna, { title: 'Minha tarefa' });
    await expect(updateTask(cAna, id, { assigneeUserId: atdId })).rejects.toThrow(/coordenação/);
    await expect(updateTask(cAna, id, { requiresApproval: true, approverUserId: anaId })).rejects.toThrow(/aprovador diferente/);
  });

  it('aprovador que executa a conclusão não pode aprová-la (segregação)', async () => {
    const id = await createTask(cCoord, { title: 'Segregação', assigneeUserId: anaId, requiresApproval: true, approverUserId: coordId });
    expect(await setStatus(cCoord, id, 'CONCLUIDA')).toBe('EM_REVISAO'); // a coordenação concluiu no lugar da responsável
    await expect(reviewTask(cCoord, id, true)).rejects.toThrow(/Segregação/);
    expect((await getTask(cCoord, id)).canReview).toBe(false);
  });

  it('leitor de projeto não cria tarefas; membro removido perde o acesso', async () => {
    const pid = await createProject(cCoord, { name: 'Projeto restrito', sectorId: I.sectors.RI });
    await setMember(cCoord, pid, atdId, 'LEITOR');
    expect((await getProject(cAtd, pid)).access).toEqual({ read: true, manage: false, contribute: false });
    await expect(createTask(cAtd, { title: 'Leitor criando', projectId: pid })).rejects.toThrow(/não participa/);
    await setMember(cCoord, pid, atdId, null);
    await expect(getProject(cAtd, pid)).rejects.toThrow(/não encontrado/);
  });

  it('pesquisa com caracteres especiais não altera a consulta', async () => {
    for (const q of ["'; DROP TABLE tasks; --", '%_\\', '<script>']) await expect(listTasks(cCoord, { q })).resolves.toBeInstanceOf(Array);
  });
});

describe('Rodada 2 (4a) — concorrência', () => {
  it('geração de rotinas simultânea não duplica ocorrências', async () => {
    await saveRoutine(cOwner, { name: 'Rotina concorrente', area: 'RI', sectorId: I.sectors.RI, frequency: 'DIARIA', times: [540, 600], businessDaysOnly: false, startsOn: '2026-12-01' });
    const r = await Promise.all([1, 2, 3, 4].map(() => generateRoutineTasks('2026-12-01', '2026-12-05')));
    expect(r.reduce((a, b) => a + b, 0)).toBe(10);
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM tasks WHERE title = 'Rotina concorrente'"))!.n).toBe(10);
  });

  it('dependências cruzadas simultâneas: o ciclo nunca se forma', async () => {
    const a = await createTask(cCoord, { title: 'Ciclo A' });
    const b = await createTask(cCoord, { title: 'Ciclo B' });
    const r = await Promise.allSettled([addDependency(cCoord, a, b), addDependency(cCoord, b, a)]);
    expect(r.filter((x) => x.status === 'fulfilled').length).toBe(1);
    expect((await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM task_dependencies WHERE task_id = ANY($1::uuid[])', [[a, b]]))!.n).toBe(1);
  });

  it('conclusões simultâneas da mesma tarefa: um único registro de conclusão', async () => {
    const id = await createTask(cAna, { title: 'Dupla conclusão' });
    await Promise.allSettled([setStatus(cAna, id, 'CONCLUIDA'), setStatus(cAna, id, 'CONCLUIDA')]);
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM task_events WHERE task_id = $1 AND event = 'CONCLUIDA'", [id]))!.n).toBe(1);
  });
});

describe('Rodada 2 (4a) — processos', () => {
  it('alterar o modelo depois de iniciado não altera o processo em andamento', async () => {
    const tpl = await saveProcessTemplate(cOwner, { name: 'Modelo mutável', sectorId: I.sectors.RI, steps: [{ title: 'Etapa um' }, { title: 'Etapa dois' }] });
    const inst = await startProcess(cCoord, tpl, 'Execução 1');
    await saveProcessTemplate(cOwner, { id: tpl, name: 'Modelo mutável', sectorId: I.sectors.RI, steps: [{ title: 'Outra etapa' }] });
    const titles = (await query<{ title: string }>(getPool(), 'SELECT title FROM tasks WHERE process_instance_id = $1 ORDER BY process_step', [inst])).map((t) => t.title);
    expect(titles).toEqual(['Execução 1 — 1. Etapa um', 'Execução 1 — 2. Etapa dois']);
    const snap = await queryOne<{ s: { etapas: unknown[] } }>(getPool(), 'SELECT template_snapshot AS s FROM process_instances WHERE id = $1', [inst]);
    expect(snap!.s.etapas.length).toBe(2);
  });

  it('trilha de auditoria íntegra', async () => {
    const r = await verifyAuditChain(getPool());
    expect(r.ok).toBe(true);
    expect(r.total).toBeGreaterThan(5);
  });
});
