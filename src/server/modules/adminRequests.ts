import { z } from 'zod';
import { type Db, getPool, query, queryOne, tx } from '../db.ts';
import type { Ctx } from '../context.ts';
import { can } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ForbiddenError, NotFoundError } from '../errors.ts';
import { notifyUsers } from './notifications.ts';
import { checkFile } from '../files.ts';
import { discardUnsaved, insertStoredFile, loadStoredFile, prepareFile, readStoredFile, rescan, type PreparedFile } from './fileStore.ts';
import { maxFileBytes } from './repository.ts';
import { findEmployeeByUser, insertAbsence } from './people.ts';

// Solicitações à administração: pedido livre de qualquer pessoa, atendido pela Oficial e por quem tiver a permissão.
// "Somente para a Oficial": o pedido não aparece para mais ninguém além de quem pediu.

export const ADMIN_REQUEST_CATEGORIES = {
  DOCUMENTO: 'Documento ou declaração',
  MATERIAL: 'Material ou equipamento',
  CADASTRO: 'Ajuste de dados cadastrais',
  PESSOAL: 'Assunto pessoal',
  SUGESTAO: 'Sugestão ou reclamação',
  ATESTADO: 'Atestado / ausência (pedido de abono)',
  OUTRO: 'Outro',
} as const;
export type AdminRequestCategory = keyof typeof ADMIN_REQUEST_CATEGORIES;
const HANDLE = 'solicitacoes.administracao.atender';
const ABSENCE = 'jornada.ausencias.gerenciar';
export const MAX_ADMIN_FILES = 5;

export type AdminRequestRow = {
  id: string; requester_id: string; requester_name: string; category: AdminRequestCategory; subject: string; body: string; only_owner: boolean;
  status: string; response: string | null; closed_by_name: string | null; closed_at: Date | null; created_at: Date; updated_at: Date; messages: number;
  absence_start: string | null; absence_end: string | null; absence_id: string | null; files: number;
};

/** Atestado é dado de saúde: quem atende só o vê se também puder lançar ausências (a Oficial sempre). */
function isHandlerFor(ctx: Ctx, r: Pick<AdminRequestRow, 'only_owner' | 'category'>): boolean {
  if (ctx.principal.isOwner) return true;
  if (r.only_owner || !can(ctx.principal, HANDLE)) return false;
  return r.category !== 'ATESTADO' || can(ctx.principal, ABSENCE);
}

export function canHandleAdminRequests(ctx: Ctx): boolean {
  return ctx.principal.isOwner || can(ctx.principal, HANDLE);
}

/** Quem atende: Oficial e titulares da permissão; pedido "somente para a Oficial", só ela; atestado, só quem também lança ausências. */
async function handlers(db: Db, onlyOwner: boolean, atestado = false): Promise<string[]> {
  return (await query<{ id: string }>(
    db,
    `SELECT u.id FROM users u WHERE u.status = 'ATIVO' AND (u.is_owner OR (NOT $2 AND
       EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.permission_code = $1
                WHERE ur.user_id = u.id AND ur.revoked_at IS NULL AND ur.valid_from <= current_date AND (ur.valid_until IS NULL OR ur.valid_until >= current_date))
       AND (NOT $3 OR EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.permission_code = $4
                WHERE ur.user_id = u.id AND ur.revoked_at IS NULL AND ur.valid_from <= current_date AND (ur.valid_until IS NULL OR ur.valid_until >= current_date)))))`,
    [HANDLE, onlyOwner, atestado, ABSENCE],
  )).map((r) => r.id);
}

const SELECT = `SELECT r.id, r.requester_id, u.display_name AS requester_name, r.category, r.subject, r.body, r.only_owner, r.status, r.response,
                       c.display_name AS closed_by_name, r.closed_at, r.created_at, r.updated_at,
                       (SELECT count(*)::int FROM admin_request_messages m WHERE m.request_id = r.id) AS messages,
                       r.absence_start, r.absence_end, r.absence_id,
                       (SELECT count(*)::int FROM admin_request_files f WHERE f.request_id = r.id) AS files
                  FROM admin_requests r JOIN users u ON u.id = r.requester_id LEFT JOIN users c ON c.id = r.closed_by`;

/** Visível para quem pediu e para quem atende (respeitando "somente para a Oficial"). */
async function load(db: Db, ctx: Ctx, id: string): Promise<AdminRequestRow> {
  z.uuid().parse(id);
  const r = await queryOne<AdminRequestRow>(db, `${SELECT} WHERE r.id = $1`, [id]);
  if (!r) throw new NotFoundError('Solicitação não encontrada.');
  const mine = r.requester_id === ctx.principal.userId;
  if (!mine && !isHandlerFor(ctx, r)) throw new NotFoundError('Solicitação não encontrada.');
  return r;
}

