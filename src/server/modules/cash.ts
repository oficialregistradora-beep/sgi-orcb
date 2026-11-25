import { z } from 'zod';
import { type Db, getPool, query, queryOne, tx } from '../db.ts';
import type { Ctx, Principal } from '../context.ts';
import { can, requireStepUp } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors.ts';
import { centsToDb, formatCents, toCents } from '../../domain/money.ts';
import { addDays, addMonths, todayLocal } from '../../domain/time.ts';
import {
  CASH_KIND_LABEL, checkEntry, dre, summarizeDay, type CashKind, type CashMethod, type DaySummary, type EntryLike,
} from '../../domain/cash.ts';
import { financeScope } from './financeAccess.ts';
import { notifyUsers, usersWithPermission } from './notifications.ts';

// Controle de caixa (atendimento e administrativo): caixa individual ou compartilhado, dia de caixa com abertura e
// fechamento, lançamentos imutáveis (correção por estorno), conferência da Bárbara por um botão no dia seguinte,
// OK final do mês e relatórios (fluxo de caixa e DRE gerencial). A conciliação com extratos fica em cashReconcile.ts.

export const canConfer = (p: Principal) => p.isOwner || can(p, 'caixa.conferir');
export const canManageCash = (p: Principal) => p.isOwner || can(p, 'caixa.gerenciar');

/** Cada aba do caixa é uma permissão, dada ou retirada pela Oficial na Matriz de permissões. */
export const CASH_TABS = {
  hoje: 'caixa.frente', mes: 'caixa.mes', ano: 'caixa.ano', conferencia: 'caixa.conferir', troco: 'caixa.troco',
  relatorios: 'caixa.relatorios', conciliacao: 'caixa.conciliacao', caixas: 'caixa.gerenciar',
} as const;
export type CashTab = keyof typeof CASH_TABS;
export const canCashTab = (p: Principal, tab: CashTab) => p.isOwner || can(p, CASH_TABS[tab]);
/** Sangria e fechamento do dia (Bárbara, por padrão). */
export const canCloseCash = (p: Principal) => p.isOwner || can(p, 'caixa.fechar');
/** Visões que alcançam todos os caixas (não só os que a pessoa opera). */
const seesAllRegisters = (p: Principal) => p.isOwner || ['caixa.conferir', 'caixa.gerenciar', 'caixa.mes', 'caixa.ano', 'caixa.relatorios', 'caixa.conciliacao', 'caixa.fechar'].some((x) => can(p, x));

export type RegisterRow = {
  id: string; code: string; name: string; sector_id: string; sector_name: string; shared: boolean; default_float: string; active: boolean;
  operators: { id: string; name: string }[];
};

async function registersQuery(db: Db, where: string, params: unknown[]): Promise<RegisterRow[]> {
  return query<RegisterRow>(db,
    `SELECT r.id, r.code, r.name, r.sector_id, s.name AS sector_name, r.shared, r.default_float::text, r.active,
            coalesce((SELECT json_agg(json_build_object('id', u.id, 'name', u.display_name) ORDER BY u.display_name)
                        FROM cash_register_operators o JOIN users u ON u.id = o.user_id WHERE o.register_id = r.id), '[]') AS operators
       FROM cash_registers r JOIN sectors s ON s.id = r.sector_id ${where} ORDER BY r.active DESC, r.name`, params);
}

/** Caixas que a pessoa enxerga: todos para quem confere ou gerencia; senão, os que ela opera. */
export async function listRegisters(ctx: Ctx): Promise<RegisterRow[]> {
  const db = getPool();
  if (seesAllRegisters(ctx.principal)) return registersQuery(db, '', []);
  return registersQuery(db, 'WHERE r.active AND EXISTS (SELECT 1 FROM cash_register_operators o WHERE o.register_id = r.id AND o.user_id = $1)', [ctx.principal.userId]);
}

export async function hasCashAccess(db: Db, p: Principal): Promise<boolean> {
  if (seesAllRegisters(p) || (can(p, 'caixa.troco') && !can(p, 'caixa.frente'))) return true;
  if (!can(p, 'caixa.frente')) return false;
  return !!(await queryOne(db, `SELECT 1 FROM cash_register_operators o JOIN cash_registers r ON r.id = o.register_id WHERE o.user_id = $1 AND r.active`, [p.userId]));
}

async function isOperator(db: Db, registerId: string, userId: string): Promise<boolean> {
  return !!(await queryOne(db, 'SELECT 1 FROM cash_register_operators WHERE register_id = $1 AND user_id = $2', [registerId, userId]));
}

async function assertSee(db: Db, ctx: Ctx, registerId: string): Promise<void> {
  if (seesAllRegisters(ctx.principal)) return;
  if (!(await isOperator(db, registerId, ctx.principal.userId))) throw new NotFoundError('Caixa não encontrado.');
}

async function assertOperate(db: Db, ctx: Ctx, registerId: string): Promise<void> {
  if (ctx.principal.isOwner) return;
  if (!can(ctx.principal, 'caixa.frente')) throw new ForbiddenError('Sem acesso à Frente de caixa.');
  if (!(await isOperator(db, registerId, ctx.principal.userId))) throw new ForbiddenError('Você não opera este caixa.');
}

