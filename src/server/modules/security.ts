import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx, Principal } from '../context.ts';
import { can, requirePermission } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors.ts';
import { checkFile } from '../files.ts';
import { getNumberSetting } from '../settings.ts';
import { addDays, todayLocal } from '../../domain/time.ts';
import { backupStatus, complianceIndex, expiring, heatmap, riskBand, vulnerabilityDue, type BackupRecord, type ReqStatus, type Severity } from '../../domain/quality.ts';
import { notifyUsers, usersWithPermission } from './notifications.ts';
import { discardUnsaved, insertStoredFile, loadStoredFile, prepareFile, readStoredFile, rescan } from './fileStore.ts';
import { maxFileBytes } from './repository.ts';
import { nextCode } from './quality.ts';

// Segurança da informação (Fase 5a): incidentes, inventário de ativos, backups e vulnerabilidades; painel e lembretes
// da qualidade. Prazos e periodicidades são parâmetros de política interna (configuráveis), não exigências normativas.

const ANY_SECTOR = '00000000-0000-0000-0000-000000000000'; // permissões de escopo TODOS não dependem do setor

const managers = (db: Db, permission: string, exclude?: string | null) => usersWithPermission(db, permission, ANY_SECTOR, exclude);
const canAssets = (p: Principal) => p.isOwner || can(p, 'ativos.gerenciar');
function requireAssetsView(ctx: Ctx) { if (!canAssets(ctx.principal) && !can(ctx.principal, 'qualidade.ver')) throw new ForbiddenError(); }

// ---------------------------------------------------------------------------
// Incidentes
// ---------------------------------------------------------------------------

const incidentSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(5).max(5000),
  category: z.enum(['SEGURANCA_INFORMACAO', 'DADOS_PESSOAIS', 'INDISPONIBILIDADE', 'FISICO', 'OPERACIONAL', 'OUTRO']),
  severity: z.enum(['BAIXA', 'MEDIA', 'ALTA', 'CRITICA']).default('MEDIA'),
  occurredAt: z.coerce.date().nullable().optional(),
  detectedAt: z.coerce.date(),
  personalDataInvolved: z.boolean().default(false),
});

