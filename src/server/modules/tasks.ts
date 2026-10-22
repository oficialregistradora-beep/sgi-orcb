import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx, Principal } from '../context.ts';
import { can } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ForbiddenError, NotFoundError } from '../errors.ts';
import { getNumberSetting } from '../settings.ts';
import { checkFile } from '../files.ts';
import { addDays, todayLocal } from '../../domain/time.ts';
import { createsCycle } from '../../domain/recurrence.ts';
import { notifyUsers } from './notifications.ts';
import { discardUnsaved, insertStoredFile, loadStoredFile, prepareFile, readStoredFile, rescan, type PreparedFile } from './fileStore.ts';
import { maxFileBytes } from './repository.ts';

// Tarefas individuais e coletivas (Fase 4a). Ferramenta de gestão interna: não pratica nem qualifica atos registrais.
// Tarefas não são excluídas (cancela-se); comentários, anexos e histórico são imutáveis.

export const STATUSES = ['A_FAZER', 'EM_ANDAMENTO', 'EM_REVISAO', 'BLOQUEADA', 'CONCLUIDA', 'CANCELADA'] as const;
export type TaskStatus = (typeof STATUSES)[number];
export const PRIORITIES = ['IMEDIATA', 'URGENTE', 'ALTA', 'MEDIA', 'BAIXA'] as const;
export type Priority = (typeof PRIORITIES)[number];
const OPEN = (s: string) => s !== 'CONCLUIDA' && s !== 'CANCELADA';

export type TaskRow = {
  id: string; project_id: string | null; project_name: string | null; phase_id: string | null; parent_task_id: string | null;
  process_instance_id: string | null; process_step: number | null; routine_id: string | null;
  title: string; description: string | null; status: TaskStatus; priority: Priority; sector_id: string; sector_name: string;
  assignee_user_id: string | null; assignee_name: string | null; start_date: string | null; due_date: string | null; due_time: number | null;
  block_start: number | null; block_end: number | null; requires_approval: boolean; approver_user_id: string | null; approver_name: string | null;
  blocked_reason: string | null; escalation_level: 'NENHUM' | 'SUBSTITUTA' | 'OFICIAL'; escalated_to_user_id: string | null; escalated_to_name: string | null;
  escalation_reason: string | null; position: number; created_by: string; created_by_name: string; created_at: Date; completed_at: Date | null;
  member_role: 'GESTOR' | 'MEMBRO' | 'LEITOR' | null; project_owner: string | null;
  checklist_total: number; checklist_done: number; subtasks_open: number; deps_open: number;
};

const TASK_SELECT = `
  SELECT t.id, t.project_id, p.name AS project_name, t.phase_id, t.parent_task_id, t.process_instance_id, t.process_step, t.routine_id,
         t.title, t.description, t.status, t.priority, t.sector_id, s.name AS sector_name, t.assignee_user_id, ua.display_name AS assignee_name,
         t.start_date, t.due_date, t.due_time, t.block_start, t.block_end, t.requires_approval, t.approver_user_id, up.display_name AS approver_name,
         t.blocked_reason, t.escalation_level, t.escalated_to_user_id, ue.display_name AS escalated_to_name, t.escalation_reason, t.position,
         t.created_by, uc.display_name AS created_by_name, t.created_at, t.completed_at,
         CASE WHEN p.owner_user_id = $1 THEN 'GESTOR' ELSE pm.role END AS member_role, p.owner_user_id AS project_owner,
         (SELECT count(*)::int FROM task_checklist_items i WHERE i.task_id = t.id) AS checklist_total,
         (SELECT count(*)::int FROM task_checklist_items i WHERE i.task_id = t.id AND i.done_at IS NOT NULL) AS checklist_done,
         (SELECT count(*)::int FROM tasks x WHERE x.parent_task_id = t.id AND x.status NOT IN ('CONCLUIDA','CANCELADA')) AS subtasks_open,
         (SELECT count(*)::int FROM task_dependencies d JOIN tasks x ON x.id = d.depends_on_id
           WHERE d.task_id = t.id AND x.status NOT IN ('CONCLUIDA','CANCELADA')) AS deps_open
    FROM tasks t
    JOIN sectors s ON s.id = t.sector_id
    JOIN users uc ON uc.id = t.created_by
    LEFT JOIN users ua ON ua.id = t.assignee_user_id
    LEFT JOIN users up ON up.id = t.approver_user_id
    LEFT JOIN users ue ON ue.id = t.escalated_to_user_id
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN project_members pm ON pm.project_id = t.project_id AND pm.user_id = $1`;

export type TaskAccess = { read: boolean; work: boolean; comment: boolean; edit: boolean; manage: boolean };

/** Regras de acesso a uma tarefa (função pura). */
export function taskAccess(p: Principal, t: Pick<TaskRow, 'sector_id' | 'assignee_user_id' | 'created_by' | 'approver_user_id' | 'escalated_to_user_id' | 'member_role'>): TaskAccess {
  const me = p.userId;
  const assignee = t.assignee_user_id === me;
  const involved = assignee || t.created_by === me || t.approver_user_id === me || t.escalated_to_user_id === me;
  const manage = p.isOwner || can(p, 'tarefas.gerenciar', { sectorId: t.sector_id }) || t.member_role === 'GESTOR';
  const read = manage || involved || t.member_role !== null || can(p, 'tarefas.ver', { sectorId: t.sector_id });
  const edit = manage || t.created_by === me;
  const work = edit || assignee || t.escalated_to_user_id === me;
  return { read, work, edit, manage, comment: work || t.approver_user_id === me || t.member_role === 'MEMBRO' };
}

