import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx } from '../context.ts';
import { can, requirePermission } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors.ts';
import { addDays, eachDay, todayLocal, weekdayOf } from '../../domain/time.ts';
import { routineOccurrences, type RoutineRule } from '../../domain/recurrence.ts';

// Rotinas recorrentes (diárias, semanais, mensais e anuais) e modelos de processo com etapas (Fase 4a).
// Ex.: verificação das centrais eletrônicas 4×/dia; bloco das 16h às 17h para notificações e matrículas eletrônicas.

export const AREAS = ['ATENDIMENTO', 'RI', 'RCPN', 'RTD', 'RCPJ', 'ADMINISTRACAO', 'DIRETORIA', 'PESSOAL'] as const;

const minutes = z.number().int().min(0).max(1440);
const routineSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(3).max(160),
  description: z.string().trim().max(3000).optional(),
  area: z.enum(AREAS),
  sectorId: z.uuid(),
  assigneeUserId: z.uuid().nullable().optional(),
  frequency: z.enum(['DIARIA', 'SEMANAL', 'MENSAL', 'ANUAL']),
  times: z.array(z.number().int().min(0).max(1439)).max(24).default([]),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  monthDay: z.number().int().min(1).max(31).nullable().optional(),
  month: z.number().int().min(1).max(12).nullable().optional(),
  businessDaysOnly: z.boolean().default(true),
  priority: z.enum(['BAIXA', 'MEDIA', 'ALTA', 'URGENTE', 'IMEDIATA']).default('MEDIA'),
  blockStart: minutes.nullable().optional(),
  blockEnd: minutes.nullable().optional(),
  startsOn: z.iso.date().optional(),
  endsOn: z.iso.date().nullable().optional(),
  active: z.boolean().default(true),
});
export type RoutineInput = z.input<typeof routineSchema>;

export async function saveRoutine(ctx: Ctx, input: RoutineInput): Promise<string> {
  requirePermission(ctx, 'rotinas.gerenciar');
  const d = routineSchema.parse(input);
  if (d.frequency === 'SEMANAL' && !d.weekdays.length) throw new AppError('Escolha os dias da semana.');
  if ((d.frequency === 'MENSAL' || d.frequency === 'ANUAL') && !d.monthDay) throw new AppError('Informe o dia do mês.');
  if (d.frequency === 'ANUAL' && !d.month) throw new AppError('Informe o mês.');
  if ((d.blockStart == null) !== (d.blockEnd == null) || (d.blockStart != null && d.blockEnd! <= d.blockStart)) throw new AppError('Bloco de horário inválido.');
  if (d.endsOn && d.startsOn && d.endsOn < d.startsOn) throw new AppError('O término não pode ser anterior ao início.');
  return tx(async (c) => {
    if (d.assigneeUserId && !(await queryOne(c, "SELECT 1 FROM users WHERE id = $1 AND status = 'ATIVO'", [d.assigneeUserId]))) throw new AppError('Responsável inexistente ou inativo.');
    const params = [d.name, d.description ?? null, d.area, d.sectorId, d.assigneeUserId ?? null, d.frequency, [...new Set(d.times)].sort((a, b) => a - b),
      [...new Set(d.weekdays)].sort(), d.frequency === 'MENSAL' || d.frequency === 'ANUAL' ? d.monthDay : null, d.frequency === 'ANUAL' ? d.month : null,
      d.businessDaysOnly, d.priority, d.blockStart ?? null, d.blockEnd ?? null, d.startsOn ?? todayLocal(), d.endsOn ?? null, d.active];
    const r = d.id
      ? await queryOne<{ id: string }>(c, `UPDATE routines SET name=$1, description=$2, area=$3, sector_id=$4, assignee_user_id=$5, frequency=$6, times=$7, weekdays=$8,
          month_day=$9, month=$10, business_days_only=$11, priority=$12, block_start=$13, block_end=$14, starts_on=$15, ends_on=$16, active=$17, updated_at=now()
          WHERE id=$18 RETURNING id`, [...params, d.id])
      : await queryOne<{ id: string }>(c, `INSERT INTO routines (name, description, area, sector_id, assignee_user_id, frequency, times, weekdays, month_day, month,
          business_days_only, priority, block_start, block_end, starts_on, ends_on, active, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`, [...params, ctx.principal.userId]);
    if (!r) throw new NotFoundError('Rotina não encontrada.');
    await audit(c, ctx, { action: d.id ? 'ROTINA_ALTERADA' : 'ROTINA_CRIADA', entityType: 'routine', entityId: r.id, summary: `Rotina "${d.name}" (${d.frequency}${d.times.length ? `, ${d.times.length}×/dia` : ''})`, data: d });
    return r.id;
  });
}