// ---------------------------------------------------------------------------
// Cadastro de caixas (Oficial)
// ---------------------------------------------------------------------------

const registerSchema = z.object({
  id: z.uuid().optional(),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/, 'Código: 2 a 20 letras, números, - ou _.'),
  name: z.string().trim().min(2).max(80),
  sectorId: z.uuid(),
  shared: z.boolean(),
  defaultFloatCents: z.number().int().min(0).max(10_000_000),
  active: z.boolean().default(true),
  operatorIds: z.array(z.uuid()).max(50),
});

export async function saveRegister(ctx: Ctx, input: z.input<typeof registerSchema>): Promise<string> {
  if (!canManageCash(ctx.principal)) throw new ForbiddenError();
  const d = registerSchema.parse(input);
  const ops = [...new Set(d.operatorIds)];
  if (!d.shared && ops.length !== 1) throw new AppError('Caixa individual tem exatamente uma operadora. Para vários usuários, marque "compartilhado".');
  if (d.shared && ops.length < 1) throw new AppError('Indique ao menos um usuário do caixa compartilhado.');
  return tx(async (c) => {
    const r = d.id
      ? await queryOne<{ id: string }>(c, 'UPDATE cash_registers SET code=$2, name=$3, sector_id=$4, shared=$5, default_float=$6, active=$7 WHERE id=$1 RETURNING id',
        [d.id, d.code, d.name, d.sectorId, d.shared, centsToDb(d.defaultFloatCents), d.active])
      : await queryOne<{ id: string }>(c, 'INSERT INTO cash_registers (code, name, sector_id, shared, default_float, active, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [d.code, d.name, d.sectorId, d.shared, centsToDb(d.defaultFloatCents), d.active, ctx.principal.userId])
        .catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('Já existe caixa com este código.'); throw e; });
    if (!r) throw new NotFoundError('Caixa não encontrado.');
    await query(c, 'DELETE FROM cash_register_operators WHERE register_id = $1', [r.id]);
    for (const u of ops) await query(c, 'INSERT INTO cash_register_operators (register_id, user_id) VALUES ($1,$2)', [r.id, u]);
    await audit(c, ctx, { action: d.id ? 'CAIXA_ALTERADO' : 'CAIXA_CRIADO', entityType: 'cash_register', entityId: r.id,
      summary: `Caixa ${d.code} — ${d.name}${d.shared ? ' (compartilhado)' : ''}: ${ops.length} operador(es), fundo de troco ${formatCents(d.defaultFloatCents)}` });
    return r.id;
  });
}

// ---------------------------------------------------------------------------
// Dia de caixa
// ---------------------------------------------------------------------------

export type SessionRow = {
  id: string; register_id: string; register_code: string; register_name: string; shared: boolean; work_date: string; status: 'ABERTO' | 'FECHADO' | 'CONFERIDO';
  opening_float: string; expected_cash: string | null; counted_cash: string | null; sent_to_deposit: string | null; difference: string | null; close_notes: string | null;
  opened_by_name: string; closed_by_name: string | null; closed_at: Date | null; checked_by_name: string | null; checked_at: Date | null; check_notes: string | null;
};
const SESSION_SELECT = `SELECT s.id, s.register_id, r.code AS register_code, r.name AS register_name, r.shared, s.work_date, s.status, s.opening_float::text,
       s.expected_cash::text, s.counted_cash::text, s.sent_to_deposit::text, s.difference::text, s.close_notes,
       uo.display_name AS opened_by_name, uc.display_name AS closed_by_name, s.closed_at, uk.display_name AS checked_by_name, s.checked_at, s.check_notes
  FROM cash_sessions s JOIN cash_registers r ON r.id = s.register_id JOIN users uo ON uo.id = s.opened_by
  LEFT JOIN users uc ON uc.id = s.closed_by LEFT JOIN users uk ON uk.id = s.checked_by`;

export type EntryRow = {
  id: string; session_id: string; kind: CashKind; method: CashMethod; protocol: string | null; payee: string | null; amount: string; received: string | null; protocol_total: string | null;
  change_given: string; description: string | null; reference: string | null; reverses_entry_id: string | null; reversed_by_id: string | null;
  operator_id: string; operator_name: string; created_at: Date; divergence: string | null; divergence_by: string | null;
  orig_kind: CashKind | null; orig_method: CashMethod | null; orig_amount: string | null; reconciled: string[];
};