async function loadTask(db: Db, ctx: Ctx, id: string, lock = false): Promise<{ t: TaskRow; a: TaskAccess }> {
  z.uuid().parse(id);
  if (lock) await query(db, 'SELECT 1 FROM tasks WHERE id = $1 FOR UPDATE', [id]);
  const t = await queryOne<TaskRow>(db, `${TASK_SELECT} WHERE t.id = $2`, [ctx.principal.userId, id]);
  if (!t) throw new NotFoundError('Tarefa não encontrada.');
  const a = taskAccess(ctx.principal, t);
  if (!a.read) throw new NotFoundError('Tarefa não encontrada.');
  return { t, a };
}

async function event(c: Db, ctx: Ctx | null, taskId: string, ev: string, details: Record<string, unknown> = {}) {
  await query(c, 'INSERT INTO task_events (task_id, user_id, event, details) VALUES ($1,$2,$3,$4)', [taskId, ctx?.principal.userId ?? null, ev, JSON.stringify(details)]);
}

async function activeUser(c: Db, id: string, label: string) {
  if (!(await queryOne(c, "SELECT 1 FROM users WHERE id = $1 AND status = 'ATIVO'", [id]))) throw new AppError(`${label}: usuário inexistente ou inativo.`);
}

// ---------------------------------------------------------------------------
// Criação e edição
// ---------------------------------------------------------------------------

const minutes = z.number().int().min(0).max(1440);
const taskSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(10000).optional(),
  priority: z.enum(PRIORITIES).default('MEDIA'),
  sectorId: z.uuid().optional(),
  assigneeUserId: z.uuid().nullable().optional(),
  projectId: z.uuid().nullable().optional(),
  phaseId: z.uuid().nullable().optional(),
  parentTaskId: z.uuid().nullable().optional(),
  startDate: z.iso.date().nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
  dueTime: minutes.nullable().optional(),
  blockStart: minutes.nullable().optional(),
  blockEnd: minutes.nullable().optional(),
  requiresApproval: z.boolean().default(false),
  approverUserId: z.uuid().nullable().optional(),
});
export type TaskInput = z.input<typeof taskSchema>;

function checkDates(d: { startDate?: string | null; dueDate?: string | null; blockStart?: number | null; blockEnd?: number | null }) {
  if (d.startDate && d.dueDate && d.dueDate < d.startDate) throw new AppError('O prazo não pode ser anterior ao início.');
  if ((d.blockStart == null) !== (d.blockEnd == null) || (d.blockStart != null && d.blockEnd! <= d.blockStart)) {
    throw new AppError('Bloco de horário inválido: informe início e fim, com o fim depois do início.');
  }
}

/** Permissão para atribuir a terceiros: gestão no setor ou gestor do projeto. */
function canAssignOthers(p: Principal, sectorId: string, memberRole: string | null) {
  return p.isOwner || can(p, 'tarefas.gerenciar', { sectorId }) || memberRole === 'GESTOR';
}

export async function createTask(ctx: Ctx, input: TaskInput): Promise<string> {
  const d = taskSchema.parse(input);
  checkDates(d);
  return tx(async (c) => {
    const p = ctx.principal;
    let sectorId = d.sectorId ?? p.employeeSectorId;
    let projectId = d.projectId ?? null;
    let memberRole: string | null = null;
    if (d.parentTaskId) {
      const { t: parent, a } = await loadTask(c, ctx, d.parentTaskId);
      if (!a.work) throw new ForbiddenError('Sem acesso para criar subtarefa nesta tarefa.');
      projectId = parent.project_id;
      sectorId = parent.sector_id;
      memberRole = parent.member_role;
    }
    if (projectId) {
      const pr = await queryOne<{ status: string; sector_id: string; owner_user_id: string; role: string | null }>(
        c, 'SELECT p.status, p.sector_id, p.owner_user_id, pm.role FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2 WHERE p.id = $1',
        [projectId, p.userId]);
      if (!pr) throw new AppError('Projeto inexistente.');
      memberRole = pr.owner_user_id === p.userId ? 'GESTOR' : pr.role;
      const projectManage = p.isOwner || can(p, 'tarefas.gerenciar', { sectorId: pr.sector_id });
      if (!projectManage && memberRole !== 'GESTOR' && memberRole !== 'MEMBRO') throw new ForbiddenError('Você não participa deste projeto.');
      if (pr.status === 'CONCLUIDO' || pr.status === 'CANCELADO') throw new AppError('Projeto encerrado não recebe novas tarefas.');
      sectorId = d.sectorId ?? pr.sector_id;
      if (d.phaseId && !(await queryOne(c, 'SELECT 1 FROM project_phases WHERE id = $1 AND project_id = $2', [d.phaseId, projectId]))) {
        throw new AppError('Fase não pertence ao projeto.');
      }
    } else if (d.phaseId) {
      throw new AppError('Fase exige projeto.');
    }
    if (!sectorId) throw new AppError('Informe o setor da tarefa.');
    if (!p.isOwner && !can(p, 'tarefas.criar', { sectorId, employeeId: p.employeeId }) && memberRole === null) throw new ForbiddenError();
    // Escopo próprio: fora de projeto, tarefa só no próprio setor (a menos que tenha gestão no setor de destino).
    if (!projectId && sectorId !== p.employeeSectorId && !canAssignOthers(p, sectorId, null)) throw new ForbiddenError('Sem permissão para criar tarefas neste setor.');
    const assignee = d.assigneeUserId === undefined ? p.userId : d.assigneeUserId;
    if (assignee && assignee !== p.userId && !canAssignOthers(p, sectorId, memberRole)) {
      throw new ForbiddenError('Você só pode criar tarefas para si. A atribuição a outras pessoas cabe à coordenação ou ao gestor do projeto.');
    }
    if (assignee) await activeUser(c, assignee, 'Responsável');
    if (d.requiresApproval) {
      if (!d.approverUserId) throw new AppError('Indique quem aprova a conclusão.');
      if (d.approverUserId === assignee) throw new AppError('Quem aprova não pode ser o responsável pela tarefa.');
      await activeUser(c, d.approverUserId, 'Aprovador');
    }
    const row = await queryOne<{ id: string }>(
      c,
      `INSERT INTO tasks (project_id, phase_id, parent_task_id, title, description, priority, sector_id, assignee_user_id, start_date, due_date, due_time,
                          block_start, block_end, requires_approval, approver_user_id, created_by, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, extract(epoch from now())) RETURNING id`,
      [projectId, d.phaseId ?? null, d.parentTaskId ?? null, d.title, d.description ?? null, d.priority, sectorId, assignee, d.startDate ?? null, d.dueDate ?? null,
        d.dueTime ?? null, d.blockStart ?? null, d.blockEnd ?? null, d.requiresApproval, d.requiresApproval ? d.approverUserId : null, p.userId]);
    await event(c, ctx, row!.id, 'CRIADA', { responsavel: assignee, prioridade: d.priority });
    if (assignee && assignee !== p.userId) {
      await notifyUsers(c, [assignee], { kind: 'TAREFA_ATRIBUIDA', title: 'Nova tarefa atribuída a você', body: d.title, link: `/tarefas/${row!.id}`, priority: d.priority === 'IMEDIATA' || d.priority === 'URGENTE' ? 'ALTA' : 'NORMAL' });
    }
    return row!.id;
  });
}

