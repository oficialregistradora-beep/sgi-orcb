import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx, Principal } from '../context.ts';
import { can } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors.ts';
import { todayLocal } from '../../domain/time.ts';
import { notifyUsers } from './notifications.ts';

// Projetos (Fase 4a): fases, marcos, custos, indicadores e membros. Tarefas do projeto ficam em tasks.ts.

export const PROJECT_STATUSES = ['PLANEJADO', 'EM_ANDAMENTO', 'PAUSADO', 'CONCLUIDO', 'CANCELADO'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Sugestões de projetos iniciais (§14), oferecidas na criação — não são criados automaticamente. */
export const PROJECT_SUGGESTIONS = [
  'Implantação dos POPs', 'Política de Integridade', 'Segurança da Informação', 'Implantação de normas do CNJ', 'Preparação para o PQTA 2027',
  'Gestão de qualidade', 'Treinamento da equipe', 'Auditoria documental', 'Revisão de procedimentos', 'Digitalização administrativa',
];

export type ProjectRow = {
  id: string; code: string | null; name: string; description: string | null; status: ProjectStatus; owner_user_id: string; owner_name: string;
  sector_id: string; sector_name: string; start_date: string | null; due_date: string | null; estimated_cost: string | null; actual_cost: string;
  created_at: Date; closed_at: Date | null; member_role: 'GESTOR' | 'MEMBRO' | 'LEITOR' | null;
  tasks_total: number; tasks_done: number; tasks_overdue: number;
};

const PROJECT_SELECT = `
  SELECT p.id, p.code, p.name, p.description, p.status, p.owner_user_id, u.display_name AS owner_name, p.sector_id, s.name AS sector_name,
         p.start_date, p.due_date, p.estimated_cost::text, (coalesce((SELECT sum(amount) FROM project_costs c WHERE c.project_id = p.id), 0)
          + coalesce((SELECT sum(x.amount) FROM expenses x WHERE x.project_id = p.id AND x.status = 'PAGA'), 0))::text AS actual_cost,
         p.created_at, p.closed_at, CASE WHEN p.owner_user_id = $1 THEN 'GESTOR' ELSE pm.role END AS member_role,
         (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status <> 'CANCELADA') AS tasks_total,
         (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status = 'CONCLUIDA') AS tasks_done,
         (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('CONCLUIDA','CANCELADA') AND t.due_date < current_date) AS tasks_overdue
    FROM projects p JOIN users u ON u.id = p.owner_user_id JOIN sectors s ON s.id = p.sector_id
    LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1`;

export type ProjectAccess = { read: boolean; manage: boolean; contribute: boolean };

export function projectAccess(p: Principal, pr: Pick<ProjectRow, 'sector_id' | 'member_role'>): ProjectAccess {
  const manage = p.isOwner || pr.member_role === 'GESTOR' || can(p, 'projetos.gerenciar', { sectorId: pr.sector_id });
  return {
    manage,
    contribute: manage || pr.member_role === 'MEMBRO',
    read: manage || pr.member_role !== null || can(p, 'tarefas.ver', { sectorId: pr.sector_id }),
  };
}

async function loadProject(db: Db, ctx: Ctx, id: string, lock = false) {
  z.uuid().parse(id);
  if (lock) await query(db, 'SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [id]);
  const pr = await queryOne<ProjectRow>(db, `${PROJECT_SELECT} WHERE p.id = $2`, [ctx.principal.userId, id]);
  if (!pr) throw new NotFoundError('Projeto não encontrado.');
  const a = projectAccess(ctx.principal, pr);
  if (!a.read) throw new NotFoundError('Projeto não encontrado.');
  return { pr, a };
}

const projectSchema = z.object({
  name: z.string().trim().min(3).max(160),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._-]{1,29}$/, 'Código inválido (ex.: PQTA-2027).').optional(),
  description: z.string().trim().max(5000).optional(),
  sectorId: z.uuid(),
  ownerUserId: z.uuid().optional(),
  startDate: z.iso.date().nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
  estimatedCost: z.number().min(0).max(1e11).nullable().optional(),
});

function mapCode(e: { code?: string }): never {
  if (e.code === '23505') throw new ConflictError('Já existe projeto com este código.');
  throw e;
}