export async function listRoutines(ctx: Ctx) {
  if (!can(ctx.principal, 'rotinas.gerenciar') && !can(ctx.principal, 'tarefas.ver')) throw new ForbiddenError();
  return query<{
    id: string; name: string; description: string | null; area: string; sector_id: string; sector_name: string; assignee_user_id: string | null; assignee_name: string | null;
    frequency: string; times: number[]; weekdays: number[]; month_day: number | null; month: number | null; business_days_only: boolean; priority: string;
    block_start: number | null; block_end: number | null; starts_on: string; ends_on: string | null; active: boolean; generated: number;
  }>(
    getPool(),
    `SELECT r.*, s.name AS sector_name, u.display_name AS assignee_name, (SELECT count(*)::int FROM tasks t WHERE t.routine_id = r.id) AS generated
       FROM routines r JOIN sectors s ON s.id = r.sector_id LEFT JOIN users u ON u.id = r.assignee_user_id ORDER BY r.active DESC, r.area, r.name`);
}

/**
 * Gera as tarefas das rotinas ativas no intervalo (idempotente: cada ocorrência gera uma única tarefa).
 * Chamado pela rotina diária e, de forma preguiçosa, ao abrir a lista de tarefas.
 */
export async function generateRoutineTasks(from: string, to: string, db: Db = getPool()): Promise<number> {
  if (to < from) return 0;
  const holidays = new Set((await query<{ date: string }>(db, 'SELECT date FROM holidays WHERE is_day_off AND date BETWEEN $1 AND $2', [from, addDays(to, 15)])).map((h) => h.date));
  const isBusinessDay = (d: string) => weekdayOf(d) !== 0 && weekdayOf(d) !== 6 && !holidays.has(d);
  const routines = await query<RoutineRule & {
    id: string; name: string; description: string | null; sector_id: string; assignee_user_id: string | null; priority: string;
    block_start: number | null; block_end: number | null; created_by: string;
  }>(db, 'SELECT * FROM routines WHERE active AND starts_on <= $2 AND (ends_on IS NULL OR ends_on >= $1)', [from, to]);
  let created = 0;
  for (const r of routines) {
    for (const day of eachDay(from, to)) {
      for (const o of routineOccurrences(r, day, isBusinessDay)) {
        const res = await query<{ id: string }>(
          db,
          `INSERT INTO tasks (routine_id, occurrence_key, title, description, priority, sector_id, assignee_user_id, start_date, due_date, due_time,
                              block_start, block_end, created_by, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12, extract(epoch from now()))
           ON CONFLICT (routine_id, occurrence_key) DO NOTHING RETURNING id`,
          [r.id, o.key, r.name, r.description, r.priority, r.sector_id, r.assignee_user_id, o.date, o.dueTime, r.block_start, r.block_end, r.created_by]);
        created += res.length;
      }
    }
  }
  return created;
}

/** Garante as tarefas de rotina de hoje (e de amanhã, para planejamento). */
export async function ensureRoutineTasks(): Promise<void> {
  const today = todayLocal();
  await generateRoutineTasks(today, addDays(today, 1));
}

// ---------------------------------------------------------------------------
// Modelos de processo
// ---------------------------------------------------------------------------

const stepSchema = z.object({
  title: z.string().trim().min(2).max(160),
  instructions: z.string().trim().max(3000).optional(),
  inputs: z.string().trim().max(1000).optional(),
  outputs: z.string().trim().max(1000).optional(),
  requiredDocuments: z.string().trim().max(1000).optional(),
  responsibleRoleId: z.uuid().nullable().optional(),
  slaDays: z.number().int().min(0).max(365).default(1),
  requiresApproval: z.boolean().default(false),
});
const templateSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(3).max(160),
  description: z.string().trim().max(3000).optional(),
  sectorId: z.uuid(),
  active: z.boolean().default(true),
  steps: z.array(stepSchema).min(1, 'Inclua ao menos uma etapa.').max(50),
});
export type TemplateInput = z.input<typeof templateSchema>;