// Atualização parcial: campos ausentes mantêm o valor atual (sem os padrões da criação, que reescreveriam prioridade e aprovação).
const updateSchema = taskSchema.omit({ projectId: true, parentTaskId: true }).partial().extend({
  title: z.string().trim().min(2).max(200).optional(),
  priority: z.enum(PRIORITIES).optional(),
  requiresApproval: z.boolean().optional(),
});

export async function updateTask(ctx: Ctx, id: string, input: z.input<typeof updateSchema>): Promise<void> {
  const d = updateSchema.parse(input);
  await tx(async (c) => {
    const { t, a } = await loadTask(c, ctx, id, true);
    if (!a.edit) throw new ForbiddenError();
    if (!OPEN(t.status)) throw new AppError('Tarefa encerrada: reabra antes de alterar.');
    const next = {
      title: d.title ?? t.title, description: d.description === undefined ? t.description : d.description || null,
      priority: d.priority ?? t.priority, sectorId: d.sectorId ?? t.sector_id,
      assignee: d.assigneeUserId === undefined ? t.assignee_user_id : d.assigneeUserId,
      phaseId: d.phaseId === undefined ? t.phase_id : d.phaseId,
      startDate: d.startDate === undefined ? t.start_date : d.startDate, dueDate: d.dueDate === undefined ? t.due_date : d.dueDate,
      dueTime: d.dueTime === undefined ? t.due_time : d.dueTime,
      blockStart: d.blockStart === undefined ? t.block_start : d.blockStart, blockEnd: d.blockEnd === undefined ? t.block_end : d.blockEnd,
      requiresApproval: d.requiresApproval ?? t.requires_approval,
      approver: d.approverUserId === undefined ? t.approver_user_id : d.approverUserId,
    };
    checkDates(next);
    const p = ctx.principal;
    if (next.assignee !== t.assignee_user_id && next.assignee !== p.userId && !canAssignOthers(p, next.sectorId, t.member_role)) {
      throw new ForbiddenError('A atribuição a outras pessoas cabe à coordenação ou ao gestor do projeto.');
    }
    if (next.sectorId !== t.sector_id && !canAssignOthers(p, next.sectorId, t.member_role)) throw new ForbiddenError('Sem permissão no setor de destino.');
    if (next.assignee) await activeUser(c, next.assignee, 'Responsável');
    if (!next.requiresApproval) next.approver = null;
    if (next.requiresApproval && (!next.approver || next.approver === next.assignee)) throw new AppError('Indique um aprovador diferente do responsável.');
    if (next.phaseId && !(await queryOne(c, 'SELECT 1 FROM project_phases WHERE id = $1 AND project_id = $2', [next.phaseId, t.project_id]))) throw new AppError('Fase não pertence ao projeto.');
    await query(
      c,
      `UPDATE tasks SET title=$2, description=$3, priority=$4, sector_id=$5, assignee_user_id=$6, phase_id=$7, start_date=$8, due_date=$9, due_time=$10,
              block_start=$11, block_end=$12, requires_approval=$13, approver_user_id=$14, updated_at=now() WHERE id=$1`,
      [id, next.title, next.description, next.priority, next.sectorId, next.assignee, next.phaseId, next.startDate, next.dueDate, next.dueTime,
        next.blockStart, next.blockEnd, next.requiresApproval, next.approver]);
    const changes: Record<string, unknown> = {};
    for (const [k, before, after] of [['titulo', t.title, next.title], ['prioridade', t.priority, next.priority], ['responsavel', t.assignee_user_id, next.assignee],
      ['prazo', t.due_date, next.dueDate], ['setor', t.sector_id, next.sectorId], ['aprovador', t.approver_user_id, next.approver]] as const) {
      if (before !== after) changes[k] = { de: before, para: after };
    }
    await event(c, ctx, id, 'ALTERADA', changes);
    if (next.assignee && next.assignee !== t.assignee_user_id) {
      if (next.assignee !== p.userId) await notifyUsers(c, [next.assignee], { kind: 'TAREFA_ATRIBUIDA', title: 'Tarefa atribuída a você', body: next.title, link: `/tarefas/${id}` });
      await audit(c, ctx, { action: 'TAREFA_ATRIBUIDA', entityType: 'task', entityId: id, summary: `"${next.title}" atribuída` });
    }
  });
}

