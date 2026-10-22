import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx, Principal } from '../context.ts';
import { can, loadPrincipal, requirePermission, requireStepUp } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors.ts';
import { canonicalJson, sha256Hex } from '../crypto.ts';
import { getNumberSetting } from '../settings.ts';
import { checkFile } from '../files.ts';
import { addDays, addMonths, todayLocal } from '../../domain/time.ts';
import { recordSignature } from './documents.ts';
import { notifyUsers, usersWithPermission } from './notifications.ts';

// Repositório institucional de documentos (Fase 3).
// Ciclo: RASCUNHO → (submissão) EM_APROVACAO → (aprovação por outra pessoa, com assinatura simples e reautenticação) VIGENTE
// → nova revisão (a anterior fica obsoleta) | OBSOLETO | ARQUIVADO. Versões submetidas são imutáveis e identificadas por SHA-256.
// Acesso: público destinatário (todos, setores ou pessoas) e confidencialidade. Documento CONFIDENCIAL só é visto pela Oficial,
// pelo responsável, por quem o criou e pelas pessoas da lista — nem a permissão de gestão o alcança.

export const REPO = 'REPOSITORIO';

export type DocStatus = 'RASCUNHO' | 'EM_APROVACAO' | 'VIGENTE' | 'OBSOLETO' | 'ARQUIVADO';
export type Confidentiality = 'INTERNO' | 'RESTRITO' | 'CONFIDENCIAL';
export type AudienceType = 'TODOS' | 'SETORES' | 'USUARIOS';
export type Draft = { texto: string; notaVersao: string; arquivoId: string | null };

export type RepoDocRow = {
  id: string; title: string; code: string | null; summary: string | null; status: DocStatus; confidentiality: Confidentiality;
  category_id: string; category_name: string; sector_id: string; sector_name: string; responsible_user_id: string; responsible_name: string;
  created_by: string; created_at: Date; updated_at: Date; review_months: number | null; next_review_on: string | null; effective_from: string | null;
  audience_type: AudienceType; requires_acknowledgement: boolean; draft: Draft | null; draft_updated_by: string | null; draft_updated_at: Date | null;
  pending_version_id: string | null; current_version_id: string | null; current_version_number: number | null;
  obsolete_at: Date | null; archived_at: Date | null; retention_until: string | null;
  aud_sectors: string[]; aud_users: string[];
};

const DOC_SELECT = `
  SELECT d.id, d.title, d.code, d.summary, d.status, d.confidentiality, d.category_id, c.name AS category_name, d.sector_id, s.name AS sector_name,
         d.responsible_user_id, ru.display_name AS responsible_name, d.created_by, d.created_at, d.updated_at, d.review_months,
         d.next_review_on, d.effective_from, d.audience_type, d.requires_acknowledgement, d.draft, d.draft_updated_by, d.draft_updated_at,
         d.pending_version_id, d.current_version_id, cv.version_number AS current_version_number, d.obsolete_at, d.archived_at, d.retention_until,
         ARRAY(SELECT sector_id FROM document_audience_sectors WHERE document_id = d.id) AS aud_sectors,
         ARRAY(SELECT user_id FROM document_audience_users WHERE document_id = d.id) AS aud_users
    FROM documents d
    JOIN document_categories c ON c.id = d.category_id
    JOIN sectors s ON s.id = d.sector_id
    JOIN users ru ON ru.id = d.responsible_user_id
    LEFT JOIN document_versions cv ON cv.id = d.current_version_id`;

export type Access = {
  /** Pode ler a versão vigente. */
  read: boolean;
  /** Pode ver rascunho, versões anteriores, submissões e histórico. */
  history: boolean;
  edit: boolean;
  approve: boolean;
  manage: boolean;
  /** Integra o público destinatário (ciência). */
  audience: boolean;
};

/** Regras de acesso a um documento do repositório (função pura, testada isoladamente). */
export function accessFor(
  p: Principal,
  d: Pick<RepoDocRow, 'status' | 'confidentiality' | 'sector_id' | 'responsible_user_id' | 'created_by' | 'audience_type' | 'aud_sectors' | 'aud_users'>,
): Access {
  const listed = d.aud_users.includes(p.userId) || d.responsible_user_id === p.userId || d.created_by === p.userId;
  const confidential = d.confidentiality === 'CONFIDENCIAL';
  const cleared = !confidential || p.isOwner || listed;
  const audience =
    d.audience_type === 'TODOS' ? !confidential
      : d.audience_type === 'SETORES' ? (!!p.employeeSectorId && d.aud_sectors.includes(p.employeeSectorId))
      : d.aud_users.includes(p.userId);
  const manage = cleared && can(p, 'documentos.gerenciar');
  const editScope = cleared && can(p, 'documentos.editar', { sectorId: d.sector_id });
  const approve = cleared && can(p, 'documentos.aprovar', { sectorId: d.sector_id });
  const history = p.isOwner || manage || editScope || approve || d.responsible_user_id === p.userId || d.created_by === p.userId;
  const read = history || (d.status === 'VIGENTE' && audience && can(p, 'documentos.ver'));
  return {
    read, history, manage, approve,
    edit: editScope && d.status !== 'OBSOLETO' && d.status !== 'ARQUIVADO',
    audience: audience && can(p, 'documentos.ver'),
  };
}

async function loadDoc(db: Db, id: string, lock = false): Promise<RepoDocRow> {
  z.uuid().parse(id);
  if (lock) await query(db, 'SELECT 1 FROM documents WHERE id = $1 FOR UPDATE', [id]);
  const d = await queryOne<RepoDocRow>(db, `${DOC_SELECT} WHERE d.id = $1 AND d.reference_type = '${REPO}'`, [id]);
  if (!d) throw new NotFoundError('Documento não encontrado.');
  return d;
}

/** Carrega e exige o nível de acesso; sem leitura, responde como inexistente (não revela a existência). */
async function loadWith(db: Db, ctx: Ctx, id: string, need: keyof Access, lock = false) {
  const d = await loadDoc(db, id, lock);
  const a = accessFor(ctx.principal, d);
  if (!a.read) throw new NotFoundError('Documento não encontrado.');
  if (!a[need]) throw new ForbiddenError();
  return { d, a };
}

async function event(c: Db, ctx: Ctx, documentId: string, ev: string, details: Record<string, unknown> = {}) {
  await query(c, 'INSERT INTO document_events (document_id, user_id, event, details) VALUES ($1,$2,$3,$4)', [documentId, ctx.principal.userId, ev, JSON.stringify(details)]);
}

// ---------------------------------------------------------------------------
// Categorias
// ---------------------------------------------------------------------------

export type CategoryRow = {
  id: string; code: string; name: string; description: string | null; review_months: number | null; retention_months: number | null;
  retention_basis: string | null; default_confidentiality: Confidentiality; active: boolean; documents: number;
};

