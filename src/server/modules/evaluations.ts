import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx, Principal } from '../context.ts';
import { can, loadPrincipal, requirePermission, requireStepUp } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ForbiddenError, NotFoundError } from '../errors.ts';
import { canonicalJson, sha256Hex } from '../crypto.ts';
import { getNumberSetting } from '../settings.ts';
import { addDays, diffDays, todayLocal } from '../../domain/time.ts';
import { scheduleDue, weightedScore, type Schedule } from '../../domain/development.ts';
import { recordSignature, type Act } from './documents.ts';
import { notifyEmployee, notifyUsers, usersWithPermission } from './notifications.ts';

// Avaliações de desempenho (Fase 5b): modelos versionados com critérios e pesos, programação automática
// (ex.: 30/60/90 dias, período de experiência, anual), autoavaliação opcional, feedback, PDI e ciência do avaliado.
// A ciência NÃO implica concordância; o avaliado pode concordar ou registrar discordância com seus motivos.
// Nenhuma consequência (efetivação, rescisão, promoção, remuneração) decorre automaticamente da avaliação.

export const EVAL_DISCLAIMER = 'Instrumento de gestão e desenvolvimento: a avaliação não gera, por si, efetivação, desligamento, promoção, desconto ou qualquer efeito automático.';

const ANY_SECTOR = '00000000-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// Modelos
// ---------------------------------------------------------------------------

const templateSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(3).max(150),
  kind: z.enum(['EXPERIENCIA', 'ACOMPANHAMENTO', 'ANUAL', 'COMPETENCIAS', 'PRODUTIVIDADE', 'OUTRA']),
  instructions: z.string().trim().max(4000).optional(),
  scaleMax: z.number().int().min(2).max(10).default(5),
  selfAssessment: z.boolean().default(false),
  criteria: z.array(z.object({
    grp: z.enum(['COMPETENCIA', 'PRODUTIVIDADE', 'COMPORTAMENTO', 'CONHECIMENTO', 'OUTRO']),
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().max(1000).optional(),
    weight: z.number().int().min(1).max(10).default(1),
  })).min(1, 'Inclua ao menos um critério.').max(40),
});

/** Salva rascunho; editar um modelo publicado cria a próxima versão (rascunho) da mesma família. */
export async function saveTemplate(ctx: Ctx, input: z.input<typeof templateSchema>): Promise<string> {
  requirePermission(ctx, 'avaliacoes.gerenciar');
  const d = templateSchema.parse(input);
  return tx(async (c) => {
    let id = d.id;
    if (id) {
      const cur = await queryOne<{ family_key: string; status: string }>(c, 'SELECT family_key, status FROM evaluation_templates WHERE id = $1 FOR UPDATE', [id]);
      if (!cur) throw new NotFoundError('Modelo não encontrado.');
      if (cur.status === 'RASCUNHO') {
        await query(c, 'UPDATE evaluation_templates SET name=$2, kind=$3, instructions=$4, scale_max=$5, self_assessment=$6 WHERE id=$1', [id, d.name, d.kind, d.instructions || null, d.scaleMax, d.selfAssessment]);
        await query(c, 'DELETE FROM evaluation_criteria WHERE template_id = $1', [id]);
      } else {
        if (await queryOne(c, "SELECT 1 FROM evaluation_templates WHERE family_key = $1 AND status = 'RASCUNHO'", [cur.family_key])) throw new AppError('Já existe uma nova versão em rascunho deste modelo.');
        id = (await queryOne<{ id: string }>(c, `INSERT INTO evaluation_templates (family_key, version, name, kind, instructions, scale_max, self_assessment, created_by)
          SELECT $1, max(version) + 1, $2, $3, $4, $5, $6, $7 FROM evaluation_templates WHERE family_key = $1 RETURNING id`,
          [cur.family_key, d.name, d.kind, d.instructions || null, d.scaleMax, d.selfAssessment, ctx.principal.userId]))!.id;
      }
    } else {
      id = (await queryOne<{ id: string }>(c, `INSERT INTO evaluation_templates (family_key, version, name, kind, instructions, scale_max, self_assessment, created_by)
        VALUES ($1,1,$2,$3,$4,$5,$6,$7) RETURNING id`, [randomUUID(), d.name, d.kind, d.instructions || null, d.scaleMax, d.selfAssessment, ctx.principal.userId]))!.id;
    }
    let pos = 0;
    for (const k of d.criteria) await query(c, 'INSERT INTO evaluation_criteria (template_id, position, grp, title, description, weight) VALUES ($1,$2,$3,$4,$5,$6)', [id, ++pos, k.grp, k.title, k.description || null, k.weight]);
    await audit(c, ctx, { action: 'AVALIACAO_MODELO_SALVO', entityType: 'evaluation_template', entityId: id, summary: `${d.name}: ${d.criteria.length} critério(s)` });
    return id;
  });
}

/** Publica a versão: as versões anteriores da família deixam de ser usadas em novas avaliações. */
export async function publishTemplate(ctx: Ctx, id: string): Promise<void> {
  requirePermission(ctx, 'avaliacoes.gerenciar');
  await tx(async (c) => {
    const t = await queryOne<{ family_key: string; status: string; name: string; version: number }>(c, 'SELECT family_key, status, name, version FROM evaluation_templates WHERE id = $1 FOR UPDATE', [z.uuid().parse(id)]);
    if (!t) throw new NotFoundError('Modelo não encontrado.');
    if (t.status !== 'RASCUNHO') throw new AppError('Modelo já publicado.');
    if (!(await queryOne(c, 'SELECT 1 FROM evaluation_criteria WHERE template_id = $1', [id]))) throw new AppError('Inclua ao menos um critério.');
    await query(c, "UPDATE evaluation_templates SET status = 'INATIVO' WHERE family_key = $1 AND status = 'PUBLICADO'", [t.family_key]);
    await query(c, "UPDATE evaluation_templates SET status = 'PUBLICADO', published_at = now() WHERE id = $1", [id]);
    await audit(c, ctx, { action: 'AVALIACAO_MODELO_PUBLICADO', entityType: 'evaluation_template', entityId: id, summary: `${t.name} v${t.version}` });
  });
}

