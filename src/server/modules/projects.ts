import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx, Principal } from '../context.ts';
import { can, requireStepUp } from '../authz.ts';
import { checkFile } from '../files.ts';
import { discardUnsaved, insertStoredFile, loadStoredFile, prepareFile, readStoredFile, rescan, type PreparedFile } from './fileStore.ts';
import { accessFor, freezeDraft, insertDocument, loadDoc, maxFileBytes, normalizeMeta, startReview, workflowStage, type MetaInput } from './repository.ts';
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
  tasks_total: number; tasks_done: number; tasks_overdue: number; has_task: boolean;
  created_by: string; approved_at: Date | null; approved_by_name: string | null; approval_notes: string | null;
};

const PROJECT_SELECT = `
  SELECT p.id, p.code, p.name, p.description, p.status, p.owner_user_id, u.display_name AS owner_name, p.sector_id, s.name AS sector_name,
         p.start_date, p.due_date, p.estimated_cost::text, (coalesce((SELECT sum(amount) FROM project_costs c WHERE c.project_id = p.id), 0)
          + coalesce((SELECT sum(x.amount) FROM expenses x WHERE x.project_id = p.id AND x.status = 'PAGA'), 0))::text AS actual_cost,
         p.created_at, p.closed_at, CASE WHEN p.owner_user_id = $1 THEN 'GESTOR' ELSE pm.role END AS member_role,
         (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status <> 'CANCELADA') AS tasks_total,
         (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status = 'CONCLUIDA') AS tasks_done,
         (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('CONCLUIDA','CANCELADA') AND t.due_date < current_date) AS tasks_overdue,
         EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = p.id AND t.assignee_user_id = $1 AND t.status <> 'CANCELADA') AS has_task,
         p.created_by, p.approved_at, au.display_name AS approved_by_name, p.approval_notes
    FROM projects p JOIN users u ON u.id = p.owner_user_id JOIN sectors s ON s.id = p.sector_id LEFT JOIN users au ON au.id = p.approved_by
    LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1`;

export type ProjectAccess = { read: boolean; manage: boolean; contribute: boolean; docs: boolean; attach: boolean; approve: boolean };