export async function listCategories(): Promise<CategoryRow[]> {
  return query<CategoryRow>(
    getPool(),
    `SELECT c.*, (SELECT count(*)::int FROM documents d WHERE d.category_id = c.id) AS documents
       FROM document_categories c ORDER BY c.sort_order, c.name`,
  );
}

const categorySchema = z.object({
  id: z.uuid().optional(),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,40}$/, 'Código: letras maiúsculas, números e _'),
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(500).optional(),
  reviewMonths: z.number().int().min(1).max(120).nullable(),
  retentionMonths: z.number().int().min(1).max(1200).nullable(),
  retentionBasis: z.string().trim().max(300).optional(),
  defaultConfidentiality: z.enum(['INTERNO', 'RESTRITO', 'CONFIDENCIAL']),
  active: z.boolean(),
});

export async function saveCategory(ctx: Ctx, input: z.input<typeof categorySchema>): Promise<string> {
  requirePermission(ctx, 'documentos.gerenciar');
  const d = categorySchema.parse(input);
  if (d.retentionMonths && (!d.retentionBasis || d.retentionBasis.length < 5)) {
    throw new AppError('Informe o fundamento do prazo de retenção (norma, tabela de temporalidade ou decisão registrada).');
  }
  return tx(async (c) => {
    const params = [d.code, d.name, d.description ?? null, d.reviewMonths, d.retentionMonths, d.retentionMonths ? d.retentionBasis : null, d.defaultConfidentiality, d.active];
    const row = d.id
      ? await queryOne<{ id: string }>(c, `UPDATE document_categories SET code=$1, name=$2, description=$3, review_months=$4, retention_months=$5,
          retention_basis=$6, default_confidentiality=$7, active=$8 WHERE id=$9 RETURNING id`, [...params, d.id])
      : await queryOne<{ id: string }>(c, `INSERT INTO document_categories (code, name, description, review_months, retention_months, retention_basis,
          default_confidentiality, active, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,(SELECT coalesce(max(sort_order),0)+10 FROM document_categories)) RETURNING id`, params)
        .catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('Já existe categoria com este código ou nome.'); throw e; });
    if (!row) throw new NotFoundError('Categoria não encontrada.');
    await audit(c, ctx, { action: d.id ? 'DOC_CATEGORIA_ALTERADA' : 'DOC_CATEGORIA_CRIADA', entityType: 'document_category', entityId: row.id,
      summary: `Categoria "${d.name}" (revisão ${d.reviewMonths ?? '—'} meses; retenção ${d.retentionMonths ?? 'não definida'})`, data: d });
    return row.id;
  });
}

// ---------------------------------------------------------------------------
// Cadastro e metadados
// ---------------------------------------------------------------------------

const metaSchema = z.object({
  categoryId: z.uuid({ error: 'Selecione a categoria.' }),
  title: z.string().trim().min(3).max(200),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._/-]{1,39}$/, 'Código inválido (ex.: POP-RI-001).').optional(),
  summary: z.string().trim().max(1000).optional(),
  sectorId: z.uuid({ error: 'Selecione o setor responsável.' }),
  responsibleUserId: z.uuid().optional(),
  confidentiality: z.enum(['INTERNO', 'RESTRITO', 'CONFIDENCIAL']).optional(),
  audienceType: z.enum(['TODOS', 'SETORES', 'USUARIOS']),
  audienceSectorIds: z.array(z.uuid()).default([]),
  audienceUserIds: z.array(z.uuid()).default([]),
  requiresAcknowledgement: z.boolean().default(false),
  reviewMonths: z.number().int().min(1).max(120).nullable().optional(),
});
export type MetaInput = z.input<typeof metaSchema>;

async function normalizeMeta(c: Db, input: MetaInput) {
  const d = metaSchema.parse(input);
  const cat = await queryOne<{ id: string; active: boolean; review_months: number | null; default_confidentiality: Confidentiality }>(
    c, 'SELECT id, active, review_months, default_confidentiality FROM document_categories WHERE id = $1', [d.categoryId]);
  if (!cat) throw new AppError('Categoria inexistente.');
  const confidentiality = d.confidentiality ?? cat.default_confidentiality;
  // Confidencial: somente pessoas nominalmente indicadas. Restrito: nunca "todos".
  if (confidentiality === 'CONFIDENCIAL' && d.audienceType !== 'USUARIOS') throw new AppError('Documento confidencial deve indicar nominalmente as pessoas com acesso.');
  if (confidentiality === 'RESTRITO' && d.audienceType === 'TODOS') throw new AppError('Documento restrito deve indicar setores ou pessoas.');
  if (d.audienceType === 'SETORES' && !d.audienceSectorIds.length) throw new AppError('Selecione ao menos um setor destinatário.');
  if (d.audienceType === 'USUARIOS' && !d.audienceUserIds.length) throw new AppError('Selecione ao menos uma pessoa destinatária.');
  const users = [...new Set(d.audienceType === 'USUARIOS' ? d.audienceUserIds : [])];
  const sectors = [...new Set(d.audienceType === 'SETORES' ? d.audienceSectorIds : [])];
  if (users.length) {
    const ok = (await queryOne<{ n: number }>(c, "SELECT count(*)::int AS n FROM users WHERE id = ANY($1::uuid[]) AND status = 'ATIVO'", [users]))!.n;
    if (ok !== users.length) throw new AppError('Há pessoa destinatária inexistente ou inativa.');
  }
  if (sectors.length) {
    const ok = (await queryOne<{ n: number }>(c, 'SELECT count(*)::int AS n FROM sectors WHERE id = ANY($1::uuid[])', [sectors]))!.n;
    if (ok !== sectors.length) throw new AppError('Setor destinatário inexistente.');
  }
  if (!(await queryOne(c, 'SELECT 1 FROM sectors WHERE id = $1', [d.sectorId]))) throw new AppError('Setor responsável inexistente.');
  if (d.responsibleUserId && !(await queryOne(c, "SELECT 1 FROM users WHERE id = $1 AND status = 'ATIVO'", [d.responsibleUserId]))) {
    throw new AppError('Responsável inexistente ou inativo.');
  }
  return { ...d, confidentiality, users, sectors, reviewMonths: d.reviewMonths === undefined ? cat.review_months : d.reviewMonths, categoryActive: cat.active };
}

async function writeAudience(c: Db, documentId: string, sectors: string[], users: string[]) {
  await query(c, 'DELETE FROM document_audience_sectors WHERE document_id = $1', [documentId]);
  await query(c, 'DELETE FROM document_audience_users WHERE document_id = $1', [documentId]);
  if (sectors.length) await query(c, 'INSERT INTO document_audience_sectors SELECT $1, unnest($2::uuid[])', [documentId, sectors]);
  if (users.length) await query(c, 'INSERT INTO document_audience_users SELECT $1, unnest($2::uuid[])', [documentId, users]);
}