export async function saveProcessTemplate(ctx: Ctx, input: TemplateInput): Promise<string> {
  requirePermission(ctx, 'rotinas.gerenciar');
  const d = templateSchema.parse(input);
  return tx(async (c) => {
    const r = d.id
      ? await queryOne<{ id: string }>(c, 'UPDATE process_templates SET name=$1, description=$2, sector_id=$3, active=$4 WHERE id=$5 RETURNING id', [d.name, d.description ?? null, d.sectorId, d.active, d.id])
          .catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('Já existe modelo com este nome.'); throw e; })
      : await queryOne<{ id: string }>(c, 'INSERT INTO process_templates (name, description, sector_id, active, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [d.name, d.description ?? null, d.sectorId, d.active, ctx.principal.userId])
          .catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('Já existe modelo com este nome.'); throw e; });
    if (!r) throw new NotFoundError('Modelo não encontrado.');
    // As etapas podem ser reescritas: processos já iniciados guardam a cópia das etapas usadas.
    await query(c, 'DELETE FROM process_template_steps WHERE template_id = $1', [r.id]);
    for (const [i, s] of d.steps.entries()) {
      await query(c, `INSERT INTO process_template_steps (template_id, position, title, instructions, inputs, outputs, required_documents, responsible_role_id, sla_days, requires_approval)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [r.id, i + 1, s.title, s.instructions ?? null, s.inputs ?? null, s.outputs ?? null, s.requiredDocuments ?? null, s.responsibleRoleId ?? null, s.slaDays, s.requiresApproval]);
    }
    await audit(c, ctx, { action: d.id ? 'PROCESSO_MODELO_ALTERADO' : 'PROCESSO_MODELO_CRIADO', entityType: 'process_template', entityId: r.id, summary: `Modelo de processo "${d.name}" (${d.steps.length} etapas)` });
    return r.id;
  });
}

export async function listProcessTemplates() {
  const db = getPool();
  const templates = await query<{ id: string; name: string; description: string | null; sector_id: string; sector_name: string; active: boolean; instances: number }>(
    db, `SELECT t.id, t.name, t.description, t.sector_id, s.name AS sector_name, t.active, (SELECT count(*)::int FROM process_instances i WHERE i.template_id = t.id) AS instances
           FROM process_templates t JOIN sectors s ON s.id = t.sector_id ORDER BY t.active DESC, t.name`);
  const steps = await query<{ template_id: string; position: number; title: string; instructions: string | null; inputs: string | null; outputs: string | null;
    required_documents: string | null; responsible_role_id: string | null; role_name: string | null; sla_days: number; requires_approval: boolean }>(
    db, 'SELECT st.*, r.name AS role_name FROM process_template_steps st LEFT JOIN roles r ON r.id = st.responsible_role_id ORDER BY st.template_id, st.position');
  return templates.map((t) => ({ ...t, steps: steps.filter((s) => s.template_id === t.id) }));
}

/** Responsável da etapa: única pessoa com o papel indicado (vigente) no setor do processo; se houver várias ou nenhuma, fica para o setor. */
async function resolveRoleAssignee(c: Db, roleId: string | null, sectorId: string): Promise<string | null> {
  if (!roleId) return null;
  const rows = await query<{ id: string }>(
    c,
    `SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN employees e ON e.user_id = u.id AND e.status <> 'DESLIGADO'
      WHERE ur.role_id = $1 AND u.status = 'ATIVO' AND ur.revoked_at IS NULL AND ur.valid_from <= current_date
        AND (ur.valid_until IS NULL OR ur.valid_until >= current_date)
        AND (coalesce(ur.sector_id, e.sector_id) = $2 OR NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = $1 AND rp.scope = 'SETOR'))`,
    [roleId, sectorId]);
  return rows.length === 1 ? rows[0]!.id : null;
}

export async function startProcess(ctx: Ctx, templateId: string, title: string): Promise<string> {
  z.uuid().parse(templateId);
  const t2 = z.string().trim().min(3).max(200).parse(title);
  return tx(async (c) => {
    const tpl = await queryOne<{ id: string; name: string; sector_id: string; active: boolean }>(c, 'SELECT id, name, sector_id, active FROM process_templates WHERE id = $1', [templateId]);
    if (!tpl) throw new NotFoundError('Modelo não encontrado.');
    if (!tpl.active) throw new AppError('Modelo inativo.');
    const p = ctx.principal;
    if (!p.isOwner && !can(p, 'tarefas.gerenciar', { sectorId: tpl.sector_id }) && !can(p, 'rotinas.gerenciar')) {
      throw new ForbiddenError('Iniciar processo cabe à coordenação do setor ou à administração.');
    }
    const steps = await query<{ position: number; title: string; instructions: string | null; inputs: string | null; outputs: string | null; required_documents: string | null;
      responsible_role_id: string | null; sla_days: number; requires_approval: boolean }>(c, 'SELECT * FROM process_template_steps WHERE template_id = $1 ORDER BY position', [templateId]);
    if (!steps.length) throw new AppError('Modelo sem etapas.');
    const inst = (await queryOne<{ id: string }>(c, 'INSERT INTO process_instances (template_id, title, template_snapshot, started_by) VALUES ($1,$2,$3,$4) RETURNING id',
      [templateId, t2, JSON.stringify({ modelo: tpl.name, etapas: steps }), p.userId]))!.id;
    const owner = (await queryOne<{ id: string }>(c, "SELECT id FROM users WHERE is_owner AND status = 'ATIVO' LIMIT 1"))?.id ?? null;
    let due = todayLocal();
    let prev: string | null = null;
    for (const s of steps) {
      due = addDays(due, s.sla_days);
      const assignee = await resolveRoleAssignee(c, s.responsible_role_id, tpl.sector_id);
      let approver: string | null = null;
      if (s.requires_approval) approver = p.userId !== assignee ? p.userId : owner !== assignee ? owner : null;
      if (s.requires_approval && !approver) throw new AppError(`Etapa "${s.title}": não há aprovador distinto do responsável.`);
      const desc = [s.instructions, s.inputs && `Entradas: ${s.inputs}`, s.outputs && `Saídas: ${s.outputs}`, s.required_documents && `Documentos exigidos: ${s.required_documents}`].filter(Boolean).join('\n');
      const id: string = (await queryOne<{ id: string }>(
        c,
        `INSERT INTO tasks (process_instance_id, process_step, title, description, priority, sector_id, assignee_user_id, start_date, due_date, requires_approval, approver_user_id, created_by, position)
         VALUES ($1,$2::int,$3,$4,'MEDIA',$5,$6,current_date,$7,$8,$9,$10,$2::int) RETURNING id`,
        [inst, s.position, `${t2} — ${s.position}. ${s.title}`, desc || null, tpl.sector_id, assignee, due, s.requires_approval, approver, p.userId]))!.id;
      if (prev) await query(c, 'INSERT INTO task_dependencies (task_id, depends_on_id) VALUES ($1,$2)', [id, prev]);
      await query(c, "INSERT INTO task_events (task_id, user_id, event, details) VALUES ($1,$2,'CRIADA',$3)", [id, p.userId, JSON.stringify({ processo: t2, etapa: s.position })]);
      prev = id;
    }
    await audit(c, ctx, { action: 'PROCESSO_INICIADO', entityType: 'process_instance', entityId: inst, summary: `Processo "${t2}" (${tpl.name}) iniciado com ${steps.length} etapas` });
    return inst;
  });
}

export async function cancelProcess(ctx: Ctx, instanceId: string, reason: string): Promise<void> {
  z.uuid().parse(instanceId);
  if (reason.trim().length < 5) throw new AppError('Informe o motivo do cancelamento.');
  await tx(async (c) => {
    const i = await queryOne<{ status: string; title: string; sector_id: string }>(c,
      'SELECT i.status, i.title, t.sector_id FROM process_instances i JOIN process_templates t ON t.id = i.template_id WHERE i.id = $1 FOR UPDATE OF i', [instanceId]);
    if (!i) throw new NotFoundError('Processo não encontrado.');
    if (!ctx.principal.isOwner && !can(ctx.principal, 'tarefas.gerenciar', { sectorId: i.sector_id })) throw new ForbiddenError();
    if (i.status !== 'EM_ANDAMENTO') throw new AppError('Processo já encerrado.');
    await query(c, "UPDATE tasks SET status='CANCELADA', updated_at=now() WHERE process_instance_id = $1 AND status NOT IN ('CONCLUIDA','CANCELADA')", [instanceId]);
    await query(c, "UPDATE process_instances SET status='CANCELADO', closed_at=now(), closed_by=$2, close_notes=$3 WHERE id=$1", [instanceId, ctx.principal.userId, reason.trim()]);
    await audit(c, ctx, { action: 'PROCESSO_CANCELADO', entityType: 'process_instance', entityId: instanceId, summary: `Processo "${i.title}" cancelado: ${reason.trim()}` });
  });
}

export async function listProcessInstances(ctx: Ctx) {
  const rows = await query<{ id: string; title: string; status: string; template_name: string; sector_id: string; started_at: Date; started_by_name: string; closed_at: Date | null;
    steps: number; steps_done: number; current_step: string | null }>(
    getPool(),
    `SELECT i.id, i.title, i.status, t.name AS template_name, t.sector_id, i.started_at, u.display_name AS started_by_name, i.closed_at,
            (SELECT count(*)::int FROM tasks x WHERE x.process_instance_id = i.id) AS steps,
            (SELECT count(*)::int FROM tasks x WHERE x.process_instance_id = i.id AND x.status IN ('CONCLUIDA','CANCELADA')) AS steps_done,
            (SELECT x.title FROM tasks x WHERE x.process_instance_id = i.id AND x.status NOT IN ('CONCLUIDA','CANCELADA') ORDER BY x.process_step LIMIT 1) AS current_step
       FROM process_instances i JOIN process_templates t ON t.id = i.template_id JOIN users u ON u.id = i.started_by
      ORDER BY i.status = 'EM_ANDAMENTO' DESC, i.started_at DESC LIMIT 200`);
  const p = ctx.principal;
  return rows.filter((r) => p.isOwner || can(p, 'tarefas.ver', { sectorId: r.sector_id }) || can(p, 'rotinas.gerenciar'));
}