const createSchema = z.object({
  category: z.enum(Object.keys(ADMIN_REQUEST_CATEGORIES) as [AdminRequestCategory, ...AdminRequestCategory[]]),
  subject: z.string().trim().min(3, 'Informe o assunto.').max(200),
  body: z.string().trim().min(5, 'Descreva o pedido (mínimo de 5 caracteres).').max(5000),
  onlyOwner: z.boolean().default(false),
  absenceStart: z.iso.date().nullable().optional(),
  absenceEnd: z.iso.date().nullable().optional(),
});

export type UploadedFile = { name: string; bytes: Uint8Array };

/** Abre o pedido; os arquivos (até 5) passam pelo antivírus e ficam guardados com hash, como os documentos. */
export async function createAdminRequest(ctx: Ctx, input: z.input<typeof createSchema>, files: UploadedFile[] = []): Promise<string> {
  const d = createSchema.parse(input);
  const list = files.filter((f) => f.bytes.byteLength > 0);
  if (list.length > MAX_ADMIN_FILES) throw new AppError(`Anexe no máximo ${MAX_ADMIN_FILES} arquivos.`);
  if (d.category === 'ATESTADO') {
    if (!d.absenceStart || !d.absenceEnd) throw new AppError('Informe o período da ausência (primeiro e último dia).');
    if (d.absenceEnd < d.absenceStart) throw new AppError('O último dia é anterior ao primeiro.');
    if (!list.length) throw new AppError('Anexe o atestado (foto ou PDF).');
  }
  const max = await maxFileBytes();
  const checked = list.map((f) => ({ f, c: checkFile(f.name, f.bytes, max) }));
  const prepared: PreparedFile[] = [];
  try {
    for (const { f, c } of checked) prepared.push(await prepareFile(ctx, c, f.bytes));
  } catch (e) {
    for (const p of prepared) await discardUnsaved(p);
    throw e;
  }
  const atestado = d.category === 'ATESTADO';
  return tx(async (c) => {
    const r = (await queryOne<{ id: string }>(c,
      'INSERT INTO admin_requests (requester_id, category, subject, body, only_owner, absence_start, absence_end) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [ctx.principal.userId, d.category, d.subject, d.body, d.onlyOwner, atestado ? d.absenceStart : null, atestado ? d.absenceEnd : null]))!;
    for (const p of prepared) {
      const fileId = await insertStoredFile(c, ctx, p);
      await query(c, 'INSERT INTO admin_request_files (request_id, file_id, added_by) VALUES ($1,$2,$3)', [r.id, fileId, ctx.principal.userId]);
    }
    await audit(c, ctx, {
      action: 'ADM_SOLICITACAO_ABERTA', entityType: 'admin_request', entityId: r.id,
      summary: `Solicitação à administração: ${ADMIN_REQUEST_CATEGORIES[d.category]}${d.onlyOwner ? ' (somente para a Oficial)' : ''}${prepared.length ? ` — ${prepared.length} anexo(s), sha256 ${prepared.map((p) => p.sha256.slice(0, 12)).join(', ')}` : ''}`,
    });
    await notifyUsers(c, (await handlers(c, d.onlyOwner, atestado)).filter((u) => u !== ctx.principal.userId), {
      kind: 'ADM_SOLICITACAO', title: 'Nova solicitação à administração', body: `${ctx.principal.displayName}: ${d.subject}`, link: `/solicitacoes/administracao/${r.id}`,
    });
    return r.id;
  }).catch(async (e) => {
    for (const p of prepared) await discardUnsaved(p);
    throw e;
  });
}

export async function listMyAdminRequests(ctx: Ctx): Promise<AdminRequestRow[]> {
  return query<AdminRequestRow>(getPool(), `${SELECT} WHERE r.requester_id = $1 ORDER BY r.created_at DESC LIMIT 200`, [ctx.principal.userId]);
}

/** Caixa da administração: abertas primeiro. */
export async function listAdminInbox(ctx: Ctx, which: 'ABERTAS' | 'ENCERRADAS'): Promise<AdminRequestRow[]> {
  if (!canHandleAdminRequests(ctx)) throw new ForbiddenError();
  return query<AdminRequestRow>(getPool(),
    `${SELECT} WHERE ($1 OR (NOT r.only_owner AND (r.category <> 'ATESTADO' OR $2))) AND r.status ${which === 'ABERTAS' ? "IN ('ABERTA','EM_ANDAMENTO')" : "IN ('ATENDIDA','RECUSADA','CANCELADA')"}
      ORDER BY ${which === 'ABERTAS' ? 'r.created_at' : 'r.updated_at DESC'} LIMIT 300`,
    [ctx.principal.isOwner, can(ctx.principal, ABSENCE)]);
}

export async function getAdminRequest(ctx: Ctx, id: string) {
  const db = getPool();
  const r = await load(db, ctx, id);
  const messages = await query<{ id: string; author_name: string; author_id: string; body: string; created_at: Date }>(db,
    `SELECT m.id, u.display_name AS author_name, m.author_id, m.body, m.created_at FROM admin_request_messages m JOIN users u ON u.id = m.author_id
      WHERE m.request_id = $1 ORDER BY m.created_at`, [id]);
  const mine = r.requester_id === ctx.principal.userId;
  const handler = isHandlerFor(ctx, r);
  const open = r.status === 'ABERTA' || r.status === 'EM_ANDAMENTO';
  const files = await query<{ id: string; filename: string; size_bytes: number; sha256: string; scan_status: string; added_at: Date }>(db,
    `SELECT f.id, f.filename, f.size_bytes, f.sha256, f.scan_status, a.added_at FROM admin_request_files a JOIN document_files f ON f.id = a.file_id
      WHERE a.request_id = $1 ORDER BY a.added_at`, [id]);
  return {
    ...r, messages, files,
    can: { reply: open, handle: open && handler && !mine, cancel: open && mine,
      launchAbsence: open && handler && !mine && r.category === 'ATESTADO' && !r.absence_id && (ctx.principal.isOwner || can(ctx.principal, ABSENCE)) },
  };
}

export async function addAdminRequestMessage(ctx: Ctx, id: string, text: string): Promise<void> {
  const body = z.string().trim().min(1, 'Escreva a mensagem.').max(3000).parse(text);
  await tx(async (c) => {
    await query(c, 'SELECT 1 FROM admin_requests WHERE id = $1 FOR UPDATE', [z.uuid().parse(id)]);
    const r = await load(c, ctx, id);
    if (r.status !== 'ABERTA' && r.status !== 'EM_ANDAMENTO') throw new AppError('Solicitação encerrada.');
    await query(c, 'INSERT INTO admin_request_messages (request_id, author_id, body) VALUES ($1,$2,$3)', [id, ctx.principal.userId, body]);
    await query(c, 'UPDATE admin_requests SET updated_at = now() WHERE id = $1', [id]);
    const mine = r.requester_id === ctx.principal.userId;
    const to = mine ? (await handlers(c, r.only_owner)).filter((u) => u !== ctx.principal.userId) : [r.requester_id];
    await notifyUsers(c, to, { kind: 'ADM_SOLICITACAO_MENSAGEM', title: 'Nova mensagem em solicitação à administração', body: r.subject, link: `/solicitacoes/administracao/${id}` });
  });
}

const handleSchema = z.object({
  status: z.enum(['EM_ANDAMENTO', 'ATENDIDA', 'RECUSADA']),
  response: z.string().trim().max(3000).optional(),
  /** Atestado atendido: lança a ausência e abona os dias no ponto. */
  absence: z.object({ type: z.enum(['ATESTADO_MEDICO', 'FALTA_JUSTIFICADA']), startDate: z.iso.date(), endDate: z.iso.date() }).nullable().optional(),
});

/** Quem atende muda a situação; encerrar (atendida ou recusada) exige a resposta escrita. Ninguém atende o próprio pedido. */
export async function handleAdminRequest(ctx: Ctx, id: string, input: z.input<typeof handleSchema>): Promise<void> {
  const d = handleSchema.parse(input);
  if (d.status !== 'EM_ANDAMENTO' && (!d.response || d.response.length < 3)) throw new AppError('Escreva a resposta para quem pediu.');
  await tx(async (c) => {
    await query(c, 'SELECT 1 FROM admin_requests WHERE id = $1 FOR UPDATE', [z.uuid().parse(id)]);
    const r = await load(c, ctx, id);
    if (r.requester_id === ctx.principal.userId) throw new ForbiddenError('Ninguém atende o próprio pedido.');
    if (!(ctx.principal.isOwner || (!r.only_owner && can(ctx.principal, HANDLE)))) throw new ForbiddenError();
    if (r.status !== 'ABERTA' && r.status !== 'EM_ANDAMENTO') throw new AppError('Solicitação já encerrada.');
    const closing = d.status !== 'EM_ANDAMENTO';
    let absenceId: string | null = null;
    if (d.absence) {
      if (d.status !== 'ATENDIDA' || r.category !== 'ATESTADO') throw new AppError('A ausência só é lançada ao atender um pedido de atestado.');
      if (r.absence_id) throw new AppError('A ausência deste pedido já foi lançada.');
      const e = await findEmployeeByUser(c, r.requester_id);
      if (!e) throw new AppError('Quem pediu não tem ficha de funcionária: lance a ausência pela Equipe.');
      if (!ctx.principal.isOwner && !can(ctx.principal, ABSENCE, { employeeId: e.id, sectorId: e.sector_id })) throw new ForbiddenError('Sem permissão para lançar ausências desta funcionária.');
      absenceId = await insertAbsence(c, ctx, e, {
        type: d.absence.type, startDate: d.absence.startDate, endDate: d.absence.endDate, countsAsWorked: true,
        notes: `Solicitação à administração: ${r.subject}`.slice(0, 500),
      });
      await query(c, 'UPDATE admin_requests SET absence_id = $2 WHERE id = $1', [id, absenceId]);
    }
    await query(c,
      `UPDATE admin_requests SET status = $2, response = CASE WHEN $3 THEN $4 ELSE response END,
              closed_by = CASE WHEN $3 THEN $5::uuid ELSE closed_by END, closed_at = CASE WHEN $3 THEN now() ELSE closed_at END, updated_at = now()
        WHERE id = $1`, [id, d.status, closing, d.response ?? null, ctx.principal.userId]);
    if (!closing && d.response) await query(c, 'INSERT INTO admin_request_messages (request_id, author_id, body) VALUES ($1,$2,$3)', [id, ctx.principal.userId, d.response]);
    const label = { EM_ANDAMENTO: 'em andamento', ATENDIDA: 'atendida', RECUSADA: 'recusada' }[d.status];
    await audit(c, ctx, { action: 'ADM_SOLICITACAO_SITUACAO', entityType: 'admin_request', entityId: id,
      summary: `Solicitação à administração ${label}${absenceId ? ` — ausência lançada e abonada de ${d.absence!.startDate} a ${d.absence!.endDate}` : ''}` });
    await notifyUsers(c, [r.requester_id], {
      kind: 'ADM_SOLICITACAO_RESPOSTA', title: `Sua solicitação à administração foi ${label}`, body: r.subject, link: `/solicitacoes/administracao/${id}`,
      priority: closing ? 'ALTA' : 'NORMAL',
    });
  });
}

export async function cancelAdminRequest(ctx: Ctx, id: string): Promise<void> {
  await tx(async (c) => {
    await query(c, 'SELECT 1 FROM admin_requests WHERE id = $1 FOR UPDATE', [z.uuid().parse(id)]);
    const r = await load(c, ctx, id);
    if (r.requester_id !== ctx.principal.userId) throw new ForbiddenError('Somente quem pediu cancela.');
    if (r.status !== 'ABERTA' && r.status !== 'EM_ANDAMENTO') throw new AppError('Solicitação já encerrada.');
    await query(c, "UPDATE admin_requests SET status = 'CANCELADA', updated_at = now() WHERE id = $1", [id]);
    await audit(c, ctx, { action: 'ADM_SOLICITACAO_CANCELADA', entityType: 'admin_request', entityId: id, summary: 'Solicitação à administração cancelada por quem pediu' });
  });
}

/** Download do anexo: só quem pode ver o pedido; hash e antivírus conferidos; acesso auditado. */
export async function adminRequestFileForDownload(ctx: Ctx, requestId: string, fileId: string) {
  const db = getPool();
  const r = await load(db, ctx, requestId);
  const ok = await queryOne(db, 'SELECT 1 FROM admin_request_files WHERE request_id = $1 AND file_id = $2', [requestId, z.uuid().parse(fileId)]);
  if (!ok) throw new NotFoundError('Arquivo não encontrado.');
  const f = await loadStoredFile(db, fileId);
  if (!f) throw new NotFoundError('Arquivo não encontrado.');
  const bytes = await readStoredFile(f);
  if (!bytes) throw new AppError('O conteúdo deste arquivo foi descartado após o prazo de retenção.', 410, 'DESCARTADO');
  await rescan(ctx, f, bytes, 'download', false);
  await audit(db, ctx, { action: 'ADM_SOLICITACAO_ANEXO_DOWNLOAD', entityType: 'admin_request', entityId: requestId, summary: `Download do anexo "${f.filename}" (${r.subject})` });
  return { filename: f.filename, mime_type: f.mime_type, sha256: f.sha256, data: Buffer.from(bytes) };
}