// ---------------------------------------------------------------------------
// Situação, aprovação e encerramento
// ---------------------------------------------------------------------------

export async function setStatus(ctx: Ctx, id: string, status: TaskStatus, reason?: string): Promise<TaskStatus> {
  if (!STATUSES.includes(status)) throw new AppError('Situação inválida.');
  return tx(async (c) => {
    const { t, a } = await loadTask(c, ctx, id, true);
    const why = reason?.trim() ?? '';
    if (t.status === status) return status;
    if (!OPEN(t.status)) {
      // Reabertura: somente gestão.
      if (!a.manage) throw new ForbiddenError('Reabrir tarefa encerrada cabe à coordenação ou ao gestor do projeto.');
      if (status !== 'A_FAZER') throw new AppError('Tarefa encerrada só pode ser reaberta (A fazer).');
      if (why.length < 3) throw new AppError('Informe o motivo da reabertura.');
      await query(c, "UPDATE tasks SET status='A_FAZER', completed_at=NULL, completed_by=NULL, approved_by=NULL, updated_at=now() WHERE id=$1", [id]);
      await event(c, ctx, id, 'REABERTA', { motivo: why });
      await audit(c, ctx, { action: 'TAREFA_REABERTA', entityType: 'task', entityId: id, summary: `"${t.title}" reaberta: ${why}` });
      return 'A_FAZER';
    }
    if (status === 'CANCELADA') {
      if (!a.edit) throw new ForbiddenError();
      if (why.length < 3) throw new AppError('Informe o motivo do cancelamento.');
      await query(c, "UPDATE tasks SET status='CANCELADA', updated_at=now() WHERE id=$1", [id]);
      await event(c, ctx, id, 'CANCELADA', { motivo: why });
      await audit(c, ctx, { action: 'TAREFA_CANCELADA', entityType: 'task', entityId: id, summary: `"${t.title}" cancelada: ${why}` });
      return status;
    }
    if (!a.work) throw new ForbiddenError();
    if (status === 'EM_REVISAO') throw new AppError('Use "Concluir": tarefas com aprovação vão para revisão automaticamente.');
    if (status === 'BLOQUEADA' && why.length < 3) throw new AppError('Descreva o impedimento (exceção).');
    if (status === 'CONCLUIDA') {
      if (t.deps_open) throw new AppError(`Há ${t.deps_open} tarefa(s) predecessora(s) em aberto.`);
      if (t.subtasks_open) throw new AppError(`Há ${t.subtasks_open} subtarefa(s) em aberto.`);
      if (t.checklist_done < t.checklist_total) throw new AppError('Conclua todos os itens do checklist.');
      if (t.requires_approval) {
        await query(c, "UPDATE tasks SET status='EM_REVISAO', blocked_reason=NULL, completed_by=$2, updated_at=now() WHERE id=$1", [id, ctx.principal.userId]);
        await event(c, ctx, id, 'ENVIADA_REVISAO', {});
        await notifyUsers(c, [t.approver_user_id!], { kind: 'TAREFA_PARA_APROVACAO', title: 'Tarefa aguardando sua aprovação', body: t.title, link: `/tarefas/${id}` });
        return 'EM_REVISAO';
      }
      await complete(c, ctx, t, null);
      return 'CONCLUIDA';
    }
    await query(c, 'UPDATE tasks SET status=$2, blocked_reason=$3, updated_at=now() WHERE id=$1', [id, status, status === 'BLOQUEADA' ? why : null]);
    await event(c, ctx, id, 'SITUACAO', { de: t.status, para: status, motivo: why || undefined });
    if (status === 'BLOQUEADA') {
      const watchers = [t.created_by, t.project_owner].filter((u): u is string => !!u && u !== ctx.principal.userId);
      await notifyUsers(c, watchers, { kind: 'TAREFA_BLOQUEADA', title: 'Tarefa bloqueada', body: `${t.title}: ${why}`, link: `/tarefas/${id}`, priority: 'ALTA' });
    }
    return status;
  });
}

async function complete(c: Db, ctx: Ctx, t: TaskRow, approvedBy: string | null) {
  await query(
    c,
    `UPDATE tasks SET status='CONCLUIDA', blocked_reason=NULL, completed_at=now(), completed_by=coalesce(completed_by, $2), approved_by=$3, updated_at=now() WHERE id=$1`,
    [t.id, ctx.principal.userId, approvedBy]);
  await event(c, ctx, t.id, approvedBy ? 'APROVADA_CONCLUIDA' : 'CONCLUIDA', {});
  if (t.process_instance_id) await advanceProcess(c, ctx, t.process_instance_id);
}

