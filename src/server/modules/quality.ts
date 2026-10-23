import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx, Principal } from '../context.ts';
import { can, requirePermission } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors.ts';
import { checkFile } from '../files.ts';
import { addMonths, todayLocal } from '../../domain/time.ts';
import { riskBand, sequenceCode, type ReqStatus } from '../../domain/quality.ts';
import { createTask } from './tasks.ts';
import { notifyUsers } from './notifications.ts';
import { discardUnsaved, insertStoredFile, prepareFile } from './fileStore.ts';
import { maxFileBytes } from './repository.ts';

// Qualidade e conformidade (Fase 5a): requisitos, auditorias internas, não conformidades, ações e riscos.
// Apoio à gestão e ao PQTA — o sistema não declara conformidade nem certificação; nenhum requisito é presumido.

export async function nextCode(c: Db, prefix: string): Promise<string> {
  const year = Number(todayLocal().slice(0, 4));
  const r = await queryOne<{ last: number }>(c,
    `INSERT INTO quality_counters (prefix, year, last) VALUES ($1,$2,1) ON CONFLICT (prefix, year) DO UPDATE SET last = quality_counters.last + 1 RETURNING last`, [prefix, year]);
  return sequenceCode(prefix, year, r!.last);
}

const canView = (p: Principal) => p.isOwner || can(p, 'qualidade.ver') || can(p, 'qualidade.gerenciar') || can(p, 'qualidade.auditar');
function requireView(ctx: Ctx) { if (!canView(ctx.principal)) throw new ForbiddenError(); }
async function activeUser(c: Db, id: string, label: string) {
  if (!(await queryOne(c, "SELECT 1 FROM users WHERE id = $1 AND status = 'ATIVO'", [id]))) throw new AppError(`${label}: usuário inexistente ou inativo.`);
}

// ---------------------------------------------------------------------------
// Requisitos e evidências
// ---------------------------------------------------------------------------

const reqSchema = z.object({
  id: z.uuid().optional(),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._/-]{0,29}$/, 'Código inválido.'),
  title: z.string().trim().min(3).max(300),
  source: z.string().trim().min(3).max(500),
  area: z.string().trim().min(2).max(60),
  ownerUserId: z.uuid(),
  reviewMonths: z.number().int().min(1).max(60).default(12),
  active: z.boolean().default(true),
});

export async function saveRequirement(ctx: Ctx, input: z.input<typeof reqSchema>): Promise<string> {
  requirePermission(ctx, 'qualidade.gerenciar');
  const d = reqSchema.parse(input);
  return tx(async (c) => {
    await activeUser(c, d.ownerUserId, 'Responsável');
    const r = await (d.id
      ? queryOne<{ id: string }>(c, 'UPDATE quality_requirements SET code=$1, title=$2, source=$3, area=$4, owner_user_id=$5, review_months=$6, active=$7 WHERE id=$8 RETURNING id',
          [d.code, d.title, d.source, d.area, d.ownerUserId, d.reviewMonths, d.active, d.id])
      : queryOne<{ id: string }>(c, 'INSERT INTO quality_requirements (code, title, source, area, owner_user_id, review_months, active, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
          [d.code, d.title, d.source, d.area, d.ownerUserId, d.reviewMonths, d.active, ctx.principal.userId])
    ).catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('Já existe requisito com este código.'); throw e; });
    if (!r) throw new NotFoundError('Requisito não encontrado.');
    await audit(c, ctx, { action: d.id ? 'QUALIDADE_REQUISITO_ALTERADO' : 'QUALIDADE_REQUISITO_CRIADO', entityType: 'quality_requirement', entityId: r.id, summary: `${d.code} — ${d.title}` });
    return r.id;
  });
}

/** Avaliação do requisito (histórico imutável). Parcial, não atendido e não aplicável exigem justificativa. */
export async function reviewRequirement(ctx: Ctx, id: string, status: ReqStatus, notes?: string): Promise<void> {
  z.uuid().parse(id);
  const st = z.enum(['ATENDIDO', 'PARCIAL', 'NAO_ATENDIDO', 'NAO_APLICAVEL']).parse(status);
  await tx(async (c) => {
    const r = await queryOne<{ owner_user_id: string; review_months: number; code: string }>(c, 'SELECT owner_user_id, review_months, code FROM quality_requirements WHERE id = $1 FOR UPDATE', [id]);
    if (!r) throw new NotFoundError('Requisito não encontrado.');
    if (r.owner_user_id !== ctx.principal.userId && !can(ctx.principal, 'qualidade.gerenciar') && !can(ctx.principal, 'qualidade.auditar')) throw new ForbiddenError();
    if (st !== 'ATENDIDO' && (!notes || notes.trim().length < 3)) throw new AppError('Justifique a avaliação.');
    if (st === 'ATENDIDO' && !(await queryOne(c, 'SELECT 1 FROM requirement_evidences WHERE requirement_id = $1', [id]))) {
      throw new AppError('Para considerar atendido, registre ao menos uma evidência.');
    }
    await applyReview(c, ctx, id, st, notes?.trim() || null, r.review_months);
    await audit(c, ctx, { action: 'QUALIDADE_REQUISITO_AVALIADO', entityType: 'quality_requirement', entityId: id, summary: `${r.code}: ${st}` });
  });
}

async function applyReview(c: Db, ctx: Ctx, id: string, st: ReqStatus, notes: string | null, months: number) {
  await query(c, `UPDATE quality_requirements SET status=$2, status_notes=$3, last_reviewed_at=now(), last_reviewed_by=$4, next_review_on=$5 WHERE id=$1`,
    [id, st, notes, ctx.principal.userId, addMonths(todayLocal(), months)]);
  await query(c, 'INSERT INTO requirement_reviews (requirement_id, status, notes, reviewed_by) VALUES ($1,$2,$3,$4)', [id, st, notes, ctx.principal.userId]);
}