async function loadEntries(db: Db, sessionIds: string[]): Promise<EntryRow[]> {
  if (!sessionIds.length) return [];
  return query<EntryRow>(db,
    `SELECT e.id, e.session_id, e.kind, e.method, e.protocol, e.payee, e.amount::text, e.received::text, e.protocol_total::text, e.change_given::text, e.description, e.reference,
            e.reverses_entry_id, (SELECT x.id FROM cash_entries x WHERE x.reverses_entry_id = e.id) AS reversed_by_id,
            e.operator_id, u.display_name AS operator_name, e.created_at, d.note AS divergence, du.display_name AS divergence_by,
            o.kind AS orig_kind, o.method AS orig_method, o.amount::text AS orig_amount,
            coalesce((SELECT array_agg(DISTINCT st.source) FROM cash_statement_lines l JOIN cash_statements st ON st.id = l.statement_id WHERE l.matched_entry_id = e.id), '{}') AS reconciled
       FROM cash_entries e JOIN users u ON u.id = e.operator_id
       LEFT JOIN cash_entry_divergences d ON d.entry_id = e.id LEFT JOIN users du ON du.id = d.marked_by
       LEFT JOIN cash_entries o ON o.id = e.reverses_entry_id
      WHERE e.session_id = ANY($1::uuid[]) ORDER BY e.created_at`, [sessionIds]);
}

const asLike = (e: EntryRow): EntryLike => ({
  kind: e.kind, method: e.method, amount: toCents(e.amount),
  reversed: e.orig_kind ? { kind: e.orig_kind, method: e.orig_method!, amount: toCents(e.orig_amount) } : null,
});

export function summarize(s: Pick<SessionRow, 'opening_float'>, entries: EntryRow[]): DaySummary {
  return summarizeDay(toCents(s.opening_float), entries.map(asLike));
}

/** Abre o dia de hoje. Fundo de troco sugerido: o que ficou na gaveta no último fechamento (contado − enviado ao depósito). */
export async function openSession(ctx: Ctx, registerId: string, openingFloatCents?: number | null): Promise<string> {
  z.uuid().parse(registerId);
  const today = todayLocal();
  return tx(async (c) => {
    const r = await queryOne<{ active: boolean; default_float: string; code: string }>(c, 'SELECT active, default_float::text, code FROM cash_registers WHERE id = $1', [registerId]);
    if (!r) throw new NotFoundError('Caixa não encontrado.');
    if (!r.active) throw new AppError('Caixa desativado.');
    await assertOperate(c, ctx, registerId);
    if (await queryOne(c, 'SELECT 1 FROM cash_month_approvals WHERE register_id = $1 AND month = $2', [registerId, `${today.slice(0, 7)}-01`])) {
      throw new AppError('O mês deste caixa já foi aprovado.');
    }
    const last = await queryOne<{ left: string }>(c,
      `SELECT (counted_cash - coalesce(sent_to_deposit, 0))::text AS left FROM cash_sessions WHERE register_id = $1 AND status <> 'ABERTO' AND work_date < $2 ORDER BY work_date DESC LIMIT 1`,
      [registerId, today]);
    const float = openingFloatCents ?? (last ? toCents(last.left) : toCents(r.default_float));
    if (!Number.isInteger(float) || float < 0) throw new AppError('Fundo de troco inválido.');
    const s = await queryOne<{ id: string }>(c,
      'INSERT INTO cash_sessions (register_id, work_date, opening_float, opened_by) VALUES ($1,$2,$3,$4) ON CONFLICT (register_id, work_date) DO NOTHING RETURNING id',
      [registerId, today, centsToDb(float), ctx.principal.userId]);
    if (!s) throw new ConflictError('O caixa de hoje já foi aberto.');
    await audit(c, ctx, { action: 'CAIXA_ABERTO', entityType: 'cash_session', entityId: s.id, summary: `Caixa ${r.code} aberto em ${today} com fundo de troco de ${formatCents(float)}` });
    return s.id;
  });
}

export async function getSession(ctx: Ctx, sessionId: string) {
  const db = getPool();
  z.uuid().parse(sessionId);
  const s = await queryOne<SessionRow>(db, `${SESSION_SELECT} WHERE s.id = $1`, [sessionId]);
  if (!s) throw new NotFoundError('Dia de caixa não encontrado.');
  await assertSee(db, ctx, s.register_id);
  const entries = await loadEntries(db, [s.id]);
  const operator = ctx.principal.isOwner || (await isOperator(db, s.register_id, ctx.principal.userId));
  const conferente = canConfer(ctx.principal);
  const closer = canCloseCash(ctx.principal);
  const ownLines = entries.some((e) => e.operator_id === ctx.principal.userId && e.kind !== 'SANGRIA');
  return {
    session: s, entries, summary: summarize(s, entries),
    can: {
      add: s.status === 'ABERTO' && operator && (ctx.principal.isOwner || can(ctx.principal, 'caixa.frente')) && s.work_date === todayLocal(),
      sangria: s.status === 'ABERTO' && closer,
      close: s.status === 'ABERTO' && closer,
      diverge: s.status === 'FECHADO' && conferente,
      confirm: s.status === 'FECHADO' && conferente && (ctx.principal.isOwner || !ownLines),
      reopen: s.status === 'FECHADO' && conferente,
    },
  };
}

export async function findSession(ctx: Ctx, registerId: string, date: string): Promise<string | null> {
  const db = getPool();
  await assertSee(db, ctx, registerId);
  return (await queryOne<{ id: string }>(db, 'SELECT id FROM cash_sessions WHERE register_id = $1 AND work_date = $2', [registerId, date]))?.id ?? null;
}