function mapCodeConflict(e: { code?: string; constraint?: string }): never {
  if (e.code === '23505' && e.constraint === 'ux_documents_repository_code') throw new ConflictError('Já existe documento com este código.');
  throw e;
}

export async function createDocument(ctx: Ctx, input: MetaInput): Promise<string> {
  return tx(async (c) => {
    const d = await normalizeMeta(c, input);
    requirePermission(ctx, 'documentos.editar', { sectorId: d.sectorId });
    if (!d.categoryActive) throw new AppError('Categoria inativa.');
    const responsible = d.responsibleUserId ?? ctx.principal.userId;
    const row = await queryOne<{ id: string }>(
      c,
      `INSERT INTO documents (reference_type, category, category_id, title, code, summary, confidentiality, sector_id, responsible_user_id,
                              review_months, audience_type, requires_acknowledgement, status, draft, draft_updated_by, draft_updated_at, created_by)
       VALUES ('${REPO}', (SELECT name FROM document_categories WHERE id = $1), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'RASCUNHO', $11, $12, now(), $12)
       RETURNING id`,
      [d.categoryId, d.title, d.code ?? null, d.summary ?? null, d.confidentiality, d.sectorId, responsible, d.reviewMonths, d.audienceType,
        d.requiresAcknowledgement, JSON.stringify({ texto: '', notaVersao: '', arquivoId: null } satisfies Draft), ctx.principal.userId],
    ).catch(mapCodeConflict);
    await writeAudience(c, row!.id, d.sectors, d.users);
    await event(c, ctx, row!.id, 'CRIADO', { titulo: d.title, confidencialidade: d.confidentiality, publico: d.audienceType });
    await audit(c, ctx, { action: 'DOC_CRIADO', entityType: 'document', entityId: row!.id, summary: `Documento "${d.title}" criado (rascunho)` });
    return row!.id;
  });
}

/**
 * Altera metadados. Público, confidencialidade, responsável e setor: gestão, ou quem edita enquanto o documento nunca foi publicado.
 */
export async function updateMetadata(ctx: Ctx, id: string, input: MetaInput): Promise<void> {
  await tx(async (c) => {
    const { d: before, a } = await loadWith(c, ctx, id, 'read', true);
    if (!a.edit && !a.manage) throw new ForbiddenError();
    if (before.status === 'ARQUIVADO') throw new AppError('Documento arquivado não pode ser alterado.');
    const d = await normalizeMeta(c, input);
    const accessChanged = d.confidentiality !== before.confidentiality || d.audienceType !== before.audience_type || d.sectorId !== before.sector_id
      || (d.responsibleUserId ?? before.responsible_user_id) !== before.responsible_user_id || d.requiresAcknowledgement !== before.requires_acknowledgement
      || [...d.sectors].sort().join() !== [...before.aud_sectors].sort().join() || [...d.users].sort().join() !== [...before.aud_users].sort().join();
    if (accessChanged && !a.manage && before.current_version_id) {
      throw new ForbiddenError('Alterações de acesso em documento já publicado exigem a permissão de gestão documental.');
    }
    // Quem altera o setor precisa ter permissão de edição também no novo setor (evita "empurrar" documento para fora do próprio escopo).
    if (d.sectorId !== before.sector_id && !a.manage) requirePermission(ctx, 'documentos.editar', { sectorId: d.sectorId });
    const after = { ...before, confidentiality: d.confidentiality, audience_type: d.audienceType, aud_sectors: d.sectors, aud_users: d.users,
      sector_id: d.sectorId, responsible_user_id: d.responsibleUserId ?? before.responsible_user_id };
    if (!accessFor(ctx.principal, after).history) throw new AppError('A alteração retiraria seu próprio acesso ao documento. Ajuste o público ou o responsável.');
    await query(
      c,
      `UPDATE documents SET category_id=$2, category=(SELECT name FROM document_categories WHERE id=$2), title=$3, code=$4, summary=$5, confidentiality=$6,
              sector_id=$7, responsible_user_id=$8, review_months=$9, audience_type=$10, requires_acknowledgement=$11,
              next_review_on = CASE WHEN effective_from IS NOT NULL AND $9::int IS NOT NULL THEN (effective_from + make_interval(months => $9::int))::date
                                    WHEN $9::int IS NULL THEN NULL ELSE next_review_on END,
              updated_at=now() WHERE id=$1`,
      [id, d.categoryId, d.title, d.code ?? null, d.summary ?? null, d.confidentiality, d.sectorId, after.responsible_user_id, d.reviewMonths,
        d.audienceType, d.requiresAcknowledgement],
    ).catch(mapCodeConflict);
    await writeAudience(c, id, d.sectors, d.users);
    const changes: Record<string, unknown> = {};
    if (before.title !== d.title) changes.titulo = { de: before.title, para: d.title };
    if ((before.code ?? null) !== (d.code ?? null)) changes.codigo = { de: before.code, para: d.code ?? null };
    if (before.category_id !== d.categoryId) changes.categoria = true;
    if (before.review_months !== d.reviewMonths) changes.revisaoMeses = { de: before.review_months, para: d.reviewMonths };
    if (accessChanged) changes.acesso = { confidencialidade: d.confidentiality, publico: d.audienceType, setores: d.sectors.length, pessoas: d.users.length, ciencia: d.requiresAcknowledgement };
    if ((before.summary ?? null) !== (d.summary ?? null)) changes.resumo = true;
    await event(c, ctx, id, 'METADADOS', changes);
    await audit(c, ctx, { action: accessChanged ? 'DOC_ACESSO_ALTERADO' : 'DOC_METADADOS', entityType: 'document', entityId: id, summary: `Metadados de "${d.title}" alterados`, data: changes });
  });
}

// ---------------------------------------------------------------------------
// Rascunho, arquivo e submissão
// ---------------------------------------------------------------------------

export async function maxFileBytes(db: Db = getPool()): Promise<number> {
  return Math.round((await getNumberSetting(db, 'documentos.arquivo_max_mb', 15)) * 1048576);
}

const draftSchema = z.object({
  texto: z.string().max(200_000, 'Texto muito extenso (máx. 200 mil caracteres).'),
  notaVersao: z.string().trim().max(1000),
  removeFile: z.boolean().default(false),
});