/** Libera a próxima etapa do processo e encerra a instância quando todas as etapas estiverem concluídas ou canceladas. */
async function advanceProcess(c: Db, ctx: Ctx, instanceId: string) {
  const steps = await query<{ id: string; status: string; assignee_user_id: string | null; title: string; deps_open: number }>(
    c,
    `SELECT t.id, t.status, t.assignee_user_id, t.title,
            (SELECT count(*)::int FROM task_dependencies d JOIN tasks x ON x.id = d.depends_on_id WHERE d.task_id = t.id AND x.status NOT IN ('CONCLUIDA','CANCELADA')) AS deps_open
       FROM tasks t WHERE t.process_instance_id = $1 ORDER BY t.process_step`, [instanceId]);
  const ready = steps.find((s) => OPEN(s.status) && s.deps_open === 0);
  if (ready?.assignee_user_id) {
    await notifyUsers(c, [ready.assignee_user_id], { kind: 'PROCESSO_ETAPA', title: 'Etapa de processo liberada', body: ready.title, link: `/tarefas/${ready.id}` });
  }
  if (steps.every((s) => !OPEN(s.status))) {
    await query(c, "UPDATE process_instances SET status='ENCERRADO', closed_at=now(), closed_by=$2, close_notes='Todas as etapas concluídas.' WHERE id=$1 AND status='EM_ANDAMENTO'",
      [instanceId, ctx.principal.userId]);
    await audit(c, ctx, { action: 'PROCESSO_ENCERRADO', entityType: 'process_instance', entityId: instanceId, summary: 'Processo encerrado: todas as etapas concluídas' });
  }
}

export async function reviewTask(ctx: Ctx, id: string, approve: boolean, notes?: string): Promise<void> {
  await tx(async (c) => {
    const { t } = await loadTask(c, ctx, id, true);
    if (t.status !== 'EM_REVISAO') throw new AppError('A tarefa não está aguardando aprovação.');
    if (t.approver_user_id !== ctx.principal.userId) throw new ForbiddenError('Somente o aprovador indicado decide.');
    const doer = await queryOne<{ completed_by: string | null }>(c, 'SELECT completed_by FROM tasks WHERE id = $1', [id]);
    if (doer?.completed_by === ctx.principal.userId || t.assignee_user_id === ctx.principal.userId) {
      throw new ForbiddenError('Segregação de funções: quem executou não aprova.');
    }
    if (approve) {
      await complete(c, ctx, t, ctx.principal.userId);
      await audit(c, ctx, { action: 'TAREFA_APROVADA', entityType: 'task', entityId: id, summary: `Conclusão de "${t.title}" aprovada` });
    } else {
      if (!notes || notes.trim().length < 3) throw new AppError('Informe o que precisa ser ajustado.');
      await query(c, "UPDATE tasks SET status='EM_ANDAMENTO', completed_by=NULL, updated_at=now() WHERE id=$1", [id]);
      await query(c, 'INSERT INTO task_comments (task_id, user_id, body) VALUES ($1,$2,$3)', [id, ctx.principal.userId, `Devolvida para ajuste: ${notes.trim()}`]);
      await event(c, ctx, id, 'DEVOLVIDA', { motivo: notes.trim() });
    }
    const target = t.assignee_user_id ?? t.created_by;
    await notifyUsers(c, [target], { kind: approve ? 'TAREFA_APROVADA' : 'TAREFA_DEVOLVIDA', title: approve ? 'Tarefa aprovada' : 'Tarefa devolvida para ajuste', body: t.title, link: `/tarefas/${id}` });
  });
}

// ---------------------------------------------------------------------------
// Escalonamento (matriz: ordinárias → Substituta Legal; complexas → Oficial)
// ---------------------------------------------------------------------------

async function escalationTarget(c: Db, level: 'SUBSTITUTA' | 'OFICIAL'): Promise<string> {
  const r = level === 'OFICIAL'
    ? await queryOne<{ id: string }>(c, "SELECT id FROM users WHERE is_owner AND status = 'ATIVO' LIMIT 1")
    : await queryOne<{ id: string }>(
        c,
        `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
          WHERE r.code = 'SUBSTITUTA_LEGAL' AND u.status = 'ATIVO' AND ur.revoked_at IS NULL AND ur.valid_from <= current_date
            AND (ur.valid_until IS NULL OR ur.valid_until >= current_date)
          ORDER BY ur.valid_from DESC LIMIT 1`);
  if (!r) throw new AppError(level === 'OFICIAL' ? 'Oficial não cadastrada.' : 'Não há Substituta Legal vigente. Encaminhe à Oficial.');
  return r.id;
}

export async function escalate(ctx: Ctx, id: string, level: 'SUBSTITUTA' | 'OFICIAL', reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new AppError('Descreva a questão a ser decidida.');
  await tx(async (c) => {
    const { t, a } = await loadTask(c, ctx, id, true);
    if (!a.work) throw new ForbiddenError();
    if (!OPEN(t.status)) throw new AppError('Tarefa encerrada.');
    const to = await escalationTarget(c, level);
    if (to === ctx.principal.userId) throw new AppError('Você é o destino deste encaminhamento.');
    await query(c, 'UPDATE tasks SET escalation_level=$2, escalated_to_user_id=$3, escalation_reason=$4, updated_at=now() WHERE id=$1', [id, level, to, reason.trim()]);
    await event(c, ctx, id, 'ENCAMINHADA', { nivel: level, para: to, motivo: reason.trim() });
    await audit(c, ctx, { action: 'TAREFA_ENCAMINHADA', entityType: 'task', entityId: id, summary: `"${t.title}" encaminhada à ${level === 'OFICIAL' ? 'Oficial' : 'Substituta Legal'}` });
    await notifyUsers(c, [to], { kind: 'TAREFA_ENCAMINHADA', title: 'Questão encaminhada para decisão', body: `${t.title}: ${reason.trim()}`, link: `/tarefas/${id}`, priority: 'ALTA' });
  });
}