const entrySchema = z.object({
  kind: z.enum(['ENTRADA', 'SAIDA_REPASSE', 'SAIDA_DESPESA', 'SAIDA_DEVOLUCAO', 'SUPRIMENTO', 'SANGRIA']),
  method: z.enum(['DINHEIRO', 'PIX', 'CARTAO_DEBITO', 'CARTAO_CREDITO', 'DEPOSITO']),
  protocol: z.string().trim().max(60).optional(),
  payee: z.string().trim().max(160).optional(),
  amountCents: z.number().int().positive().max(10_000_000_00),
  receivedCents: z.number().int().positive().max(10_000_000_00).nullable().optional(),
  description: z.string().trim().max(500).optional(),
  reference: z.string().trim().max(120).optional(),
});

async function lockOpenSession(c: Db, ctx: Ctx, sessionId: string, sangria = false): Promise<{ id: string; register_id: string; register_code: string; work_date: string }> {
  const s = await queryOne<{ id: string; register_id: string; register_code: string; work_date: string; status: string }>(c,
    'SELECT s.id, s.register_id, r.code AS register_code, s.work_date, s.status FROM cash_sessions s JOIN cash_registers r ON r.id = s.register_id WHERE s.id = $1 FOR UPDATE OF s', [sessionId]);
  if (!s) throw new NotFoundError('Dia de caixa não encontrado.');
  if (s.status !== 'ABERTO') throw new AppError('O caixa deste dia já foi fechado.');
  // Sangria: só quem fecha o caixa, e vale também no dia útil seguinte, antes do fechamento.
  if (sangria) {
    if (!canCloseCash(ctx.principal)) throw new ForbiddenError('A sangria é feita por quem fecha o caixa.');
    return s;
  }
  await assertOperate(c, ctx, s.register_id);
  if (s.work_date !== todayLocal()) throw new AppError('Lançamentos só no dia do caixa. Este dia aguarda o fechamento; abra o caixa de hoje.');
  return s;
}