/** Salva o rascunho (texto, nota da versão e, opcionalmente, arquivo). */
export async function saveDraft(
  ctx: Ctx, id: string, input: z.input<typeof draftSchema>, file?: { name: string; bytes: Uint8Array } | null,
): Promise<void> {
  const d = draftSchema.parse(input);
  const db = getPool();
  const checked = file && file.bytes.byteLength ? checkFile(file.name, file.bytes, await maxFileBytes(db)) : null;
  await tx(async (c) => {
    const { d: doc } = await loadWith(c, ctx, id, 'edit', true);
    if (doc.pending_version_id) throw new AppError('Há versão aguardando aprovação. Aguarde a decisão para editar o rascunho.');
    // Sem rascunho em curso (revisão de documento vigente), o arquivo da versão vigente é o ponto de partida.
    const inherited = !doc.draft && doc.current_version_id
      ? (await queryOne<{ file_id: string | null }>(c, 'SELECT file_id FROM document_version_reviews WHERE version_id = $1', [doc.current_version_id]))?.file_id ?? null
      : null;
    let arquivoId = d.removeFile ? null : doc.draft ? doc.draft.arquivoId : inherited;
    if (checked) {
      const f = await queryOne<{ id: string }>(
        c, 'INSERT INTO document_files (filename, mime_type, size_bytes, sha256, data, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [checked.filename, checked.mime, checked.size, sha256Hex(Buffer.from(file!.bytes)), Buffer.from(file!.bytes), ctx.principal.userId]);
      arquivoId = f!.id;
    }
    const draft: Draft = { texto: d.texto.replace(/\r\n/g, '\n'), notaVersao: d.notaVersao, arquivoId };
    await query(c, 'UPDATE documents SET draft=$2, draft_updated_by=$3, draft_updated_at=now(), updated_at=now() WHERE id=$1', [id, JSON.stringify(draft), ctx.principal.userId]);
    await event(c, ctx, id, 'RASCUNHO_SALVO', { caracteres: draft.texto.length, arquivo: checked ? { nome: checked.filename, bytes: checked.size } : d.removeFile ? 'removido' : undefined });
  });
}

export type VersionContent = {
  tipo: 'REPOSITORIO'; layout: 1;
  titulo: string; codigo: string | null; categoria: string; texto: string; notaVersao: string;
  arquivo: { id: string; nome: string; mime: string; bytes: number; sha256: string } | null;
  elaboradoPor: { id: string; nome: string } | null;
};

export async function submitForApproval(ctx: Ctx, id: string): Promise<string> {
  return tx(async (c) => {
    const { d } = await loadWith(c, ctx, id, 'edit', true);
    if (d.pending_version_id) throw new AppError('Já existe versão aguardando aprovação.');
    const draft = d.draft;
    if (!draft || (!draft.texto.trim() && !draft.arquivoId)) throw new AppError('O rascunho está vazio: inclua o texto ou um arquivo.');
    if (d.current_version_id && !draft.notaVersao.trim()) throw new AppError('Descreva o que mudou nesta revisão (nota da versão).');
    const file = draft.arquivoId
      ? await queryOne<{ id: string; filename: string; mime_type: string; size_bytes: number; sha256: string; purged_at: Date | null }>(
          c, 'SELECT id, filename, mime_type, size_bytes, sha256, purged_at FROM document_files WHERE id = $1', [draft.arquivoId])
      : null;
    if (file?.purged_at) throw new AppError('O arquivo do rascunho foi descartado.');
    const author = d.draft_updated_by
      ? await queryOne<{ id: string; display_name: string }>(c, 'SELECT id, display_name FROM users WHERE id = $1', [d.draft_updated_by]) : null;
    const content: VersionContent = {
      tipo: 'REPOSITORIO', layout: 1, titulo: d.title, codigo: d.code, categoria: d.category_name, texto: draft.texto, notaVersao: draft.notaVersao,
      arquivo: file ? { id: file.id, nome: file.filename, mime: file.mime_type, bytes: file.size_bytes, sha256: file.sha256 } : null,
      elaboradoPor: author ? { id: author.id, nome: author.display_name } : null,
    };
    const hash = sha256Hex(canonicalJson(content));
    const next = (await queryOne<{ n: number }>(c, 'SELECT coalesce(max(version_number),0)+1 AS n FROM document_versions WHERE document_id = $1', [id]))!.n;
    const v = await queryOne<{ id: string }>(
      c, 'INSERT INTO document_versions (document_id, version_number, content, content_sha256, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [id, next, JSON.stringify(content), hash, ctx.principal.userId]);
    await query(c, 'INSERT INTO document_version_reviews (version_id, submitted_by, file_id) VALUES ($1,$2,$3)', [v!.id, ctx.principal.userId, file?.id ?? null]);
    await query(
      c,
      `UPDATE documents SET pending_version_id=$2, status = CASE WHEN status = 'RASCUNHO' THEN 'EM_APROVACAO' ELSE status END,
              draft=NULL, draft_updated_by=NULL, draft_updated_at=NULL, updated_at=now() WHERE id=$1`,
      [id, v!.id]);
    await event(c, ctx, id, 'SUBMETIDO', { versao: next, sha256: hash });
    await audit(c, ctx, { action: 'DOC_SUBMETIDO', entityType: 'document_version', entityId: v!.id, summary: `"${d.title}" v${next} submetida à aprovação (sha256 ${hash.slice(0, 16)}…)` });
    const approvers = (await usersWithPermission(c, 'documentos.aprovar', d.sector_id))
      .filter((u) => u !== ctx.principal.userId && u !== d.draft_updated_by);
    const visible = await filterUsersWithAccess(c, approvers, d, 'approve');
    await notifyUsers(c, visible, { kind: 'DOCUMENTO_PARA_APROVACAO', title: 'Documento aguardando aprovação', body: `${d.title} — versão ${next}`, link: `/documentos/${id}` });
    return v!.id;
  });
}

/** Mantém somente os usuários que efetivamente têm o acesso indicado (respeita a confidencialidade). */
async function filterUsersWithAccess(c: Db, userIds: string[], d: RepoDocRow, need: keyof Access): Promise<string[]> {
  if (d.confidentiality !== 'CONFIDENCIAL') return userIds;
  const out: string[] = [];
  for (const u of userIds) {
    const p = await loadPrincipal(c, u);
    if (p && accessFor(p, d)[need]) out.push(u);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aprovação
// ---------------------------------------------------------------------------

const decideSchema = z.object({
  versionId: z.uuid(),
  decision: z.enum(['APROVADA', 'REJEITADA']),
  notes: z.string().trim().max(2000).optional(),
  confirmed: z.boolean().default(false),
});

export async function decideVersion(ctx: Ctx, id: string, input: z.input<typeof decideSchema>): Promise<void> {
  const d = decideSchema.parse(input);
  if (d.decision === 'APROVADA') {
    if (!d.confirmed) throw new AppError('É necessário confirmar expressamente a aprovação.');
    await requireStepUp(getPool(), ctx);
  } else if (!d.notes || d.notes.length < 5) {
    throw new AppError('Informe o motivo da rejeição.');
  }
  await tx(async (c) => {
    const { d: doc } = await loadWith(c, ctx, id, 'approve', true);
    if (doc.pending_version_id !== d.versionId) throw new AppError('Esta versão não está aguardando aprovação.');
    const v = await queryOne<{ id: string; version_number: number; content: VersionContent; content_sha256: string; submitted_by: string }>(
      c,
      `SELECT v.id, v.version_number, v.content, v.content_sha256, r.submitted_by FROM document_versions v
         JOIN document_version_reviews r ON r.version_id = v.id WHERE v.id = $1 AND v.document_id = $2`,
      [d.versionId, id]);
    if (!v) throw new NotFoundError('Versão não encontrada.');
    // Segregação de funções: quem elaborou ou submeteu não aprova.
    if (v.submitted_by === ctx.principal.userId || v.content.elaboradoPor?.id === ctx.principal.userId) {
      throw new ForbiddenError('Segregação de funções: quem elaborou ou submeteu a versão não pode decidir sobre ela.');
    }
    if (sha256Hex(canonicalJson(v.content)) !== v.content_sha256) {
      throw new AppError('Falha de integridade: o conteúdo não corresponde ao hash registrado. Operação bloqueada.', 500, 'INTEGRIDADE');
    }
    if (v.content.arquivo) {
      const f = await queryOne<{ ok: boolean }>(c, 'SELECT data IS NOT NULL AND sha256 = encode(sha256(data), \'hex\') AS ok FROM document_files WHERE id = $1', [v.content.arquivo.id]);
      if (!f?.ok) throw new AppError('Falha de integridade do arquivo anexado. Operação bloqueada.', 500, 'INTEGRIDADE');
    }
    if (d.decision === 'REJEITADA') {
      await query(c, "UPDATE document_version_reviews SET decision='REJEITADA', decided_by=$2, decided_at=now(), decision_notes=$3 WHERE version_id=$1",
        [v.id, ctx.principal.userId, d.notes]);
      const draft: Draft = { texto: v.content.texto, notaVersao: v.content.notaVersao, arquivoId: v.content.arquivo?.id ?? null };
      await query(c, `UPDATE documents SET pending_version_id=NULL, status = CASE WHEN current_version_id IS NULL THEN 'RASCUNHO' ELSE status END,
                      draft=$2, draft_updated_by=$3, draft_updated_at=now(), updated_at=now() WHERE id=$1`,
        [id, JSON.stringify(draft), v.content.elaboradoPor?.id ?? v.submitted_by]);
      await event(c, ctx, id, 'REJEITADO', { versao: v.version_number, motivo: d.notes });
      await audit(c, ctx, { action: 'DOC_REJEITADO', entityType: 'document_version', entityId: v.id, summary: `"${doc.title}" v${v.version_number} rejeitada` });
      await notifyUsers(c, [v.submitted_by], { kind: 'DOCUMENTO_REJEITADO', title: 'Versão rejeitada', body: `${doc.title}: ${d.notes}`, link: `/documentos/${id}`, priority: 'ALTA' });
      return;
    }
    const signatureId = await recordSignature(c, ctx, { id: v.id, contentSha256: v.content_sha256, title: doc.title, versionNumber: v.version_number }, 'APROVACAO', d.notes);
    const today = todayLocal();
    await query(c, "UPDATE document_version_reviews SET decision='APROVADA', decided_by=$2, decided_at=now(), decision_notes=$3, signature_id=$4 WHERE version_id=$1",
      [v.id, ctx.principal.userId, d.notes ?? null, signatureId]);
    if (doc.current_version_id) {
      await query(c, 'UPDATE document_version_reviews SET superseded_at=now() WHERE version_id=$1 AND superseded_at IS NULL', [doc.current_version_id]);
    }
    await query(
      c,
      `UPDATE documents SET current_version_id=$2, pending_version_id=NULL, status='VIGENTE', effective_from=$3, next_review_on=$4, updated_at=now() WHERE id=$1`,
      [id, v.id, today, doc.review_months ? addMonths(today, doc.review_months) : null]);
    await event(c, ctx, id, 'APROVADO', { versao: v.version_number, vigencia: today, anterior: doc.current_version_number });
    await audit(c, ctx, { action: 'DOC_APROVADO', entityType: 'document_version', entityId: v.id, summary: `"${doc.title}" v${v.version_number} aprovada e vigente desde ${today}` });
    await notifyUsers(c, [v.submitted_by, doc.responsible_user_id].filter((u) => u !== ctx.principal.userId), {
      kind: 'DOCUMENTO_APROVADO', title: 'Documento aprovado e vigente', body: `${doc.title} — versão ${v.version_number}`, link: `/documentos/${id}`,
    });
    if (doc.requires_acknowledgement) {
      const audience = await audienceUserIds(c, { ...doc, status: 'VIGENTE' });
      await notifyUsers(c, audience, { kind: 'DOCUMENTO_PARA_CIENCIA', title: 'Documento para ciência', body: `${doc.title} — versão ${v.version_number}`, link: `/documentos/${id}`, priority: 'ALTA' });
    }
  });
}

// ---------------------------------------------------------------------------
// Ciência
// ---------------------------------------------------------------------------

/** Usuários ativos que integram o público destinatário do documento. */
export async function audienceUserIds(db: Db, d: RepoDocRow): Promise<string[]> {
  const rows = d.audience_type === 'TODOS'
    ? await query<{ id: string }>(db, "SELECT id FROM users WHERE status = 'ATIVO'")
    : d.audience_type === 'SETORES'
      ? await query<{ id: string }>(db, `SELECT u.id FROM users u JOIN employees e ON e.user_id = u.id AND e.status <> 'DESLIGADO'
                                           WHERE u.status = 'ATIVO' AND e.sector_id = ANY($1::uuid[])`, [d.aud_sectors])
      : await query<{ id: string }>(db, "SELECT id FROM users WHERE status = 'ATIVO' AND id = ANY($1::uuid[])", [d.aud_users]);
  const out: string[] = [];
  for (const r of rows) {
    const p = await loadPrincipal(db, r.id);
    if (p && accessFor(p, d).audience) out.push(r.id);
  }
  return out;
}

export async function acknowledge(ctx: Ctx, id: string, confirmed: boolean): Promise<string> {
  if (!confirmed) throw new AppError('É necessário confirmar expressamente a ciência.');
  await requireStepUp(getPool(), ctx);
  return tx(async (c) => {
    const { d, a } = await loadWith(c, ctx, id, 'read', true);
    if (d.status !== 'VIGENTE' || !d.current_version_id) throw new AppError('Somente documentos vigentes recebem ciência.');
    if (!d.requires_acknowledgement) throw new AppError('Este documento não exige ciência.');
    if (!a.audience) throw new ForbiddenError('Você não integra o público destinatário deste documento.');
    const v = await queryOne<{ id: string; version_number: number; content: unknown; content_sha256: string }>(
      c, 'SELECT id, version_number, content, content_sha256 FROM document_versions WHERE id = $1', [d.current_version_id]);
    if (sha256Hex(canonicalJson(v!.content)) !== v!.content_sha256) throw new AppError('Falha de integridade do conteúdo. Operação bloqueada.', 500, 'INTEGRIDADE');
    const id2 = await recordSignature(c, ctx, { id: v!.id, contentSha256: v!.content_sha256, title: d.title, versionNumber: v!.version_number }, 'CIENCIA');
    await event(c, ctx, id, 'CIENCIA', { versao: v!.version_number });
    return id2;
  });
}

export async function acknowledgementReport(ctx: Ctx, id: string) {
  const db = getPool();
  const { d, a } = await loadWith(db, ctx, id, 'read');
  if (!a.manage && d.responsible_user_id !== ctx.principal.userId && !ctx.principal.isOwner) throw new ForbiddenError();
  if (!d.current_version_id || !d.requires_acknowledgement) return null;
  const audience = await audienceUserIds(db, d);
  const rows = await query<{ id: string; display_name: string; sector_name: string | null; signed_at: Date | null }>(
    db,
    `SELECT u.id, u.display_name, s.name AS sector_name,
            (SELECT g.signed_at FROM signatures g WHERE g.document_version_id = $2 AND g.signer_user_id = u.id AND g.act = 'CIENCIA') AS signed_at
       FROM users u LEFT JOIN employees e ON e.user_id = u.id AND e.status <> 'DESLIGADO' LEFT JOIN sectors s ON s.id = e.sector_id
      WHERE u.id = ANY($1::uuid[]) ORDER BY u.display_name`,
    [audience, d.current_version_id]);
  return { versionNumber: d.current_version_number, rows, done: rows.filter((r) => r.signed_at).length, total: rows.length };
}

// ---------------------------------------------------------------------------
// Obsolescência, arquivamento e descarte
// ---------------------------------------------------------------------------

async function retentionUntil(c: Db, categoryId: string, from: string): Promise<string | null> {
  const r = await queryOne<{ retention_months: number | null }>(c, 'SELECT retention_months FROM document_categories WHERE id = $1', [categoryId]);
  return r?.retention_months ? addMonths(from, r.retention_months) : null;
}

export async function changeLifecycle(ctx: Ctx, id: string, op: 'OBSOLETO' | 'ARQUIVADO', reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new AppError('Informe o motivo.');
  await tx(async (c) => {
    const { d } = await loadWith(c, ctx, id, 'manage', true);
    if (d.pending_version_id) throw new AppError('Há versão aguardando aprovação: decida-a antes.');
    if (op === 'OBSOLETO' && d.status !== 'VIGENTE') throw new AppError('Somente documento vigente pode ser declarado obsoleto.');
    if (op === 'ARQUIVADO' && d.status === 'ARQUIVADO') throw new AppError('Documento já arquivado.');
    const today = todayLocal();
    const retention = await retentionUntil(c, d.category_id, today);
    if (op === 'OBSOLETO') {
      await query(c, "UPDATE documents SET status='OBSOLETO', obsolete_at=now(), next_review_on=NULL, retention_until=$2, updated_at=now() WHERE id=$1", [id, retention]);
    } else {
      await query(c, "UPDATE documents SET status='ARQUIVADO', archived_at=now(), next_review_on=NULL, retention_until=$2, updated_at=now() WHERE id=$1", [id, retention]);
    }
    await event(c, ctx, id, op, { motivo: reason.trim(), retencaoAte: retention });
    await audit(c, ctx, { action: op === 'OBSOLETO' ? 'DOC_OBSOLETO' : 'DOC_ARQUIVADO', entityType: 'document', entityId: id,
      summary: `"${d.title}" ${op === 'OBSOLETO' ? 'declarado obsoleto' : 'arquivado'}: ${reason.trim()}` });
  });
}

/**
 * Descarta o CONTEÚDO dos arquivos após o prazo de retenção. Preserva metadados, hashes, versões e assinaturas.
 * Exige permissão própria, reautenticação e prazo de retenção definido e vencido.
 */
export async function purgeFiles(ctx: Ctx, id: string, reason: string): Promise<number> {
  requirePermission(ctx, 'documentos.descartar');
  if (reason.trim().length < 5) throw new AppError('Informe o fundamento do descarte.');
  await requireStepUp(getPool(), ctx);
  return tx(async (c) => {
    const { d } = await loadWith(c, ctx, id, 'manage', true);
    if (d.status !== 'ARQUIVADO' && d.status !== 'OBSOLETO') throw new AppError('Somente documentos obsoletos ou arquivados podem ter conteúdo descartado.');
    if (!d.retention_until) throw new AppError('Prazo de retenção não definido para este documento: descarte bloqueado.');
    if (d.retention_until > todayLocal()) throw new AppError(`Prazo de retenção vigente até ${d.retention_until}.`);
    const files = await query<{ id: string }>(
      c,
      `SELECT DISTINCT f.id FROM document_files f
        WHERE f.purged_at IS NULL AND (f.id IN (SELECT r.file_id FROM document_version_reviews r JOIN document_versions v ON v.id = r.version_id WHERE v.document_id = $1)
                                       OR f.id::text = $2)`,
      [id, d.draft?.arquivoId ?? '']);
    for (const f of files) {
      await query(c, 'UPDATE document_files SET data=NULL, purged_at=now(), purged_by=$2, purge_reason=$3 WHERE id=$1', [f.id, ctx.principal.userId, reason.trim()]);
    }
    await event(c, ctx, id, 'DESCARTE', { arquivos: files.length, fundamento: reason.trim() });
    await audit(c, ctx, { action: 'DOC_DESCARTE', entityType: 'document', entityId: id, summary: `Descarte do conteúdo de ${files.length} arquivo(s) de "${d.title}"` });
    return files.length;
  });
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

export type ListFilter = { q?: string; categoryId?: string; status?: DocStatus | 'TODOS' };

function likeEscape(s: string) {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export async function listDocuments(ctx: Ctx, f: ListFilter = {}) {
  requirePermission(ctx, 'documentos.ver');
  const params: unknown[] = [];
  const where = [`d.reference_type = '${REPO}'`];
  const q = f.q?.trim().slice(0, 100);
  if (q) {
    params.push(`%${likeEscape(q)}%`, q);
    where.push(`(d.title ILIKE $${params.length - 1} OR d.code ILIKE $${params.length - 1} OR d.summary ILIKE $${params.length - 1}
      OR to_tsvector('portuguese', coalesce(d.title,'') || ' ' || coalesce(d.summary,'') || ' ' || coalesce(cv.content->>'texto',''))
         @@ plainto_tsquery('portuguese', $${params.length}))`);
  }
  if (f.categoryId && z.uuid().safeParse(f.categoryId).success) {
    params.push(f.categoryId);
    where.push(`d.category_id = $${params.length}`);
  }
  if (f.status && f.status !== 'TODOS') {
    params.push(f.status);
    where.push(`d.status = $${params.length}`);
  } else if (!f.status) {
    where.push(`d.status <> 'ARQUIVADO'`);
  }
  params.push(ctx.principal.userId);
  const rows = await query<RepoDocRow & { my_ack: boolean }>(
    getPool(),
    `${DOC_SELECT.replace('FROM documents d', `, EXISTS (SELECT 1 FROM signatures g WHERE g.document_version_id = d.current_version_id AND g.act = 'CIENCIA'
        AND g.signer_user_id = $${params.length}) AS my_ack FROM documents d`)}
      WHERE ${where.join(' AND ')} ORDER BY c.sort_order, d.title`,
    params);
  return rows
    .map((d) => ({ ...d, access: accessFor(ctx.principal, d) }))
    .filter((d) => d.access.read)
    .map(({ draft: _draft, aud_users: _u, aud_sectors: _s, ...rest }) => rest);
}

/** Documentos vigentes que exigem ciência do usuário e ainda não a receberam. */
export async function listPendingAcknowledgements(ctx: Ctx) {
  if (!can(ctx.principal, 'documentos.ver')) return [];
  const rows = await query<RepoDocRow>(
    getPool(),
    `${DOC_SELECT} WHERE d.reference_type = '${REPO}' AND d.status = 'VIGENTE' AND d.requires_acknowledgement
       AND NOT EXISTS (SELECT 1 FROM signatures g WHERE g.document_version_id = d.current_version_id AND g.act = 'CIENCIA' AND g.signer_user_id = $1)
     ORDER BY d.effective_from`,
    [ctx.principal.userId]);
  return rows.filter((d) => accessFor(ctx.principal, d).audience).map((d) => ({ id: d.id, title: d.title, code: d.code, version: d.current_version_number, effective_from: d.effective_from }));
}

/** Documentos com revisão periódica vencida ou próxima, visíveis a quem edita, aprova ou gere. */
export async function listReviewsDue(ctx: Ctx) {
  const db = getPool();
  const days = await getNumberSetting(db, 'documentos.revisao_aviso_dias', 30);
  const rows = await query<RepoDocRow>(
    db, `${DOC_SELECT} WHERE d.reference_type = '${REPO}' AND d.status = 'VIGENTE' AND d.next_review_on <= $1 ORDER BY d.next_review_on`,
    [addDays(todayLocal(), days)]);
  return rows.filter((d) => accessFor(ctx.principal, d).history)
    .map((d) => ({ id: d.id, title: d.title, code: d.code, next_review_on: d.next_review_on!, responsible_name: d.responsible_name, overdue: d.next_review_on! < todayLocal() }));
}

/** Pendências de aprovação para o usuário (exclui o que ele mesmo elaborou ou submeteu). */
export async function listPendingDocApprovals(ctx: Ctx) {
  if (!can(ctx.principal, 'documentos.aprovar')) return [];
  const rows = await query<RepoDocRow & { submitted_by: string; author_id: string | null; version_number: number; submitted_at: Date }>(
    getPool(),
    `${DOC_SELECT.replace('FROM documents d', ', r.submitted_by, pv.content->\'elaboradoPor\'->>\'id\' AS author_id, pv.version_number, r.submitted_at FROM documents d')}
       JOIN document_versions pv ON pv.id = d.pending_version_id JOIN document_version_reviews r ON r.version_id = pv.id
      WHERE d.reference_type = '${REPO}' ORDER BY r.submitted_at`);
  return rows
    .filter((d) => accessFor(ctx.principal, d).approve && d.submitted_by !== ctx.principal.userId && d.author_id !== ctx.principal.userId)
    .map((d) => ({ id: d.id, title: d.title, code: d.code, version: d.version_number, submitted_at: d.submitted_at }));
}

export type VersionRow = {
  id: string; version_number: number; content: VersionContent; content_sha256: string; created_at: Date; submitted_by_name: string;
  decision: string | null; decided_by_name: string | null; decided_at: Date | null; decision_notes: string | null; superseded_at: Date | null;
  acks: number; file_purged: boolean;
};

export async function getDocument(ctx: Ctx, id: string) {
  const db = getPool();
  const { d, a } = await loadWith(db, ctx, id, 'read');
  const versions = await query<VersionRow>(
    db,
    `SELECT v.id, v.version_number, v.content, v.content_sha256, v.created_at, su.display_name AS submitted_by_name, r.decision,
            du.display_name AS decided_by_name, r.decided_at, r.decision_notes, r.superseded_at,
            (SELECT count(*)::int FROM signatures g WHERE g.document_version_id = v.id AND g.act = 'CIENCIA') AS acks,
            coalesce((SELECT f.purged_at IS NOT NULL FROM document_files f WHERE f.id = r.file_id), false) AS file_purged
       FROM document_versions v JOIN document_version_reviews r ON r.version_id = v.id
       JOIN users su ON su.id = r.submitted_by LEFT JOIN users du ON du.id = r.decided_by
      WHERE v.document_id = $1 ORDER BY v.version_number DESC`,
    [id]);
  const visibleVersions = a.history ? versions : versions.filter((v) => v.id === d.current_version_id);
  const events = a.history
    ? await query<{ id: string; event: string; details: Record<string, unknown>; created_at: Date; user_name: string | null }>(
        db, `SELECT e.id, e.event, e.details, e.created_at, u.display_name AS user_name FROM document_events e LEFT JOIN users u ON u.id = e.user_id
              WHERE e.document_id = $1 ORDER BY e.created_at DESC LIMIT 200`, [id])
    : [];
  const draftFile = a.history && d.draft?.arquivoId
    ? await queryOne<{ id: string; filename: string; size_bytes: number; sha256: string }>(db, 'SELECT id, filename, size_bytes, sha256 FROM document_files WHERE id = $1', [d.draft.arquivoId])
    : null;
  const myAck = d.current_version_id
    ? await queryOne<{ signed_at: Date }>(db, "SELECT signed_at FROM signatures WHERE document_version_id = $1 AND signer_user_id = $2 AND act = 'CIENCIA'", [d.current_version_id, ctx.principal.userId])
    : null;
  const pending = versions.find((v) => v.id === d.pending_version_id);
  const canDecide = !!pending && a.approve && pending.content.elaboradoPor?.id !== ctx.principal.userId
    && !(await queryOne(db, 'SELECT 1 FROM document_version_reviews WHERE version_id = $1 AND submitted_by = $2', [pending.id, ctx.principal.userId]));
  return {
    doc: { ...d, draft: a.history ? d.draft : null, aud_users: a.history ? d.aud_users : [], aud_sectors: d.aud_sectors },
    access: a, versions: visibleVersions, events, draftFile, myAck: myAck?.signed_at ?? null, canDecide,
  };
}

/** Localiza um arquivo para download, conferindo o acesso: versão vigente para o público; demais somente com acesso ao histórico. */
export async function fileForDownload(ctx: Ctx, documentId: string, which: string) {
  const db = getPool();
  const { d, a } = await loadWith(db, ctx, documentId, 'read');
  let fileId: string | null = null;
  if (which === 'rascunho') {
    if (!a.history) throw new NotFoundError('Arquivo não encontrado.');
    fileId = d.draft?.arquivoId ?? null;
  } else {
    z.uuid().parse(which);
    if (which !== d.current_version_id && !a.history) throw new NotFoundError('Arquivo não encontrado.');
    const r = await queryOne<{ file_id: string | null }>(
      db, 'SELECT r.file_id FROM document_version_reviews r JOIN document_versions v ON v.id = r.version_id WHERE v.id = $1 AND v.document_id = $2', [which, documentId]);
    fileId = r?.file_id ?? null;
  }
  if (!fileId) throw new NotFoundError('Arquivo não encontrado.');
  const f = await queryOne<{ id: string; filename: string; mime_type: string; size_bytes: number; sha256: string; data: Buffer | null }>(
    db, 'SELECT id, filename, mime_type, size_bytes, sha256, data FROM document_files WHERE id = $1', [fileId]);
  if (!f) throw new NotFoundError('Arquivo não encontrado.');
  if (!f.data) throw new AppError('O conteúdo deste arquivo foi descartado após o prazo de retenção (metadados e hash preservados).', 410, 'DESCARTADO');
  if (sha256Hex(f.data) !== f.sha256) throw new AppError('Falha de integridade do arquivo. Download bloqueado.', 500, 'INTEGRIDADE');
  await audit(db, ctx, { action: 'DOC_DOWNLOAD', entityType: 'document', entityId: documentId, summary: `Download de "${f.filename}" (${d.title})` });
  return f;
}

/** Pacote de exportação de uma versão: metadados, conteúdo, hashes e assinaturas com verificação recalculada. */
export async function exportVersion(ctx: Ctx, documentId: string, versionId: string) {
  const db = getPool();
  const { d, a } = await loadWith(db, ctx, documentId, 'read');
  z.uuid().parse(versionId);
  if (versionId !== d.current_version_id && !a.history) throw new NotFoundError('Versão não encontrada.');
  const v = await queryOne<{ id: string; version_number: number; content: VersionContent; content_sha256: string; created_at: Date }>(
    db, 'SELECT id, version_number, content, content_sha256, created_at FROM document_versions WHERE id = $1 AND document_id = $2', [versionId, documentId]);
  if (!v) throw new NotFoundError('Versão não encontrada.');
  const sigs = await query<{ act: string; signer: string; signed_at: Date; statement: string; comment: string | null; content_sha256: string; evidence_sha256: string; auth_method: string }>(
    db, `SELECT g.act, u.display_name AS signer, g.signed_at, g.statement, g.comment, g.content_sha256, g.evidence_sha256, g.auth_method
           FROM signatures g JOIN users u ON u.id = g.signer_user_id WHERE g.document_version_id = $1 ORDER BY g.signed_at`, [versionId]);
  const file = v.content.arquivo
    ? await queryOne<{ ok: boolean | null; purged: boolean }>(db, "SELECT CASE WHEN data IS NULL THEN NULL ELSE sha256 = encode(sha256(data),'hex') END AS ok, purged_at IS NOT NULL AS purged FROM document_files WHERE id = $1", [v.content.arquivo.id])
    : null;
  await audit(db, ctx, { action: 'DOC_EXPORTADO', entityType: 'document_version', entityId: versionId, summary: `Exportação de "${d.title}" v${v.version_number}` });
  return {
    geradoEm: new Date().toISOString(),
    natureza: 'Documento administrativo interno. Assinaturas eletrônicas simples (Lei nº 14.063/2020, art. 4º, I) para atos internos.',
    documento: { id: d.id, titulo: d.title, codigo: d.code, categoria: d.category_name, setor: d.sector_name, situacao: d.status, vigenciaDesde: d.effective_from, proximaRevisao: d.next_review_on },
    versao: { id: v.id, numero: v.version_number, criadaEm: v.created_at, vigente: v.id === d.current_version_id, sha256: v.content_sha256, conteudo: v.content },
    verificacao: {
      conteudoIntegro: sha256Hex(canonicalJson(v.content)) === v.content_sha256,
      arquivo: file ? (file.purged ? 'descartado após retenção (hash preservado)' : file.ok ? 'íntegro' : 'DIVERGENTE') : 'sem arquivo',
    },
    assinaturas: sigs.map((s) => ({ ...s, vinculadaAEstaVersao: s.content_sha256 === v.content_sha256 })),
  };
}

/** Rotina: avisa responsáveis sobre revisões próximas/vencidas (uma vez por data de revisão). */
export async function processReviewReminders(db: Db = getPool()): Promise<number> {
  const days = await getNumberSetting(db, 'documentos.revisao_aviso_dias', 30);
  const due = await query<{ id: string; title: string; responsible_user_id: string; next_review_on: string }>(
    db,
    `SELECT d.id, d.title, d.responsible_user_id, d.next_review_on FROM documents d
      WHERE d.reference_type = '${REPO}' AND d.status = 'VIGENTE' AND d.next_review_on <= $1
        AND NOT EXISTS (SELECT 1 FROM document_events e WHERE e.document_id = d.id AND e.event = 'AVISO_REVISAO' AND e.details->>'revisao' = d.next_review_on::text)`,
    [addDays(todayLocal(), days)]);
  for (const d of due) {
    await tx(async (c) => {
      await query(c, "INSERT INTO document_events (document_id, user_id, event, details) VALUES ($1, NULL, 'AVISO_REVISAO', $2)", [d.id, JSON.stringify({ revisao: d.next_review_on })]);
      await notifyUsers(c, [d.responsible_user_id], {
        kind: 'DOCUMENTO_REVISAO', title: d.next_review_on < todayLocal() ? 'Revisão de documento vencida' : 'Revisão de documento próxima',
        body: `${d.title} — revisão prevista para ${d.next_review_on}`, link: `/documentos/${d.id}`, priority: d.next_review_on < todayLocal() ? 'ALTA' : 'NORMAL',
      });
    });
  }
  return due.length;
}

/** Pessoas e setores para escolha de público e responsável (somente para quem elabora ou gere documentos). */
export async function listDirectory(ctx: Ctx) {
  if (!can(ctx.principal, 'documentos.editar') && !can(ctx.principal, 'documentos.gerenciar')) throw new ForbiddenError();
  const db = getPool();
  const users = await query<{ id: string; display_name: string; sector_name: string | null }>(
    db,
    `SELECT u.id, u.display_name, s.name AS sector_name FROM users u
       LEFT JOIN employees e ON e.user_id = u.id AND e.status <> 'DESLIGADO' LEFT JOIN sectors s ON s.id = e.sector_id
      WHERE u.status = 'ATIVO' ORDER BY u.display_name`);
  const sectors = await query<{ id: string; name: string }>(db, 'SELECT id, name FROM sectors WHERE active ORDER BY name');
  return { users, sectors };
}