/** Qualquer pessoa com a permissão de comunicar registra; os gestores de incidentes são avisados imediatamente. */
export async function reportIncident(ctx: Ctx, input: z.input<typeof incidentSchema>): Promise<string> {
  if (!can(ctx.principal, 'incidentes.registrar') && !can(ctx.principal, 'incidentes.gerenciar')) throw new ForbiddenError();
  const d = incidentSchema.parse(input);
  if (d.detectedAt.getTime() > Date.now() + 60_000) throw new AppError('A detecção não pode estar no futuro.');
  if (d.occurredAt && d.occurredAt > d.detectedAt) throw new AppError('A ocorrência não pode ser posterior à detecção.');
  const personal = d.personalDataInvolved || d.category === 'DADOS_PESSOAIS';
  return tx(async (c) => {
    const code = await nextCode(c, 'INC');
    const r = await queryOne<{ id: string }>(c, `INSERT INTO incidents (code, title, description, category, severity, occurred_at, detected_at, reported_by, personal_data_involved)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [code, d.title, d.description, d.category, d.severity, d.occurredAt ?? null, d.detectedAt, ctx.principal.userId, personal]);
    await query(c, "INSERT INTO incident_events (incident_id, user_id, event) VALUES ($1,$2,'COMUNICADO')", [r!.id, ctx.principal.userId]);
    await audit(c, ctx, { action: 'INCIDENTE_COMUNICADO', entityType: 'incident', entityId: r!.id, summary: `${code} (${d.severity}${personal ? ', dados pessoais' : ''})` });
    // O aviso traz apenas código e categoria: a descrição pode conter dados pessoais.
    await notifyUsers(c, await managers(c, 'incidentes.gerenciar', ctx.principal.userId), {
      kind: 'INCIDENTE', title: `Incidente ${code} comunicado (${d.severity.toLowerCase()})`, body: personal ? 'Envolve dados pessoais — avaliar comunicação (LGPD).' : undefined,
      link: `/qualidade/incidentes/${r!.id}`, priority: personal || d.severity === 'ALTA' || d.severity === 'CRITICA' ? 'ALTA' : 'NORMAL',
    });
    return r!.id;
  });
}

type IncidentRow = { id: string; code: string; title: string; description: string; category: string; severity: string; occurred_at: Date | null; detected_at: Date; reported_by: string;
  reporter_name: string; reported_at: Date; personal_data_involved: boolean; containment: string | null; root_cause: string | null; lgpd_assessment: string | null;
  lgpd_assessed_by_name: string | null; status: string; closed_at: Date | null };

const incidentSelect = `SELECT i.id, i.code, i.title, i.description, i.category, i.severity, i.occurred_at, i.detected_at, i.reported_by, r.display_name AS reporter_name, i.reported_at,
  i.personal_data_involved, i.containment, i.root_cause, i.lgpd_assessment, l.display_name AS lgpd_assessed_by_name, i.status, i.closed_at
  FROM incidents i JOIN users r ON r.id = i.reported_by LEFT JOIN users l ON l.id = i.lgpd_assessed_by`;

/** Incidentes visíveis: gestores veem todos; quem comunicou vê os próprios. */
export async function listIncidents(ctx: Ctx): Promise<IncidentRow[]> {
  const p = ctx.principal;
  const all = can(p, 'incidentes.gerenciar');
  return query<IncidentRow>(getPool(), `${incidentSelect} WHERE $1 OR i.reported_by = $2 ORDER BY (i.status = 'ENCERRADO'), i.detected_at DESC`, [all, p.userId]);
}

export async function getIncident(ctx: Ctx, id: string) {
  z.uuid().parse(id);
  const db = getPool();
  const i = await queryOne<IncidentRow>(db, `${incidentSelect} WHERE i.id = $1`, [id]);
  if (!i || (!can(ctx.principal, 'incidentes.gerenciar') && i.reported_by !== ctx.principal.userId)) throw new NotFoundError('Incidente não encontrado.');
  const events = await query<{ event: string; notes: string | null; user_name: string | null; created_at: Date }>(db,
    'SELECT e.event, e.notes, u.display_name AS user_name, e.created_at FROM incident_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.incident_id = $1 ORDER BY e.created_at', [id]);
  const ncs = await query<{ id: string; code: string; status: string }>(db, 'SELECT id, code, status FROM nonconformities WHERE incident_id = $1 ORDER BY created_at', [id]);
  const actions = await query<{ id: string; kind: string; task_id: string; title: string; status: string; assignee_name: string | null; due_date: string | null }>(db,
    `SELECT a.id, a.kind, a.task_id, t.title, t.status, u.display_name AS assignee_name, t.due_date FROM quality_actions a JOIN tasks t ON t.id = a.task_id
       LEFT JOIN users u ON u.id = t.assignee_user_id WHERE a.incident_id = $1 ORDER BY a.created_at`, [id]);
  return { incident: i, events, ncs, actions, canManage: can(ctx.principal, 'incidentes.gerenciar') && i.status !== 'ENCERRADO' };
}

async function loadIncident(c: Db, id: string) {
  z.uuid().parse(id);
  const i = await queryOne<{ code: string; status: string; personal_data_involved: boolean; containment: string | null; root_cause: string | null; lgpd_assessment: string | null }>(c,
    'SELECT code, status, personal_data_involved, containment, root_cause, lgpd_assessment FROM incidents WHERE id = $1 FOR UPDATE', [id]);
  if (!i) throw new NotFoundError('Incidente não encontrado.');
  if (i.status === 'ENCERRADO') throw new AppError('Incidente encerrado.');
  return i;
}

const treatSchema = z.object({
  severity: z.enum(['BAIXA', 'MEDIA', 'ALTA', 'CRITICA']).optional(),
  personalDataInvolved: z.boolean().optional(),
  containment: z.string().trim().min(3).max(5000).optional(),
  rootCause: z.string().trim().min(3).max(5000).optional(),
  notes: z.string().trim().max(3000).optional(),
});

/** Tratamento: classificação, contenção (→ CONTIDO), causa raiz e anotações; cada passo fica na linha do tempo. */
export async function treatIncident(ctx: Ctx, id: string, input: z.input<typeof treatSchema>): Promise<void> {
  requirePermission(ctx, 'incidentes.gerenciar');
  const d = treatSchema.parse(input);
  await tx(async (c) => {
    const i = await loadIncident(c, id);
    if (i.personal_data_involved && d.personalDataInvolved === false) throw new AppError('Envolvimento de dados pessoais, uma vez registrado, não é removido; registre a avaliação LGPD.');
    const contained = d.containment && i.status === 'ABERTO';
    await query(c, `UPDATE incidents SET severity = coalesce($2, severity), personal_data_involved = coalesce($3, personal_data_involved), containment = coalesce($4, containment),
      root_cause = coalesce($5, root_cause), status = CASE WHEN $6 THEN 'CONTIDO' ELSE status END WHERE id = $1`,
      [id, d.severity ?? null, d.personalDataInvolved ?? null, d.containment ?? null, d.rootCause ?? null, !!contained]);
    const parts = [d.severity && `severidade ${d.severity}`, d.personalDataInvolved && 'envolve dados pessoais', d.containment && 'contenção registrada', d.rootCause && 'causa raiz registrada'].filter(Boolean);
    const event = contained ? 'CONTIDO' : parts.length ? 'TRATAMENTO' : 'ANOTACAO';
    if (!parts.length && !d.notes) throw new AppError('Nada a registrar.');
    await query(c, 'INSERT INTO incident_events (incident_id, user_id, event, notes) VALUES ($1,$2,$3,$4)', [id, ctx.principal.userId, event, [parts.join('; '), d.notes].filter(Boolean).join(' — ') || null]);
    await audit(c, ctx, { action: 'INCIDENTE_TRATAMENTO', entityType: 'incident', entityId: id, summary: `${i.code}: ${parts.join('; ') || 'anotação'}` });
  });
}

/**
 * Avaliação sobre comunicação à ANPD e aos titulares, registrada por gestor de incidentes (idealmente o encarregado).
 * O sistema não decide se a comunicação é obrigatória: registra a avaliação e quem a fez.
 */
export async function recordLgpdAssessment(ctx: Ctx, id: string, assessment: string): Promise<void> {
  requirePermission(ctx, 'incidentes.gerenciar');
  const a = z.string().trim().min(5, 'Descreva a avaliação.').max(5000).parse(assessment);
  await tx(async (c) => {
    const i = await loadIncident(c, id);
    if (!i.personal_data_involved) throw new AppError('O incidente não está marcado como envolvendo dados pessoais.');
    await query(c, 'UPDATE incidents SET lgpd_assessment = $2, lgpd_assessed_by = $3 WHERE id = $1', [id, a, ctx.principal.userId]);
    await query(c, "INSERT INTO incident_events (incident_id, user_id, event, notes) VALUES ($1,$2,'AVALIACAO_LGPD',$3)", [id, ctx.principal.userId, a]);
    await audit(c, ctx, { action: 'INCIDENTE_AVALIACAO_LGPD', entityType: 'incident', entityId: id, summary: `${i.code}: avaliação LGPD registrada` });
  });
}

/** Encerramento: contenção, causa raiz, avaliação LGPD (se houver dados pessoais) e nenhuma ação em aberto. */
export async function closeIncident(ctx: Ctx, id: string, notes?: string): Promise<void> {
  requirePermission(ctx, 'incidentes.gerenciar');
  await tx(async (c) => {
    const i = await loadIncident(c, id);
    if (!i.containment) throw new AppError('Registre a contenção.');
    if (!i.root_cause) throw new AppError('Registre a causa raiz.');
    if (i.personal_data_involved && !i.lgpd_assessment) throw new AppError('Envolve dados pessoais: registre a avaliação LGPD antes de encerrar.');
    const open = (await queryOne<{ n: number }>(c, "SELECT count(*)::int AS n FROM quality_actions a JOIN tasks t ON t.id = a.task_id WHERE a.incident_id = $1 AND t.status NOT IN ('CONCLUIDA','CANCELADA')", [id]))!.n;
    if (open) throw new AppError(`Há ${open} ação(ões) em aberto.`);
    await query(c, "UPDATE incidents SET status = 'ENCERRADO', closed_at = now(), closed_by = $2 WHERE id = $1", [id, ctx.principal.userId]);
    await query(c, "INSERT INTO incident_events (incident_id, user_id, event, notes) VALUES ($1,$2,'ENCERRADO',$3)", [id, ctx.principal.userId, notes?.trim() || null]);
    await audit(c, ctx, { action: 'INCIDENTE_ENCERRADO', entityType: 'incident', entityId: id, summary: `${i.code} encerrado` });
  });
}

// ---------------------------------------------------------------------------
// Inventário de ativos
// ---------------------------------------------------------------------------

const assetSchema = z.object({
  id: z.uuid().optional(),
  tag: z.string().trim().min(1).max(40),
  name: z.string().trim().min(2).max(200),
  kind: z.enum(['COMPUTADOR', 'NOTEBOOK', 'IMPRESSORA', 'SCANNER', 'SERVIDOR', 'REDE', 'NOBREAK', 'SOFTWARE_LICENCA', 'CERTIFICADO_DIGITAL', 'TOKEN_SMARTCARD', 'CELULAR', 'MOBILIARIO', 'OUTRO']),
  serial: z.string().trim().max(100).optional(),
  location: z.string().trim().max(200).optional(),
  sectorId: z.uuid().nullable().optional(),
  responsibleUserId: z.uuid().nullable().optional(),
  criticality: z.enum(['BAIXA', 'MEDIA', 'ALTA']).default('MEDIA'),
  acquiredOn: z.iso.date().nullable().optional(),
  warrantyUntil: z.iso.date().nullable().optional(),
  expiresOn: z.iso.date().nullable().optional(),
  status: z.enum(['EM_USO', 'ESTOQUE', 'MANUTENCAO']).default('EM_USO'),
  notes: z.string().trim().max(2000).optional(),
});

export async function saveAsset(ctx: Ctx, input: z.input<typeof assetSchema>): Promise<string> {
  requirePermission(ctx, 'ativos.gerenciar');
  const d = assetSchema.parse(input);
  return tx(async (c) => {
    const vals = [d.tag, d.name, d.kind, d.serial || null, d.location || null, d.sectorId ?? null, d.responsibleUserId ?? null, d.criticality, d.acquiredOn ?? null,
      d.warrantyUntil ?? null, d.expiresOn ?? null, d.status, d.notes || null];
    const dup = (e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('Já existe ativo com esta identificação.'); throw e; };
    if (d.id) {
      const old = await queryOne<{ location: string | null; sector_id: string | null; responsible_user_id: string | null; status: string }>(c,
        'SELECT location, sector_id, responsible_user_id, status FROM assets WHERE id = $1 FOR UPDATE', [d.id]);
      if (!old) throw new NotFoundError('Ativo não encontrado.');
      if (old.status === 'BAIXADO') throw new AppError('Ativo baixado não é alterado.');
      await query(c, `UPDATE assets SET tag=$1, name=$2, kind=$3, serial=$4, location=$5, sector_id=$6, responsible_user_id=$7, criticality=$8, acquired_on=$9, warranty_until=$10,
        expires_on=$11, status=$12, notes=$13, updated_at=now() WHERE id=$14`, [...vals, d.id]).catch(dup);
      const moved = old.location !== (d.location || null) || old.sector_id !== (d.sectorId ?? null) || old.responsible_user_id !== (d.responsibleUserId ?? null);
      const event = moved ? 'MOVIMENTACAO' : d.status === 'MANUTENCAO' && old.status !== 'MANUTENCAO' ? 'MANUTENCAO' : 'ALTERACAO';
      await query(c, 'INSERT INTO asset_events (asset_id, event, notes, user_id) VALUES ($1,$2,$3,$4)', [d.id, event, moved ? `Local: ${d.location || '—'}` : null, ctx.principal.userId]);
      await audit(c, ctx, { action: 'ATIVO_ALTERADO', entityType: 'asset', entityId: d.id, summary: `${d.tag} — ${event}` });
      return d.id;
    }
    const r = await queryOne<{ id: string }>(c, `INSERT INTO assets (tag, name, kind, serial, location, sector_id, responsible_user_id, criticality, acquired_on, warranty_until, expires_on, status, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`, [...vals, ctx.principal.userId]).catch(dup);
    await query(c, "INSERT INTO asset_events (asset_id, event, user_id) VALUES ($1,'CADASTRO',$2)", [r!.id, ctx.principal.userId]);
    await audit(c, ctx, { action: 'ATIVO_CADASTRADO', entityType: 'asset', entityId: r!.id, summary: `${d.tag} — ${d.name}` });
    return r!.id;
  });
}

export async function registerMaintenance(ctx: Ctx, id: string, notes: string): Promise<void> {
  requirePermission(ctx, 'ativos.gerenciar');
  const n = z.string().trim().min(3).max(2000).parse(notes);
  await tx(async (c) => {
    const a = await queryOne<{ tag: string; status: string }>(c, 'SELECT tag, status FROM assets WHERE id = $1 FOR UPDATE', [z.uuid().parse(id)]);
    if (!a) throw new NotFoundError('Ativo não encontrado.');
    if (a.status === 'BAIXADO') throw new AppError('Ativo baixado.');
    await query(c, "INSERT INTO asset_events (asset_id, event, notes, user_id) VALUES ($1,'MANUTENCAO',$2,$3)", [id, n, ctx.principal.userId]);
    await audit(c, ctx, { action: 'ATIVO_MANUTENCAO', entityType: 'asset', entityId: id, summary: `${a.tag}: manutenção registrada` });
  });
}

/** Baixa: exige motivo; vulnerabilidades em aberto do ativo precisam ser tratadas antes. */
export async function disposeAsset(ctx: Ctx, id: string, reason: string): Promise<void> {
  requirePermission(ctx, 'ativos.gerenciar');
  const r = z.string().trim().min(3, 'Informe o motivo da baixa.').max(2000).parse(reason);
  await tx(async (c) => {
    const a = await queryOne<{ tag: string; status: string }>(c, 'SELECT tag, status FROM assets WHERE id = $1 FOR UPDATE', [z.uuid().parse(id)]);
    if (!a) throw new NotFoundError('Ativo não encontrado.');
    if (a.status === 'BAIXADO') throw new AppError('Ativo já baixado.');
    if (await queryOne(c, "SELECT 1 FROM vulnerabilities WHERE asset_id = $1 AND status IN ('ABERTA','EM_TRATAMENTO')", [id])) throw new AppError('Há vulnerabilidades em aberto para este ativo.');
    await query(c, "UPDATE assets SET status = 'BAIXADO', disposal_reason = $2, updated_at = now() WHERE id = $1", [id, r]);
    await query(c, "INSERT INTO asset_events (asset_id, event, notes, user_id) VALUES ($1,'BAIXA',$2,$3)", [id, r, ctx.principal.userId]);
    await audit(c, ctx, { action: 'ATIVO_BAIXADO', entityType: 'asset', entityId: id, summary: `${a.tag} baixado: ${r}` });
  });
}

export type AssetRow = { id: string; tag: string; name: string; kind: string; serial: string | null; location: string | null; sector_id: string | null; sector_name: string | null;
  responsible_user_id: string | null; responsible_name: string | null; criticality: string; acquired_on: string | null; warranty_until: string | null; expires_on: string | null;
  status: string; disposal_reason: string | null; notes: string | null };

export async function listAssets(ctx: Ctx): Promise<AssetRow[]> {
  requireAssetsView(ctx);
  return query<AssetRow>(getPool(),
    `SELECT a.id, a.tag, a.name, a.kind, a.serial, a.location, a.sector_id, s.name AS sector_name, a.responsible_user_id, u.display_name AS responsible_name, a.criticality,
            a.acquired_on, a.warranty_until, a.expires_on, a.status, a.disposal_reason, a.notes
       FROM assets a LEFT JOIN sectors s ON s.id = a.sector_id LEFT JOIN users u ON u.id = a.responsible_user_id ORDER BY (a.status = 'BAIXADO'), a.tag`);
}

export async function assetEvents(ctx: Ctx, id: string) {
  requireAssetsView(ctx);
  return query<{ event: string; notes: string | null; user_name: string; created_at: Date }>(getPool(),
    'SELECT e.event, e.notes, u.display_name AS user_name, e.created_at FROM asset_events e JOIN users u ON u.id = e.user_id WHERE e.asset_id = $1 ORDER BY e.created_at DESC', [z.uuid().parse(id)]);
}

// ---------------------------------------------------------------------------
// Backups e testes de restauração
// ---------------------------------------------------------------------------

const backupSchema = z.object({
  kind: z.enum(['BACKUP', 'TESTE_RESTAURACAO']),
  system: z.string().trim().min(2).max(100),
  performedOn: z.iso.date(),
  result: z.enum(['SUCESSO', 'PARCIAL', 'FALHA']),
  notes: z.string().trim().max(3000).optional(),
});

/** Registro (imutável) de backup ou teste de restauração; falhas avisam os gestores. */
export async function recordBackup(ctx: Ctx, input: z.input<typeof backupSchema>, file?: { name: string; bytes: Uint8Array } | null): Promise<string> {
  requirePermission(ctx, 'ativos.gerenciar');
  const d = backupSchema.parse(input);
  if (d.performedOn > todayLocal()) throw new AppError('A data não pode estar no futuro.');
  if (d.result !== 'SUCESSO' && (!d.notes || d.notes.length < 3)) throw new AppError('Descreva o problema.');
  const prepared = file && file.bytes.byteLength ? await prepareFile(ctx, checkFile(file.name, file.bytes, await maxFileBytes()), file.bytes) : null;
  return tx(async (c) => {
    const fileId = prepared ? await insertStoredFile(c, ctx, prepared) : null;
    const r = await queryOne<{ id: string }>(c, 'INSERT INTO backup_records (kind, system, performed_on, result, notes, file_id, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [d.kind, d.system, d.performedOn, d.result, d.notes || null, fileId, ctx.principal.userId]);
    const label = d.kind === 'BACKUP' ? 'Backup' : 'Teste de restauração';
    await audit(c, ctx, { action: 'BACKUP_REGISTRADO', entityType: 'backup_record', entityId: r!.id, summary: `${label} ${d.system} ${d.performedOn}: ${d.result}` });
    if (d.result !== 'SUCESSO') {
      await notifyUsers(c, await managers(c, 'ativos.gerenciar', ctx.principal.userId), { kind: 'BACKUP', title: `${label} de ${d.system} com resultado ${d.result.toLowerCase()}`, link: '/qualidade?aba=backups', priority: 'ALTA' });
    }
    return r!.id;
  }).catch(async (e) => { await discardUnsaved(prepared); throw e; });
}

export async function listBackups(ctx: Ctx, limit = 200) {
  requireAssetsView(ctx);
  const db = getPool();
  const rows = await query<BackupRecord & { id: string; notes: string | null; file_id: string | null; recorded_by_name: string }>(db,
    `SELECT b.id, b.kind, b.system, b.performed_on, b.result, b.notes, b.file_id, u.display_name AS recorded_by_name FROM backup_records b JOIN users u ON u.id = b.recorded_by
      ORDER BY b.performed_on DESC, b.recorded_at DESC LIMIT $1`, [limit]);
  const all = await query<BackupRecord>(db, 'SELECT kind, system, performed_on, result FROM backup_records');
  return { rows, status: backupStatus(all, todayLocal(), await getNumberSetting(db, 'seguranca.teste_restauracao_dias', 90)) };
}

// ---------------------------------------------------------------------------
// Vulnerabilidades
// ---------------------------------------------------------------------------

async function vulnPolicy(db: Db): Promise<Record<Severity, number>> {
  return {
    CRITICA: await getNumberSetting(db, 'seguranca.vulnerabilidade_prazo_critica', 7),
    ALTA: await getNumberSetting(db, 'seguranca.vulnerabilidade_prazo_alta', 30),
    MEDIA: await getNumberSetting(db, 'seguranca.vulnerabilidade_prazo_media', 90),
    BAIXA: await getNumberSetting(db, 'seguranca.vulnerabilidade_prazo_baixa', 180),
  };
}

const vulnSchema = z.object({
  title: z.string().trim().min(3).max(300),
  source: z.string().trim().min(2).max(200),
  assetId: z.uuid().nullable().optional(),
  severity: z.enum(['BAIXA', 'MEDIA', 'ALTA', 'CRITICA']),
  detectedOn: z.iso.date(),
});

/** Registro com prazo de correção calculado pela política interna conforme a severidade. */
export async function registerVulnerability(ctx: Ctx, input: z.input<typeof vulnSchema>): Promise<string> {
  requirePermission(ctx, 'ativos.gerenciar');
  const d = vulnSchema.parse(input);
  if (d.detectedOn > todayLocal()) throw new AppError('A data de detecção não pode estar no futuro.');
  return tx(async (c) => {
    if (d.assetId && !(await queryOne(c, "SELECT 1 FROM assets WHERE id = $1 AND status <> 'BAIXADO'", [d.assetId]))) throw new AppError('Ativo inexistente ou baixado.');
    const due = vulnerabilityDue(d.detectedOn, d.severity, await vulnPolicy(c));
    const r = await queryOne<{ id: string }>(c, 'INSERT INTO vulnerabilities (title, source, asset_id, severity, detected_on, due_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [d.title, d.source, d.assetId ?? null, d.severity, d.detectedOn, due, ctx.principal.userId]);
    await audit(c, ctx, { action: 'VULNERABILIDADE_REGISTRADA', entityType: 'vulnerability', entityId: r!.id, summary: `${d.title} (${d.severity}) — prazo ${due}` });
    return r!.id;
  });
}

/** Andamento e fechamento. Aceitar o risco de vulnerabilidade alta ou crítica é decisão da Oficial. */
export async function updateVulnerability(ctx: Ctx, id: string, status: 'EM_TRATAMENTO' | 'CORRIGIDA' | 'RISCO_ACEITO', resolution?: string): Promise<void> {
  requirePermission(ctx, 'ativos.gerenciar');
  const st = z.enum(['EM_TRATAMENTO', 'CORRIGIDA', 'RISCO_ACEITO']).parse(status);
  await tx(async (c) => {
    const v = await queryOne<{ title: string; severity: Severity; status: string }>(c, 'SELECT title, severity, status FROM vulnerabilities WHERE id = $1 FOR UPDATE', [z.uuid().parse(id)]);
    if (!v) throw new NotFoundError('Vulnerabilidade não encontrada.');
    if (v.status === 'CORRIGIDA' || v.status === 'RISCO_ACEITO') throw new AppError('Vulnerabilidade já encerrada.');
    if (st === 'EM_TRATAMENTO') {
      await query(c, "UPDATE vulnerabilities SET status = 'EM_TRATAMENTO' WHERE id = $1", [id]);
    } else {
      if (!resolution || resolution.trim().length < 5) throw new AppError(st === 'CORRIGIDA' ? 'Descreva a correção aplicada.' : 'Justifique a aceitação do risco.');
      if (st === 'RISCO_ACEITO' && (v.severity === 'ALTA' || v.severity === 'CRITICA') && !ctx.principal.isOwner) throw new ForbiddenError('Aceitar o risco de vulnerabilidade alta ou crítica é decisão da Oficial.');
      await query(c, 'UPDATE vulnerabilities SET status = $2, resolution = $3, closed_by = $4, closed_at = now() WHERE id = $1', [id, st, resolution.trim(), ctx.principal.userId]);
    }
    await audit(c, ctx, { action: 'VULNERABILIDADE_' + st, entityType: 'vulnerability', entityId: id, summary: `${v.title}: ${st}` });
  });
}

export async function listVulnerabilities(ctx: Ctx) {
  requireAssetsView(ctx);
  return query<{ id: string; title: string; source: string; asset_id: string | null; asset_tag: string | null; severity: string; detected_on: string; due_on: string; status: string;
    resolution: string | null; closed_by_name: string | null; closed_at: Date | null; overdue: boolean }>(getPool(),
    `SELECT v.id, v.title, v.source, v.asset_id, a.tag AS asset_tag, v.severity, v.detected_on, v.due_on, v.status, v.resolution, u.display_name AS closed_by_name, v.closed_at,
            (v.status IN ('ABERTA','EM_TRATAMENTO') AND v.due_on < $1::date) AS overdue
       FROM vulnerabilities v LEFT JOIN assets a ON a.id = v.asset_id LEFT JOIN users u ON u.id = v.closed_by
      ORDER BY (v.status IN ('CORRIGIDA','RISCO_ACEITO')), v.due_on`, [todayLocal()]);
}

// ---------------------------------------------------------------------------
// Downloads de evidências (requisitos, itens de auditoria e backups)
// ---------------------------------------------------------------------------

export async function qualityFileForDownload(ctx: Ctx, fileId: string) {
  z.uuid().parse(fileId);
  const db = getPool();
  const link = await queryOne<{ kind: string }>(db,
    `SELECT 'Q' AS kind FROM requirement_evidences WHERE file_id = $1 UNION ALL SELECT 'Q' FROM audit_items WHERE file_id = $1
     UNION ALL SELECT 'B' FROM backup_records WHERE file_id = $1 LIMIT 1`, [fileId]);
  const p = ctx.principal;
  const allowed = link && (link.kind === 'B' ? canAssets(p) || can(p, 'qualidade.ver') : p.isOwner || can(p, 'qualidade.ver') || can(p, 'qualidade.gerenciar') || can(p, 'qualidade.auditar'));
  if (!allowed) throw new NotFoundError('Arquivo não encontrado.');
  const f = (await loadStoredFile(db, fileId))!;
  const bytes = await readStoredFile(f);
  if (!bytes) throw new AppError('Conteúdo descartado.', 410, 'DESCARTADO');
  await rescan(ctx, f, bytes, 'download', false);
  await audit(db, ctx, { action: 'QUALIDADE_ARQUIVO_DOWNLOAD', entityType: 'document_file', entityId: f.id, summary: `Download de "${f.filename}"` });
  return { filename: f.filename, mime_type: f.mime_type, sha256: f.sha256, data: Buffer.from(bytes) };
}

// ---------------------------------------------------------------------------
// Painel e indicadores
// ---------------------------------------------------------------------------

/** Indicadores de apoio à gestão — não constituem declaração de conformidade ou certificação. */
export async function qualityOverview(ctx: Ctx) {
  const p = ctx.principal;
  const view = p.isOwner || can(p, 'qualidade.ver') || can(p, 'qualidade.gerenciar') || can(p, 'qualidade.auditar');
  if (!view && !canAssets(p) && !can(p, 'incidentes.gerenciar')) throw new ForbiddenError();
  const db = getPool();
  const today = todayLocal();
  const out: Record<string, unknown> = {};
  if (view) {
    const reqs = await query<{ status: ReqStatus; next_review_on: string | null }>(db, 'SELECT status, next_review_on FROM quality_requirements WHERE active');
    out.compliance = { ...complianceIndex(reqs.map((r) => r.status)), total: reqs.length, reviewDue: reqs.filter((r) => r.next_review_on && r.next_review_on <= today).length };
    out.ncs = await queryOne<{ open: number; critical_open: number; awaiting: number; closed_12m: number; avg_days_to_close: number | null }>(db,
      `SELECT count(*) FILTER (WHERE status IN ('ABERTA','EM_TRATAMENTO','AGUARDANDO_VERIFICACAO'))::int AS open,
              count(*) FILTER (WHERE status IN ('ABERTA','EM_TRATAMENTO','AGUARDANDO_VERIFICACAO') AND severity <> 'MENOR')::int AS critical_open,
              count(*) FILTER (WHERE status = 'AGUARDANDO_VERIFICACAO')::int AS awaiting,
              count(*) FILTER (WHERE status = 'ENCERRADA' AND closed_at > now() - interval '12 months')::int AS closed_12m,
              round(avg(extract(epoch FROM closed_at - created_at) / 86400) FILTER (WHERE status = 'ENCERRADA' AND closed_at > now() - interval '12 months'))::int AS avg_days_to_close
         FROM nonconformities`);
    out.actions = await queryOne<{ open: number; overdue: number; done_12m: number; done_on_time_12m: number }>(db,
      `SELECT count(*) FILTER (WHERE t.status NOT IN ('CONCLUIDA','CANCELADA'))::int AS open,
              count(*) FILTER (WHERE t.status NOT IN ('CONCLUIDA','CANCELADA') AND t.due_date < $1::date)::int AS overdue,
              count(*) FILTER (WHERE t.status = 'CONCLUIDA' AND t.completed_at > now() - interval '12 months')::int AS done_12m,
              count(*) FILTER (WHERE t.status = 'CONCLUIDA' AND t.completed_at > now() - interval '12 months' AND (t.due_date IS NULL OR t.completed_at::date <= t.due_date))::int AS done_on_time_12m
         FROM quality_actions a JOIN tasks t ON t.id = a.task_id`, [today]);
    const risks = await query<{ probability: number; impact: number; residual_probability: number | null; residual_impact: number | null; next_review_on: string }>(db,
      "SELECT probability, impact, residual_probability, residual_impact, next_review_on FROM risks WHERE status = 'ATIVO'");
    const bands = { BAIXO: 0, MODERADO: 0, ALTO: 0, CRITICO: 0 };
    for (const r of risks) bands[riskBand(r.probability, r.impact)]++;
    out.risks = {
      total: risks.length, bands, reviewDue: risks.filter((r) => r.next_review_on <= today).length, heatmap: heatmap(risks),
      residualHeatmap: heatmap(risks.map((r) => ({ probability: r.residual_probability ?? r.probability, impact: r.residual_impact ?? r.impact }))),
    };
    out.audits = await query<{ id: string; code: string; title: string; planned_date: string; status: string }>(db,
      "SELECT id, code, title, planned_date, status FROM audits WHERE status IN ('PLANEJADA','EM_EXECUCAO') ORDER BY planned_date LIMIT 10");
  }
  if (can(p, 'incidentes.gerenciar')) {
    out.incidents = await queryOne<{ open: number; personal_pending: number; last_12m: number }>(db,
      `SELECT count(*) FILTER (WHERE status <> 'ENCERRADO')::int AS open,
              count(*) FILTER (WHERE status <> 'ENCERRADO' AND personal_data_involved AND lgpd_assessment IS NULL)::int AS personal_pending,
              count(*) FILTER (WHERE detected_at > now() - interval '12 months')::int AS last_12m FROM incidents`);
  }
  if (canAssets(p) || view) {
    out.vulnerabilities = await queryOne<{ open: number; overdue: number }>(db,
      "SELECT count(*) FILTER (WHERE status IN ('ABERTA','EM_TRATAMENTO'))::int AS open, count(*) FILTER (WHERE status IN ('ABERTA','EM_TRATAMENTO') AND due_on < $1::date)::int AS overdue FROM vulnerabilities", [today]);
    const all = await query<BackupRecord>(db, 'SELECT kind, system, performed_on, result FROM backup_records');
    out.backups = backupStatus(all, today, await getNumberSetting(db, 'seguranca.teste_restauracao_dias', 90));
    out.expiring = await expiringAssets(db);
  }
  return out as {
    compliance?: ReturnType<typeof complianceIndex> & { total: number; reviewDue: number };
    ncs?: { open: number; critical_open: number; awaiting: number; closed_12m: number; avg_days_to_close: number | null };
    actions?: { open: number; overdue: number; done_12m: number; done_on_time_12m: number };
    risks?: { total: number; bands: Record<string, number>; reviewDue: number; heatmap: number[][]; residualHeatmap: number[][] };
    audits?: { id: string; code: string; title: string; planned_date: string; status: string }[];
    incidents?: { open: number; personal_pending: number; last_12m: number };
    vulnerabilities?: { open: number; overdue: number };
    backups?: ReturnType<typeof backupStatus>;
    expiring?: Awaited<ReturnType<typeof expiringAssets>>;
  };
}

async function expiringAssets(db: Db) {
  const notice = await getNumberSetting(db, 'seguranca.aviso_vencimento_ativos_dias', 60);
  const rows = await query<{ id: string; tag: string; name: string; warranty_until: string | null; expires_on: string | null }>(db,
    "SELECT id, tag, name, warranty_until, expires_on FROM assets WHERE status <> 'BAIXADO' AND (warranty_until IS NOT NULL OR expires_on IS NOT NULL)");
  const items = rows.flatMap((a) => [
    ...(a.expires_on ? [{ id: a.id, tag: a.tag, name: a.name, what: 'Validade/licença', expires: a.expires_on }] : []),
    ...(a.warranty_until ? [{ id: a.id, tag: a.tag, name: a.name, what: 'Garantia', expires: a.warranty_until }] : []),
  ]);
  return expiring(items, todayLocal(), notice);
}

// ---------------------------------------------------------------------------
// Lembretes periódicos (rotina agendada); cada aviso é enviado uma única vez (reminder_log).
// ---------------------------------------------------------------------------

async function once(c: Db, key: string): Promise<boolean> {
  return !!(await queryOne(c, 'INSERT INTO reminder_log (key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING key', [key]));
}

export async function processQualityReminders(db: Db = getPool()): Promise<number> {
  const today = todayLocal();
  let sent = 0;
  const send = async (key: string, users: string[] | ((c: Db) => Promise<string[]>), n: Parameters<typeof notifyUsers>[2]) => {
    await tx(async (c) => {
      if (!(await once(c, key))) return;
      const to = typeof users === 'function' ? await users(c) : users;
      await notifyUsers(c, to, n);
      sent++;
    });
  };
  for (const r of await query<{ id: string; code: string; owner_user_id: string; next_review_on: string }>(db,
    'SELECT id, code, owner_user_id, next_review_on FROM quality_requirements WHERE active AND next_review_on <= $1', [today])) {
    await send(`req:${r.id}:${r.next_review_on}`, [r.owner_user_id], { kind: 'QUALIDADE', title: `Requisito ${r.code}: reavaliação devida`, link: '/qualidade?aba=requisitos' });
  }
  for (const r of await query<{ id: string; code: string; owner_user_id: string; next_review_on: string }>(db,
    "SELECT id, code, owner_user_id, next_review_on FROM risks WHERE status = 'ATIVO' AND next_review_on <= $1", [today])) {
    await send(`risk:${r.id}:${r.next_review_on}`, [r.owner_user_id], { kind: 'QUALIDADE', title: `Risco ${r.code}: reavaliação devida`, link: '/qualidade?aba=riscos' });
  }
  for (const a of await query<{ id: string; code: string; lead_auditor_id: string; planned_date: string }>(db,
    "SELECT id, code, lead_auditor_id, planned_date FROM audits WHERE status = 'PLANEJADA' AND planned_date <= $1", [addDays(today, 7)])) {
    await send(`audit:${a.id}:${a.planned_date}`, [a.lead_auditor_id], { kind: 'AUDITORIA', title: `Auditoria ${a.code} planejada para ${a.planned_date}`, link: `/qualidade/auditorias/${a.id}` });
  }
  const assetManagers = (c: Db) => managers(c, 'ativos.gerenciar');
  for (const v of await query<{ id: string; title: string; severity: string; due_on: string }>(db,
    "SELECT id, title, severity, due_on FROM vulnerabilities WHERE status IN ('ABERTA','EM_TRATAMENTO') AND due_on <= $1", [addDays(today, 7)])) {
    const late = v.due_on < today;
    await send(`vuln:${v.id}:${late ? 'vencida' : 'a-vencer'}`, assetManagers,
      { kind: 'VULNERABILIDADE', title: late ? `Vulnerabilidade com prazo vencido (${v.severity.toLowerCase()})` : `Vulnerabilidade vence em ${v.due_on}`, body: v.title, link: '/qualidade?aba=vulnerabilidades', priority: late ? 'ALTA' : 'NORMAL' });
  }
  for (const e of await expiringAssets(db)) {
    await send(`asset:${e.id}:${e.what}:${e.expires}`, assetManagers,
      { kind: 'ATIVO', title: `${e.what} de ${e.tag} ${e.daysLeft < 0 ? 'vencida' : `vence em ${e.expires}`}`, body: e.name, link: '/qualidade?aba=ativos', priority: e.daysLeft < 0 ? 'ALTA' : 'NORMAL' });
  }
  const all = await query<BackupRecord>(db, 'SELECT kind, system, performed_on, result FROM backup_records');
  for (const b of backupStatus(all, today, await getNumberSetting(db, 'seguranca.teste_restauracao_dias', 90)).filter((s) => s.restoreOverdue)) {
    await send(`restore:${b.system}:${b.lastRestoreOk ?? 'nunca'}`, assetManagers,
      { kind: 'BACKUP', title: `Teste de restauração de ${b.system} em atraso`, body: b.lastRestoreOk ? `Último teste bem-sucedido: ${b.lastRestoreOk}` : 'Nenhum teste bem-sucedido registrado.', link: '/qualidade?aba=backups', priority: 'ALTA' });
  }
  return sent;
}