/** Lança uma linha. `pending` > 0 indica pagamento dividido: falta lançar o restante do protocolo em outra forma. */
export async function addEntry(ctx: Ctx, sessionId: string, input: z.input<typeof entrySchema>): Promise<{ id: string; pending: number }> {
  const d = entrySchema.parse(input);
  let checked: ReturnType<typeof checkEntry>;
  try { checked = checkEntry({ kind: d.kind, method: d.method, amount: d.amountCents, received: d.receivedCents, protocol: d.protocol, payee: d.payee }); }
  catch (e) { throw new AppError((e as Error).message); }
  return tx(async (c) => {
    const s = await lockOpenSession(c, ctx, z.uuid().parse(sessionId), d.kind === 'SANGRIA');
    const r = (await queryOne<{ id: string }>(c,
      `INSERT INTO cash_entries (session_id, kind, method, protocol, payee, amount, received, change_given, description, reference, operator_id, protocol_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [s.id, d.kind, d.method, d.protocol || null, d.payee || null, centsToDb(checked.paid), checked.received != null ? centsToDb(checked.received) : null,
        centsToDb(checked.change), d.description || null, d.reference || null, ctx.principal.userId, checked.protocolTotal != null ? centsToDb(checked.protocolTotal) : null]))!;
    await audit(c, ctx, { action: 'CAIXA_LANCAMENTO', entityType: 'cash_entry', entityId: r.id,
      summary: `Caixa ${s.register_code} ${s.work_date}: ${CASH_KIND_LABEL[d.kind]} ${formatCents(checked.paid)} (${d.method.toLowerCase()})${d.protocol ? ` — prot. ${d.protocol}` : ''}`
        + `${checked.protocolTotal && checked.protocolTotal !== checked.paid ? ` de ${formatCents(checked.protocolTotal)}` : ''}${d.payee ? ` — ${d.payee}` : ''}` });
    return { id: r.id, pending: checked.pending };
  });
}

/** Estorno: lançado no dia aberto de hoje do mesmo caixa, anulando o original (que nunca é apagado). */
export async function reverseEntry(ctx: Ctx, entryId: string, reason: string): Promise<string> {
  z.uuid().parse(entryId);
  if (reason.trim().length < 3) throw new AppError('Informe o motivo do estorno.');
  return tx(async (c) => {
    const o = await queryOne<{ id: string; kind: CashKind; method: CashMethod; amount: string; protocol: string | null; payee: string | null; register_id: string }>(c,
      `SELECT e.id, e.kind, e.method, e.amount::text, e.protocol, e.payee, s.register_id FROM cash_entries e JOIN cash_sessions s ON s.id = e.session_id WHERE e.id = $1`, [entryId]);
    if (!o) throw new NotFoundError('Lançamento não encontrado.');
    if (o.kind === 'ESTORNO') throw new AppError('Um estorno não pode ser estornado.');
    if (await queryOne(c, 'SELECT 1 FROM cash_entries WHERE reverses_entry_id = $1', [entryId])) throw new AppError('Este lançamento já foi estornado.');
    const today = await queryOne<{ id: string }>(c, "SELECT id FROM cash_sessions WHERE register_id = $1 AND work_date = $2 AND status = 'ABERTO'", [o.register_id, todayLocal()]);
    if (!today) throw new AppError('Abra o caixa de hoje para lançar o estorno.');
    const s = await lockOpenSession(c, ctx, today.id);
    const r = (await queryOne<{ id: string }>(c,
      `INSERT INTO cash_entries (session_id, kind, method, protocol, payee, amount, change_given, description, reverses_entry_id, operator_id)
       VALUES ($1,'ESTORNO',$2,$3,$4,$5,0,$6,$7,$8) RETURNING id`,
      [s.id, o.method, o.protocol, o.payee, o.amount, reason.trim(), o.id, ctx.principal.userId]))!;
    await audit(c, ctx, { action: 'CAIXA_ESTORNO', entityType: 'cash_entry', entityId: r.id, summary: `Caixa ${s.register_code}: estorno de ${CASH_KIND_LABEL[o.kind]} ${formatCents(toCents(o.amount))} — ${reason.trim()}` });
    return r.id;
  });
}

const closeSchema = z.object({
  countedCents: z.number().int().min(0).max(10_000_000_00),
  sentToDepositCents: z.number().int().min(0).max(10_000_000_00).default(0),
  notes: z.string().trim().max(1000).optional(),
});

/** Fechamento (quem tem "caixa.fechar", inclusive no dia útil seguinte): dinheiro contado e enviado ao depósito; o sistema calcula esperado e diferença. */
export async function closeSession(ctx: Ctx, sessionId: string, input: z.input<typeof closeSchema>): Promise<{ expected: number; difference: number }> {
  const d = closeSchema.parse(input);
  if (d.sentToDepositCents > d.countedCents) throw new AppError('O valor enviado ao depósito não pode ser maior que o dinheiro contado.');
  return tx(async (c) => {
    const s = await queryOne<SessionRow>(c, `${SESSION_SELECT} WHERE s.id = $1 FOR UPDATE OF s`, [z.uuid().parse(sessionId)]);
    if (!s) throw new NotFoundError('Dia de caixa não encontrado.');
    if (!canCloseCash(ctx.principal)) throw new ForbiddenError('O fechamento do dia é feito por quem tem a permissão de fechar o caixa.');
    if (s.status !== 'ABERTO') throw new AppError('Este dia já foi fechado.');
    const sum = summarize(s, await loadEntries(c, [s.id]));
    const difference = d.countedCents - sum.expectedCash;
    await query(c,
      `UPDATE cash_sessions SET status='FECHADO', expected_cash=$2, counted_cash=$3, sent_to_deposit=$4, difference=$5, close_notes=$6, closed_by=$7, closed_at=now() WHERE id=$1`,
      [s.id, centsToDb(sum.expectedCash), centsToDb(d.countedCents), centsToDb(d.sentToDepositCents), centsToDb(difference), d.notes || null, ctx.principal.userId]);
    await audit(c, ctx, { action: 'CAIXA_FECHADO', entityType: 'cash_session', entityId: s.id,
      summary: `Caixa ${s.register_code} ${s.work_date} fechado: esperado ${formatCents(sum.expectedCash)}, contado ${formatCents(d.countedCents)}, diferença ${formatCents(difference)}` });
    const confs = (await usersWithPermission(c, 'caixa.conferir', '00000000-0000-0000-0000-000000000000')).filter((u) => u !== ctx.principal.userId);
    await notifyUsers(c, confs, { kind: 'CAIXA_CONFERIR', title: `Caixa ${s.register_code} de ${s.work_date} fechado para conferência`,
      body: difference ? `Diferença de ${formatCents(difference)}` : 'Sem diferença na contagem', link: `/caixa?dia=${s.id}`, priority: difference ? 'ALTA' : 'NORMAL' });
    return { expected: sum.expectedCash, difference };
  });
}

// ---------------------------------------------------------------------------
// Conferência (Bárbara) e aprovação do mês
// ---------------------------------------------------------------------------

async function lockForConference(c: Db, ctx: Ctx, sessionId: string) {
  if (!canConfer(ctx.principal)) throw new ForbiddenError('Somente quem confere o caixa.');
  const s = await queryOne<{ id: string; status: string; register_id: string; register_code: string; work_date: string }>(c,
    'SELECT s.id, s.status, s.register_id, r.code AS register_code, s.work_date FROM cash_sessions s JOIN cash_registers r ON r.id = s.register_id WHERE s.id = $1 FOR UPDATE OF s',
    [z.uuid().parse(sessionId)]);
  if (!s) throw new NotFoundError('Dia de caixa não encontrado.');
  if (s.status !== 'FECHADO') throw new AppError(s.status === 'ABERTO' ? 'O caixa deste dia ainda não foi fechado pela operadora.' : 'Este dia já foi conferido.');
  return s;
}

/** Aponta (ou retira, com nota vazia) divergência numa linha, antes de confirmar o dia. */
export async function markDivergence(ctx: Ctx, entryId: string, note: string | null): Promise<void> {
  await tx(async (c) => {
    const e = await queryOne<{ session_id: string; amount: string }>(c, 'SELECT session_id, amount::text FROM cash_entries WHERE id = $1', [z.uuid().parse(entryId)]);
    if (!e) throw new NotFoundError('Lançamento não encontrado.');
    const s = await lockForConference(c, ctx, e.session_id);
    if (note && note.trim().length >= 3) {
      await query(c, `INSERT INTO cash_entry_divergences (entry_id, note, marked_by) VALUES ($1,$2,$3)
                      ON CONFLICT (entry_id) DO UPDATE SET note = EXCLUDED.note, marked_by = EXCLUDED.marked_by, marked_at = now()`, [entryId, note.trim(), ctx.principal.userId]);
    } else {
      await query(c, 'DELETE FROM cash_entry_divergences WHERE entry_id = $1', [entryId]);
    }
    await audit(c, ctx, { action: 'CAIXA_DIVERGENCIA', entityType: 'cash_entry', entityId: entryId,
      summary: `Caixa ${s.register_code} ${s.work_date}: ${note ? `divergência apontada — ${note.trim()}` : 'divergência retirada'}` });
  });
}

/** Um clique confere o dia inteiro. Quem lançou no dia não confere o próprio caixa (salvo a Oficial). */
export async function confirmSession(ctx: Ctx, sessionId: string, notes?: string): Promise<void> {
  await tx(async (c) => {
    const s = await lockForConference(c, ctx, sessionId);
    // Sangria é parte do fechamento: não impede quem fecha de conferir. Os demais lançamentos, sim.
    if (!ctx.principal.isOwner && await queryOne(c, "SELECT 1 FROM cash_entries WHERE session_id = $1 AND operator_id = $2 AND kind <> 'SANGRIA'", [s.id, ctx.principal.userId])) {
      throw new ForbiddenError('Quem lançou no caixa do dia não confere o próprio caixa.');
    }
    const div = (await queryOne<{ n: number }>(c, 'SELECT count(*)::int AS n FROM cash_entry_divergences d JOIN cash_entries e ON e.id = d.entry_id WHERE e.session_id = $1', [s.id]))!.n;
    await query(c, "UPDATE cash_sessions SET status='CONFERIDO', checked_by=$2, checked_at=now(), check_notes=$3 WHERE id=$1", [s.id, ctx.principal.userId, notes?.trim() || null]);
    await audit(c, ctx, { action: 'CAIXA_CONFERIDO', entityType: 'cash_session', entityId: s.id,
      summary: `Caixa ${s.register_code} ${s.work_date} conferido${div ? ` com ${div} divergência(s)` : ''}` });
  });
}

/** Reabre um dia fechado (ainda não conferido) para a operadora corrigir a contagem. */
export async function reopenSession(ctx: Ctx, sessionId: string, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new AppError('Informe o motivo da reabertura.');
  await tx(async (c) => {
    const s = await lockForConference(c, ctx, sessionId);
    await query(c, `UPDATE cash_sessions SET status='ABERTO', expected_cash=NULL, counted_cash=NULL, sent_to_deposit=NULL, difference=NULL, closed_by=NULL, closed_at=NULL WHERE id=$1`, [s.id]);
    await audit(c, ctx, { action: 'CAIXA_REABERTO', entityType: 'cash_session', entityId: s.id, summary: `Caixa ${s.register_code} ${s.work_date} reaberto: ${reason.trim()}` });
  });
}

/** OK final do mês: todos os dias com movimento conferidos. */
export async function approveMonth(ctx: Ctx, registerId: string, month: string, notes?: string): Promise<void> {
  if (!canConfer(ctx.principal)) throw new ForbiddenError('Somente quem confere o caixa.');
  const m = z.string().regex(/^\d{4}-\d{2}$/).parse(month);
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    const r = await queryOne<{ code: string }>(c, 'SELECT code FROM cash_registers WHERE id = $1', [z.uuid().parse(registerId)]);
    if (!r) throw new NotFoundError('Caixa não encontrado.');
    const st = (await queryOne<{ total: number; pending: number }>(c,
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE status <> 'CONFERIDO')::int AS pending FROM cash_sessions
        WHERE register_id = $1 AND work_date >= $2::date AND work_date < ($2::date + interval '1 month')`, [registerId, `${m}-01`]))!;
    if (!st.total) throw new AppError('Não há dias de caixa neste mês.');
    if (st.pending) throw new AppError(`Há ${st.pending} dia(s) ainda não conferido(s) neste mês.`);
    await query(c, 'INSERT INTO cash_month_approvals (register_id, month, approved_by, notes) VALUES ($1,$2,$3,$4)', [registerId, `${m}-01`, ctx.principal.userId, notes?.trim() || null])
      .catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('Este mês já foi aprovado.'); throw e; });
    await audit(c, ctx, { action: 'CAIXA_MES_APROVADO', entityType: 'cash_register', entityId: registerId, summary: `Caixa ${r.code}: aprovação final de ${m} (${st.total} dia(s))` });
  });
}