export async function listTemplates(ctx: Ctx) {
  if (!can(ctx.principal, 'avaliacoes.gerenciar') && !can(ctx.principal, 'avaliacoes.avaliar')) throw new ForbiddenError();
  const db = getPool();
  const rows = await query<{ id: string; family_key: string; version: number; name: string; kind: string; instructions: string | null; scale_max: number; self_assessment: boolean; status: string; published_at: Date | null }>(db,
    'SELECT id, family_key, version, name, kind, instructions, scale_max, self_assessment, status, published_at FROM evaluation_templates ORDER BY name, version DESC');
  const criteria = await query<{ template_id: string; id: string; position: number; grp: string; title: string; description: string | null; weight: number }>(db,
    'SELECT template_id, id, position, grp, title, description, weight FROM evaluation_criteria ORDER BY template_id, position');
  return rows.map((t) => ({ ...t, criteria: criteria.filter((k) => k.template_id === t.id) }));
}

// ---------------------------------------------------------------------------
// Programação automática
// ---------------------------------------------------------------------------

const scheduleSchema = z.object({
  id: z.uuid().optional(), name: z.string().trim().min(3).max(150), templateFamily: z.uuid(), trigger: z.enum(['DIAS_APOS_ADMISSAO', 'ANUAL']),
  daysAfter: z.number().int().min(1).max(3650).nullable().optional(), annualMonth: z.number().int().min(1).max(12).nullable().optional(),
  annualDay: z.number().int().min(1).max(28).nullable().optional(), leadDays: z.number().int().min(0).max(60).default(7), sectorId: z.uuid().nullable().optional(), active: z.boolean().default(true),
});