export async function addRequirementEvidence(ctx: Ctx, id: string, input: { description: string; documentId?: string | null }, file?: { name: string; bytes: Uint8Array } | null): Promise<void> {
  z.uuid().parse(id);
  const d = z.object({ description: z.string().trim().min(3).max(1000), documentId: z.uuid().nullable().optional() }).parse(input);
  const r = await queryOne<{ owner_user_id: string }>(getPool(), 'SELECT owner_user_id FROM quality_requirements WHERE id = $1', [id]);
  if (!r) throw new NotFoundError('Requisito não encontrado.');
  if (r.owner_user_id !== ctx.principal.userId && !can(ctx.principal, 'qualidade.gerenciar') && !can(ctx.principal, 'qualidade.auditar')) throw new ForbiddenError();
  if (d.documentId && !(await queryOne(getPool(), "SELECT 1 FROM documents WHERE id = $1 AND reference_type = 'REPOSITORIO'", [d.documentId]))) throw new AppError('Documento do repositório inexistente.');
  const prepared = file && file.bytes.byteLength ? await prepareFile(ctx, checkFile(file.name, file.bytes, await maxFileBytes()), file.bytes) : null;
  await tx(async (c) => {
    const fileId = prepared ? await insertStoredFile(c, ctx, prepared) : null;
    await query(c, 'INSERT INTO requirement_evidences (requirement_id, description, document_id, file_id, added_by) VALUES ($1,$2,$3,$4,$5)',
      [id, d.description, d.documentId ?? null, fileId, ctx.principal.userId]);
  }).catch(async (e) => { await discardUnsaved(prepared); throw e; });
}

export async function listRequirements(ctx: Ctx) {
  requireView(ctx);
  return query<{ id: string; code: string; title: string; source: string; area: string; owner_user_id: string; owner_name: string; status: ReqStatus; status_notes: string | null;
    last_reviewed_at: Date | null; next_review_on: string | null; review_months: number; active: boolean; evidences: number }>(getPool(),
    `SELECT q.id, q.code, q.title, q.source, q.area, q.owner_user_id, u.display_name AS owner_name, q.status, q.status_notes, q.last_reviewed_at, q.next_review_on, q.review_months, q.active,
            (SELECT count(*)::int FROM requirement_evidences e WHERE e.requirement_id = q.id) AS evidences
       FROM quality_requirements q JOIN users u ON u.id = q.owner_user_id ORDER BY q.active DESC, q.area, q.code`);
}

export async function getRequirement(ctx: Ctx, id: string) {
  requireView(ctx);
  z.uuid().parse(id);
  const db = getPool();
  const evidences = await query<{ id: string; description: string; document_id: string | null; document_title: string | null; file_id: string | null; filename: string | null; added_by_name: string; added_at: Date }>(db,
    `SELECT e.id, e.description, e.document_id, d.title AS document_title, e.file_id, f.filename, u.display_name AS added_by_name, e.added_at
       FROM requirement_evidences e LEFT JOIN documents d ON d.id = e.document_id LEFT JOIN document_files f ON f.id = e.file_id JOIN users u ON u.id = e.added_by
      WHERE e.requirement_id = $1 ORDER BY e.added_at DESC`, [id]);
  const reviews = await query<{ status: string; notes: string | null; reviewed_by_name: string; reviewed_at: Date }>(db,
    'SELECT r.status, r.notes, u.display_name AS reviewed_by_name, r.reviewed_at FROM requirement_reviews r JOIN users u ON u.id = r.reviewed_by WHERE r.requirement_id = $1 ORDER BY r.reviewed_at DESC', [id]);
  return { evidences, reviews };
}

// ---------------------------------------------------------------------------
// Auditorias internas
// ---------------------------------------------------------------------------

const auditSchema = z.object({
  title: z.string().trim().min(3).max(200),
  kind: z.enum(['INTERNA', 'DOCUMENTAL', 'SEGURANCA_INFORMACAO', 'LGPD', 'PROCESSOS', 'OUTRA']),
  scope: z.string().trim().min(3).max(2000),
  auditedSectorId: z.uuid().nullable().optional(),
  leadAuditorId: z.uuid(),
  plannedDate: z.iso.date(),
  importArea: z.string().trim().max(60).optional(),
  questions: z.array(z.string().trim().min(3).max(500)).max(100).default([]),
});

async function userSector(c: Db, userId: string): Promise<string | null> {
  return (await queryOne<{ sector_id: string }>(c, "SELECT sector_id FROM employees WHERE user_id = $1 AND status <> 'DESLIGADO'", [userId]))?.sector_id ?? null;
}

/** Independência: o auditor líder não pertence ao setor auditado (salvo a Oficial). */
async function assertIndependent(c: Db, auditorId: string, sectorId: string | null) {
  if (!sectorId) return;
  const owner = (await queryOne<{ is_owner: boolean }>(c, 'SELECT is_owner FROM users WHERE id = $1', [auditorId]))?.is_owner;
  if (!owner && (await userSector(c, auditorId)) === sectorId) throw new AppError('Independência: o auditor líder não pode pertencer ao setor auditado.');
}