/** Dias ainda abertos (de hoje ou anteriores), para quem faz a sangria e o fechamento. */
export async function pendingClose(ctx: Ctx) {
  if (!canCloseCash(ctx.principal)) return [];
  return query<{ id: string; register_code: string; register_name: string; work_date: string; opened_by_name: string }>(getPool(),
    `SELECT s.id, r.code AS register_code, r.name AS register_name, s.work_date, u.display_name AS opened_by_name
       FROM cash_sessions s JOIN cash_registers r ON r.id = s.register_id JOIN users u ON u.id = s.opened_by
      WHERE s.status = 'ABERTO' ORDER BY s.work_date, r.code`);
}

export async function pendingConference(ctx: Ctx) {
  if (!canConfer(ctx.principal)) return [];
  return query<{ id: string; register_code: string; register_name: string; work_date: string; difference: string | null; closed_by_name: string | null }>(getPool(),
    `SELECT s.id, r.code AS register_code, r.name AS register_name, s.work_date, s.difference::text, u.display_name AS closed_by_name
       FROM cash_sessions s JOIN cash_registers r ON r.id = s.register_id LEFT JOIN users u ON u.id = s.closed_by
      WHERE s.status = 'FECHADO' ORDER BY s.work_date, r.code`);
}

// ---------------------------------------------------------------------------
// Visões do mês e do ano (o modelo das planilhas: um arquivo anual por caixa, uma aba por mês)
// ---------------------------------------------------------------------------

