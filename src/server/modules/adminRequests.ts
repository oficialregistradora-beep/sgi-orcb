import { z } from 'zod';
import { type Db, getPool, query, queryOne, tx } from '../db.ts';
import type { Ctx } from '../context.ts';
import { can } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ForbiddenError, NotFoundError } from '../errors.ts';
import { notifyUsers } from './notifications.ts';

// Solicitações à administração: pedido livre de qualquer pessoa, atendido pela Oficial e por quem tiver a permissão.
// "Somente para a Oficial": o pedido não aparece para mais ninguém além de quem pediu.

export const ADMIN_REQUEST_CATEGORIES = {
  DOCUMENTO: 'Documento ou declaração',
  MATERIAL: 'Material ou equipamento',
  CADASTRO: 'Ajuste de dados cadastrais',
  PESSOAL: 'Assunto pessoal',
  SUGESTAO: 'Sugestão ou reclamação',
  OUTRO: 'Outro',
} as const;
export type AdminRequestCategory = keyof typeof ADMIN_REQUEST_CATEGORIES;
const HANDLE = 'solicitacoes.administracao.atender';

export type AdminRequestRow = {
  id: string; requester_id: string; requester_name: string; category: AdminRequestCategory; subject: string; body: string; only_owner: boolean;
  status: string; response: string | null; closed_by_name: string | null; closed_at: Date | null; created_at: Date; updated_at: Date; messages: number;
};

export function canHandleAdminRequests(ctx: Ctx): boolean {
  return ctx.principal.isOwner || can(ctx.principal, HANDLE);
}

/** Quem atende: Oficial e titulares da permissão; pedido "somente para a Oficial", só ela. */
async function handlers(db: Db, onlyOwner: boolean): Promise<string[]> {
  return (await query<{ id: string }>(
    db,
    `SELECT DISTINCT u.id FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL AND ur.valid_from <= current_date
                              AND (ur.valid_until IS NULL OR ur.valid_until >= current_date)
       LEFT JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.permission_code = $1
      WHERE u.status = 'ATIVO' AND (u.is_owner OR (NOT $2 AND rp.permission_code IS NOT NULL))`,
    [HANDLE, onlyOwner],
  )).map((r) => r.id);
}

const SELECT = `SELECT r.id, r.requester_id, u.display_name AS requester_name, r.category, r.subject, r.body, r.only_owner, r.status, r.response,
                       c.display_name AS closed_by_name, r.closed_at, r.created_at, r.updated_at,
                       (SELECT count(*)::int FROM admin_request_messages m WHERE m.request_id = r.id) AS messages
                  FROM admin_requests r JOIN users u ON u.id = r.requester_id LEFT JOIN users c ON c.id = r.closed_by`;

/** Visível para quem pediu e para quem atende (respeitando "somente para a Oficial"). */
async function load(db: Db, ctx: Ctx, id: string): Promise<AdminRequestRow> {
  z.uuid().parse(id);
  const r = await queryOne<AdminRequestRow>(db, `${SELECT} WHERE r.id = $1`, [id]);
  if (!r) throw new NotFoundError('Solicitação não encontrada.');
  const mine = r.requester_id === ctx.principal.userId;
  const handler = ctx.principal.isOwner || (!r.only_owner && can(ctx.principal, HANDLE));
  if (!mine && !handler) throw new NotFoundError('Solicitação não encontrada.');
  return r;
}

const createSchema = z.object({
  category: z.enum(Object.keys(ADMIN_REQUEST_CATEGORIES) as [AdminRequestCategory, ...AdminRequestCategory[]]),
  subject: z.string().trim().min(3, 'Informe o assunto.').max(200),
  body: z.string().trim().min(5, 'Descreva o pedido (mínimo de 5 caracteres).').max(5000),
  onlyOwner: z.boolean().default(false),
});