export async function resolveEscalation(ctx: Ctx, id: string, decision: string): Promise<void> {
  if (decision.trim().length < 3) throw new AppError('Registre a orientação/decisão.');
  await tx(async (c) => {
    const { t } = await loadTask(c, ctx, id, true);
    if (t.escalated_to_user_id !== ctx.principal.userId) throw new ForbiddenError('Somente o destinatário do encaminhamento registra a decisão.');
    await query(c, "UPDATE tasks SET escalation_level='NENHUM', escalated_to_user_id=NULL, escalation_reason=NULL, updated_at=now() WHERE id=$1", [id]);
    await query(c, 'INSERT INTO task_comments (task_id, user_id, body) VALUES ($1,$2,$3)', [id, ctx.principal.userId, `Decisão sobre o encaminhamento: ${decision.trim()}`]);
    await event(c, ctx, id, 'ENCAMINHAMENTO_DECIDIDO', { decisao: decision.trim() });
    await notifyUsers(c, [t.assignee_user_id ?? t.created_by], { kind: 'TAREFA_DECISAO', title: 'Encaminhamento decidido', body: t.title, link: `/tarefas/${id}` });
  });
}

// ---------------------------------------------------------------------------
// Dependências, checklist, comentários e anexos
// ---------------------------------------------------------------------------