export async function monthView(ctx: Ctx, registerId: string, month: string) {
  if (!canCashTab(ctx.principal, 'mes') && !canCashTab(ctx.principal, 'ano')) throw new ForbiddenError();
  const db = getPool();
  const m = z.string().regex(/^\d{4}-\d{2}$/).parse(month);
  await assertSee(db, ctx, z.uuid().parse(registerId));
  const sessions = await query<SessionRow>(db, `${SESSION_SELECT} WHERE s.register_id = $1 AND s.work_date >= $2::date AND s.work_date < ($2::date + interval '1 month') ORDER BY s.work_date`,
    [registerId, `${m}-01`]);
  const entries = await loadEntries(db, sessions.map((s) => s.id));
  const days = sessions.map((s) => {
    const es = entries.filter((e) => e.session_id === s.id);
    return { session: s, summary: summarize(s, es), lines: es.length, divergences: es.filter((e) => e.divergence).length };
  });
  const approval = await queryOne<{ approved_at: Date; approved_by_name: string; notes: string | null }>(db,
    'SELECT a.approved_at, u.display_name AS approved_by_name, a.notes FROM cash_month_approvals a JOIN users u ON u.id = a.approved_by WHERE a.register_id = $1 AND a.month = $2',
    [registerId, `${m}-01`]);
  const total = (k: keyof Omit<DaySummary, 'entradas'>) => days.reduce((a, d) => a + (d.summary[k] as number), 0);
  return {
    days, approval,
    totals: {
      entradas: total('totalEntradas'), repasses: total('repasses'), despesas: total('despesas'), devolucoes: total('devolucoes'),
      diferencas: days.reduce((a, d) => a + toCents(d.session.difference), 0),
      pendentes: days.filter((d) => d.session.status !== 'CONFERIDO').length, divergencias: days.reduce((a, d) => a + d.divergences, 0),
    },
    canApprove: canConfer(ctx.principal) && !approval && days.length > 0 && days.every((d) => d.session.status === 'CONFERIDO'),
  };
}