export async function createProject(ctx: Ctx, input: z.input<typeof projectSchema>): Promise<string> {
  const d = projectSchema.parse(input);
  if (!ctx.principal.isOwner && !can(ctx.principal, 'projetos.gerenciar', { sectorId: d.sectorId })) throw new ForbiddenError();
  if (d.startDate && d.dueDate && d.dueDate < d.startDate) throw new AppError('A data final não pode ser anterior ao início.');
  return tx(async (c) => {
    const owner = d.ownerUserId ?? ctx.principal.userId;
    if (!(await queryOne(c, "SELECT 1 FROM users WHERE id = $1 AND status = 'ATIVO'", [owner]))) throw new AppError('Gestor do projeto inexistente ou inativo.');
    const r = await queryOne<{ id: string }>(
      c,
      `INSERT INTO projects (code, name, description, sector_id, owner_user_id, start_date, due_date, estimated_cost, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [d.code ?? null, d.name, d.description ?? null, d.sectorId, owner, d.startDate ?? null, d.dueDate ?? null, d.estimatedCost ?? null, ctx.principal.userId],
    ).catch(mapCode);
    await query(c, "INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,'GESTOR')", [r!.id, owner]);
    await audit(c, ctx, { action: 'PROJETO_CRIADO', entityType: 'project', entityId: r!.id, summary: `Projeto "${d.name}" criado` });
    if (owner !== ctx.principal.userId) await notifyUsers(c, [owner], { kind: 'PROJETO_GESTOR', title: 'Você é gestor(a) de um projeto', body: d.name, link: `/projetos/${r!.id}` });
    return r!.id;
  });
}

export async function updateProject(ctx: Ctx, id: string, input: z.input<typeof projectSchema> & { status?: ProjectStatus; reason?: string }): Promise<void> {
  const d = projectSchema.parse(input);
  const status = input.status ? z.enum(PROJECT_STATUSES).parse(input.status) : undefined;
  await tx(async (c) => {
    const { pr, a } = await loadProject(c, ctx, id, true);
    if (!a.manage) throw new ForbiddenError();
    if (pr.closed_at && status !== 'EM_ANDAMENTO') throw new AppError('Projeto encerrado: reabra-o (Em andamento) para alterar.');
    if (d.sectorId !== pr.sector_id && !ctx.principal.isOwner && !can(ctx.principal, 'projetos.gerenciar', { sectorId: d.sectorId })) throw new ForbiddenError('Sem permissão no setor de destino.');
    if (d.startDate && d.dueDate && d.dueDate < d.startDate) throw new AppError('A data final não pode ser anterior ao início.');
    const next = status ?? pr.status;
    if (next === 'CONCLUIDO' && pr.status !== 'CONCLUIDO') {
      const open = (await queryOne<{ n: number }>(c, "SELECT count(*)::int AS n FROM tasks WHERE project_id = $1 AND status NOT IN ('CONCLUIDA','CANCELADA')", [id]))!.n;
      if (open) throw new AppError(`Há ${open} tarefa(s) em aberto. Conclua ou cancele antes de encerrar o projeto.`);
    }
    if ((next === 'CANCELADO' || (pr.closed_at && next === 'EM_ANDAMENTO')) && next !== pr.status && (input.reason ?? '').trim().length < 3) {
      throw new AppError('Informe o motivo.');
    }
    const owner = d.ownerUserId ?? pr.owner_user_id;
    if (owner !== pr.owner_user_id) {
      if (!(await queryOne(c, "SELECT 1 FROM users WHERE id = $1 AND status = 'ATIVO'", [owner]))) throw new AppError('Gestor inexistente ou inativo.');
      await query(c, "INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,'GESTOR') ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'GESTOR'", [id, owner]);
    }
    await query(
      c,
      `UPDATE projects SET code=$2, name=$3, description=$4, sector_id=$5, owner_user_id=$6, start_date=$7, due_date=$8, estimated_cost=$9, status=$10,
              closed_at = CASE WHEN $10 IN ('CONCLUIDO','CANCELADO') THEN coalesce(closed_at, now()) ELSE NULL END, updated_at=now() WHERE id=$1`,
      [id, d.code ?? null, d.name, d.description ?? null, d.sectorId, owner, d.startDate ?? null, d.dueDate ?? null, d.estimatedCost ?? null, next],
    ).catch(mapCode);
    if (next !== pr.status) {
      await audit(c, ctx, { action: 'PROJETO_SITUACAO', entityType: 'project', entityId: id, summary: `Projeto "${d.name}": ${pr.status} → ${next}${input.reason ? ` (${input.reason.trim()})` : ''}` });
    }
  });
}

export async function setMember(ctx: Ctx, projectId: string, userId: string, role: 'GESTOR' | 'MEMBRO' | 'LEITOR' | null): Promise<void> {
  await tx(async (c) => {
    const { pr, a } = await loadProject(c, ctx, projectId, true);
    if (!a.manage) throw new ForbiddenError();
    z.uuid().parse(userId);
    if (userId === pr.owner_user_id && role !== 'GESTOR') throw new AppError('O gestor principal não pode ser removido; troque o gestor antes.');
    if (role === null) {
      await query(c, 'DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
    } else {
      if (!(await queryOne(c, "SELECT 1 FROM users WHERE id = $1 AND status = 'ATIVO'", [userId]))) throw new AppError('Usuário inexistente ou inativo.');
      await query(c, 'INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role', [projectId, userId, role]);
      await notifyUsers(c, [userId].filter((u) => u !== ctx.principal.userId), { kind: 'PROJETO_MEMBRO', title: 'Você foi incluído(a) em um projeto', body: pr.name, link: `/projetos/${projectId}` });
    }
    await audit(c, ctx, { action: 'PROJETO_MEMBRO', entityType: 'project', entityId: projectId, summary: `Membro ${role ? `definido como ${role}` : 'removido'} em "${pr.name}"`, data: { userId } });
  });
}

export async function addPhase(ctx: Ctx, projectId: string, input: { name: string; startDate?: string | null; dueDate?: string | null }): Promise<string> {
  const d = z.object({ name: z.string().trim().min(2).max(120), startDate: z.iso.date().nullable().optional(), dueDate: z.iso.date().nullable().optional() }).parse(input);
  if (d.startDate && d.dueDate && d.dueDate < d.startDate) throw new AppError('A data final não pode ser anterior ao início.');
  return tx(async (c) => {
    const { a } = await loadProject(c, ctx, projectId, true);
    if (!a.manage) throw new ForbiddenError();
    return (await queryOne<{ id: string }>(c, `INSERT INTO project_phases (project_id, name, position, start_date, due_date)
      VALUES ($1,$2,(SELECT coalesce(max(position),0)+1 FROM project_phases WHERE project_id=$1),$3,$4) RETURNING id`, [projectId, d.name, d.startDate ?? null, d.dueDate ?? null]))!.id;
  });
}

export async function addMilestone(ctx: Ctx, projectId: string, input: { title: string; dueDate: string }): Promise<string> {
  const d = z.object({ title: z.string().trim().min(2).max(160), dueDate: z.iso.date() }).parse(input);
  return tx(async (c) => {
    const { a } = await loadProject(c, ctx, projectId, true);
    if (!a.manage) throw new ForbiddenError();
    return (await queryOne<{ id: string }>(c, 'INSERT INTO project_milestones (project_id, title, due_date) VALUES ($1,$2,$3) RETURNING id', [projectId, d.title, d.dueDate]))!.id;
  });
}

export async function toggleMilestone(ctx: Ctx, milestoneId: string, done: boolean): Promise<void> {
  z.uuid().parse(milestoneId);
  await tx(async (c) => {
    const m = await queryOne<{ project_id: string; title: string }>(c, 'SELECT project_id, title FROM project_milestones WHERE id = $1', [milestoneId]);
    if (!m) throw new NotFoundError('Marco não encontrado.');
    const { a } = await loadProject(c, ctx, m.project_id, true);
    if (!a.manage) throw new ForbiddenError();
    await query(c, 'UPDATE project_milestones SET done_at = CASE WHEN $2 THEN now() END, done_by = CASE WHEN $2 THEN $3::uuid END WHERE id = $1', [milestoneId, done, ctx.principal.userId]);
    await audit(c, ctx, { action: done ? 'MARCO_ATINGIDO' : 'MARCO_REABERTO', entityType: 'project', entityId: m.project_id, summary: `Marco "${m.title}"` });
  });
}

export async function addCost(ctx: Ctx, projectId: string, input: { description: string; amount: number; spentOn: string }): Promise<void> {
  const d = z.object({ description: z.string().trim().min(3).max(300), amount: z.number().positive().max(1e11), spentOn: z.iso.date() }).parse(input);
  if (d.spentOn > todayLocal()) throw new AppError('Custo realizado não pode ter data futura.');
  await tx(async (c) => {
    const { pr, a } = await loadProject(c, ctx, projectId, true);
    if (!a.manage) throw new ForbiddenError();
    await query(c, 'INSERT INTO project_costs (project_id, description, amount, spent_on, created_by) VALUES ($1,$2,$3,$4,$5)',
      [projectId, d.description, d.amount.toFixed(2), d.spentOn, ctx.principal.userId]);
    await audit(c, ctx, { action: 'PROJETO_CUSTO', entityType: 'project', entityId: projectId, summary: `Custo de R$ ${d.amount.toFixed(2)} em "${pr.name}": ${d.description}` });
  });
}

export async function saveIndicator(ctx: Ctx, projectId: string, input: { id?: string; name: string; unit?: string; target: number; current: number }): Promise<void> {
  const d = z.object({ id: z.uuid().optional(), name: z.string().trim().min(2).max(120), unit: z.string().trim().max(20).optional(), target: z.number(), current: z.number() }).parse(input);
  await tx(async (c) => {
    const { a } = await loadProject(c, ctx, projectId, true);
    if (!a.contribute) throw new ForbiddenError();
    if (d.id) {
      const r = await query(c, 'UPDATE project_indicators SET name=$3, unit=$4, target=$5, current=$6, updated_at=now() WHERE id=$1 AND project_id=$2 RETURNING id',
        [d.id, projectId, d.name, d.unit ?? null, d.target, d.current]);
      if (!r.length) throw new NotFoundError('Indicador não encontrado.');
    } else {
      if (!a.manage) throw new ForbiddenError();
      await query(c, 'INSERT INTO project_indicators (project_id, name, unit, target, current) VALUES ($1,$2,$3,$4,$5)', [projectId, d.name, d.unit ?? null, d.target, d.current]);
    }
  });
}

export async function listProjects(ctx: Ctx, opts: { includeClosed?: boolean } = {}) {
  const rows = await query<ProjectRow>(getPool(), `${PROJECT_SELECT} ${opts.includeClosed ? '' : 'WHERE p.closed_at IS NULL'} ORDER BY p.due_date NULLS LAST, p.name`, [ctx.principal.userId]);
  return rows.map((r) => ({ ...r, access: projectAccess(ctx.principal, r) })).filter((r) => r.access.read);
}

export async function getProject(ctx: Ctx, id: string) {
  const db = getPool();
  const { pr, a } = await loadProject(db, ctx, id);
  const [members, phases, milestones, costs, indicators] = await Promise.all([
    query<{ user_id: string; display_name: string; role: string }>(db,
      'SELECT m.user_id, u.display_name, m.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 ORDER BY m.role, u.display_name', [id]),
    query<{ id: string; name: string; position: number; start_date: string | null; due_date: string | null }>(db,
      'SELECT id, name, position, start_date, due_date FROM project_phases WHERE project_id = $1 ORDER BY position', [id]),
    query<{ id: string; title: string; due_date: string; done_at: Date | null }>(db,
      'SELECT id, title, due_date, done_at FROM project_milestones WHERE project_id = $1 ORDER BY due_date', [id]),
    query<{ id: string; description: string; amount: string; spent_on: string; created_by_name: string }>(db,
      'SELECT c.id, c.description, c.amount::text, c.spent_on, u.display_name AS created_by_name FROM project_costs c JOIN users u ON u.id = c.created_by WHERE c.project_id = $1 ORDER BY c.spent_on DESC', [id]),
    query<{ id: string; name: string; unit: string | null; target: string; current: string }>(db,
      'SELECT id, name, unit, target::text, current::text FROM project_indicators WHERE project_id = $1 ORDER BY name', [id]),
  ]);
  return { project: pr, access: a, members, phases, milestones, costs, indicators };
}