export async function addDependency(ctx: Ctx, id: string, dependsOnId: string): Promise<void> {
  await tx(async (c) => {
    await query(c, "SELECT pg_advisory_xact_lock(hashtext('task-deps'))");
    const { a } = await loadTask(c, ctx, id, true);
    if (!a.edit) throw new ForbiddenError();
    await loadTask(c, ctx, dependsOnId);
    const edges = await query<{ task_id: string; depends_on_id: string }>(c, 'SELECT task_id, depends_on_id FROM task_dependencies');
    if (createsCycle(edges, id, dependsOnId)) throw new AppError('Dependência circular: a tarefa escolhida já depende desta.');
    await query(c, 'INSERT INTO task_dependencies (task_id, depends_on_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, dependsOnId]);
    await event(c, ctx, id, 'DEPENDENCIA', { predecessora: dependsOnId });
  });
}

export async function removeDependency(ctx: Ctx, id: string, dependsOnId: string): Promise<void> {
  await tx(async (c) => {
    const { t, a } = await loadTask(c, ctx, id, true);
    if (!a.edit) throw new ForbiddenError();
    if (t.process_instance_id) throw new AppError('A ordem das etapas de processo é definida pelo modelo.');
    await query(c, 'DELETE FROM task_dependencies WHERE task_id = $1 AND depends_on_id = $2', [id, dependsOnId]);
    await event(c, ctx, id, 'DEPENDENCIA_REMOVIDA', { predecessora: dependsOnId });
  });
}

export async function addChecklistItem(ctx: Ctx, id: string, title: string): Promise<void> {
  const t = z.string().trim().min(1).max(300).parse(title);
  await tx(async (c) => {
    const { t: task, a } = await loadTask(c, ctx, id, true);
    if (!a.work) throw new ForbiddenError();
    if (!OPEN(task.status)) throw new AppError('Tarefa encerrada.');
    await query(c, 'INSERT INTO task_checklist_items (task_id, position, title) VALUES ($1, (SELECT coalesce(max(position),0)+1 FROM task_checklist_items WHERE task_id=$1), $2)', [id, t]);
  });
}

export async function toggleChecklistItem(ctx: Ctx, itemId: string, done: boolean): Promise<void> {
  z.uuid().parse(itemId);
  await tx(async (c) => {
    const it = await queryOne<{ task_id: string; title: string }>(c, 'SELECT task_id, title FROM task_checklist_items WHERE id = $1', [itemId]);
    if (!it) throw new NotFoundError('Item não encontrado.');
    const { t, a } = await loadTask(c, ctx, it.task_id, true);
    if (!a.work) throw new ForbiddenError();
    if (!OPEN(t.status)) throw new AppError('Tarefa encerrada.');
    await query(c, 'UPDATE task_checklist_items SET done_at = CASE WHEN $2 THEN now() END, done_by = CASE WHEN $2 THEN $3::uuid END WHERE id = $1', [itemId, done, ctx.principal.userId]);
    await event(c, ctx, it.task_id, done ? 'ITEM_CONCLUIDO' : 'ITEM_REABERTO', { item: it.title });
  });
}

export async function addComment(ctx: Ctx, id: string, body: string): Promise<void> {
  const b = z.string().trim().min(1).max(5000).parse(body);
  await tx(async (c) => {
    const { t, a } = await loadTask(c, ctx, id);
    if (!a.comment) throw new ForbiddenError();
    await query(c, 'INSERT INTO task_comments (task_id, user_id, body) VALUES ($1,$2,$3)', [id, ctx.principal.userId, b]);
    const others = [t.assignee_user_id, t.created_by, t.approver_user_id, t.escalated_to_user_id].filter((u): u is string => !!u && u !== ctx.principal.userId);
    await notifyUsers(c, others, { kind: 'TAREFA_COMENTARIO', title: 'Novo comentário em tarefa', body: t.title, link: `/tarefas/${id}`, priority: 'BAIXA' });
  });
}

export async function addAttachment(ctx: Ctx, id: string, file: { name: string; bytes: Uint8Array }): Promise<string> {
  const checked = checkFile(file.name, file.bytes, await maxFileBytes());
  const pre = await loadTask(getPool(), ctx, id);
  if (!pre.a.work) throw new ForbiddenError();
  const prepared: PreparedFile = await prepareFile(ctx, checked, file.bytes);
  return tx(async (c) => {
    const { t, a } = await loadTask(c, ctx, id, true);
    if (!a.work) throw new ForbiddenError();
    if (!OPEN(t.status)) throw new AppError('Tarefa encerrada.');
    const fileId = await insertStoredFile(c, ctx, prepared);
    await query(c, 'INSERT INTO task_attachments (task_id, file_id, added_by) VALUES ($1,$2,$3)', [id, fileId, ctx.principal.userId]);
    await event(c, ctx, id, 'ANEXO', { nome: checked.filename, bytes: checked.size, antivirus: prepared.scan.status });
    return fileId;
  }).catch(async (err) => {
    await discardUnsaved(prepared);
    throw err;
  });
}

export async function attachmentForDownload(ctx: Ctx, taskId: string, fileId: string) {
  const db = getPool();
  await loadTask(db, ctx, taskId);
  z.uuid().parse(fileId);
  if (!(await queryOne(db, 'SELECT 1 FROM task_attachments WHERE task_id = $1 AND file_id = $2', [taskId, fileId]))) throw new NotFoundError('Arquivo não encontrado.');
  const f = (await loadStoredFile(db, fileId))!;
  const bytes = await readStoredFile(f);
  if (!bytes) throw new AppError('Conteúdo descartado.', 410, 'DESCARTADO');
  await rescan(ctx, f, bytes, 'download', false);
  await audit(db, ctx, { action: 'TAREFA_ANEXO_DOWNLOAD', entityType: 'task', entityId: taskId, summary: `Download de "${f.filename}"` });
  return { filename: f.filename, mime_type: f.mime_type, sha256: f.sha256, data: Buffer.from(bytes) };
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

export type TaskFilter = {
  scope?: 'minhas' | 'visiveis'; projectId?: string; status?: TaskStatus | 'ABERTAS' | 'TODAS'; assigneeUserId?: string; sectorId?: string;
  q?: string; dueFrom?: string; dueTo?: string; limit?: number;
};

export async function listTasks(ctx: Ctx, f: TaskFilter = {}) {
  const params: unknown[] = [ctx.principal.userId];
  const where: string[] = ['TRUE'];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (f.scope === 'minhas') where.push('(t.assignee_user_id = $1 OR t.escalated_to_user_id = $1 OR (t.approver_user_id = $1 AND t.status = \'EM_REVISAO\'))');
  if (f.projectId && z.uuid().safeParse(f.projectId).success) add('t.project_id = ?', f.projectId);
  if (f.assigneeUserId && z.uuid().safeParse(f.assigneeUserId).success) add('t.assignee_user_id = ?', f.assigneeUserId);
  if (f.sectorId && z.uuid().safeParse(f.sectorId).success) add('t.sector_id = ?', f.sectorId);
  if (!f.status || f.status === 'ABERTAS') where.push("t.status NOT IN ('CONCLUIDA','CANCELADA')");
  else if (f.status !== 'TODAS' && STATUSES.includes(f.status)) add('t.status = ?', f.status);
  if (f.q?.trim()) {
    params.push(`%${f.q.trim().slice(0, 100).replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where.push(`(t.title ILIKE $${params.length} OR coalesce(t.description, '') ILIKE $${params.length})`);
  }
  if (f.dueFrom) add('t.due_date >= ?', z.iso.date().parse(f.dueFrom));
  if (f.dueTo) add('t.due_date <= ?', z.iso.date().parse(f.dueTo));
  const rows = await query<TaskRow>(
    getPool(),
    `${TASK_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY CASE t.priority WHEN 'IMEDIATA' THEN 0 WHEN 'URGENTE' THEN 1 WHEN 'ALTA' THEN 2 WHEN 'MEDIA' THEN 3 ELSE 4 END,
               t.due_date NULLS LAST, t.due_time NULLS LAST, t.position LIMIT ${Math.min(f.limit ?? 500, 2000)}`,
    params);
  return rows.filter((t) => taskAccess(ctx.principal, t).read);
}

export async function getTask(ctx: Ctx, id: string) {
  const db = getPool();
  const { t, a } = await loadTask(db, ctx, id);
  const [checklist, comments, attachments, deps, dependents, subtasks, events] = await Promise.all([
    query<{ id: string; title: string; done_at: Date | null; done_by_name: string | null }>(db,
      'SELECT i.id, i.title, i.done_at, u.display_name AS done_by_name FROM task_checklist_items i LEFT JOIN users u ON u.id = i.done_by WHERE i.task_id = $1 ORDER BY i.position', [id]),
    query<{ id: string; body: string; created_at: Date; user_name: string }>(db,
      'SELECT c.id, c.body, c.created_at, u.display_name AS user_name FROM task_comments c JOIN users u ON u.id = c.user_id WHERE c.task_id = $1 ORDER BY c.created_at', [id]),
    query<{ file_id: string; filename: string; size_bytes: number; scan_status: string; added_at: Date; added_by_name: string }>(db,
      `SELECT a.file_id, f.filename, f.size_bytes, f.scan_status, a.added_at, u.display_name AS added_by_name
         FROM task_attachments a JOIN document_files f ON f.id = a.file_id JOIN users u ON u.id = a.added_by WHERE a.task_id = $1 ORDER BY a.added_at`, [id]),
    query<{ id: string; title: string; status: TaskStatus }>(db,
      'SELECT x.id, x.title, x.status FROM task_dependencies d JOIN tasks x ON x.id = d.depends_on_id WHERE d.task_id = $1', [id]),
    query<{ id: string; title: string; status: TaskStatus }>(db,
      'SELECT x.id, x.title, x.status FROM task_dependencies d JOIN tasks x ON x.id = d.task_id WHERE d.depends_on_id = $1', [id]),
    query<{ id: string; title: string; status: TaskStatus; assignee_name: string | null }>(db,
      'SELECT x.id, x.title, x.status, u.display_name AS assignee_name FROM tasks x LEFT JOIN users u ON u.id = x.assignee_user_id WHERE x.parent_task_id = $1 ORDER BY x.created_at', [id]),
    query<{ id: string; event: string; details: Record<string, unknown>; created_at: Date; user_name: string | null }>(db,
      'SELECT e.id, e.event, e.details, e.created_at, u.display_name AS user_name FROM task_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.task_id = $1 ORDER BY e.created_at DESC LIMIT 100', [id]),
  ]);
  const completedBy = await queryOne<{ completed_by: string | null }>(db, 'SELECT completed_by FROM tasks WHERE id = $1', [id]);
  const canReview = t.status === 'EM_REVISAO' && t.approver_user_id === ctx.principal.userId
    && completedBy?.completed_by !== ctx.principal.userId && t.assignee_user_id !== ctx.principal.userId;
  return { task: t, access: a, checklist, comments, attachments, deps, dependents, subtasks, events, canReview };
}

/** Indicadores das tarefas visíveis ao usuário (painel de tarefas). */
export async function taskDashboard(ctx: Ctx, f: Pick<TaskFilter, 'projectId' | 'sectorId'> = {}) {
  const rows = await listTasks(ctx, { ...f, status: 'TODAS', scope: 'visiveis', limit: 2000 });
  const today = todayLocal();
  const open = rows.filter((t) => OPEN(t.status));
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, rows.filter((t) => t.status === s).length])) as Record<TaskStatus, number>;
  const byAssignee = new Map<string, { name: string; open: number; overdue: number }>();
  for (const t of open) {
    const k = t.assignee_name ?? 'Sem responsável';
    const e = byAssignee.get(k) ?? { name: k, open: 0, overdue: 0 };
    e.open++;
    if (t.due_date && t.due_date < today) e.overdue++;
    byAssignee.set(k, e);
  }
  const done30 = rows.filter((t) => t.status === 'CONCLUIDA' && t.completed_at && t.completed_at.getTime() > Date.now() - 30 * 86400000);
  const onTime = done30.filter((t) => !t.due_date || t.completed_at!.toISOString().slice(0, 10) <= t.due_date).length;
  return {
    byStatus,
    open: open.length,
    overdue: open.filter((t) => t.due_date && t.due_date < today).length,
    dueToday: open.filter((t) => t.due_date === today).length,
    immediate: open.filter((t) => t.priority === 'IMEDIATA').length,
    escalated: open.filter((t) => t.escalation_level !== 'NENHUM').length,
    byAssignee: [...byAssignee.values()].sort((a, b) => b.open - a.open),
    completed30: done30.length,
    onTimePct: done30.length ? Math.round((onTime / done30.length) * 100) : null,
  };
}

/** Rotina: avisa o responsável de tarefas com prazo hoje/amanhã ou vencidas (uma vez por prazo). */
export async function processTaskReminders(db: Db = getPool()): Promise<number> {
  const days = await getNumberSetting(db, 'tarefas.aviso_prazo_dias', 1);
  const rows = await query<{ id: string; title: string; assignee_user_id: string; due_date: string }>(
    db,
    `SELECT t.id, t.title, t.assignee_user_id, t.due_date FROM tasks t
      WHERE t.status NOT IN ('CONCLUIDA','CANCELADA') AND t.assignee_user_id IS NOT NULL AND t.due_date <= $1
        AND NOT EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = t.id AND e.event = 'AVISO_PRAZO' AND e.details->>'prazo' = t.due_date::text)`,
    [addDays(todayLocal(), days)]);
  for (const r of rows) {
    await tx(async (c) => {
      await query(c, "INSERT INTO task_events (task_id, user_id, event, details) VALUES ($1, NULL, 'AVISO_PRAZO', $2)", [r.id, JSON.stringify({ prazo: r.due_date })]);
      const late = r.due_date < todayLocal();
      await notifyUsers(c, [r.assignee_user_id], { kind: 'TAREFA_PRAZO', title: late ? 'Tarefa com prazo vencido' : 'Prazo de tarefa próximo', body: `${r.title} — ${r.due_date}`, link: `/tarefas/${r.id}`, priority: late ? 'ALTA' : 'NORMAL' });
    });
  }
  return rows.length;
}
