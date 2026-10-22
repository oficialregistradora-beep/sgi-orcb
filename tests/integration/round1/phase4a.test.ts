import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import {
  addChecklistItem, addComment, addDependency, attachmentForDownload, addAttachment, createTask, escalate, getTask, listTasks, processTaskReminders,
  resolveEscalation, reviewTask, setStatus, taskDashboard, toggleChecklistItem, updateTask,
} from '../../../src/server/modules/tasks.ts';
import { addCost, addMilestone, addPhase, createProject, getProject, listProjects, saveIndicator, setMember, toggleMilestone, updateProject } from '../../../src/server/modules/projects.ts';
import { cancelProcess, generateRoutineTasks, listProcessInstances, saveProcessTemplate, saveRoutine, startProcess } from '../../../src/server/modules/routines.ts';
import { addDays, todayLocal, weekdayOf } from '../../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';

let I: Awaited<ReturnType<typeof ids>>;
type P = { userId: string; employeeId: string };
let owner: P, subst: P, coord: P, ana: P, bruno: P, atd: P;
let cOwner: Ctx, cSubst: Ctx, cCoord: Ctx, cAna: Ctx, cBruno: Ctx, cAtd: Ctx;
const today = todayLocal();

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  owner = await makePerson({ name: 'Oficial Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
  subst = await makePerson({ name: 'Substituta Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] });
  coord = await makePerson({ name: 'Coord RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }, { roleId: I.roles.COORDENACAO_SETOR }] });
  ana = await makePerson({ name: 'Ana RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
  bruno = await makePerson({ name: 'Bruno RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
  atd = await makePerson({ name: 'Atendente', sectorId: I.sectors.ATD, jobId: I.jobs.atendente, roles: [{ roleId: I.roles.COLABORADOR }] });
  cOwner = await ctxFor(owner.userId); cSubst = await ctxFor(subst.userId); cCoord = await ctxFor(coord.userId);
  cAna = await ctxFor(ana.userId); cBruno = await ctxFor(bruno.userId); cAtd = await ctxFor(atd.userId);
});
afterAll(closePool);

describe('Fase 4a — tarefas', () => {
  let t1: string;
  it('colaborador cria tarefa para si; não atribui a terceiros nem cria em outro setor', async () => {
    t1 = await createTask(cAna, { title: 'Conferir averbações pendentes', priority: 'IMEDIATA', dueDate: today });
    const { task } = await getTask(cAna, t1);
    expect(task.assignee_user_id).toBe(ana.userId);
    expect(task.sector_id).toBe(I.sectors.RI);
    await expect(createTask(cAna, { title: 'Para o Bruno', assigneeUserId: bruno.userId })).rejects.toThrow(/só pode criar tarefas para si/);
    await expect(createTask(cAna, { title: 'Outro setor', sectorId: I.sectors.ATD })).rejects.toThrow(/setor/);
  });

  it('coordenação atribui no setor; responsável é notificado; terceiros de outro setor não veem', async () => {
    const id = await createTask(cCoord, { title: 'Notificações e matrículas eletrônicas', assigneeUserId: bruno.userId, priority: 'ALTA', dueDate: today, blockStart: 960, blockEnd: 1020 });
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'TAREFA_ATRIBUIDA'", [bruno.userId]))!.n).toBe(1);
    await expect(getTask(cAtd, id)).rejects.toThrow(/não encontrada/);
    expect((await listTasks(cAtd)).length).toBe(0);
    expect((await listTasks(cCoord)).map((t) => t.id)).toEqual(expect.arrayContaining([id, t1]));
    await expect(createTask(cCoord, { title: 'Bloco inválido', blockStart: 1000, blockEnd: 900 })).rejects.toThrow(/Bloco/);
  });

  it('ordenação: IMEDIATA primeiro', async () => {
    const mine = await listTasks(cCoord);
    expect(mine[0]!.priority).toBe('IMEDIATA');
  });

  it('checklist, subtarefa e dependência impedem a conclusão até serem resolvidos', async () => {
    await addChecklistItem(cAna, t1, 'Separar os títulos');
    const sub = await createTask(cAna, { title: 'Subtarefa', parentTaskId: t1 });
    const pre = await createTask(cAna, { title: 'Predecessora' });
    await addDependency(cAna, t1, pre);
    await expect(addDependency(cAna, pre, t1)).rejects.toThrow(/circular/);
    await expect(setStatus(cAna, t1, 'CONCLUIDA')).rejects.toThrow(/predecessora/);
    await setStatus(cAna, pre, 'CONCLUIDA');
    await expect(setStatus(cAna, t1, 'CONCLUIDA')).rejects.toThrow(/subtarefa/);
    await setStatus(cAna, sub, 'CONCLUIDA');
    await expect(setStatus(cAna, t1, 'CONCLUIDA')).rejects.toThrow(/checklist/);
    const { checklist } = await getTask(cAna, t1);
    await toggleChecklistItem(cAna, checklist[0]!.id, true);
    expect(await setStatus(cAna, t1, 'CONCLUIDA')).toBe('CONCLUIDA');
    await expect(updateTask(cAna, t1, { title: 'Mudou' })).rejects.toThrow(/encerrada/);
  });

  it('reabertura só pela gestão e com motivo; cancelamento exige motivo; tarefas não são excluídas', async () => {
    await expect(setStatus(cAna, t1, 'A_FAZER', 'Refazer')).rejects.toThrow(/coordenação/);
    await expect(setStatus(cCoord, t1, 'A_FAZER')).rejects.toThrow(/motivo/);
    await setStatus(cCoord, t1, 'A_FAZER', 'Faltou um título');
    await expect(setStatus(cAna, t1, 'CANCELADA')).rejects.toThrow(/motivo/);
    await setStatus(cAna, t1, 'CANCELADA', 'Duplicada');
    await expect(query(getPool(), 'DELETE FROM tasks WHERE id = $1', [t1])).rejects.toThrow(/não podem ser excluídas/);
  });

  it('bloqueio (exceção) exige descrição e avisa quem criou', async () => {
    const id = await createTask(cCoord, { title: 'Conferir central', assigneeUserId: ana.userId });
    await expect(setStatus(cAna, id, 'BLOQUEADA')).rejects.toThrow(/impedimento/);
    await setStatus(cAna, id, 'BLOQUEADA', 'Central fora do ar');
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'TAREFA_BLOQUEADA'", [coord.userId]))!.n).toBe(1);
  });

  it('aprovação: conclusão vai para revisão; quem executou não aprova; devolução e aprovação', async () => {
    await expect(createTask(cCoord, { title: 'Aprovação inválida', assigneeUserId: ana.userId, requiresApproval: true, approverUserId: ana.userId })).rejects.toThrow(/aprova/);
    const id = await createTask(cCoord, { title: 'Minuta de ofício', assigneeUserId: ana.userId, requiresApproval: true, approverUserId: coord.userId });
    expect(await setStatus(cAna, id, 'CONCLUIDA')).toBe('EM_REVISAO');
    await expect(reviewTask(cAna, id, true)).rejects.toThrow(/aprovador/);
    await expect(reviewTask(cCoord, id, false)).rejects.toThrow(/ajustado/);
    await reviewTask(cCoord, id, false, 'Corrigir o destinatário');
    expect((await getTask(cAna, id)).task.status).toBe('EM_ANDAMENTO');
    await setStatus(cAna, id, 'CONCLUIDA');
    await reviewTask(cCoord, id, true);
    const t = await queryOne<{ status: string; approved_by: string; completed_by: string }>(getPool(), 'SELECT status, approved_by, completed_by FROM tasks WHERE id = $1', [id]);
    expect(t).toEqual({ status: 'CONCLUIDA', approved_by: coord.userId, completed_by: ana.userId });
  });

  it('escalonamento: ordinária → Substituta; complexa → Oficial; decisão registrada', async () => {
    const id = await createTask(cAna, { title: 'Dúvida sobre emolumentos' });
    await expect(escalate(cAna, id, 'SUBSTITUTA', 'abc')).rejects.toThrow(/Descreva/);
    await escalate(cAna, id, 'SUBSTITUTA', 'Dúvida ordinária sobre cálculo');
    expect((await getTask(cSubst, id)).task.escalated_to_user_id).toBe(subst.userId);
    await escalate(cSubst, id, 'OFICIAL', 'Questão complexa: entendimento novo');
    expect((await getTask(cOwner, id)).task.escalation_level).toBe('OFICIAL');
    await expect(resolveEscalation(cSubst, id, 'Decisão de quem não recebeu')).rejects.toThrow(/destinatário/);
    await resolveEscalation(cOwner, id, 'Seguir o entendimento já registrado na matriz.');
    const { task, comments } = await getTask(cAna, id);
    expect(task.escalation_level).toBe('NENHUM');
    expect(comments.at(-1)!.body).toMatch(/Decisão/);
  });

  it('comentários e anexos (com antivírus/armazenamento comum)', async () => {
    const id = await createTask(cAna, { title: 'Com anexo' });
    await addComment(cAna, id, 'Primeiro registro');
    await expect(addComment(cAtd, id, 'intruso')).rejects.toThrow(/não encontrada/);
    const fileId = await addAttachment(cAna, id, { name: 'nota.txt', bytes: new TextEncoder().encode('anotação fictícia') });
    const dl = await attachmentForDownload(cAna, id, fileId);
    expect(dl.data.toString()).toBe('anotação fictícia');
    await expect(attachmentForDownload(cAtd, id, fileId)).rejects.toThrow(/não encontrada/);
    await expect(addAttachment(cAna, id, { name: 'x.html', bytes: new TextEncoder().encode('<script>') })).rejects.toThrow(/Formato/);
  });

  it('avisos de prazo: uma vez por prazo', async () => {
    await createTask(cBruno, { title: 'Prazo vencido', dueDate: addDays(today, -2), startDate: addDays(today, -3) });
    const n = await processTaskReminders();
    expect(n).toBeGreaterThan(0);
    expect(await processTaskReminders()).toBe(0);
  });

  it('painel de tarefas: contagens coerentes', async () => {
    const d = await taskDashboard(cCoord);
    const all = await listTasks(cCoord, { status: 'TODAS' });
    expect(Object.values(d.byStatus).reduce((a, b) => a + b, 0)).toBe(all.length);
    expect(d.overdue).toBeGreaterThanOrEqual(1);
  });
});

describe('Fase 4a — projetos', () => {
  let pid: string;
  it('coordenação cria projeto no setor; colaborador não', async () => {
    await expect(createProject(cAna, { name: 'Projeto do colaborador', sectorId: I.sectors.RI })).rejects.toThrow(/permissão/);
    await expect(createProject(cCoord, { name: 'Outro setor', sectorId: I.sectors.ATD })).rejects.toThrow(/permissão/);
    pid = await createProject(cCoord, { name: 'Implantação dos POPs', code: 'pops-2026', sectorId: I.sectors.RI, startDate: today, dueDate: addDays(today, 90), estimatedCost: 1500 });
    expect((await listProjects(cCoord)).map((p) => p.id)).toContain(pid);
    expect((await listProjects(cAtd)).length).toBe(0);
  });

  it('membros, fases, marcos, custos e indicadores', async () => {
    await setMember(cCoord, pid, ana.userId, 'MEMBRO');
    await setMember(cCoord, pid, atd.userId, 'LEITOR');
    const phase = await addPhase(cCoord, pid, { name: 'Levantamento', startDate: today, dueDate: addDays(today, 30) });
    const ms = await addMilestone(cCoord, pid, { title: 'POPs do RI aprovados', dueDate: addDays(today, 60) });
    await toggleMilestone(cCoord, ms, true);
    await addCost(cCoord, pid, { description: 'Impressão (fictício)', amount: 120.5, spentOn: today });
    await expect(addCost(cCoord, pid, { description: 'Futuro', amount: 1, spentOn: addDays(today, 2) })).rejects.toThrow(/futura/);
    await saveIndicator(cCoord, pid, { name: 'POPs publicados', unit: 'un', target: 10, current: 2 });
    await expect(saveIndicator(cAtd, pid, { name: 'Indicador do leitor', target: 1, current: 0 })).rejects.toThrow(/permissão/);
    // Membro cria tarefa no projeto e na fase; leitor vê, mas não cria.
    const t = await createTask(cAna, { title: 'Mapear rotina de prenotação', projectId: pid, phaseId: phase });
    await expect(createTask(cAtd, { title: 'Leitor tenta', projectId: pid })).rejects.toThrow(/não participa/);
    expect((await getTask(cAtd, t)).access).toMatchObject({ read: true, comment: false });
    const pr = await getProject(cCoord, pid);
    expect(pr.project.actual_cost).toBe('120.50');
    expect(pr.project.code).toBe('POPS-2026');
    expect(pr.members.map((m) => m.role).sort()).toEqual(['GESTOR', 'LEITOR', 'MEMBRO']);
    expect(pr.milestones[0]!.done_at).not.toBeNull();
    expect(pr.indicators[0]!.current).toBe('2.00');
  });

  it('encerramento bloqueado com tarefas abertas; cancelamento exige motivo; reabertura', async () => {
    const base = { name: 'Implantação dos POPs', code: 'POPS-2026', sectorId: I.sectors.RI };
    await expect(updateProject(cCoord, pid, { ...base, status: 'CONCLUIDO' })).rejects.toThrow(/em aberto/);
    for (const t of await listTasks(cCoord, { projectId: pid })) await setStatus(cCoord, t.id, 'CONCLUIDA');
    await updateProject(cCoord, pid, { ...base, status: 'CONCLUIDO' });
    await expect(createTask(cAna, { title: 'Depois do fim', projectId: pid })).rejects.toThrow(/encerrado/);
    await expect(updateProject(cCoord, pid, { ...base, status: 'EM_ANDAMENTO' })).rejects.toThrow(/motivo/);
    await updateProject(cCoord, pid, { ...base, status: 'EM_ANDAMENTO', reason: 'Nova etapa' });
    await expect(query(getPool(), 'DELETE FROM projects WHERE id = $1', [pid])).rejects.toThrow(/excluídas/);
  });
});

describe('Fase 4a — rotinas e processos', () => {
  it('rotina 4×/dia (centrais eletrônicas) gera 4 tarefas por dia útil, sem duplicar', async () => {
    await expect(saveRoutine(cAna, { name: 'X', area: 'RI', sectorId: I.sectors.RI, frequency: 'DIARIA' })).rejects.toThrow(/permissão/);
    await saveRoutine(cSubst, {
      name: 'Verificar centrais eletrônicas', area: 'RI', sectorId: I.sectors.RI, assigneeUserId: ana.userId, frequency: 'DIARIA',
      times: [540, 660, 840, 960], priority: 'ALTA', startsOn: '2026-11-02',
    });
    await saveRoutine(cSubst, {
      name: 'Notificações e matrículas eletrônicas', area: 'RI', sectorId: I.sectors.RI, frequency: 'DIARIA', priority: 'URGENTE',
      blockStart: 960, blockEnd: 1020, startsOn: '2026-11-02',
    });
    await expect(saveRoutine(cSubst, { name: 'Semanal sem dia', area: 'RI', sectorId: I.sectors.RI, frequency: 'SEMANAL' })).rejects.toThrow(/dias da semana/);
    const n = await generateRoutineTasks('2026-11-02', '2026-11-08'); // seg (feriado) a dom
    const businessDays = ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].filter((d) => weekdayOf(d) !== 0);
    expect(n).toBe(businessDays.length * 5);
    expect(await generateRoutineTasks('2026-11-02', '2026-11-08')).toBe(0);
    const block = await queryOne<{ block_start: number; block_end: number; assignee_user_id: string | null }>(getPool(),
      "SELECT block_start, block_end, assignee_user_id FROM tasks WHERE title = 'Notificações e matrículas eletrônicas' AND due_date = '2026-11-03' AND routine_id IS NOT NULL");
    expect(block).toEqual({ block_start: 960, block_end: 1020, assignee_user_id: null }); // tarefa do setor
  });

  it('processo: etapas em sequência, aprovação na etapa e encerramento automático', async () => {
    const tpl = await saveProcessTemplate(cSubst, {
      name: 'Admissão de colaborador (administrativo)', sectorId: I.sectors.RI,
      steps: [
        { title: 'Coletar documentos', requiredDocuments: 'RG, CPF, comprovante (fictício)', slaDays: 2, responsibleRoleId: I.roles.COORDENACAO_SETOR },
        { title: 'Conferir cadastro', slaDays: 1, requiresApproval: true },
        { title: 'Arquivar dossiê', slaDays: 1 },
      ],
    });
    await expect(startProcess(cAna, tpl, 'Admissão — Fulano')).rejects.toThrow(/coordenação/);
    const inst = await startProcess(cCoord, tpl, 'Admissão — Fulano (fictício)');
    const steps = await query<{ id: string; process_step: number; assignee_user_id: string | null; approver_user_id: string | null; due_date: string }>(getPool(),
      'SELECT id, process_step, assignee_user_id, approver_user_id, due_date FROM tasks WHERE process_instance_id = $1 ORDER BY process_step', [inst]);
    expect(steps.length).toBe(3);
    expect(steps[0]!.assignee_user_id).toBe(coord.userId); // único com o papel no setor
    expect(steps[1]!.approver_user_id).toBe(coord.userId); // quem iniciou aprova
    expect(steps[1]!.due_date > steps[0]!.due_date).toBe(true);
    await expect(setStatus(cCoord, steps[1]!.id, 'CONCLUIDA')).rejects.toThrow(/predecessora/);
    await setStatus(cCoord, steps[0]!.id, 'CONCLUIDA');
    await updateTask(cCoord, steps[1]!.id, { assigneeUserId: ana.userId });
    expect(await setStatus(cAna, steps[1]!.id, 'CONCLUIDA')).toBe('EM_REVISAO');
    await reviewTask(cCoord, steps[1]!.id, true);
    await setStatus(cCoord, steps[2]!.id, 'CONCLUIDA');
    const i = (await listProcessInstances(cCoord)).find((x) => x.id === inst)!;
    expect(i.status).toBe('ENCERRADO');
    expect(i.steps_done).toBe(3);
  });

  it('cancelamento de processo cancela as etapas abertas', async () => {
    const tpl = (await queryOne<{ id: string }>(getPool(), 'SELECT id FROM process_templates LIMIT 1'))!.id;
    const inst = await startProcess(cCoord, tpl, 'Processo a cancelar');
    await expect(cancelProcess(cCoord, inst, 'x')).rejects.toThrow(/motivo/);
    await cancelProcess(cCoord, inst, 'Iniciado por engano');
    const open = (await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM tasks WHERE process_instance_id = $1 AND status <> 'CANCELADA'", [inst]))!.n;
    expect(open).toBe(0);
  });
});