export async function yearView(ctx: Ctx, registerId: string, year: number) {
  if (!canCashTab(ctx.principal, 'ano')) throw new ForbiddenError();
  const out = [];
  for (let mo = 1; mo <= 12; mo++) {
    const m = `${year}-${String(mo).padStart(2, '0')}`;
    const v = await monthView(ctx, registerId, m);
    out.push({ month: m, days: v.days.length, ...v.totals, approved: !!v.approval });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Relatórios: fluxo de caixa (realizado e previsto) e DRE gerencial — ligam o caixa ao financeiro administrativo
// ---------------------------------------------------------------------------

export function canSeeCashReports(p: Principal): boolean {
  return canCashTab(p, 'relatorios');
}

async function cashTotalsByDay(db: Db, from: string, toExcl: string, registerId: string | null) {
  const sessions = await query<SessionRow>(db, `${SESSION_SELECT} WHERE s.work_date >= $1 AND s.work_date < $2 AND ($3::uuid IS NULL OR s.register_id = $3)`, [from, toExcl, registerId]);
  const entries = await loadEntries(db, sessions.map((s) => s.id));
  const byDay = new Map<string, DaySummary[]>();
  for (const s of sessions) {
    const sum = summarize({ opening_float: '0' }, entries.filter((e) => e.session_id === s.id));
    byDay.set(s.work_date, [...(byDay.get(s.work_date) ?? []), sum]);
  }
  return byDay;
}

export async function cashFlowReport(ctx: Ctx, month: string, registerId: string | null) {
  if (!canSeeCashReports(ctx.principal)) throw new ForbiddenError();
  const db = getPool();
  const m = z.string().regex(/^\d{4}-\d{2}$/).parse(month);
  const from = `${m}-01`;
  const toExcl = addMonths(from, 1);
  const byDay = await cashTotalsByDay(db, from, toExcl, registerId);
  // O financeiro administrativo entra só para quem vê todo o financeiro (e na visão consolidada).
  const withFinance = !registerId && (await financeScope(db, ctx.principal)) === null;
  const paid = withFinance ? await query<{ d: string; v: string }>(db, 'SELECT paid_on AS d, sum(amount)::text AS v FROM expense_payments WHERE paid_on >= $1 AND paid_on < $2 GROUP BY paid_on', [from, toExcl]) : [];
  const revenues = withFinance ? await query<{ d: string; v: string }>(db,
    'SELECT received_on AS d, sum(CASE WHEN reverses_id IS NULL THEN amount ELSE -amount END)::text AS v FROM revenue_entries WHERE received_on >= $1 AND received_on < $2 GROUP BY received_on', [from, toExcl]) : [];
  const forecast = withFinance ? await query<{ d: string; v: string }>(db,
    `SELECT due_date AS d, sum(amount)::text AS v FROM expenses WHERE status IN ('SOLICITADA','APROVADA') AND due_date >= $1 AND due_date < $2 GROUP BY due_date`, [from, toExcl]) : [];
  const map = (rows: { d: string; v: string }[]) => new Map(rows.map((r) => [r.d, toCents(r.v)]));
  const [mPaid, mRev, mFc] = [map(paid), map(revenues), map(forecast)];
  type FlowRow = { date: string; methods: Record<CashMethod, number>; receitasFinanceiro: number; repasses: number; despesasCaixa: number; devolucoes: number;
    pagamentosFinanceiro: number; previsto: number; saldoDia: number; acumulado: number };
  const rows: FlowRow[] = [];
  let acc = 0;
  for (let d = from; d < toExcl; d = addDays(d, 1)) {
    const sums = byDay.get(d) ?? [];
    const sum = (k: 'totalEntradas' | 'repasses' | 'despesas' | 'devolucoes') => sums.reduce((a, s) => a + s[k], 0);
    const methods = { DINHEIRO: 0, PIX: 0, CARTAO_DEBITO: 0, CARTAO_CREDITO: 0, DEPOSITO: 0 } as Record<CashMethod, number>;
    for (const s of sums) for (const k of Object.keys(methods) as CashMethod[]) methods[k] += s.entradas[k];
    const entradas = sum('totalEntradas') + (mRev.get(d) ?? 0);
    const saidas = sum('repasses') + sum('despesas') + sum('devolucoes') + (mPaid.get(d) ?? 0);
    acc += entradas - saidas;
    if (!sums.length && !mPaid.get(d) && !mRev.get(d) && !mFc.get(d)) continue;
    rows.push({ date: d, methods, receitasFinanceiro: mRev.get(d) ?? 0, repasses: sum('repasses'), despesasCaixa: sum('despesas'), devolucoes: sum('devolucoes'),
      pagamentosFinanceiro: mPaid.get(d) ?? 0, previsto: mFc.get(d) ?? 0, saldoDia: entradas - saidas, acumulado: acc });
  }
  const tot = (k: Exclude<keyof FlowRow, 'date' | 'methods'>) => rows.reduce((a, r) => a + (r[k] as number), 0);
  return { rows, withFinance, totals: { entradas: rows.reduce((a, r) => a + Object.values(r.methods).reduce((x, y) => x + y, 0) + r.receitasFinanceiro, 0),
    saidas: tot('repasses') + tot('despesasCaixa') + tot('devolucoes') + tot('pagamentosFinanceiro'), previsto: tot('previsto'), saldo: acc } };
}

export async function dreReport(ctx: Ctx, fromMonth: string, toMonth: string) {
  if (!canSeeCashReports(ctx.principal)) throw new ForbiddenError();
  const db = getPool();
  const from = `${z.string().regex(/^\d{4}-\d{2}$/).parse(fromMonth)}-01`;
  const toExcl = addMonths(`${z.string().regex(/^\d{4}-\d{2}$/).parse(toMonth)}-01`, 1);
  if (toExcl <= from) throw new AppError('Período inválido.');
  const byDay = await cashTotalsByDay(db, from, toExcl, null);
  let entradas = 0, repasses = 0, devolucoes = 0, despesasCaixa = 0;
  for (const sums of byDay.values()) for (const s of sums) { entradas += s.totalEntradas; repasses += s.repasses; devolucoes += s.devolucoes; despesasCaixa += s.despesas; }
  const withFinance = (await financeScope(db, ctx.principal)) === null;
  const fin = withFinance ? await query<{ name: string; v: string }>(db,
    `SELECT fc.name, sum(p.amount)::text AS v FROM expense_payments p JOIN expenses e ON e.id = p.expense_id JOIN finance_categories fc ON fc.id = e.category_id
      WHERE p.paid_on >= $1 AND p.paid_on < $2 GROUP BY fc.name ORDER BY sum(p.amount) DESC`, [from, toExcl]) : [];
  return { withFinance, ...dre({ entradas, repasses, devolucoes, despesasCaixa, despesasFinanceiro: fin.map((r) => ({ name: r.name, cents: toCents(r.v) })) }) };
}