export function projectAccess(p: Principal, pr: Pick<ProjectRow, 'sector_id' | 'member_role'> & Partial<Pick<ProjectRow, 'has_task'>>): ProjectAccess {
  const manage = p.isOwner || pr.member_role === 'GESTOR' || can(p, 'projetos.gerenciar', { sectorId: pr.sector_id });
  const hasTask = !!pr.has_task;
  // Anexar: próprio = projetos em que tem tarefa (ou é gestor/a); setor = projetos do setor; todos.
  const g = p.grants.get('projetos.anexar');
  const attach = p.isOwner || (!!g && (g.scope === 'TODOS' || (g.scope === 'SETOR' && g.sectorIds.has(pr.sector_id)) || hasTask || pr.member_role === 'GESTOR'));
  // Aba Documentos: gestor(a), pessoas com tarefa no projeto e a Oficial (e quem gere o setor).
  const docs = manage || hasTask || attach;
  return {
    manage,
    contribute: manage || pr.member_role === 'MEMBRO',
    read: manage || pr.member_role !== null || hasTask || can(p, 'tarefas.ver', { sectorId: pr.sector_id }),
    docs, attach, approve: can(p, 'projetos.aprovar'),
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
  ownerUserId: z.uuid({ error: 'Escolha o(a) gestor(a).' }).optional(),
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
      `INSERT INTO projects (code, name, description, sector_id, owner_user_id, start_date, due_date, estimated_cost, created_by, owner_checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now()) RETURNING id`,
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
      const docs = (await queryOne<{ n: number }>(c,
        `SELECT count(*)::int AS n FROM project_documents pd JOIN documents d ON d.id = pd.document_id
          WHERE pd.project_id = $1 AND pd.removed_at IS NULL AND d.status NOT IN ('VIGENTE','EXCLUIDO')`, [id]))!.n;
      if (docs) throw new AppError(`Há ${docs} documento(s) enviado(s) à Gestão documental ainda não vigente(s). Aguarde a aprovação ou retire-os do projeto.`);
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
              closed_at = CASE WHEN $10 IN ('CONCLUIDO','CANCELADO') THEN coalesce(closed_at, now()) ELSE NULL END,
              owner_checked_at = CASE WHEN $6 <> owner_user_id THEN now() ELSE owner_checked_at END, updated_at=now() WHERE id=$1`,
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
    query<{ id: string; name: string; position: number; start_date: string | null; due_date: string | null; approved_at: Date | null; approved_by_name: string | null }>(db,
      `SELECT f.id, f.name, f.position, f.start_date, f.due_date, f.approved_at, u.display_name AS approved_by_name
         FROM project_phases f LEFT JOIN users u ON u.id = f.approved_by WHERE f.project_id = $1 ORDER BY f.position`, [id]),
    query<{ id: string; title: string; due_date: string; done_at: Date | null }>(db,
      'SELECT id, title, due_date, done_at FROM project_milestones WHERE project_id = $1 ORDER BY due_date', [id]),
    query<{ id: string; description: string; amount: string; spent_on: string; created_by_name: string }>(db,
      'SELECT c.id, c.description, c.amount::text, c.spent_on, u.display_name AS created_by_name FROM project_costs c JOIN users u ON u.id = c.created_by WHERE c.project_id = $1 ORDER BY c.spent_on DESC', [id]),
    query<{ id: string; name: string; unit: string | null; target: string; current: string }>(db,
      'SELECT id, name, unit, target::text, current::text FROM project_indicators WHERE project_id = $1 ORDER BY name', [id]),
  ]);
  return { project: pr, access: a, members, phases, milestones, costs, indicators };
}

// ---------------------------------------------------------------------------
// Aprovação do projeto e das fases (somente a Oficial; Substituta Legal com autorização). A Oficial pode autoaprovar.
// ---------------------------------------------------------------------------

export async function approveProject(ctx: Ctx, projectId: string, input: { phaseId?: string | null; notes?: string | null }): Promise<void> {
  const notes = z.string().trim().max(1000).optional().nullable().parse(input.notes) || null;
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    const { pr, a } = await loadProject(c, ctx, projectId, true);
    if (!a.approve) throw new ForbiddenError('A aprovação de projetos é da Oficial Registradora.');
    const own = pr.owner_user_id === ctx.principal.userId || pr.created_by === ctx.principal.userId;
    if (own && !ctx.principal.isOwner) throw new ForbiddenError('Segregação de funções: quem gere ou criou o projeto não o aprova.');
    const self = own && ctx.principal.isOwner;
    if (input.phaseId) {
      const f = await queryOne<{ name: string }>(c,
        'UPDATE project_phases SET approved_at = now(), approved_by = $3, approval_notes = $4 WHERE id = $1 AND project_id = $2 AND approved_at IS NULL RETURNING name',
        [z.uuid().parse(input.phaseId), projectId, ctx.principal.userId, notes]);
      if (!f) throw new AppError('Fase inexistente ou já aprovada.');
      await audit(c, ctx, { action: self ? 'PROJETO_FASE_AUTOAPROVADA' : 'PROJETO_FASE_APROVADA', entityType: 'project', entityId: projectId,
        summary: `${self ? 'Fase autoaprovada pela Oficial Registradora' : 'Fase aprovada'}: "${f.name}" do projeto "${pr.name}"${notes ? ` — ${notes}` : ''}` });
      return;
    }
    if (pr.approved_at) throw new AppError('Projeto já aprovado.');
    await query(c, 'UPDATE projects SET approved_at = now(), approved_by = $2, approval_notes = $3 WHERE id = $1', [projectId, ctx.principal.userId, notes]);
    await audit(c, ctx, { action: self ? 'PROJETO_AUTOAPROVADO' : 'PROJETO_APROVADO', entityType: 'project', entityId: projectId,
      summary: `${self ? 'Projeto autoaprovado pela Oficial Registradora' : 'Projeto aprovado'}: "${pr.name}"${notes ? ` — ${notes}` : ''}` });
    await notifyUsers(c, [pr.owner_user_id].filter((u) => u !== ctx.principal.userId), { kind: 'PROJETO_APROVADO', title: 'Projeto aprovado pela Oficial', body: pr.name, link: `/projetos/${projectId}` });
  });
}

// ---------------------------------------------------------------------------
// Documentos do projeto
// ---------------------------------------------------------------------------

export type ProjectDocRow = {
  id: string; title: string; file_id: string | null; filename: string | null; size_bytes: number | null; sha256: string | null; scan_status: string | null;
  document_id: string | null; added_by_name: string; added_at: Date; removed_at: Date | null; remove_reason: string | null;
  doc_status: string | null; doc_in_review: boolean | null; doc_pending: string | null; doc_version: number | null; doc_delete_reason: string | null;
};

export async function listProjectDocuments(ctx: Ctx, projectId: string) {
  const db = getPool();
  const { a } = await loadProject(db, ctx, projectId);
  if (!a.docs) throw new ForbiddenError();
  const rows = await query<ProjectDocRow>(db,
    `SELECT pd.id, pd.title, pd.file_id, f.filename, f.size_bytes, f.sha256, f.scan_status, pd.document_id, u.display_name AS added_by_name, pd.added_at,
            pd.removed_at, pd.remove_reason, d.status AS doc_status, d.in_review AS doc_in_review, d.pending_version_id AS doc_pending,
            cv.version_number AS doc_version, d.delete_reason AS doc_delete_reason
       FROM project_documents pd JOIN users u ON u.id = pd.added_by LEFT JOIN document_files f ON f.id = pd.file_id
       LEFT JOIN documents d ON d.id = pd.document_id LEFT JOIN document_versions cv ON cv.id = d.current_version_id
      WHERE pd.project_id = $1 AND pd.removed_at IS NULL ORDER BY pd.added_at DESC`, [projectId]);
  return rows.map((r) => ({
    ...r,
    stage: !r.document_id ? 'Anexo do projeto'
      : workflowStage({ status: r.doc_status as 'RASCUNHO', in_review: !!r.doc_in_review, pending_version_id: r.doc_pending }),
  }));
}

export async function attachProjectFile(ctx: Ctx, projectId: string, file: { name: string; bytes: Uint8Array }, title?: string | null): Promise<string> {
  const db = getPool();
  const pre = await loadProject(db, ctx, projectId);
  if (!pre.a.attach) throw new ForbiddenError('Sem permissão para anexar neste projeto.');
  if (pre.pr.closed_at) throw new AppError('Projeto encerrado.');
  const checked = checkFile(file.name, file.bytes, await maxFileBytes(db));
  const prepared: PreparedFile = await prepareFile(ctx, checked, file.bytes);
  return tx(async (c) => {
    const { pr, a } = await loadProject(c, ctx, projectId, true);
    if (!a.attach) throw new ForbiddenError();
    const fileId = await insertStoredFile(c, ctx, prepared);
    const name = (title?.trim() || checked.filename).slice(0, 200);
    const r = await queryOne<{ id: string }>(c, 'INSERT INTO project_documents (project_id, title, file_id, added_by) VALUES ($1,$2,$3,$4) RETURNING id', [projectId, name, fileId, ctx.principal.userId]);
    await audit(c, ctx, { action: 'PROJETO_ANEXO', entityType: 'project', entityId: projectId,
      summary: `Arquivo "${checked.filename}" anexado ao projeto "${pr.name}" (sha256 ${prepared.sha256.slice(0, 16)}…, antivírus ${prepared.scan.status})` });
    return r!.id;
  }).catch(async (e) => { await discardUnsaved(prepared); throw e; });
}

export async function linkProjectDocument(ctx: Ctx, projectId: string, documentId: string): Promise<void> {
  await tx(async (c) => {
    const { pr, a } = await loadProject(c, ctx, projectId, true);
    if (!a.attach) throw new ForbiddenError('Sem permissão para anexar neste projeto.');
    const d = await loadDoc(c, z.uuid().parse(documentId));
    if (!accessFor(ctx.principal, d).read || d.status === 'EXCLUIDO') throw new NotFoundError('Documento não encontrado.');
    await query(c, 'INSERT INTO project_documents (project_id, title, document_id, added_by) VALUES ($1,$2,$3,$4)', [projectId, d.title, d.id, ctx.principal.userId])
      .catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('Este documento já está vinculado ao projeto.'); throw e; });
    await audit(c, ctx, { action: 'PROJETO_DOC_VINCULADO', entityType: 'project', entityId: projectId, summary: `Documento "${d.title}" vinculado ao projeto "${pr.name}"` });
  });
}

export async function removeProjectDocument(ctx: Ctx, attachmentId: string, reason: string): Promise<void> {
  if (reason.trim().length < 3) throw new AppError('Informe o motivo.');
  await tx(async (c) => {
    const att = await queryOne<{ project_id: string; title: string }>(c, 'SELECT project_id, title FROM project_documents WHERE id = $1 AND removed_at IS NULL', [z.uuid().parse(attachmentId)]);
    if (!att) throw new NotFoundError('Anexo não encontrado.');
    const { pr, a } = await loadProject(c, ctx, att.project_id, true);
    if (!a.manage) throw new ForbiddenError('Somente o(a) gestor(a) do projeto ou a Oficial retiram documentos.');
    await query(c, 'UPDATE project_documents SET removed_at = now(), removed_by = $2, remove_reason = $3 WHERE id = $1', [attachmentId, ctx.principal.userId, reason.trim()]);
    await audit(c, ctx, { action: 'PROJETO_DOC_RETIRADO', entityType: 'project', entityId: att.project_id, summary: `"${att.title}" retirado do projeto "${pr.name}": ${reason.trim()}` });
  });
}

/** Download de anexo do projeto: mesma verificação de acesso, hash e antivírus da Gestão documental. */
export async function projectFileForDownload(ctx: Ctx, projectId: string, attachmentId: string) {
  const db = getPool();
  const { a, pr } = await loadProject(db, ctx, projectId);
  if (!a.docs) throw new NotFoundError('Arquivo não encontrado.');
  const att = await queryOne<{ file_id: string | null }>(db, 'SELECT file_id FROM project_documents WHERE id = $1 AND project_id = $2', [z.uuid().parse(attachmentId), projectId]);
  if (!att?.file_id) throw new NotFoundError('Arquivo não encontrado.');
  const f = await loadStoredFile(db, att.file_id);
  if (!f) throw new NotFoundError('Arquivo não encontrado.');
  const bytes = await readStoredFile(f);
  if (!bytes) throw new AppError('O conteúdo deste arquivo foi descartado após o prazo de retenção.', 410, 'DESCARTADO');
  await rescan(ctx, f, bytes, 'download', false);
  await audit(db, ctx, { action: 'PROJETO_ANEXO_DOWNLOAD', entityType: 'project', entityId: projectId, summary: `Download de "${f.filename}" (projeto ${pr.name})` });
  return { filename: f.filename, mime_type: f.mime_type, sha256: f.sha256, data: Buffer.from(bytes) };
}

/**
 * "Enviar à Gestão documental": cria o documento já preenchido (Responsável = gestor/a do projeto, setor do projeto,
 * arquivo do anexo), com origem no projeto, e o envia para revisão ou direto para a aprovação da Oficial.
 */
export async function sendAttachmentToRepository(ctx: Ctx, attachmentId: string, meta: Omit<MetaInput, 'sectorId' | 'responsibleUserId'>,
  review: { mode: 'SEM' | 'COM'; reviewerIds: string[] }): Promise<string> {
  const mode = z.enum(['SEM', 'COM'], { error: 'Escolha a revisão: sem revisão (direto para aprovação) ou com revisão.' }).parse(review.mode);
  const reviewerIds = [...new Set(z.array(z.uuid()).parse(review.reviewerIds))];
  if (mode === 'COM' && !reviewerIds.length) throw new AppError('Indique ao menos uma revisora.');
  return tx(async (c) => {
    const att = await queryOne<{ id: string; project_id: string; file_id: string | null; document_id: string | null }>(c,
      'SELECT id, project_id, file_id, document_id FROM project_documents WHERE id = $1 AND removed_at IS NULL FOR UPDATE', [z.uuid().parse(attachmentId)]);
    if (!att) throw new NotFoundError('Anexo não encontrado.');
    if (att.document_id) throw new AppError('Este anexo já foi enviado à Gestão documental.');
    if (!att.file_id) throw new AppError('Anexo sem arquivo.');
    const { pr, a } = await loadProject(c, ctx, att.project_id, true);
    if (!a.attach) throw new ForbiddenError('Sem permissão para enviar documentos deste projeto.');
    const d = await normalizeMeta(c, { ...meta, sectorId: pr.sector_id, responsibleUserId: pr.owner_user_id });
    const docId = await insertDocument(c, ctx, d, { fileId: att.file_id, projectId: pr.id });
    await query(c, 'UPDATE project_documents SET document_id = $2 WHERE id = $1', [att.id, docId]);
    const doc = await loadDoc(c, docId);
    if (mode === 'COM') await startReview(c, ctx, doc, reviewerIds);
    else await freezeDraft(c, ctx, doc, ctx.principal.userId);
    await audit(c, ctx, { action: 'PROJETO_DOC_ENVIADO', entityType: 'project', entityId: pr.id,
      summary: `Anexo enviado à Gestão documental (${mode === 'COM' ? 'com revisão' : 'direto para aprovação'}): "${d.title}" — projeto "${pr.name}"` });
    return docId;
  });
}