export async function saveSchedule(ctx: Ctx, input: z.input<typeof scheduleSchema>): Promise<string> {
  requirePermission(ctx, 'avaliacoes.gerenciar');
  const d = scheduleSchema.parse(input);
  if (d.trigger === 'DIAS_APOS_ADMISSAO' && !d.daysAfter) throw new AppError('Informe os dias após a admissão.');
  if (d.trigger === 'ANUAL' && (!d.annualMonth || !d.annualDay)) throw new AppError('Informe o dia e o mês da avaliação anual.');
  return tx(async (c) => {
    if (!(await queryOne(c, 'SELECT 1 FROM evaluation_templates WHERE family_key = $1', [d.templateFamily]))) throw new AppError('Modelo inexistente.');
    const vals = [d.name, d.templateFamily, d.trigger, d.trigger === 'DIAS_APOS_ADMISSAO' ? d.daysAfter : null, d.trigger === 'ANUAL' ? d.annualMonth : null,
      d.trigger === 'ANUAL' ? d.annualDay : null, d.leadDays, d.sectorId ?? null, d.active];
    const id = d.id
      ? (await queryOne<{ id: string }>(c, `UPDATE evaluation_schedules SET name=$1, template_family=$2, trigger=$3, days_after=$4, annual_month=$5, annual_day=$6, lead_days=$7, sector_id=$8, active=$9
          WHERE id=$10 RETURNING id`, [...vals, d.id]))?.id
      : (await queryOne<{ id: string }>(c, `INSERT INTO evaluation_schedules (name, template_family, trigger, days_after, annual_month, annual_day, lead_days, sector_id, active, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [...vals, ctx.principal.userId]))!.id;
    if (!id) throw new NotFoundError('Programação não encontrada.');
    await audit(c, ctx, { action: 'AVALIACAO_PROGRAMACAO', entityType: 'evaluation_schedule', entityId: id, summary: d.name });
    return id;
  });
}

export async function listSchedules(ctx: Ctx) {
  requirePermission(ctx, 'avaliacoes.gerenciar');
  return query<{ id: string; name: string; template_family: string; trigger: string; days_after: number | null; annual_month: number | null; annual_day: number | null; lead_days: number;
    sector_id: string | null; sector_name: string | null; active: boolean; generated: number }>(getPool(),
    `SELECT s.*, x.name AS sector_name, (SELECT count(*)::int FROM evaluations e WHERE e.schedule_id = s.id) AS generated
       FROM evaluation_schedules s LEFT JOIN sectors x ON x.id = s.sector_id ORDER BY s.active DESC, s.name`);
}

/** Quem avalia por padrão: coordenação do setor (que não seja a própria pessoa); senão a Substituta/Oficial. */
async function defaultEvaluator(c: Db, emp: { sector_id: string; user_id: string | null }): Promise<string | null> {
  const r = await queryOne<{ id: string }>(c,
    `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL AND ur.valid_from <= current_date AND (ur.valid_until IS NULL OR ur.valid_until >= current_date)
       JOIN roles r ON r.id = ur.role_id LEFT JOIN employees e ON e.user_id = u.id
      WHERE u.status = 'ATIVO' AND u.id IS DISTINCT FROM $2
      ORDER BY (r.code = 'COORDENACAO_SETOR' AND coalesce(ur.sector_id, e.sector_id) = $1) DESC, (r.code = 'SUBSTITUTA_LEGAL') DESC, u.is_owner DESC LIMIT 1`, [emp.sector_id, emp.user_id]);
  return r?.id ?? null;
}

/** Gera as avaliações programadas devidas (idempotente). Executada pela rotina diária. */
export async function generateScheduledEvaluations(today = todayLocal(), db: Db = getPool()): Promise<number> {
  const schedules = await query<Schedule & { id: string; name: string; template_family: string; sector_id: string | null; created_by: string }>(db,
    'SELECT * FROM evaluation_schedules WHERE active');
  let created = 0;
  for (const s of schedules) {
    const tpl = await queryOne<{ id: string }>(db, "SELECT id FROM evaluation_templates WHERE family_key = $1 AND status = 'PUBLICADO'", [s.template_family]);
    if (!tpl) continue;
    // A Oficial (titular da delegação) não é avaliada por subordinados: fica fora da programação automática.
    const people = await query<{ id: string; user_id: string | null; sector_id: string; admission_date: string }>(db,
      `SELECT e.id, e.user_id, e.sector_id, e.admission_date FROM employees e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.status <> 'DESLIGADO' AND NOT coalesce(u.is_owner, false) AND ($1::uuid IS NULL OR e.sector_id = $1)`, [s.sector_id]);
    for (const p of people) {
      const due = scheduleDue(s, p.admission_date, today);
      if (!due) continue;
      await tx(async (c) => {
        // Avaliação do mesmo modelo já criada manualmente para o mesmo período (±15 dias): não duplica.
        const manual = await queryOne(c, `SELECT 1 FROM evaluations v JOIN evaluation_templates t ON t.id = v.template_id
          WHERE v.employee_id = $1 AND t.family_key = $2 AND v.status <> 'CANCELADA' AND v.schedule_id IS NULL AND abs(v.due_date - $3::date) <= 15`, [p.id, s.template_family, due.due]);
        if (manual) return;
        const evaluator = await defaultEvaluator(c, p);
        if (!evaluator) return;
        const r = await queryOne<{ id: string }>(c, `INSERT INTO evaluations (template_id, employee_id, evaluator_user_id, period_label, due_date, schedule_id, schedule_ref, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (schedule_id, employee_id, schedule_ref) DO NOTHING RETURNING id`,
          [tpl.id, p.id, evaluator, `${s.name} (${due.ref.startsWith('ANUAL') ? due.ref.slice(6) : `admissão + ${s.days_after} dias`})`, due.due, s.id, due.ref, s.created_by]);
        if (!r) return;
        created++;
        await notifyUsers(c, [evaluator], { kind: 'AVALIACAO', title: `Avaliação a realizar até ${due.due}`, body: s.name, link: `/avaliacoes/${r.id}` });
      });
    }
  }
  return created;
}

// ---------------------------------------------------------------------------
// Avaliações
// ---------------------------------------------------------------------------

type EvalRow = { id: string; template_id: string; employee_id: string; employee_user_id: string | null; employee_name: string; sector_id: string; sector_name: string; evaluator_user_id: string;
  evaluator_name: string; period_label: string; due_date: string; status: string; self_submitted_at: Date | null; strengths: string | null; improvements: string | null; feedback: string | null;
  overall_score: string | null; document_id: string | null; sent_at: Date | null; closed_at: Date | null; close_notes: string | null; template_name: string; template_version: number;
  scale_max: number; self_assessment: boolean; instructions: string | null; kind: string };
const evalSelect = `SELECT v.id, v.template_id, v.employee_id, e.user_id AS employee_user_id, e.full_name AS employee_name, e.sector_id, s.name AS sector_name, v.evaluator_user_id,
  u.display_name AS evaluator_name, v.period_label, v.due_date, v.status, v.self_submitted_at, v.strengths, v.improvements, v.feedback, v.overall_score, v.document_id, v.sent_at,
  v.closed_at, v.close_notes, t.name AS template_name, t.version AS template_version, t.scale_max, t.self_assessment, t.instructions, t.kind
  FROM evaluations v JOIN employees e ON e.id = v.employee_id JOIN sectors s ON s.id = e.sector_id JOIN users u ON u.id = v.evaluator_user_id JOIN evaluation_templates t ON t.id = v.template_id`;

/** Papel de quem consulta. O avaliado não vê notas e comentários do avaliador antes do envio. */
function roleIn(p: Principal, v: Pick<EvalRow, 'evaluator_user_id' | 'employee_user_id' | 'sector_id' | 'employee_id'>) {
  const self = v.employee_user_id === p.userId;
  return {
    self,
    evaluator: v.evaluator_user_id === p.userId,
    manager: !self && (p.isOwner || can(p, 'avaliacoes.gerenciar')),
    sectorLead: !self && can(p, 'avaliacoes.avaliar', { sectorId: v.sector_id, employeeId: v.employee_id }),
  };
}

async function loadEval(c: Db, id: string, lock = false): Promise<EvalRow> {
  const v = await queryOne<EvalRow>(c, `${evalSelect} WHERE v.id = $1 ${lock ? 'FOR UPDATE OF v' : ''}`, [z.uuid().parse(id)]);
  if (!v) throw new NotFoundError('Avaliação não encontrada.');
  return v;
}

async function canEvaluate(c: Db, evaluatorUserId: string, emp: { id: string; sector_id: string; user_id: string | null }) {
  if (evaluatorUserId === emp.user_id) throw new AppError('O avaliador não pode ser o próprio avaliado.');
  const ep = await loadPrincipal(c, evaluatorUserId);
  if (!ep || !can(ep, 'avaliacoes.avaliar', { sectorId: emp.sector_id, employeeId: emp.id })) throw new AppError('O avaliador indicado não tem permissão para avaliar esta pessoa.');
}

const createSchema = z.object({ templateId: z.uuid(), employeeId: z.uuid(), evaluatorUserId: z.uuid().optional(), periodLabel: z.string().trim().min(2).max(120), dueDate: z.iso.date() });

export async function createEvaluation(ctx: Ctx, input: z.input<typeof createSchema>): Promise<string> {
  const d = createSchema.parse(input);
  return tx(async (c) => {
    const emp = await queryOne<{ id: string; sector_id: string; user_id: string | null; full_name: string }>(c, "SELECT id, sector_id, user_id, full_name FROM employees WHERE id = $1 AND status <> 'DESLIGADO'", [d.employeeId]);
    if (!emp) throw new NotFoundError('Funcionário não encontrado.');
    const evaluator = d.evaluatorUserId ?? ctx.principal.userId;
    // Gestão atribui a qualquer avaliador habilitado; a coordenação cria avaliações em que ela mesma avalia.
    if (!can(ctx.principal, 'avaliacoes.gerenciar') && !(evaluator === ctx.principal.userId && can(ctx.principal, 'avaliacoes.avaliar', { sectorId: emp.sector_id, employeeId: emp.id }))) throw new ForbiddenError();
    await canEvaluate(c, evaluator, emp);
    if (!(await queryOne(c, "SELECT 1 FROM evaluation_templates WHERE id = $1 AND status = 'PUBLICADO'", [d.templateId]))) throw new AppError('Use um modelo publicado.');
    const r = await queryOne<{ id: string }>(c, 'INSERT INTO evaluations (template_id, employee_id, evaluator_user_id, period_label, due_date, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [d.templateId, emp.id, evaluator, d.periodLabel, d.dueDate, ctx.principal.userId]);
    await audit(c, ctx, { action: 'AVALIACAO_CRIADA', entityType: 'evaluation', entityId: r!.id, summary: `${emp.full_name}: ${d.periodLabel}` });
    if (evaluator !== ctx.principal.userId) await notifyUsers(c, [evaluator], { kind: 'AVALIACAO', title: `Avaliação a realizar até ${d.dueDate}`, link: `/avaliacoes/${r!.id}` });
    return r!.id;
  });
}

const scoresSchema = z.array(z.object({ criterionId: z.uuid(), score: z.number().int().min(1).max(10), comment: z.string().trim().max(2000).optional() })).max(40);

async function writeScores(c: Db, v: EvalRow, source: 'AVALIADOR' | 'AUTOAVALIACAO', scores: z.infer<typeof scoresSchema>) {
  const valid = new Set((await query<{ id: string }>(c, 'SELECT id FROM evaluation_criteria WHERE template_id = $1', [v.template_id])).map((k) => k.id));
  for (const s of scores) {
    if (!valid.has(s.criterionId)) throw new AppError('Critério não pertence ao modelo.');
    if (s.score > v.scale_max) throw new AppError(`As notas vão de 1 a ${v.scale_max}.`);
    await query(c, `INSERT INTO evaluation_scores (evaluation_id, criterion_id, source, score, comment) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (evaluation_id, criterion_id, source) DO UPDATE SET score = EXCLUDED.score, comment = EXCLUDED.comment`, [v.id, s.criterionId, source, s.score, s.comment || null]);
  }
}

/** Rascunho do avaliador (notas, pontos fortes, a desenvolver e feedback), editável até o envio. */
export async function saveAssessment(ctx: Ctx, id: string, input: { scores: z.input<typeof scoresSchema>; strengths?: string; improvements?: string; feedback?: string }): Promise<void> {
  const scores = scoresSchema.parse(input.scores);
  const txt = z.object({ strengths: z.string().trim().max(4000).optional(), improvements: z.string().trim().max(4000).optional(), feedback: z.string().trim().max(6000).optional() }).parse(input);
  await tx(async (c) => {
    const v = await loadEval(c, id, true);
    if (v.evaluator_user_id !== ctx.principal.userId) throw new ForbiddenError('Somente o avaliador designado preenche a avaliação.');
    if (v.status !== 'PENDENTE') throw new AppError('Avaliação já enviada.');
    await writeScores(c, v, 'AVALIADOR', scores);
    await query(c, 'UPDATE evaluations SET strengths = $2, improvements = $3, feedback = $4 WHERE id = $1', [v.id, txt.strengths || null, txt.improvements || null, txt.feedback || null]);
  });
}

export async function saveSelfAssessment(ctx: Ctx, id: string, scores: z.input<typeof scoresSchema>, submit: boolean): Promise<void> {
  const sc = scoresSchema.parse(scores);
  await tx(async (c) => {
    const v = await loadEval(c, id, true);
    if (v.employee_user_id !== ctx.principal.userId) throw new ForbiddenError('A autoavaliação é feita pelo próprio avaliado.');
    if (!v.self_assessment) throw new AppError('Este modelo não prevê autoavaliação.');
    if (v.status !== 'PENDENTE' || v.self_submitted_at) throw new AppError('Autoavaliação já entregue.');
    await writeScores(c, v, 'AUTOAVALIACAO', sc);
    if (submit) {
      const missing = (await queryOne<{ n: number }>(c, `SELECT count(*)::int AS n FROM evaluation_criteria k WHERE k.template_id = $1
        AND NOT EXISTS (SELECT 1 FROM evaluation_scores s WHERE s.evaluation_id = $2 AND s.criterion_id = k.id AND s.source = 'AUTOAVALIACAO')`, [v.template_id, v.id]))!.n;
      if (missing) throw new AppError(`Faltam ${missing} critério(s) na autoavaliação.`);
      await query(c, 'UPDATE evaluations SET self_submitted_at = now() WHERE id = $1', [v.id]);
      await audit(c, ctx, { action: 'AVALIACAO_AUTOAVALIACAO', entityType: 'evaluation', entityId: v.id, summary: 'Autoavaliação entregue' });
      await notifyUsers(c, [v.evaluator_user_id], { kind: 'AVALIACAO', title: `Autoavaliação entregue: ${v.employee_name}`, link: `/avaliacoes/${v.id}` });
    }
  });
}

/** Congela o conteúdo (versão com hash) e envia ao avaliado para ciência. Retificação gera nova versão. */
export async function sendForAcknowledgement(ctx: Ctx, id: string): Promise<void> {
  await tx(async (c) => {
    const v = await loadEval(c, id, true);
    if (v.evaluator_user_id !== ctx.principal.userId) throw new ForbiddenError('Somente o avaliador designado envia a avaliação.');
    if (v.status !== 'PENDENTE') throw new AppError('Avaliação já enviada.');
    if (v.self_assessment && !v.self_submitted_at) throw new AppError('Aguarde a entrega da autoavaliação.');
    const criteria = await query<{ id: string; position: number; grp: string; title: string; weight: number }>(c, 'SELECT id, position, grp, title, weight FROM evaluation_criteria WHERE template_id = $1 ORDER BY position', [v.template_id]);
    const scores = await query<{ criterion_id: string; source: string; score: number; comment: string | null }>(c, 'SELECT criterion_id, source, score, comment FROM evaluation_scores WHERE evaluation_id = $1', [v.id]);
    const mine = (k: string, src: string) => scores.find((s) => s.criterion_id === k && s.source === src);
    if (criteria.some((k) => !mine(k.id, 'AVALIADOR'))) throw new AppError('Atribua nota a todos os critérios.');
    if (!v.feedback || v.feedback.trim().length < 10) throw new AppError('Registre o feedback ao avaliado.');
    const overall = weightedScore(criteria.map((k) => ({ score: mine(k.id, 'AVALIADOR')!.score, weight: k.weight })), v.scale_max);
    const pdi = await query<{ goal: string; action: string; due_date: string }>(c, 'SELECT goal, action, due_date FROM pdi_items WHERE evaluation_id = $1 AND status <> $2 ORDER BY created_at', [v.id, 'CANCELADO']);
    const content = {
      tipo: 'AVALIACAO', layout: 1, avaliacao: v.id, modelo: `${v.template_name} (versão ${v.template_version})`, periodo: v.period_label,
      avaliado: v.employee_name, setor: v.sector_name, avaliador: v.evaluator_name, escala: `1 a ${v.scale_max}`,
      criterios: criteria.map((k) => ({ criterio: k.title, grupo: k.grp, peso: k.weight, nota: mine(k.id, 'AVALIADOR')!.score, comentario: mine(k.id, 'AVALIADOR')!.comment,
        autoavaliacao: mine(k.id, 'AUTOAVALIACAO')?.score ?? null })),
      resultadoPonderado: overall, pontosFortes: v.strengths, aDesenvolver: v.improvements, feedback: v.feedback, pdi, ressalva: EVAL_DISCLAIMER,
    };
    const hash = sha256Hex(canonicalJson(content));
    let docId = v.document_id;
    if (!docId) {
      docId = (await queryOne<{ id: string }>(c, `INSERT INTO documents (category, title, confidentiality, owner_employee_id, sector_id, reference_type, reference_key, created_by)
        VALUES ('Avaliação de desempenho',$1,'RESTRITO',$2,$3,'AVALIACAO',$4,$5) RETURNING id`, [`Avaliação — ${v.period_label}`.slice(0, 200), v.employee_id, v.sector_id, v.id, ctx.principal.userId]))!.id;
    }
    const n = (await queryOne<{ n: number }>(c, 'SELECT coalesce(max(version_number),0)::int AS n FROM document_versions WHERE document_id = $1', [docId]))!.n;
    await query(c, 'INSERT INTO document_versions (document_id, version_number, content, content_sha256, created_by) VALUES ($1,$2,$3,$4,$5)', [docId, n + 1, JSON.stringify(content), hash, ctx.principal.userId]);
    await query(c, "UPDATE evaluations SET status = 'AGUARDANDO_CIENCIA', overall_score = $2, document_id = $3, sent_at = now() WHERE id = $1", [v.id, overall, docId]);
    await audit(c, ctx, { action: 'AVALIACAO_ENVIADA', entityType: 'evaluation', entityId: v.id, summary: `${v.employee_name}: versão ${n + 1} enviada para ciência (sha256 ${hash.slice(0, 16)}…)` });
    await notifyEmployee(c, v.employee_id, { kind: 'AVALIACAO', title: 'Sua avaliação está disponível para ciência', link: `/avaliacoes/${v.id}`, priority: 'ALTA' });
  });
}

/** Volta ao preenchimento (antes da ciência); o próximo envio gera nova versão e a anterior fica no histórico. */
export async function rectify(ctx: Ctx, id: string, reason: string): Promise<void> {
  const why = z.string().trim().min(5, 'Informe o motivo da retificação.').max(1000).parse(reason);
  await tx(async (c) => {
    const v = await loadEval(c, id, true);
    if (v.evaluator_user_id !== ctx.principal.userId && !can(ctx.principal, 'avaliacoes.gerenciar')) throw new ForbiddenError();
    if (v.status !== 'AGUARDANDO_CIENCIA') throw new AppError('Somente avaliação aguardando ciência pode ser retificada.');
    await query(c, "UPDATE evaluations SET status = 'PENDENTE', sent_at = NULL WHERE id = $1", [v.id]);
    await audit(c, ctx, { action: 'AVALIACAO_RETIFICACAO', entityType: 'evaluation', entityId: v.id, summary: why });
    await notifyEmployee(c, v.employee_id, { kind: 'AVALIACAO', title: 'Sua avaliação está em retificação', body: why, link: `/avaliacoes/${v.id}` });
  });
}

/** Manifestação do avaliado sobre a versão enviada: ciência (não implica concordância), concordância ou discordância motivada. */
export async function acknowledgeEvaluation(ctx: Ctx, id: string, act: 'CIENCIA' | 'CONCORDANCIA' | 'CONTESTACAO', comment: string | undefined, confirmed: boolean): Promise<void> {
  const a = z.enum(['CIENCIA', 'CONCORDANCIA', 'CONTESTACAO']).parse(act) as Act;
  if (!confirmed) throw new AppError('É necessário confirmar expressamente a manifestação.');
  if (a === 'CONTESTACAO' && (!comment || comment.trim().length < 5)) throw new AppError('Descreva os motivos da discordância.');
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    const v = await loadEval(c, id, true);
    if (v.employee_user_id !== ctx.principal.userId) throw new ForbiddenError('Somente o avaliado registra a manifestação.');
    if (v.status !== 'AGUARDANDO_CIENCIA') throw new AppError('A avaliação não aguarda sua manifestação.');
    const ver = await queryOne<{ id: string; version_number: number; content: unknown; content_sha256: string }>(c,
      'SELECT id, version_number, content, content_sha256 FROM document_versions WHERE document_id = $1 ORDER BY version_number DESC LIMIT 1', [v.document_id]);
    if (sha256Hex(canonicalJson(ver!.content)) !== ver!.content_sha256) throw new AppError('Falha de integridade do conteúdo. Operação bloqueada.', 500, 'INTEGRIDADE');
    await recordSignature(c, ctx, { id: ver!.id, contentSha256: ver!.content_sha256, title: `Avaliação — ${v.period_label}`, versionNumber: ver!.version_number }, a, comment?.trim() || null);
    await query(c, "UPDATE evaluations SET status = 'CONCLUIDA', closed_at = now() WHERE id = $1", [v.id]);
    await notifyUsers(c, [v.evaluator_user_id], { kind: 'AVALIACAO', title: `${v.employee_name} registrou ${a === 'CONTESTACAO' ? 'DISCORDÂNCIA' : a === 'CONCORDANCIA' ? 'concordância' : 'ciência'}`, link: `/avaliacoes/${v.id}`, priority: a === 'CONTESTACAO' ? 'ALTA' : 'NORMAL' });
  });
}

/** Sem manifestação no prazo configurado, o avaliador encerra registrando o motivo (ex.: recusa em dar ciência). */
export async function closeWithoutAcknowledgement(ctx: Ctx, id: string, notes: string): Promise<void> {
  const why = z.string().trim().min(5, 'Registre o motivo.').max(2000).parse(notes);
  await tx(async (c) => {
    const v = await loadEval(c, id, true);
    if (v.evaluator_user_id !== ctx.principal.userId && !can(ctx.principal, 'avaliacoes.gerenciar')) throw new ForbiddenError();
    if (v.employee_user_id === ctx.principal.userId) throw new ForbiddenError();
    if (v.status !== 'AGUARDANDO_CIENCIA') throw new AppError('A avaliação não aguarda ciência.');
    const days = await getNumberSetting(c, 'avaliacoes.prazo_ciencia_dias', 10);
    if (diffDays(todayLocal(), addDays(v.sent_at!.toISOString().slice(0, 10), days)) > 0) throw new AppError(`Aguarde ${days} dias do envio para encerrar sem ciência.`);
    await query(c, "UPDATE evaluations SET status = 'CONCLUIDA_SEM_CIENCIA', closed_at = now(), close_notes = $2 WHERE id = $1", [v.id, why]);
    await audit(c, ctx, { action: 'AVALIACAO_SEM_CIENCIA', entityType: 'evaluation', entityId: v.id, summary: why });
  });
}

export async function cancelEvaluation(ctx: Ctx, id: string, notes: string): Promise<void> {
  requirePermission(ctx, 'avaliacoes.gerenciar');
  const why = z.string().trim().min(5, 'Informe o motivo.').max(2000).parse(notes);
  await tx(async (c) => {
    const v = await loadEval(c, id, true);
    if (v.employee_user_id === ctx.principal.userId) throw new ForbiddenError();
    if (v.status !== 'PENDENTE' && v.status !== 'AGUARDANDO_CIENCIA') throw new AppError('Avaliação encerrada.');
    await query(c, "UPDATE evaluations SET status = 'CANCELADA', closed_at = now(), close_notes = $2 WHERE id = $1", [v.id, why]);
    await audit(c, ctx, { action: 'AVALIACAO_CANCELADA', entityType: 'evaluation', entityId: v.id, summary: why });
  });
}

export async function listEvaluations(ctx: Ctx, f: { scope?: 'minhas' | 'avaliar' | 'todas'; employeeId?: string } = {}) {
  const p = ctx.principal;
  const rows = await query<EvalRow>(getPool(), `${evalSelect} WHERE ($1::uuid IS NULL OR v.employee_id = $1) ORDER BY (v.status IN ('PENDENTE','AGUARDANDO_CIENCIA')) DESC, v.due_date DESC`, [f.employeeId ?? null]);
  return rows.filter((v) => {
    const r = roleIn(p, v);
    if (f.scope === 'minhas') return r.self && v.status !== 'CANCELADA' && (v.status !== 'PENDENTE' || v.self_assessment);
    if (f.scope === 'avaliar') return r.evaluator;
    return r.evaluator || r.manager || r.sectorLead || (r.self && (v.status !== 'PENDENTE' || v.self_assessment));
  }).map((v) => {
    const r = roleIn(p, v);
    // O avaliado não vê o rascunho do avaliador.
    return r.self && v.status === 'PENDENTE' ? { ...v, strengths: null, improvements: null, feedback: null, overall_score: null } : v;
  });
}

export async function getEvaluation(ctx: Ctx, id: string) {
  const db = getPool();
  const v = await loadEval(db, id);
  const r = roleIn(ctx.principal, v);
  if (!r.evaluator && !r.manager && !r.sectorLead && !(r.self && (v.status !== 'PENDENTE' || v.self_assessment))) throw new NotFoundError('Avaliação não encontrada.');
  const hideEvaluator = r.self && v.status === 'PENDENTE';
  const criteria = await query<{ id: string; position: number; grp: string; title: string; description: string | null; weight: number }>(db,
    'SELECT id, position, grp, title, description, weight FROM evaluation_criteria WHERE template_id = $1 ORDER BY position', [v.template_id]);
  const scores = (await query<{ criterion_id: string; source: string; score: number; comment: string | null }>(db, 'SELECT criterion_id, source, score, comment FROM evaluation_scores WHERE evaluation_id = $1', [v.id]))
    // A autoavaliação só aparece para o avaliador depois de entregue.
    .filter((s) => (s.source === 'AVALIADOR' ? !hideEvaluator : r.self || !!v.self_submitted_at));
  const versions = v.document_id ? await query<{ id: string; version_number: number; content: Record<string, unknown>; content_sha256: string; created_at: Date }>(db,
    'SELECT id, version_number, content, content_sha256, created_at FROM document_versions WHERE document_id = $1 ORDER BY version_number DESC', [v.document_id]) : [];
  const signatures = versions.length ? await query<{ version_id: string; act: string; comment: string | null; signed_at: Date; statement: string; signer_name: string }>(db,
    `SELECT s.document_version_id AS version_id, s.act, s.comment, s.signed_at, s.statement, u.display_name AS signer_name FROM signatures s JOIN users u ON u.id = s.signer_user_id
      WHERE s.document_version_id = ANY($1::uuid[]) ORDER BY s.signed_at`, [versions.map((x) => x.id)]) : [];
  const pdi = await listPdi(db, { evaluationId: v.id });
  const ackDays = await getNumberSetting(db, 'avaliacoes.prazo_ciencia_dias', 10);
  const masked = hideEvaluator ? { ...v, strengths: null, improvements: null, feedback: null, overall_score: null } : v;
  return { evaluation: masked, role: r, criteria, scores, versions, signatures, pdi, ackDays };
}

// ---------------------------------------------------------------------------
// PDI e feedbacks
// ---------------------------------------------------------------------------

async function listPdi(db: Db, f: { evaluationId?: string; employeeId?: string }) {
  return query<{ id: string; evaluation_id: string | null; employee_id: string; goal: string; action: string; training_id: string | null; training_title: string | null; due_date: string; status: string; result_notes: string | null }>(db,
    `SELECT p.id, p.evaluation_id, p.employee_id, p.goal, p.action, p.training_id, t.title AS training_title, p.due_date, p.status, p.result_notes
       FROM pdi_items p LEFT JOIN trainings t ON t.id = p.training_id WHERE ($1::uuid IS NULL OR p.evaluation_id = $1) AND ($2::uuid IS NULL OR p.employee_id = $2) ORDER BY p.due_date`,
    [f.evaluationId ?? null, f.employeeId ?? null]);
}

async function requireLead(c: Db, ctx: Ctx, employeeId: string) {
  const e = await queryOne<{ id: string; sector_id: string; user_id: string | null }>(c, 'SELECT id, sector_id, user_id FROM employees WHERE id = $1', [employeeId]);
  if (!e) throw new NotFoundError('Funcionário não encontrado.');
  if (e.user_id === ctx.principal.userId) throw new ForbiddenError();
  if (!can(ctx.principal, 'avaliacoes.gerenciar') && !can(ctx.principal, 'avaliacoes.avaliar', { sectorId: e.sector_id, employeeId: e.id })) throw new ForbiddenError();
  return e;
}

const pdiSchema = z.object({ evaluationId: z.uuid().optional(), employeeId: z.uuid(), goal: z.string().trim().min(3).max(500), action: z.string().trim().min(3).max(1000), trainingId: z.uuid().optional(), dueDate: z.iso.date() });

/** Item do PDI; com treinamento recomendado, a pessoa é inscrita nele (sem turma). */
export async function addPdiItem(ctx: Ctx, input: z.input<typeof pdiSchema>): Promise<string> {
  const d = pdiSchema.parse(input);
  return tx(async (c) => {
    const e = await requireLead(c, ctx, d.employeeId);
    if (d.evaluationId) {
      const v = await loadEval(c, d.evaluationId);
      if (v.employee_id !== e.id) throw new AppError('A avaliação é de outra pessoa.');
      if (v.status !== 'PENDENTE') throw new AppError('Itens do PDI desta avaliação são incluídos antes do envio.');
    }
    const r = await queryOne<{ id: string }>(c, 'INSERT INTO pdi_items (evaluation_id, employee_id, goal, action, training_id, due_date, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [d.evaluationId ?? null, e.id, d.goal, d.action, d.trainingId ?? null, d.dueDate, ctx.principal.userId]);
    if (d.trainingId) {
      await query(c, `INSERT INTO training_records (training_id, employee_id, status, source, notes, submitted_by) VALUES ($1,$2,'INSCRITO','INSCRICAO','Recomendado no PDI',$3)
        ON CONFLICT (training_id, employee_id) WHERE status IN ('INSCRITO','PENDENTE_VALIDACAO') DO NOTHING`, [d.trainingId, e.id, ctx.principal.userId]);
    }
    await audit(c, ctx, { action: 'PDI_ITEM', entityType: 'pdi_item', entityId: r!.id, summary: d.goal });
    if (!d.evaluationId) await notifyEmployee(c, e.id, { kind: 'AVALIACAO', title: 'Novo item no seu plano de desenvolvimento', body: d.goal, link: '/avaliacoes' });
    return r!.id;
  });
}

/** O avaliado acompanha (em andamento); a conclusão ou o cancelamento é registrado pela liderança. */
export async function updatePdiItem(ctx: Ctx, id: string, status: 'EM_ANDAMENTO' | 'CONCLUIDO' | 'CANCELADO', notes?: string): Promise<void> {
  const st = z.enum(['EM_ANDAMENTO', 'CONCLUIDO', 'CANCELADO']).parse(status);
  await tx(async (c) => {
    const it = await queryOne<{ id: string; employee_id: string; status: string; goal: string }>(c, 'SELECT id, employee_id, status, goal FROM pdi_items WHERE id = $1 FOR UPDATE', [z.uuid().parse(id)]);
    if (!it) throw new NotFoundError('Item não encontrado.');
    if (it.status === 'CONCLUIDO' || it.status === 'CANCELADO') throw new AppError('Item encerrado.');
    const own = ctx.principal.employeeId === it.employee_id;
    if (st === 'EM_ANDAMENTO') { if (!own) await requireLead(c, ctx, it.employee_id); } else await requireLead(c, ctx, it.employee_id);
    if (st !== 'EM_ANDAMENTO' && (!notes || notes.trim().length < 3)) throw new AppError('Registre o resultado.');
    await query(c, 'UPDATE pdi_items SET status = $2, result_notes = coalesce($3, result_notes), updated_at = now() WHERE id = $1', [it.id, st, notes?.trim() || null]);
    await audit(c, ctx, { action: 'PDI_' + st, entityType: 'pdi_item', entityId: it.id, summary: it.goal });
  });
}

export async function addFeedback(ctx: Ctx, employeeId: string, kind: 'RECONHECIMENTO' | 'ORIENTACAO' | 'ALINHAMENTO', content: string): Promise<string> {
  const k = z.enum(['RECONHECIMENTO', 'ORIENTACAO', 'ALINHAMENTO']).parse(kind);
  const text = z.string().trim().min(5).max(4000).parse(content);
  return tx(async (c) => {
    const e = await requireLead(c, ctx, z.uuid().parse(employeeId));
    const r = await queryOne<{ id: string }>(c, 'INSERT INTO feedback_notes (employee_id, author_user_id, kind, content) VALUES ($1,$2,$3,$4) RETURNING id', [e.id, ctx.principal.userId, k, text]);
    await audit(c, ctx, { action: 'FEEDBACK_REGISTRADO', entityType: 'feedback', entityId: r!.id, summary: k });
    await notifyEmployee(c, e.id, { kind: 'AVALIACAO', title: 'Você recebeu um feedback documentado', link: '/avaliacoes' });
    return r!.id;
  });
}

export async function acknowledgeFeedback(ctx: Ctx, id: string, comment?: string): Promise<void> {
  await tx(async (c) => {
    const f = await queryOne<{ id: string; employee_id: string; acknowledged_at: Date | null; author_user_id: string }>(c, 'SELECT id, employee_id, acknowledged_at, author_user_id FROM feedback_notes WHERE id = $1 FOR UPDATE', [z.uuid().parse(id)]);
    if (!f || f.employee_id !== ctx.principal.employeeId) throw new NotFoundError('Feedback não encontrado.');
    if (f.acknowledged_at) throw new AppError('Ciência já registrada.');
    await query(c, 'UPDATE feedback_notes SET acknowledged_at = now(), employee_comment = $2 WHERE id = $1', [f.id, comment?.trim().slice(0, 2000) || null]);
    await audit(c, ctx, { action: 'FEEDBACK_CIENCIA', entityType: 'feedback', entityId: f.id, summary: 'Ciência do feedback' });
    await notifyUsers(c, [f.author_user_id], { kind: 'AVALIACAO', title: 'Ciência registrada no feedback', link: '/avaliacoes?aba=equipe' });
  });
}

/** Histórico da pessoa: avaliações, PDI e feedbacks — para o próprio, para a liderança com escopo e para a gestão. */
export async function developmentHistory(ctx: Ctx, employeeId: string) {
  const db = getPool();
  z.uuid().parse(employeeId);
  if (ctx.principal.employeeId !== employeeId) await requireLead(db, ctx, employeeId);
  const evaluations = (await listEvaluations(ctx, { employeeId })).filter((v) => v.status !== 'PENDENTE' || v.evaluator_user_id === ctx.principal.userId);
  const feedbacks = await query<{ id: string; kind: string; content: string; created_at: Date; author_name: string; acknowledged_at: Date | null; employee_comment: string | null }>(db,
    'SELECT f.id, f.kind, f.content, f.created_at, u.display_name AS author_name, f.acknowledged_at, f.employee_comment FROM feedback_notes f JOIN users u ON u.id = f.author_user_id WHERE f.employee_id = $1 ORDER BY f.created_at DESC', [employeeId]);
  return { evaluations, feedbacks, pdi: await listPdi(db, { employeeId }) };
}

export async function evaluablePeople(ctx: Ctx) {
  const rows = await query<{ id: string; full_name: string; sector_id: string; sector_name: string; user_id: string | null }>(getPool(),
    "SELECT e.id, e.full_name, e.sector_id, s.name AS sector_name, e.user_id FROM employees e JOIN sectors s ON s.id = e.sector_id WHERE e.status <> 'DESLIGADO' ORDER BY e.full_name");
  return rows.filter((e) => e.user_id !== ctx.principal.userId && (can(ctx.principal, 'avaliacoes.gerenciar') || can(ctx.principal, 'avaliacoes.avaliar', { sectorId: e.sector_id, employeeId: e.id })));
}

export async function evaluators(ctx: Ctx) {
  requirePermission(ctx, 'avaliacoes.gerenciar');
  return usersWithPermission(getPool(), 'avaliacoes.avaliar', ANY_SECTOR);
}

// ---------------------------------------------------------------------------
// Lembretes: prazo do avaliador, autoavaliação e ciência pendentes — uma vez por chave.
// ---------------------------------------------------------------------------

export async function processEvaluationReminders(db: Db = getPool()): Promise<number> {
  const today = todayLocal();
  let sent = 0;
  const once = async (key: string, users: string[], n: Parameters<typeof notifyUsers>[2]) => {
    if (!users.length) return;
    await tx(async (c) => {
      if (!(await queryOne(c, 'INSERT INTO reminder_log (key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING key', [key]))) return;
      await notifyUsers(c, users, n);
      sent++;
    });
  };
  for (const v of await query<{ id: string; due_date: string; evaluator_user_id: string; employee_user_id: string | null; self_assessment: boolean; self_submitted_at: Date | null; employee_name: string }>(db,
    `SELECT v.id, v.due_date, v.evaluator_user_id, e.user_id AS employee_user_id, t.self_assessment, v.self_submitted_at, e.full_name AS employee_name
       FROM evaluations v JOIN employees e ON e.id = v.employee_id JOIN evaluation_templates t ON t.id = v.template_id WHERE v.status = 'PENDENTE' AND v.due_date <= $1`, [addDays(today, 3)])) {
    const late = v.due_date < today;
    await once(`aval:${v.id}:${late ? 'atrasada' : 'prazo'}`, [v.evaluator_user_id], { kind: 'AVALIACAO', title: late ? `Avaliação em atraso: ${v.employee_name}` : `Avaliação vence em ${v.due_date}: ${v.employee_name}`, link: `/avaliacoes/${v.id}`, priority: late ? 'ALTA' : 'NORMAL' });
    if (v.self_assessment && !v.self_submitted_at && v.employee_user_id) {
      await once(`aval:${v.id}:auto`, [v.employee_user_id], { kind: 'AVALIACAO', title: 'Sua autoavaliação está pendente', link: `/avaliacoes/${v.id}` });
    }
  }
  for (const v of await query<{ id: string; employee_user_id: string | null }>(db,
    "SELECT v.id, e.user_id AS employee_user_id FROM evaluations v JOIN employees e ON e.id = v.employee_id WHERE v.status = 'AGUARDANDO_CIENCIA' AND v.sent_at < now() - interval '3 days'")) {
    if (v.employee_user_id) await once(`aval:${v.id}:ciencia`, [v.employee_user_id], { kind: 'AVALIACAO', title: 'Avaliação aguardando sua manifestação', link: `/avaliacoes/${v.id}` });
  }
  return sent;
}