export async function createAudit(ctx: Ctx, input: z.input<typeof auditSchema>): Promise<string> {
  requirePermission(ctx, 'qualidade.auditar');
  const d = auditSchema.parse(input);
  return tx(async (c) => {
    await activeUser(c, d.leadAuditorId, 'Auditor líder');
    await assertIndependent(c, d.leadAuditorId, d.auditedSectorId ?? null);
    const code = await nextCode(c, 'AUD');
    const a = await queryOne<{ id: string }>(c, `INSERT INTO audits (code, title, kind, scope, audited_sector_id, lead_auditor_id, planned_date, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [code, d.title, d.kind, d.scope, d.auditedSectorId ?? null, d.leadAuditorId, d.plannedDate, ctx.principal.userId]);
    let pos = 0;
    if (d.importArea) {
      for (const r of await query<{ id: string; code: string; title: string }>(c, 'SELECT id, code, title FROM quality_requirements WHERE active AND area = $1 ORDER BY code', [d.importArea])) {
        await query(c, 'INSERT INTO audit_items (audit_id, position, question, requirement_id) VALUES ($1,$2,$3,$4)', [a!.id, ++pos, `${r.code} — ${r.title}`, r.id]);
      }
    }
    for (const q of d.questions) await query(c, 'INSERT INTO audit_items (audit_id, position, question) VALUES ($1,$2,$3)', [a!.id, ++pos, q]);
    await audit(c, ctx, { action: 'AUDITORIA_PLANEJADA', entityType: 'audit', entityId: a!.id, summary: `${code} — ${d.title} (${pos} itens)` });
    if (d.leadAuditorId !== ctx.principal.userId) await notifyUsers(c, [d.leadAuditorId], { kind: 'AUDITORIA', title: `Você é o(a) auditor(a) líder de ${code}`, body: d.title, link: `/qualidade/auditorias/${a!.id}` });
    return a!.id;
  });
}

async function loadAudit(c: Db, id: string, lock = false) {
  z.uuid().parse(id);
  const a = await queryOne<{ id: string; code: string; title: string; status: string; lead_auditor_id: string; audited_sector_id: string | null; created_by: string }>(c,
    `SELECT id, code, title, status, lead_auditor_id, audited_sector_id, created_by FROM audits WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!a) throw new NotFoundError('Auditoria não encontrada.');
  return a;
}

/** Quem conduz: auditor líder ou outro auditor de fora do setor auditado. */
async function assertAuditor(c: Db, ctx: Ctx, a: { lead_auditor_id: string; audited_sector_id: string | null }) {
  if (a.lead_auditor_id === ctx.principal.userId) return;
  requirePermission(ctx, 'qualidade.auditar');
  if (!ctx.principal.isOwner && a.audited_sector_id && ctx.principal.employeeSectorId === a.audited_sector_id) throw new ForbiddenError('Independência: integrantes do setor auditado não avaliam os itens.');
}

export async function addAuditItem(ctx: Ctx, auditId: string, question: string): Promise<void> {
  const q = z.string().trim().min(3).max(500).parse(question);
  await tx(async (c) => {
    const a = await loadAudit(c, auditId, true);
    await assertAuditor(c, ctx, a);
    await query(c, 'INSERT INTO audit_items (audit_id, position, question) VALUES ($1,(SELECT coalesce(max(position),0)+1 FROM audit_items WHERE audit_id=$1),$2)', [auditId, q]);
  });
}

export async function startAudit(ctx: Ctx, auditId: string): Promise<void> {
  await tx(async (c) => {
    const a = await loadAudit(c, auditId, true);
    await assertAuditor(c, ctx, a);
    if (a.status !== 'PLANEJADA') throw new AppError('Auditoria não está planejada.');
    if (!(await queryOne(c, 'SELECT 1 FROM audit_items WHERE audit_id = $1', [auditId]))) throw new AppError('Inclua os itens do checklist antes de iniciar.');
    await query(c, "UPDATE audits SET status = 'EM_EXECUCAO' WHERE id = $1", [auditId]);
    await audit(c, ctx, { action: 'AUDITORIA_INICIADA', entityType: 'audit', entityId: auditId, summary: `${a.code} iniciada` });
  });
}

const evalSchema = z.object({
  itemId: z.uuid(),
  result: z.enum(['CONFORME', 'NAO_CONFORME', 'OBSERVACAO', 'NAO_APLICAVEL']),
  evidence: z.string().trim().max(3000).optional(),
  ncSeverity: z.enum(['MENOR', 'MAIOR', 'CRITICA']).default('MENOR'),
  ncResponsibleId: z.uuid().optional(),
});

/** Avalia um item; NÃO CONFORME gera automaticamente a não conformidade vinculada. */
export async function evaluateAuditItem(ctx: Ctx, input: z.input<typeof evalSchema>, file?: { name: string; bytes: Uint8Array } | null): Promise<void> {
  const d = evalSchema.parse(input);
  if ((d.result === 'NAO_CONFORME' || d.result === 'OBSERVACAO') && (!d.evidence || d.evidence.length < 3)) throw new AppError('Descreva a evidência objetiva.');
  const prepared = file && file.bytes.byteLength ? await prepareFile(ctx, checkFile(file.name, file.bytes, await maxFileBytes()), file.bytes) : null;
  await tx(async (c) => {
    const it = await queryOne<{ audit_id: string; question: string; result: string }>(c, 'SELECT audit_id, question, result FROM audit_items WHERE id = $1 FOR UPDATE', [d.itemId]);
    if (!it) throw new NotFoundError('Item não encontrado.');
    const a = await loadAudit(c, it.audit_id, true);
    await assertAuditor(c, ctx, a);
    if (a.status !== 'EM_EXECUCAO') throw new AppError('Inicie a auditoria para avaliar os itens.');
    if (it.result === 'NAO_CONFORME') throw new AppError('Item já registrado como não conforme (a não conformidade foi aberta).');
    const fileId = prepared ? await insertStoredFile(c, ctx, prepared) : null;
    await query(c, 'UPDATE audit_items SET result=$2, evidence=$3, file_id=coalesce($4, file_id), evaluated_by=$5, evaluated_at=now() WHERE id=$1',
      [d.itemId, d.result, d.evidence ?? null, fileId, ctx.principal.userId]);
    if (d.result === 'NAO_CONFORME') {
      const responsible = d.ncResponsibleId ?? a.created_by;
      await activeUser(c, responsible, 'Responsável pela não conformidade');
      await openNc(c, ctx, { origin: 'AUDITORIA', auditItemId: d.itemId, description: `${a.code} — ${it.question}: ${d.evidence}`, severity: d.ncSeverity, sectorId: a.audited_sector_id, responsibleUserId: responsible });
    }
  }).catch(async (e) => { await discardUnsaved(prepared); throw e; });
}

export async function concludeAudit(ctx: Ctx, auditId: string, conclusion: string): Promise<void> {
  if (conclusion.trim().length < 5) throw new AppError('Registre a conclusão da auditoria.');
  await tx(async (c) => {
    const a = await loadAudit(c, auditId, true);
    if (a.lead_auditor_id !== ctx.principal.userId && !ctx.principal.isOwner) throw new ForbiddenError('Somente o auditor líder conclui a auditoria.');
    if (a.status !== 'EM_EXECUCAO') throw new AppError('Auditoria não está em execução.');
    const pending = (await queryOne<{ n: number }>(c, "SELECT count(*)::int AS n FROM audit_items WHERE audit_id = $1 AND result = 'PENDENTE'", [auditId]))!.n;
    if (pending) throw new AppError(`Há ${pending} item(ns) sem avaliação.`);
    // Itens ligados a requisitos atualizam a avaliação do requisito (com histórico).
    for (const it of await query<{ requirement_id: string; result: string; evidence: string | null; review_months: number }>(c,
      `SELECT i.requirement_id, i.result, i.evidence, q.review_months FROM audit_items i JOIN quality_requirements q ON q.id = i.requirement_id
        WHERE i.audit_id = $1 AND i.result <> 'PENDENTE'`, [auditId])) {
      // Observação não é não conformidade: o requisito é tido como atendido, com a observação registrada no histórico.
      const st: ReqStatus = it.result === 'NAO_CONFORME' ? 'NAO_ATENDIDO' : it.result === 'NAO_APLICAVEL' ? 'NAO_APLICAVEL' : 'ATENDIDO';
      const kind = it.result === 'OBSERVACAO' ? ' (observação)' : '';
      await applyReview(c, ctx, it.requirement_id, st, `Auditoria ${a.code}${kind}${it.evidence ? `: ${it.evidence}` : ''}`, it.review_months);
    }
    await query(c, "UPDATE audits SET status='CONCLUIDA', conclusion=$2, concluded_at=now() WHERE id=$1", [auditId, conclusion.trim()]);
    await audit(c, ctx, { action: 'AUDITORIA_CONCLUIDA', entityType: 'audit', entityId: auditId, summary: `${a.code} concluída` });
  });
}

export async function listAudits(ctx: Ctx) {
  requireView(ctx);
  return query<{ id: string; code: string; title: string; kind: string; status: string; planned_date: string; lead_name: string; sector_name: string | null; items: number; nc: number; pending: number }>(getPool(),
    `SELECT a.id, a.code, a.title, a.kind, a.status, a.planned_date, u.display_name AS lead_name, s.name AS sector_name,
            (SELECT count(*)::int FROM audit_items i WHERE i.audit_id = a.id) AS items,
            (SELECT count(*)::int FROM audit_items i WHERE i.audit_id = a.id AND i.result = 'NAO_CONFORME') AS nc,
            (SELECT count(*)::int FROM audit_items i WHERE i.audit_id = a.id AND i.result = 'PENDENTE') AS pending
       FROM audits a JOIN users u ON u.id = a.lead_auditor_id LEFT JOIN sectors s ON s.id = a.audited_sector_id ORDER BY a.planned_date DESC`);
}

export async function getAudit(ctx: Ctx, id: string) {
  requireView(ctx);
  const db = getPool();
  const a = await queryOne<{ id: string; code: string; title: string; kind: string; scope: string; status: string; planned_date: string; conclusion: string | null; concluded_at: Date | null;
    lead_auditor_id: string; lead_name: string; audited_sector_id: string | null; sector_name: string | null }>(db,
    `SELECT a.*, u.display_name AS lead_name, s.name AS sector_name FROM audits a JOIN users u ON u.id = a.lead_auditor_id LEFT JOIN sectors s ON s.id = a.audited_sector_id WHERE a.id = $1`, [z.uuid().parse(id)]);
  if (!a) throw new NotFoundError('Auditoria não encontrada.');
  const items = await query<{ id: string; position: number; question: string; result: string; evidence: string | null; file_id: string | null; evaluated_by_name: string | null; nc_id: string | null; nc_code: string | null }>(db,
    `SELECT i.id, i.position, i.question, i.result, i.evidence, i.file_id, u.display_name AS evaluated_by_name, n.id AS nc_id, n.code AS nc_code
       FROM audit_items i LEFT JOIN users u ON u.id = i.evaluated_by LEFT JOIN nonconformities n ON n.audit_item_id = i.id WHERE i.audit_id = $1 ORDER BY i.position`, [id]);
  const p = ctx.principal;
  const conduct = a.lead_auditor_id === p.userId || ((p.isOwner || can(p, 'qualidade.auditar')) && (p.isOwner || !a.audited_sector_id || p.employeeSectorId !== a.audited_sector_id));
  return { audit: a, items, canConduct: conduct && (a.status === 'PLANEJADA' || a.status === 'EM_EXECUCAO') };
}

// ---------------------------------------------------------------------------
// Não conformidades e ações
// ---------------------------------------------------------------------------

type NcInput = { origin: 'AUDITORIA' | 'INCIDENTE' | 'RECLAMACAO' | 'AUTOAVALIACAO' | 'OUTRA'; auditItemId?: string; incidentId?: string; description: string; severity: 'MENOR' | 'MAIOR' | 'CRITICA'; sectorId: string | null; responsibleUserId: string };

async function openNc(c: Db, ctx: Ctx, d: NcInput): Promise<string> {
  const code = await nextCode(c, 'NC');
  const r = await queryOne<{ id: string }>(c, `INSERT INTO nonconformities (code, origin, audit_item_id, incident_id, description, severity, sector_id, responsible_user_id, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [code, d.origin, d.auditItemId ?? null, d.incidentId ?? null, d.description, d.severity, d.sectorId, d.responsibleUserId, ctx.principal.userId]);
  await audit(c, ctx, { action: 'NC_ABERTA', entityType: 'nonconformity', entityId: r!.id, summary: `${code} (${d.severity}) aberta — origem ${d.origin}` });
  await notifyUsers(c, [d.responsibleUserId].filter((u) => u !== ctx.principal.userId), { kind: 'NC', title: `Não conformidade ${code} sob sua responsabilidade`, body: d.description.slice(0, 200), link: `/qualidade/nc/${r!.id}`, priority: d.severity === 'MENOR' ? 'NORMAL' : 'ALTA' });
  return r!.id;
}

export async function createNc(ctx: Ctx, input: { origin: 'RECLAMACAO' | 'AUTOAVALIACAO' | 'OUTRA' | 'INCIDENTE'; incidentId?: string; description: string; severity: 'MENOR' | 'MAIOR' | 'CRITICA'; sectorId?: string | null; responsibleUserId: string }): Promise<string> {
  requirePermission(ctx, 'qualidade.gerenciar');
  const d = z.object({ origin: z.enum(['RECLAMACAO', 'AUTOAVALIACAO', 'OUTRA', 'INCIDENTE']), incidentId: z.uuid().optional(), description: z.string().trim().min(5).max(3000),
    severity: z.enum(['MENOR', 'MAIOR', 'CRITICA']), sectorId: z.uuid().nullable().optional(), responsibleUserId: z.uuid() }).parse(input);
  if (d.origin === 'INCIDENTE' && !d.incidentId) throw new AppError('Indique o incidente de origem.');
  return tx(async (c) => {
    await activeUser(c, d.responsibleUserId, 'Responsável');
    return openNc(c, ctx, { ...d, sectorId: d.sectorId ?? null });
  });
}

async function loadNc(c: Db, id: string, lock = false) {
  z.uuid().parse(id);
  const n = await queryOne<{ id: string; code: string; status: string; responsible_user_id: string; sector_id: string | null; root_cause: string | null; description: string }>(c,
    `SELECT id, code, status, responsible_user_id, sector_id, root_cause, description FROM nonconformities WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!n) throw new NotFoundError('Não conformidade não encontrada.');
  return n;
}

/** Ação vinculada a NC, risco ou incidente: cria uma tarefa (responsável, prazo, evidências e histórico ficam na tarefa). */
export async function addAction(ctx: Ctx, input: { kind: 'CORRECAO_IMEDIATA' | 'CORRETIVA' | 'PREVENTIVA' | 'MELHORIA'; ncId?: string; riskId?: string; incidentId?: string; title: string; responsibleUserId: string; dueDate: string; requiresApproval?: boolean }): Promise<string> {
  const d = z.object({ kind: z.enum(['CORRECAO_IMEDIATA', 'CORRETIVA', 'PREVENTIVA', 'MELHORIA']), ncId: z.uuid().optional(), riskId: z.uuid().optional(), incidentId: z.uuid().optional(),
    title: z.string().trim().min(3).max(180), responsibleUserId: z.uuid(), dueDate: z.iso.date(), requiresApproval: z.boolean().default(false) }).parse(input);
  if ([d.ncId, d.riskId, d.incidentId].filter(Boolean).length !== 1) throw new AppError('Vincule a ação a uma não conformidade, um risco ou um incidente.');
  if (d.kind === 'CORRETIVA' && !d.ncId) throw new AppError('Ação corretiva exige não conformidade.');
  const p = ctx.principal;
  let label = '', sectorId: string | null = null, ncResponsible: string | null = null;
  const db = getPool();
  if (d.ncId) {
    const n = await loadNc(db, d.ncId);
    if (n.status === 'ENCERRADA' || n.status === 'CANCELADA') throw new AppError('Não conformidade encerrada.');
    if (n.responsible_user_id !== p.userId && !can(p, 'qualidade.gerenciar')) throw new ForbiddenError();
    label = n.code; sectorId = n.sector_id; ncResponsible = n.responsible_user_id;
  } else if (d.riskId) {
    requirePermission(ctx, 'qualidade.gerenciar');
    label = (await queryOne<{ code: string }>(db, 'SELECT code FROM risks WHERE id = $1', [d.riskId]))?.code ?? '';
    if (!label) throw new NotFoundError('Risco não encontrado.');
  } else {
    requirePermission(ctx, 'incidentes.gerenciar');
    label = (await queryOne<{ code: string }>(db, 'SELECT code FROM incidents WHERE id = $1', [d.incidentId]))?.code ?? '';
    if (!label) throw new NotFoundError('Incidente não encontrado.');
  }
  const kindLabel = { CORRECAO_IMEDIATA: 'Correção imediata', CORRETIVA: 'Ação corretiva', PREVENTIVA: 'Ação preventiva', MELHORIA: 'Melhoria' }[d.kind];
  const sector = sectorId ?? (await userSector(db, d.responsibleUserId)) ?? p.employeeSectorId ?? undefined;
  const approver = d.requiresApproval ? (ncResponsible && ncResponsible !== d.responsibleUserId ? ncResponsible : p.userId !== d.responsibleUserId ? p.userId : null) : null;
  if (d.requiresApproval && !approver) throw new AppError('Indique um responsável diferente de quem verificará a ação.');
  const taskId = await createTask(ctx, {
    title: `[${label}] ${kindLabel}: ${d.title}`, description: `Ação de qualidade vinculada a ${label}. Registre as evidências nesta tarefa.`, priority: d.kind === 'CORRECAO_IMEDIATA' ? 'IMEDIATA' : 'ALTA',
    sectorId: sector, assigneeUserId: d.responsibleUserId, dueDate: d.dueDate, requiresApproval: !!approver, approverUserId: approver,
  });
  return tx(async (c) => {
    const r = await queryOne<{ id: string }>(c, 'INSERT INTO quality_actions (kind, nc_id, risk_id, incident_id, task_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [d.kind, d.ncId ?? null, d.riskId ?? null, d.incidentId ?? null, taskId, p.userId]);
    if (d.ncId) await query(c, "UPDATE nonconformities SET status = 'EM_TRATAMENTO' WHERE id = $1 AND status = 'ABERTA'", [d.ncId]);
    await audit(c, ctx, { action: 'QUALIDADE_ACAO', entityType: 'quality_action', entityId: r!.id, summary: `${kindLabel} para ${label}: ${d.title}` });
    return r!.id;
  });
}

export async function setRootCause(ctx: Ctx, ncId: string, rootCause: string): Promise<void> {
  const rc = z.string().trim().min(3).max(3000).parse(rootCause);
  await tx(async (c) => {
    const n = await loadNc(c, ncId, true);
    if (n.responsible_user_id !== ctx.principal.userId && !can(ctx.principal, 'qualidade.gerenciar')) throw new ForbiddenError();
    if (n.status === 'ENCERRADA' || n.status === 'CANCELADA') throw new AppError('Não conformidade encerrada.');
    await query(c, 'UPDATE nonconformities SET root_cause = $2 WHERE id = $1', [ncId, rc]);
    await audit(c, ctx, { action: 'NC_CAUSA_RAIZ', entityType: 'nonconformity', entityId: ncId, summary: `${n.code}: causa raiz registrada` });
  });
}

/** Encaminha para verificação de eficácia: causa raiz registrada e todas as ações encerradas (ao menos uma concluída). */
export async function submitNcForVerification(ctx: Ctx, ncId: string): Promise<void> {
  await tx(async (c) => {
    const n = await loadNc(c, ncId, true);
    if (n.responsible_user_id !== ctx.principal.userId && !can(ctx.principal, 'qualidade.gerenciar')) throw new ForbiddenError();
    if (n.status !== 'EM_TRATAMENTO' && n.status !== 'ABERTA') throw new AppError('Situação não permite encaminhar.');
    if (!n.root_cause) throw new AppError('Registre a análise de causa raiz.');
    const acts = await query<{ status: string }>(c, 'SELECT t.status FROM quality_actions a JOIN tasks t ON t.id = a.task_id WHERE a.nc_id = $1', [ncId]);
    if (!acts.some((a) => a.status === 'CONCLUIDA')) throw new AppError('Conclua ao menos uma ação antes da verificação.');
    if (acts.some((a) => a.status !== 'CONCLUIDA' && a.status !== 'CANCELADA')) throw new AppError('Há ações em aberto.');
    await query(c, "UPDATE nonconformities SET status = 'AGUARDANDO_VERIFICACAO' WHERE id = $1", [ncId]);
    await audit(c, ctx, { action: 'NC_PARA_VERIFICACAO', entityType: 'nonconformity', entityId: ncId, summary: `${n.code} encaminhada para verificação de eficácia` });
  });
}

/** Verificação de eficácia por quem não é o responsável: eficaz encerra; ineficaz volta ao tratamento. */
export async function verifyNc(ctx: Ctx, ncId: string, effective: boolean, notes: string): Promise<void> {
  requirePermission(ctx, 'qualidade.gerenciar');
  if (notes.trim().length < 5) throw new AppError('Descreva a verificação de eficácia.');
  await tx(async (c) => {
    const n = await loadNc(c, ncId, true);
    if (n.status !== 'AGUARDANDO_VERIFICACAO') throw new AppError('Não conformidade não aguarda verificação.');
    if (n.responsible_user_id === ctx.principal.userId) throw new ForbiddenError('Segregação: o responsável pelo tratamento não verifica a própria eficácia.');
    if (effective) {
      await query(c, "UPDATE nonconformities SET status='ENCERRADA', effectiveness_notes=$2, verified_by=$3, closed_at=now() WHERE id=$1", [ncId, notes.trim(), ctx.principal.userId]);
    } else {
      await query(c, "UPDATE nonconformities SET status='EM_TRATAMENTO', effectiveness_notes=$2 WHERE id=$1", [ncId, `Ineficaz: ${notes.trim()}`]);
      await notifyUsers(c, [n.responsible_user_id], { kind: 'NC', title: `${n.code}: tratamento considerado ineficaz`, body: notes.trim(), link: `/qualidade/nc/${ncId}`, priority: 'ALTA' });
    }
    await audit(c, ctx, { action: effective ? 'NC_ENCERRADA' : 'NC_INEFICAZ', entityType: 'nonconformity', entityId: ncId, summary: `${n.code}: ${effective ? 'eficaz — encerrada' : 'ineficaz — volta ao tratamento'}` });
  });
}

export async function cancelNc(ctx: Ctx, ncId: string, reason: string): Promise<void> {
  requirePermission(ctx, 'qualidade.gerenciar');
  if (reason.trim().length < 5) throw new AppError('Informe o motivo.');
  await tx(async (c) => {
    const n = await loadNc(c, ncId, true);
    if (n.status === 'ENCERRADA' || n.status === 'CANCELADA') throw new AppError('Já encerrada.');
    await query(c, "UPDATE nonconformities SET status='CANCELADA', cancel_reason=$2 WHERE id=$1", [ncId, reason.trim()]);
    await audit(c, ctx, { action: 'NC_CANCELADA', entityType: 'nonconformity', entityId: ncId, summary: `${n.code} cancelada: ${reason.trim()}` });
  });
}

export type NcRow = { id: string; code: string; origin: string; description: string; severity: string; status: string; sector_name: string | null; responsible_user_id: string;
  responsible_name: string; created_at: Date; closed_at: Date | null; actions: number; actions_open: number; actions_overdue: number };

export async function listNcs(ctx: Ctx) {
  const p = ctx.principal;
  const rows = await query<NcRow & { sector_id: string | null }>(getPool(),
    `SELECT n.id, n.code, n.origin, n.description, n.severity, n.status, n.sector_id, s.name AS sector_name, n.responsible_user_id, u.display_name AS responsible_name, n.created_at, n.closed_at,
            (SELECT count(*)::int FROM quality_actions a WHERE a.nc_id = n.id) AS actions,
            (SELECT count(*)::int FROM quality_actions a JOIN tasks t ON t.id = a.task_id WHERE a.nc_id = n.id AND t.status NOT IN ('CONCLUIDA','CANCELADA')) AS actions_open,
            (SELECT count(*)::int FROM quality_actions a JOIN tasks t ON t.id = a.task_id WHERE a.nc_id = n.id AND t.status NOT IN ('CONCLUIDA','CANCELADA') AND t.due_date < current_date) AS actions_overdue
       FROM nonconformities n JOIN users u ON u.id = n.responsible_user_id LEFT JOIN sectors s ON s.id = n.sector_id ORDER BY n.created_at DESC`);
  return rows.filter((n) => p.isOwner || n.responsible_user_id === p.userId || can(p, 'qualidade.gerenciar') || can(p, 'qualidade.auditar') || can(p, 'qualidade.ver', { sectorId: n.sector_id }));
}

export async function getNc(ctx: Ctx, id: string) {
  const n = (await listNcs(ctx)).find((x) => x.id === z.uuid().parse(id));
  if (!n) throw new NotFoundError('Não conformidade não encontrada.');
  const db = getPool();
  const full = await queryOne<{ root_cause: string | null; effectiveness_notes: string | null; verified_by_name: string | null; cancel_reason: string | null; audit_id: string | null; audit_code: string | null; incident_id: string | null }>(db,
    `SELECT n.root_cause, n.effectiveness_notes, v.display_name AS verified_by_name, n.cancel_reason, a.id AS audit_id, a.code AS audit_code, n.incident_id
       FROM nonconformities n LEFT JOIN users v ON v.id = n.verified_by LEFT JOIN audit_items i ON i.id = n.audit_item_id LEFT JOIN audits a ON a.id = i.audit_id WHERE n.id = $1`, [id]);
  const actions = await listActions({ ncId: id });
  return { nc: { ...n, ...full! }, actions };
}

export async function listActions(f: { ncId?: string; riskId?: string; incidentId?: string }) {
  return query<{ id: string; kind: string; task_id: string; title: string; status: string; assignee_name: string | null; due_date: string | null; completed_at: Date | null }>(getPool(),
    `SELECT a.id, a.kind, a.task_id, t.title, t.status, u.display_name AS assignee_name, t.due_date, t.completed_at
       FROM quality_actions a JOIN tasks t ON t.id = a.task_id LEFT JOIN users u ON u.id = t.assignee_user_id
      WHERE ($1::uuid IS NULL OR a.nc_id = $1) AND ($2::uuid IS NULL OR a.risk_id = $2) AND ($3::uuid IS NULL OR a.incident_id = $3) ORDER BY a.created_at`,
    [f.ncId ?? null, f.riskId ?? null, f.incidentId ?? null]);
}

// ---------------------------------------------------------------------------
// Riscos
// ---------------------------------------------------------------------------

const riskSchema = z.object({
  id: z.uuid().optional(),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(3000).optional(),
  category: z.enum(['OPERACIONAL', 'SEGURANCA_INFORMACAO', 'DADOS_PESSOAIS', 'CONTINUIDADE', 'LEGAL_NORMATIVO', 'FINANCEIRO', 'PESSOAS', 'IMAGEM']),
  probability: z.number().int().min(1).max(5),
  impact: z.number().int().min(1).max(5),
  treatment: z.enum(['MITIGAR', 'ACEITAR', 'TRANSFERIR', 'EVITAR']),
  controls: z.string().trim().max(3000).optional(),
  residualProbability: z.number().int().min(1).max(5).nullable().optional(),
  residualImpact: z.number().int().min(1).max(5).nullable().optional(),
  ownerUserId: z.uuid(),
  reviewMonths: z.number().int().min(1).max(36).default(6),
  notes: z.string().trim().max(2000).optional(),
});

/** Cadastro ou reavaliação do risco (cada avaliação fica no histórico). Aceitar risco alto/crítico é decisão da Oficial. */
export async function saveRisk(ctx: Ctx, input: z.input<typeof riskSchema>): Promise<string> {
  requirePermission(ctx, 'qualidade.gerenciar');
  const d = riskSchema.parse(input);
  if ((d.residualProbability == null) !== (d.residualImpact == null)) throw new AppError('Informe probabilidade e impacto residuais juntos.');
  const band = riskBand(d.probability, d.impact);
  if (d.treatment === 'ACEITAR' && (band === 'ALTO' || band === 'CRITICO') && !ctx.principal.isOwner) throw new ForbiddenError('Aceitar risco alto ou crítico é decisão da Oficial.');
  return tx(async (c) => {
    await activeUser(c, d.ownerUserId, 'Responsável pelo risco');
    const next = addMonths(todayLocal(), d.reviewMonths);
    const vals = [d.title, d.description ?? null, d.category, d.probability, d.impact, d.treatment, d.controls ?? null, d.residualProbability ?? null, d.residualImpact ?? null,
      d.ownerUserId, d.reviewMonths, next, d.treatment === 'ACEITAR' ? ctx.principal.userId : null];
    let id = d.id;
    if (id) {
      const r = await query(c, `UPDATE risks SET title=$1, description=$2, category=$3, probability=$4, impact=$5, treatment=$6, controls=$7, residual_probability=$8, residual_impact=$9,
        owner_user_id=$10, review_months=$11, next_review_on=$12, accepted_by=$13, updated_at=now() WHERE id=$14 AND status='ATIVO' RETURNING id`, [...vals, id]);
      if (!r.length) throw new NotFoundError('Risco não encontrado ou encerrado.');
    } else {
      const code = await nextCode(c, 'RSC');
      id = (await queryOne<{ id: string }>(c, `INSERT INTO risks (title, description, category, probability, impact, treatment, controls, residual_probability, residual_impact,
        owner_user_id, review_months, next_review_on, accepted_by, code, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, [...vals, code, ctx.principal.userId]))!.id;
    }
    await query(c, 'INSERT INTO risk_reviews (risk_id, probability, impact, treatment, residual_probability, residual_impact, notes, reviewed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, d.probability, d.impact, d.treatment, d.residualProbability ?? null, d.residualImpact ?? null, d.notes ?? null, ctx.principal.userId]);
    await audit(c, ctx, { action: d.id ? 'RISCO_REAVALIADO' : 'RISCO_CRIADO', entityType: 'risk', entityId: id, summary: `${d.title}: ${d.probability}×${d.impact} (${band}), ${d.treatment}` });
    return id;
  });
}

export async function closeRisk(ctx: Ctx, id: string, notes: string): Promise<void> {
  requirePermission(ctx, 'qualidade.gerenciar');
  if (notes.trim().length < 5) throw new AppError('Justifique o encerramento.');
  await tx(async (c) => {
    const r = await queryOne<{ probability: number; impact: number; treatment: string; residual_probability: number | null; residual_impact: number | null; code: string }>(c,
      "SELECT probability, impact, treatment, residual_probability, residual_impact, code FROM risks WHERE id = $1 AND status = 'ATIVO' FOR UPDATE", [id]);
    if (!r) throw new NotFoundError('Risco não encontrado ou encerrado.');
    await query(c, "UPDATE risks SET status='ENCERRADO', updated_at=now() WHERE id=$1", [id]);
    await query(c, 'INSERT INTO risk_reviews (risk_id, probability, impact, treatment, residual_probability, residual_impact, notes, reviewed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, r.probability, r.impact, r.treatment, r.residual_probability, r.residual_impact, `Encerrado: ${notes.trim()}`, ctx.principal.userId]);
    await audit(c, ctx, { action: 'RISCO_ENCERRADO', entityType: 'risk', entityId: id, summary: `${r.code} encerrado` });
  });
}

export async function listRisks(ctx: Ctx) {
  requireView(ctx);
  return query<{ id: string; code: string; title: string; description: string | null; category: string; probability: number; impact: number; level: number; treatment: string; controls: string | null;
    residual_probability: number | null; residual_impact: number | null; owner_user_id: string; owner_name: string; review_months: number; next_review_on: string; status: string; actions: number; actions_open: number }>(getPool(),
    `SELECT r.id, r.code, r.title, r.description, r.category, r.probability, r.impact, r.level, r.treatment, r.controls, r.residual_probability, r.residual_impact, r.owner_user_id,
            u.display_name AS owner_name, r.review_months, r.next_review_on, r.status,
            (SELECT count(*)::int FROM quality_actions a WHERE a.risk_id = r.id) AS actions,
            (SELECT count(*)::int FROM quality_actions a JOIN tasks t ON t.id = a.task_id WHERE a.risk_id = r.id AND t.status NOT IN ('CONCLUIDA','CANCELADA')) AS actions_open
       FROM risks r JOIN users u ON u.id = r.owner_user_id ORDER BY r.status, r.level DESC, r.code`);
}

export async function riskHistory(ctx: Ctx, id: string) {
  requireView(ctx);
  return query<{ probability: number; impact: number; treatment: string; residual_probability: number | null; residual_impact: number | null; notes: string | null; reviewed_by_name: string; reviewed_at: Date }>(getPool(),
    'SELECT r.probability, r.impact, r.treatment, r.residual_probability, r.residual_impact, r.notes, u.display_name AS reviewed_by_name, r.reviewed_at FROM risk_reviews r JOIN users u ON u.id = r.reviewed_by WHERE r.risk_id = $1 ORDER BY r.reviewed_at DESC',
    [z.uuid().parse(id)]);
}