export async function createAdminRequest(ctx: Ctx, input: z.input<typeof createSchema>): Promise<string> {
  const d = createSchema.parse(input);
  return tx(async (c) => {
    const r = (await queryOne<{ id: string }>(c,
      'INSERT INTO admin_requests (requester_id, category, subject, body, only_owner) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [ctx.principal.userId, d.category, d.subject, d.body, d.onlyOwner]))!;
    await audit(c, ctx, {
      action: 'ADM_SOLICITACAO_ABERTA', entityType: 'admin_request', entityId: r.id,
      summary: `Solicitação à administração: ${ADMIN_REQUEST_CATEGORIES[d.category]}${d.onlyOwner ? ' (somente para a Oficial)' : ''}`,
    });
    await notifyUsers(c, (await handlers(c, d.onlyOwner)).filter((u) => u !== ctx.principal.userId), {
      kind: 'ADM_SOLICITACAO', title: 'Nova solicitação à administração', body: `${ctx.principal.displayName}: ${d.subject}`, link: `/solicitacoes/administracao/${r.id}`,
    });
    return r.id;
  });
}

export async function listMyAdminRequests(ctx: Ctx): Promise<AdminRequestRow[]> {
  return query<AdminRequestRow>(getPool(), `${SELECT} WHERE r.requester_id = $1 ORDER BY r.created_at DESC LIMIT 200`, [ctx.principal.userId]);
}

/** Caixa da administração: abertas primeiro. */
export async function listAdminInbox(ctx: Ctx, which: 'ABERTAS' | 'ENCERRADAS'): Promise<AdminRequestRow[]> {
  if (!canHandleAdminRequests(ctx)) throw new ForbiddenError();
  return query<AdminRequestRow>(getPool(),
    `${SELECT} WHERE ($1 OR NOT r.only_owner) AND r.status ${which === 'ABERTAS' ? "IN ('ABERTA','EM_ANDAMENTO')" : "IN ('ATENDIDA','RECUSADA','CANCELADA')"}
      ORDER BY ${which === 'ABERTAS' ? 'r.created_at' : 'r.updated_at DESC'} LIMIT 300`,
    [ctx.principal.isOwner]);
}

export async function getAdminRequest(ctx: Ctx, id: string) {
  const db = getPool();
  const r = await load(db, ctx, id);
  const messages = await query<{ id: string; author_name: string; author_id: string; body: string; created_at: Date }>(db,
    `SELECT m.id, u.display_name AS author_name, m.author_id, m.body, m.created_at FROM admin_request_messages m JOIN users u ON u.id = m.author_id
      WHERE m.request_id = $1 ORDER BY m.created_at`, [id]);
  const mine = r.requester_id === ctx.principal.userId;
  const handler = ctx.principal.isOwner || (!r.only_owner && can(ctx.principal, HANDLE));
  const open = r.status === 'ABERTA' || r.status === 'EM_ANDAMENTO';
  return { ...r, messages, can: { reply: open, handle: open && handler && !mine, cancel: open && mine } };
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
    await query(c,
      `UPDATE admin_requests SET status = $2, response = CASE WHEN $3 THEN $4 ELSE response END,
              closed_by = CASE WHEN $3 THEN $5::uuid ELSE closed_by END, closed_at = CASE WHEN $3 THEN now() ELSE closed_at END, updated_at = now()
        WHERE id = $1`, [id, d.status, closing, d.response ?? null, ctx.principal.userId]);
    if (!closing && d.response) await query(c, 'INSERT INTO admin_request_messages (request_id, author_id, body) VALUES ($1,$2,$3)', [id, ctx.principal.userId, d.response]);
    const label = { EM_ANDAMENTO: 'em andamento', ATENDIDA: 'atendida', RECUSADA: 'recusada' }[d.status];
    await audit(c, ctx, { action: 'ADM_SOLICITACAO_SITUACAO', entityType: 'admin_request', entityId: id, summary: `Solicitação à administração ${label}` });
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
