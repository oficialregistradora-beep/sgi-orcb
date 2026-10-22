import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx, Principal } from '../context.ts';
import { can, requirePermission, requireStepUp, scopeFilter } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors.ts';
import { decryptField, encryptField, hmacLookup, normalizeCpf } from '../crypto.ts';
import { getNumberSetting, getSetting } from '../settings.ts';
import { checkFile } from '../files.ts';
import { addDays, addMonths, todayLocal } from '../../domain/time.ts';
import { centsToDb, toCents } from '../../domain/money.ts';
import { budgetVsActual, cashFlow, competenceDate, contractAlerts, dueDateIn, monthsBetween, normalizeCnpj, projectOutflows } from '../../domain/finance.ts';
import { notifyUsers, usersWithPermission } from './notifications.ts';
import { discardUnsaved, insertStoredFile, loadStoredFile, prepareFile, readStoredFile, rescan } from './fileStore.ts';
import { maxFileBytes } from './repository.ts';

// Financeiro GERENCIAL (Fase 4b). Não substitui a escrituração obrigatória, o Livro Diário Auxiliar nem outros
// controles formais da serventia. Segregação: quem solicita não aprova; quem solicita ou aprova não paga.

export const DISCLAIMER = 'Controle gerencial interno. Não substitui a escrituração obrigatória, o Livro Diário Auxiliar nem outros controles formais da serventia.';

const cents = z.number().int().positive().max(99_999_999_999_99);

// ---------------------------------------------------------------------------
// Escopo de visualização
// ---------------------------------------------------------------------------

/** Centros de custo visíveis: todos (escopo TODOS, aprovação ou pagamento) ou os dos setores do escopo. null = todos. */
async function visibleCostCenters(db: Db, p: Principal): Promise<string[] | null> {
  if (p.isOwner || can(p, 'financeiro.aprovar') || can(p, 'financeiro.pagar') || can(p, 'financeiro.cadastros')) return null;
  const f = scopeFilter(p, 'financeiro.ver') ?? scopeFilter(p, 'financeiro.solicitar');
  if (!f) return [];
  if (f.all) return null;
  return (await query<{ id: string }>(db, 'SELECT id FROM cost_centers WHERE sector_id = ANY($1::uuid[])', [f.sectorIds])).map((r) => r.id);
}

function requireAnyFinance(p: Principal) {
  if (!['financeiro.ver', 'financeiro.solicitar', 'financeiro.aprovar', 'financeiro.pagar', 'financeiro.cadastros', 'financeiro.receitas'].some((x) => can(p, x))) {
    throw new ForbiddenError();
  }
}

// ---------------------------------------------------------------------------
// Cadastros
// ---------------------------------------------------------------------------

export async function listCostCenters() {
  return query<{ id: string; code: string; name: string; sector_id: string; sector_name: string; active: boolean }>(
    getPool(), 'SELECT c.id, c.code, c.name, c.sector_id, s.name AS sector_name, c.active FROM cost_centers c JOIN sectors s ON s.id = c.sector_id ORDER BY c.code');
}

export async function saveCostCenter(ctx: Ctx, input: { id?: string; code: string; name: string; sectorId: string; active: boolean }): Promise<string> {
  requirePermission(ctx, 'financeiro.cadastros');
  const d = z.object({ id: z.uuid().optional(), code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._-]{0,19}$/, 'Código inválido.'), name: z.string().trim().min(2).max(120), sectorId: z.uuid(), active: z.boolean() }).parse(input);
  return tx(async (c) => {
    const r = await (d.id
      ? queryOne<{ id: string }>(c, 'UPDATE cost_centers SET code=$1, name=$2, sector_id=$3, active=$4 WHERE id=$5 RETURNING id', [d.code, d.name, d.sectorId, d.active, d.id])
      : queryOne<{ id: string }>(c, 'INSERT INTO cost_centers (code, name, sector_id, active) VALUES ($1,$2,$3,$4) RETURNING id', [d.code, d.name, d.sectorId, d.active])
    ).catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('Já existe centro de custo com este código ou nome.'); throw e; });
    if (!r) throw new NotFoundError('Centro de custo não encontrado.');
    await audit(c, ctx, { action: 'FIN_CENTRO_CUSTO', entityType: 'cost_center', entityId: r.id, summary: `Centro de custo ${d.code} — ${d.name}` });
    return r.id;
  });
}

export async function listFinanceCategories() {
  return query<{ id: string; code: string; name: string; kind: string; active: boolean }>(getPool(), 'SELECT id, code, name, kind, active FROM finance_categories ORDER BY sort_order, name');
}

export async function saveFinanceCategory(ctx: Ctx, input: { id?: string; code: string; name: string; kind: string; active: boolean }): Promise<void> {
  requirePermission(ctx, 'financeiro.cadastros');
  const d = z.object({ id: z.uuid().optional(), code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,30}$/), name: z.string().trim().min(2).max(120),
    kind: z.enum(['DESPESA_FIXA', 'DESPESA_VARIAVEL', 'PESSOAL', 'INVESTIMENTO', 'RECEITA']), active: z.boolean() }).parse(input);
  await tx(async (c) => {
    await (d.id
      ? query(c, 'UPDATE finance_categories SET code=$1, name=$2, kind=$3, active=$4 WHERE id=$5', [d.code, d.name, d.kind, d.active, d.id])
      : query(c, 'INSERT INTO finance_categories (code, name, kind, active, sort_order) VALUES ($1,$2,$3,$4,(SELECT coalesce(max(sort_order),0)+10 FROM finance_categories))', [d.code, d.name, d.kind, d.active])
    ).catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('Já existe categoria com este código ou nome.'); throw e; });
    await audit(c, ctx, { action: 'FIN_CATEGORIA', entityType: 'finance_category', entityId: d.id ?? null, summary: `Categoria ${d.code} — ${d.name}` });
  });
}

const supplierSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(2).max(160),
  document: z.string().trim().min(11).max(20),
  email: z.email().optional(),
  phone: z.string().trim().max(30).optional(),
  notes: z.string().trim().max(1000).optional(),
  active: z.boolean().default(true),
});

export async function saveSupplier(ctx: Ctx, input: z.input<typeof supplierSchema>): Promise<string> {
  requirePermission(ctx, 'financeiro.cadastros');
  const d = supplierSchema.parse(input);
  const cnpj = normalizeCnpj(d.document);
  const cpf = cnpj ? null : normalizeCpf(d.document);
  if (!cnpj && !cpf) throw new AppError('CNPJ ou CPF inválido.');
  const doc = (cnpj ?? cpf)!;
  return tx(async (c) => {
    const params = [d.name, cnpj ? 'CNPJ' : 'CPF', encryptField(doc), hmacLookup(`fornecedor:${doc}`), doc.slice(-4), d.email ?? null, d.phone ?? null, d.notes ?? null, d.active];
    const r = await (d.id
      ? queryOne<{ id: string }>(c, `UPDATE suppliers SET name=$1, document_type=$2, document_enc=$3, document_hmac=$4, document_last4=$5, email=$6, phone=$7, notes=$8, active=$9
          WHERE id=$10 RETURNING id`, [...params, d.id])
      : queryOne<{ id: string }>(c, `INSERT INTO suppliers (name, document_type, document_enc, document_hmac, document_last4, email, phone, notes, active, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [...params, ctx.principal.userId])
    ).catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('Fornecedor já cadastrado com este CNPJ/CPF.'); throw e; });
    if (!r) throw new NotFoundError('Fornecedor não encontrado.');
    await audit(c, ctx, { action: d.id ? 'FIN_FORNECEDOR_ALTERADO' : 'FIN_FORNECEDOR_CRIADO', entityType: 'supplier', entityId: r.id, summary: `Fornecedor "${d.name}" (${cnpj ? 'CNPJ' : 'CPF'} final ${doc.slice(-4)})` });
    return r.id;
  });
}

export async function listSuppliers(ctx: Ctx) {
  requireAnyFinance(ctx.principal);
  return query<{ id: string; name: string; document_type: string; document_last4: string; email: string | null; phone: string | null; active: boolean; contracts: number }>(
    getPool(), `SELECT s.id, s.name, s.document_type, s.document_last4, s.email, s.phone, s.active,
                       (SELECT count(*)::int FROM contracts c WHERE c.supplier_id = s.id AND c.status = 'VIGENTE') AS contracts
                  FROM suppliers s ORDER BY s.active DESC, s.name`);
}

/** Documento completo do fornecedor (consulta auditada). */
export async function supplierDocument(ctx: Ctx, id: string): Promise<string> {
  requirePermission(ctx, 'financeiro.cadastros');
  z.uuid().parse(id);
  const r = await queryOne<{ document_enc: string; name: string }>(getPool(), 'SELECT document_enc, name FROM suppliers WHERE id = $1', [id]);
  if (!r) throw new NotFoundError('Fornecedor não encontrado.');
  await audit(getPool(), ctx, { action: 'FIN_FORNECEDOR_DOCUMENTO_VISTO', entityType: 'supplier', entityId: id, summary: `Documento do fornecedor "${r.name}" exibido` });
  return decryptField(r.document_enc)!;
}

const contractSchema = z.object({
  id: z.uuid().optional(),
  supplierId: z.uuid(),
  object: z.string().trim().min(3).max(500),
  costCenterId: z.uuid(),
  categoryId: z.uuid(),
  startDate: z.iso.date(),
  endDate: z.iso.date().nullable().optional(),
  monthlyCents: cents.nullable().optional(),
  totalCents: cents.nullable().optional(),
  dueDay: z.number().int().min(1).max(31).nullable().optional(),
  readjustment: z.string().trim().max(500).optional(),
  noticeDays: z.number().int().min(0).max(365).default(60),
});

export async function saveContract(ctx: Ctx, input: z.input<typeof contractSchema>): Promise<string> {
  requirePermission(ctx, 'financeiro.cadastros');
  const d = contractSchema.parse(input);
  if (d.endDate && d.endDate < d.startDate) throw new AppError('O término não pode ser anterior ao início.');
  if ((d.monthlyCents == null) !== (d.dueDay == null)) throw new AppError('Contrato com valor mensal exige o dia de vencimento (e vice-versa).');
  return tx(async (c) => {
    const params = [d.supplierId, d.object, d.costCenterId, d.categoryId, d.startDate, d.endDate ?? null, d.monthlyCents != null ? centsToDb(d.monthlyCents) : null,
      d.totalCents != null ? centsToDb(d.totalCents) : null, d.dueDay ?? null, d.readjustment ?? null, d.noticeDays];
    const r = d.id
      ? await queryOne<{ id: string }>(c, `UPDATE contracts SET supplier_id=$1, object=$2, cost_center_id=$3, category_id=$4, start_date=$5, end_date=$6, monthly_amount=$7,
          total_amount=$8, due_day=$9, readjustment=$10, notice_days=$11 WHERE id=$12 AND status = 'VIGENTE' RETURNING id`, [...params, d.id])
      : await queryOne<{ id: string }>(c, `INSERT INTO contracts (supplier_id, object, cost_center_id, category_id, start_date, end_date, monthly_amount, total_amount, due_day,
          readjustment, notice_days, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [...params, ctx.principal.userId]);
    if (!r) throw new NotFoundError('Contrato não encontrado ou encerrado.');
    await audit(c, ctx, { action: d.id ? 'FIN_CONTRATO_ALTERADO' : 'FIN_CONTRATO_CRIADO', entityType: 'contract', entityId: r.id, summary: `Contrato: ${d.object}`,
      data: { mensal: d.monthlyCents ?? null, total: d.totalCents ?? null, inicio: d.startDate, fim: d.endDate ?? null } });
    return r.id;
  });
}

export async function closeContract(ctx: Ctx, id: string, reason: string): Promise<void> {
  requirePermission(ctx, 'financeiro.cadastros');
  if (reason.trim().length < 3) throw new AppError('Informe o motivo do encerramento.');
  await tx(async (c) => {
    const r = await query(c, "UPDATE contracts SET status='ENCERRADO', closed_reason=$2 WHERE id=$1 AND status='VIGENTE' RETURNING id", [id, reason.trim()]);
    if (!r.length) throw new AppError('Contrato inexistente ou já encerrado.');
    await audit(c, ctx, { action: 'FIN_CONTRATO_ENCERRADO', entityType: 'contract', entityId: id, summary: `Contrato encerrado: ${reason.trim()}` });
  });
}

export type ContractRow = {
  id: string; supplier_id: string; supplier_name: string; object: string; cost_center_id: string; cost_center: string; category_id: string; category: string;
  start_date: string; end_date: string | null; monthly_amount: string | null; total_amount: string | null; due_day: number | null; readjustment: string | null;
  notice_days: number; status: string; closed_reason: string | null;
};

export async function listContracts(ctx: Ctx) {
  const db = getPool();
  requireAnyFinance(ctx.principal);
  const ccs = await visibleCostCenters(db, ctx.principal);
  const rows = await query<ContractRow>(db,
    `SELECT k.id, k.supplier_id, s.name AS supplier_name, k.object, k.cost_center_id, cc.code || ' — ' || cc.name AS cost_center, k.category_id, fc.name AS category,
            k.start_date, k.end_date, k.monthly_amount::text, k.total_amount::text, k.due_day, k.readjustment, k.notice_days, k.status, k.closed_reason
       FROM contracts k JOIN suppliers s ON s.id = k.supplier_id JOIN cost_centers cc ON cc.id = k.cost_center_id JOIN finance_categories fc ON fc.id = k.category_id
      WHERE ($1::uuid[] IS NULL OR k.cost_center_id = ANY($1::uuid[])) ORDER BY k.status DESC, k.end_date NULLS LAST`, [ccs]);
  return { rows, alerts: contractAlerts(rows, todayLocal()) };
}

/** Lança, para a competência, as mensalidades dos contratos vigentes (idempotente; seguem para aprovação). */
export async function generateContractExpenses(ctx: Ctx, month: string): Promise<number> {
  requirePermission(ctx, 'financeiro.cadastros');
  const comp = competenceDate(z.string().regex(/^\d{4}-\d{2}$/).parse(month));
  const last = addDays(addMonths(comp, 1), -1);
  return tx(async (c) => {
    const contracts = await query<{ id: string; object: string; supplier_id: string; cost_center_id: string; category_id: string; monthly_amount: string; due_day: number }>(
      c, `SELECT id, object, supplier_id, cost_center_id, category_id, monthly_amount::text, due_day FROM contracts
           WHERE status = 'VIGENTE' AND monthly_amount IS NOT NULL AND start_date <= $2 AND (end_date IS NULL OR end_date >= $1)`, [comp, last]);
    let n = 0;
    for (const k of contracts) {
      const r = await query<{ id: string }>(
        c,
        `INSERT INTO expenses (kind, origin, description, supplier_id, contract_id, cost_center_id, category_id, amount, competence, due_date, requested_by)
         VALUES ('FIXA','CONTRATO',$1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (contract_id, competence) WHERE origin = 'CONTRATO' AND status <> 'CANCELADA' DO NOTHING RETURNING id`,
        [`${k.object} — ${comp.slice(5, 7)}/${comp.slice(0, 4)}`, k.supplier_id, k.id, k.cost_center_id, k.category_id, k.monthly_amount, comp, dueDateIn(comp, k.due_day), ctx.principal.userId]);
      if (r.length) {
        n++;
        await query(c, "INSERT INTO expense_events (expense_id, user_id, event, details) VALUES ($1,$2,'SOLICITADA',$3)", [r[0]!.id, ctx.principal.userId, JSON.stringify({ origem: 'contrato' })]);
      }
    }
    await audit(c, ctx, { action: 'FIN_DESPESAS_FIXAS_GERADAS', entityType: 'expense', entityId: null, summary: `${n} despesa(s) fixa(s) de contratos lançadas para ${comp.slice(0, 7)}` });
    if (n) await notifyUsers(c, (await usersWithPermission(c, 'financeiro.aprovar', '00000000-0000-0000-0000-000000000000')).filter((u) => u !== ctx.principal.userId),
      { kind: 'FIN_APROVACAO', title: 'Despesas fixas aguardando aprovação', body: `${n} lançamento(s) de contratos — ${comp.slice(0, 7)}`, link: '/financeiro?aba=pagar' });
    return n;
  });
}

export async function setBudget(ctx: Ctx, input: { year: number; months: number[]; costCenterId: string; categoryId: string; amountCents: number }): Promise<void> {
  requirePermission(ctx, 'financeiro.cadastros');
  const d = z.object({ year: z.number().int().min(2020).max(2100), months: z.array(z.number().int().min(1).max(12)).min(1).max(12), costCenterId: z.uuid(), categoryId: z.uuid(),
    amountCents: z.number().int().min(0).max(99_999_999_999_99) }).parse(input);
  await tx(async (c) => {
    for (const m of new Set(d.months)) {
      await query(c, `INSERT INTO budget_lines (year, month, cost_center_id, category_id, amount, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (year, month, cost_center_id, category_id) DO UPDATE SET amount = EXCLUDED.amount, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [d.year, m, d.costCenterId, d.categoryId, centsToDb(d.amountCents), ctx.principal.userId]);
    }
    await audit(c, ctx, { action: 'FIN_ORCAMENTO', entityType: 'budget', entityId: null, summary: `Orçamento ${d.year} (${d.months.length} mês(es)) = ${centsToDb(d.amountCents)} por mês`, data: d });
  });
}

// ---------------------------------------------------------------------------
// Despesas: solicitação → aprovação → pagamento
// ---------------------------------------------------------------------------

const expenseSchema = z.object({
  kind: z.enum(['FIXA', 'VARIAVEL', 'COMPRA']),
  description: z.string().trim().min(3).max(500),
  supplierId: z.uuid().nullable().optional(),
  contractId: z.uuid().nullable().optional(),
  projectId: z.uuid().nullable().optional(),
  costCenterId: z.uuid(),
  categoryId: z.uuid(),
  amountCents: cents,
  competence: z.string().regex(/^\d{4}-\d{2}$/, 'Competência no formato AAAA-MM.'),
  dueDate: z.iso.date(),
  justification: z.string().trim().max(2000).optional(),
});

async function costCenterSector(c: Db, id: string): Promise<string> {
  const r = await queryOne<{ sector_id: string; active: boolean }>(c, 'SELECT sector_id, active FROM cost_centers WHERE id = $1', [id]);
  if (!r) throw new AppError('Centro de custo inexistente.');
  if (!r.active) throw new AppError('Centro de custo inativo.');
  return r.sector_id;
}

async function event(c: Db, ctx: Ctx, id: string, ev: string, details: Record<string, unknown> = {}) {
  await query(c, 'INSERT INTO expense_events (expense_id, user_id, event, details) VALUES ($1,$2,$3,$4)', [id, ctx.principal.userId, ev, JSON.stringify(details)]);
}

export async function requestExpense(ctx: Ctx, input: z.input<typeof expenseSchema>): Promise<string> {
  const d = expenseSchema.parse(input);
  if (d.kind === 'COMPRA' && (!d.justification || d.justification.length < 3)) throw new AppError('Compras exigem justificativa.');
  return tx(async (c) => {
    const sector = await costCenterSector(c, d.costCenterId);
    if (!ctx.principal.isOwner && !can(ctx.principal, 'financeiro.solicitar', { sectorId: sector })) throw new ForbiddenError('Sem permissão para solicitar despesas neste centro de custo.');
    const cat = await queryOne<{ kind: string; active: boolean }>(c, 'SELECT kind, active FROM finance_categories WHERE id = $1', [d.categoryId]);
    if (!cat || !cat.active || cat.kind === 'RECEITA') throw new AppError('Categoria de despesa inválida.');
    const r = await queryOne<{ id: string }>(
      c,
      `INSERT INTO expenses (kind, description, supplier_id, contract_id, project_id, cost_center_id, category_id, amount, competence, due_date, justification, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [d.kind, d.description, d.supplierId ?? null, d.contractId ?? null, d.projectId ?? null, d.costCenterId, d.categoryId, centsToDb(d.amountCents), competenceDate(d.competence),
        d.dueDate, d.justification ?? null, ctx.principal.userId]);
    await event(c, ctx, r!.id, 'SOLICITADA', { valor: d.amountCents });
    await audit(c, ctx, { action: 'FIN_DESPESA_SOLICITADA', entityType: 'expense', entityId: r!.id, summary: `Despesa solicitada: ${d.description} (${centsToDb(d.amountCents)})` });
    const approvers = (await usersWithPermission(c, 'financeiro.aprovar', sector)).filter((u) => u !== ctx.principal.userId);
    await notifyUsers(c, approvers, { kind: 'FIN_APROVACAO', title: d.kind === 'COMPRA' ? 'Compra aguardando aprovação' : 'Despesa aguardando aprovação', body: d.description, link: `/financeiro/despesas/${r!.id}` });
    return r!.id;
  });
}

export type ExpenseRow = {
  id: string; kind: string; origin: string; description: string; supplier_id: string | null; supplier_name: string | null; contract_id: string | null;
  project_id: string | null; project_name: string | null; cost_center_id: string; cost_center: string; sector_id: string; category_id: string; category: string;
  amount: string; competence: string; due_date: string; status: string; requested_by: string; requested_by_name: string; requested_at: Date;
  justification: string | null; decided_by: string | null; decided_by_name: string | null; decided_at: Date | null; decision_notes: string | null;
  cancel_reason: string | null; paid_on: string | null; paid_amount: string | null; method: string | null; paid_by_name: string | null; reference: string | null;
  receipts: number;
};

const EXPENSE_SELECT = `
  SELECT e.id, e.kind, e.origin, e.description, e.supplier_id, s.name AS supplier_name, e.contract_id, e.project_id, pr.name AS project_name,
         e.cost_center_id, cc.code || ' — ' || cc.name AS cost_center, cc.sector_id, e.category_id, fc.name AS category, e.amount::text, e.competence, e.due_date,
         e.status, e.requested_by, ur.display_name AS requested_by_name, e.requested_at, e.justification, e.decided_by, ud.display_name AS decided_by_name,
         e.decided_at, e.decision_notes, e.cancel_reason, p.paid_on, p.amount::text AS paid_amount, p.method, up.display_name AS paid_by_name, p.reference,
         (SELECT count(*)::int FROM finance_attachments a WHERE a.expense_id = e.id AND a.kind = 'COMPROVANTE') AS receipts
    FROM expenses e
    JOIN cost_centers cc ON cc.id = e.cost_center_id JOIN finance_categories fc ON fc.id = e.category_id JOIN users ur ON ur.id = e.requested_by
    LEFT JOIN suppliers s ON s.id = e.supplier_id LEFT JOIN projects pr ON pr.id = e.project_id LEFT JOIN users ud ON ud.id = e.decided_by
    LEFT JOIN expense_payments p ON p.expense_id = e.id LEFT JOIN users up ON up.id = p.paid_by`;

async function loadExpense(c: Db, ctx: Ctx, id: string, lock = false): Promise<ExpenseRow> {
  z.uuid().parse(id);
  if (lock) await query(c, 'SELECT 1 FROM expenses WHERE id = $1 FOR UPDATE', [id]);
  const e = await queryOne<ExpenseRow>(c, `${EXPENSE_SELECT} WHERE e.id = $1`, [id]);
  if (!e) throw new NotFoundError('Despesa não encontrada.');
  const ccs = await visibleCostCenters(c, ctx.principal);
  if (e.requested_by !== ctx.principal.userId && ccs !== null && !ccs.includes(e.cost_center_id)) throw new NotFoundError('Despesa não encontrada.');
  return e;
}

export async function updateRequest(ctx: Ctx, id: string, input: z.input<typeof expenseSchema>): Promise<void> {
  const d = expenseSchema.parse(input);
  await tx(async (c) => {
    const e = await loadExpense(c, ctx, id, true);
    if (e.requested_by !== ctx.principal.userId) throw new ForbiddenError('Somente quem solicitou altera a solicitação.');
    if (e.status !== 'SOLICITADA') throw new AppError('Somente solicitações pendentes podem ser alteradas.');
    const sector = await costCenterSector(c, d.costCenterId);
    if (!ctx.principal.isOwner && !can(ctx.principal, 'financeiro.solicitar', { sectorId: sector })) throw new ForbiddenError();
    await query(c, `UPDATE expenses SET kind=$2, description=$3, supplier_id=$4, project_id=$5, cost_center_id=$6, category_id=$7, amount=$8, competence=$9, due_date=$10,
                    justification=$11, updated_at=now() WHERE id=$1`,
      [id, d.kind, d.description, d.supplierId ?? null, d.projectId ?? null, d.costCenterId, d.categoryId, centsToDb(d.amountCents), competenceDate(d.competence), d.dueDate, d.justification ?? null]);
    await event(c, ctx, id, 'ALTERADA', { valor: d.amountCents });
  });
}

export async function decideExpense(ctx: Ctx, id: string, approve: boolean, notes?: string): Promise<void> {
  requirePermission(ctx, 'financeiro.aprovar');
  if (!approve && (!notes || notes.trim().length < 3)) throw new AppError('Informe o motivo da rejeição.');
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    const e = await loadExpense(c, ctx, id, true);
    if (e.status !== 'SOLICITADA') throw new AppError('A despesa não está aguardando decisão.');
    if (e.requested_by === ctx.principal.userId) throw new ForbiddenError('Segregação de funções: quem solicitou não aprova.');
    const limit = await getNumberSetting(c, 'financeiro.limite_aprovacao_delegada', 0);
    if (approve && limit > 0 && toCents(e.amount) > Math.round(limit * 100) && !ctx.principal.isOwner) {
      throw new ForbiddenError(`Valor acima do limite de aprovação delegada (R$ ${limit.toFixed(2)}): cabe à Oficial.`);
    }
    if (approve && e.kind === 'COMPRA') {
      const chosen = await queryOne<{ amount: string }>(c, 'SELECT amount::text FROM expense_quotes WHERE expense_id = $1 AND chosen', [id]);
      if (!chosen) throw new AppError('Compra: registre as cotações e indique a escolhida antes da aprovação.');
    }
    await query(c, 'UPDATE expenses SET status=$2, decided_by=$3, decided_at=now(), decision_notes=$4, updated_at=now() WHERE id=$1',
      [id, approve ? 'APROVADA' : 'REJEITADA', ctx.principal.userId, notes?.trim() || null]);
    await event(c, ctx, id, approve ? 'APROVADA' : 'REJEITADA', { notas: notes?.trim() || undefined });
    await audit(c, ctx, { action: approve ? 'FIN_DESPESA_APROVADA' : 'FIN_DESPESA_REJEITADA', entityType: 'expense', entityId: id, summary: `${e.description} (${e.amount}) ${approve ? 'aprovada' : 'rejeitada'}` });
    await notifyUsers(c, [e.requested_by], { kind: approve ? 'FIN_APROVADA' : 'FIN_REJEITADA', title: approve ? 'Despesa aprovada' : 'Despesa rejeitada', body: e.description, link: `/financeiro/despesas/${id}` });
    if (approve) {
      const payers = (await usersWithPermission(c, 'financeiro.pagar', e.sector_id)).filter((u) => u !== ctx.principal.userId && u !== e.requested_by);
      await notifyUsers(c, payers, { kind: 'FIN_A_PAGAR', title: 'Despesa aprovada para pagamento', body: `${e.description} — vence em ${e.due_date}`, link: `/financeiro/despesas/${id}` });
    }
  });
}

const paymentSchema = z.object({
  paidOn: z.iso.date(),
  amountCents: cents,
  method: z.enum(['PIX', 'BOLETO', 'TRANSFERENCIA', 'DEBITO_AUTOMATICO', 'CARTAO', 'DINHEIRO']),
  reference: z.string().trim().max(200).optional(),
});

export async function registerPayment(ctx: Ctx, id: string, input: z.input<typeof paymentSchema>): Promise<void> {
  requirePermission(ctx, 'financeiro.pagar');
  const d = paymentSchema.parse(input);
  if (d.paidOn > todayLocal()) throw new AppError('A data do pagamento não pode ser futura.');
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    const e = await loadExpense(c, ctx, id, true);
    if (e.status !== 'APROVADA') throw new AppError('Somente despesa aprovada pode ser paga.');
    if (e.requested_by === ctx.principal.userId || e.decided_by === ctx.principal.userId) throw new ForbiddenError('Segregação de funções: quem solicitou ou aprovou não registra o pagamento.');
    if (d.amountCents !== toCents(e.amount)) throw new AppError('O valor pago deve ser igual ao valor aprovado (pagamentos parciais não são admitidos; ajuste exige nova solicitação).');
    if ((await getSetting<boolean>(c, 'financeiro.comprovante_obrigatorio', true)) && e.receipts === 0) throw new AppError('Anexe o comprovante antes de registrar o pagamento.');
    await query(c, 'INSERT INTO expense_payments (expense_id, paid_on, amount, method, reference, paid_by) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, d.paidOn, centsToDb(d.amountCents), d.method, d.reference ?? null, ctx.principal.userId])
      .catch((err: { code?: string }) => { if (err.code === '23505') throw new ConflictError('Pagamento já registrado.'); throw err; });
    await query(c, "UPDATE expenses SET status='PAGA', updated_at=now() WHERE id=$1", [id]);
    await event(c, ctx, id, 'PAGA', { data: d.paidOn, forma: d.method });
    await audit(c, ctx, { action: 'FIN_PAGAMENTO', entityType: 'expense', entityId: id, summary: `Pagamento de ${e.description} (${e.amount}) em ${d.paidOn} via ${d.method}` });
  });
}

export async function cancelExpense(ctx: Ctx, id: string, reason: string): Promise<void> {
  if (reason.trim().length < 3) throw new AppError('Informe o motivo do cancelamento.');
  await tx(async (c) => {
    const e = await loadExpense(c, ctx, id, true);
    if (e.status === 'PAGA') throw new AppError('Despesa paga não é cancelada (registro imutável). Registre o ajuste em nova solicitação.');
    if (e.status !== 'SOLICITADA' && e.status !== 'APROVADA') throw new AppError('Despesa já encerrada.');
    const allowed = (e.status === 'SOLICITADA' && e.requested_by === ctx.principal.userId) || can(ctx.principal, 'financeiro.aprovar') || can(ctx.principal, 'financeiro.cadastros');
    if (!allowed) throw new ForbiddenError();
    await query(c, "UPDATE expenses SET status='CANCELADA', cancelled_by=$2, cancel_reason=$3, updated_at=now() WHERE id=$1", [id, ctx.principal.userId, reason.trim()]);
    await event(c, ctx, id, 'CANCELADA', { motivo: reason.trim() });
    await audit(c, ctx, { action: 'FIN_DESPESA_CANCELADA', entityType: 'expense', entityId: id, summary: `${e.description} cancelada: ${reason.trim()}` });
  });
}

// Cotações (compras) e anexos ------------------------------------------------

export async function addQuote(ctx: Ctx, id: string, input: { supplierName: string; amountCents: number }, file?: { name: string; bytes: Uint8Array } | null): Promise<void> {
  const d = z.object({ supplierName: z.string().trim().min(2).max(160), amountCents: cents }).parse(input);
  const checked = file && file.bytes.byteLength ? checkFile(file.name, file.bytes, await maxFileBytes()) : null;
  const pre = await loadExpense(getPool(), ctx, id);
  if (pre.requested_by !== ctx.principal.userId && !can(ctx.principal, 'financeiro.cadastros')) throw new ForbiddenError();
  const prepared = checked ? await prepareFile(ctx, checked, file!.bytes) : null;
  await tx(async (c) => {
    const e = await loadExpense(c, ctx, id, true);
    if (e.status !== 'SOLICITADA') throw new AppError('Cotações só podem ser incluídas enquanto a solicitação está pendente.');
    const fileId = prepared ? await insertStoredFile(c, ctx, prepared) : null;
    await query(c, 'INSERT INTO expense_quotes (expense_id, supplier_name, amount, file_id, created_by) VALUES ($1,$2,$3,$4,$5)', [id, d.supplierName, centsToDb(d.amountCents), fileId, ctx.principal.userId]);
    await event(c, ctx, id, 'COTACAO', { fornecedor: d.supplierName, valor: d.amountCents });
  }).catch(async (err) => { await discardUnsaved(prepared); throw err; });
}

/** Escolhe a cotação vencedora; o valor da solicitação passa a ser o da cotação escolhida. */
export async function chooseQuote(ctx: Ctx, quoteId: string, reason?: string): Promise<void> {
  z.uuid().parse(quoteId);
  await tx(async (c) => {
    const q = await queryOne<{ expense_id: string; amount: string; supplier_name: string }>(c, 'SELECT expense_id, amount::text, supplier_name FROM expense_quotes WHERE id = $1', [quoteId]);
    if (!q) throw new NotFoundError('Cotação não encontrada.');
    const e = await loadExpense(c, ctx, q.expense_id, true);
    if (e.requested_by !== ctx.principal.userId && !can(ctx.principal, 'financeiro.cadastros')) throw new ForbiddenError();
    if (e.status !== 'SOLICITADA') throw new AppError('Solicitação já decidida.');
    const lowest = (await queryOne<{ m: string }>(c, 'SELECT min(amount)::text AS m FROM expense_quotes WHERE expense_id = $1', [q.expense_id]))!.m;
    if (toCents(q.amount) > toCents(lowest) && (!reason || reason.trim().length < 5)) throw new AppError('A cotação escolhida não é a de menor valor: justifique a escolha.');
    await query(c, 'UPDATE expense_quotes SET chosen = false WHERE expense_id = $1', [q.expense_id]);
    await query(c, 'UPDATE expense_quotes SET chosen = true WHERE id = $1', [quoteId]);
    await query(c, 'UPDATE expenses SET amount = $2, updated_at = now() WHERE id = $1', [q.expense_id, q.amount]);
    await event(c, ctx, q.expense_id, 'COTACAO_ESCOLHIDA', { fornecedor: q.supplier_name, valor: q.amount, justificativa: reason?.trim() || undefined });
  });
}

export async function addFinanceAttachment(ctx: Ctx, target: { expenseId?: string; contractId?: string }, kind: string, file: { name: string; bytes: Uint8Array }): Promise<void> {
  const k = z.enum(['NOTA_FISCAL', 'COMPROVANTE', 'CONTRATO', 'ORCAMENTO', 'OUTRO']).parse(kind);
  const checked = checkFile(file.name, file.bytes, await maxFileBytes());
  if (target.contractId) requirePermission(ctx, 'financeiro.cadastros');
  else {
    const e = await loadExpense(getPool(), ctx, target.expenseId!);
    const allowed = e.requested_by === ctx.principal.userId || can(ctx.principal, 'financeiro.pagar') || can(ctx.principal, 'financeiro.cadastros') || can(ctx.principal, 'financeiro.aprovar');
    if (!allowed) throw new ForbiddenError();
    if (e.status === 'REJEITADA' || e.status === 'CANCELADA') throw new AppError('Despesa encerrada.');
    if (k === 'COMPROVANTE' && e.status !== 'APROVADA' && e.status !== 'PAGA') throw new AppError('Comprovante só após a aprovação.');
  }
  const prepared = await prepareFile(ctx, checked, file.bytes);
  await tx(async (c) => {
    const fileId = await insertStoredFile(c, ctx, prepared);
    await query(c, 'INSERT INTO finance_attachments (expense_id, contract_id, kind, file_id, added_by) VALUES ($1,$2,$3,$4,$5)',
      [target.expenseId ?? null, target.contractId ?? null, k, fileId, ctx.principal.userId]);
    if (target.expenseId) await event(c, ctx, target.expenseId, 'ANEXO', { tipo: k, nome: checked.filename, antivirus: prepared.scan.status });
  }).catch(async (err) => { await discardUnsaved(prepared); throw err; });
}

export async function financeFileForDownload(ctx: Ctx, attachmentOrQuoteFileId: string) {
  const db = getPool();
  z.uuid().parse(attachmentOrQuoteFileId);
  const link = await queryOne<{ expense_id: string | null; contract_id: string | null }>(db,
    `SELECT expense_id, contract_id FROM finance_attachments WHERE file_id = $1
     UNION ALL SELECT expense_id, NULL FROM expense_quotes WHERE file_id = $1 LIMIT 1`, [attachmentOrQuoteFileId]);
  if (!link) throw new NotFoundError('Arquivo não encontrado.');
  if (link.expense_id) await loadExpense(db, ctx, link.expense_id);
  else {
    const k = await queryOne<{ cost_center_id: string }>(db, 'SELECT cost_center_id FROM contracts WHERE id = $1', [link.contract_id]);
    const ccs = await visibleCostCenters(db, ctx.principal);
    requireAnyFinance(ctx.principal);
    if (ccs !== null && !ccs.includes(k!.cost_center_id)) throw new NotFoundError('Arquivo não encontrado.');
  }
  const f = (await loadStoredFile(db, attachmentOrQuoteFileId))!;
  const bytes = await readStoredFile(f);
  if (!bytes) throw new AppError('Conteúdo descartado.', 410, 'DESCARTADO');
  await rescan(ctx, f, bytes, 'download', false);
  await audit(db, ctx, { action: 'FIN_ANEXO_DOWNLOAD', entityType: 'document_file', entityId: f.id, summary: `Download de "${f.filename}"` });
  return { filename: f.filename, mime_type: f.mime_type, sha256: f.sha256, data: Buffer.from(bytes) };
}

// Consultas -----------------------------------------------------------------

export type ExpenseFilter = { status?: string; month?: string; costCenterId?: string; mine?: boolean; dueUntil?: string; q?: string };

export async function listExpenses(ctx: Ctx, f: ExpenseFilter = {}) {
  requireAnyFinance(ctx.principal);
  const db = getPool();
  const ccs = await visibleCostCenters(db, ctx.principal);
  const params: unknown[] = [ccs, ctx.principal.userId];
  const where = ['($1::uuid[] IS NULL OR e.cost_center_id = ANY($1::uuid[]) OR e.requested_by = $2)'];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (f.mine) where.push('e.requested_by = $2');
  if (f.status === 'ABERTAS') where.push("e.status IN ('SOLICITADA','APROVADA')");
  else if (f.status && f.status !== 'TODAS') add('e.status = ?', f.status);
  if (f.month && /^\d{4}-\d{2}$/.test(f.month)) add('e.competence = ?::date', competenceDate(f.month));
  if (f.costCenterId && z.uuid().safeParse(f.costCenterId).success) add('e.cost_center_id = ?', f.costCenterId);
  if (f.dueUntil) add('e.due_date <= ?', z.iso.date().parse(f.dueUntil));
  if (f.q?.trim()) add("(e.description ILIKE ? OR coalesce(s.name,'') ILIKE ?)", `%${f.q.trim().slice(0, 100).replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  return query<ExpenseRow>(db, `${EXPENSE_SELECT} WHERE ${where.join(' AND ')} ORDER BY CASE e.status WHEN 'SOLICITADA' THEN 0 WHEN 'APROVADA' THEN 1 ELSE 2 END, e.due_date LIMIT 1000`, params);
}

export async function getExpense(ctx: Ctx, id: string) {
  requireAnyFinance(ctx.principal);
  const db = getPool();
  const e = await loadExpense(db, ctx, id);
  const [quotes, attachments, events] = await Promise.all([
    query<{ id: string; supplier_name: string; amount: string; file_id: string | null; chosen: boolean; created_at: Date }>(db,
      'SELECT id, supplier_name, amount::text, file_id, chosen, created_at FROM expense_quotes WHERE expense_id = $1 ORDER BY amount', [id]),
    query<{ id: string; kind: string; file_id: string; filename: string; scan_status: string; added_at: Date; added_by_name: string }>(db,
      `SELECT a.id, a.kind, a.file_id, f.filename, f.scan_status, a.added_at, u.display_name AS added_by_name
         FROM finance_attachments a JOIN document_files f ON f.id = a.file_id JOIN users u ON u.id = a.added_by WHERE a.expense_id = $1 ORDER BY a.added_at`, [id]),
    query<{ id: string; event: string; details: Record<string, unknown>; created_at: Date; user_name: string | null }>(db,
      'SELECT e.id, e.event, e.details, e.created_at, u.display_name AS user_name FROM expense_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.expense_id = $1 ORDER BY e.created_at DESC', [id]),
  ]);
  const p = ctx.principal;
  return {
    expense: e, quotes, attachments, events,
    can: {
      decide: e.status === 'SOLICITADA' && can(p, 'financeiro.aprovar') && e.requested_by !== p.userId,
      pay: e.status === 'APROVADA' && can(p, 'financeiro.pagar') && e.requested_by !== p.userId && e.decided_by !== p.userId,
      edit: e.status === 'SOLICITADA' && e.requested_by === p.userId,
      quote: e.status === 'SOLICITADA' && (e.requested_by === p.userId || can(p, 'financeiro.cadastros')),
      attach: (e.status === 'SOLICITADA' || e.status === 'APROVADA' || e.status === 'PAGA') && (e.requested_by === p.userId || can(p, 'financeiro.pagar') || can(p, 'financeiro.cadastros') || can(p, 'financeiro.aprovar')),
      cancel: (e.status === 'SOLICITADA' && e.requested_by === p.userId) || ((e.status === 'SOLICITADA' || e.status === 'APROVADA') && (can(p, 'financeiro.aprovar') || can(p, 'financeiro.cadastros'))),
    },
  };
}

// Receitas -----------------------------------------------------------------

export async function addRevenue(ctx: Ctx, input: { competence: string; receivedOn: string; categoryId: string; description: string; amountCents: number }): Promise<string> {
  requirePermission(ctx, 'financeiro.receitas');
  const d = z.object({ competence: z.string().regex(/^\d{4}-\d{2}$/), receivedOn: z.iso.date(), categoryId: z.uuid(), description: z.string().trim().min(3).max(300), amountCents: cents }).parse(input);
  if (d.receivedOn > todayLocal()) throw new AppError('Recebimento não pode ter data futura.');
  return tx(async (c) => {
    const cat = await queryOne<{ kind: string }>(c, 'SELECT kind FROM finance_categories WHERE id = $1 AND active', [d.categoryId]);
    if (cat?.kind !== 'RECEITA') throw new AppError('Escolha uma categoria de receita.');
    const r = await queryOne<{ id: string }>(c, 'INSERT INTO revenue_entries (competence, received_on, category_id, description, amount, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [competenceDate(d.competence), d.receivedOn, d.categoryId, d.description, centsToDb(d.amountCents), ctx.principal.userId]);
    await audit(c, ctx, { action: 'FIN_RECEITA', entityType: 'revenue', entityId: r!.id, summary: `Receita gerencial: ${d.description} (${centsToDb(d.amountCents)})` });
    return r!.id;
  });
}

/** Estorno: novo lançamento vinculado que anula o original (o original permanece). */
export async function reverseRevenue(ctx: Ctx, id: string, reason: string): Promise<void> {
  requirePermission(ctx, 'financeiro.receitas');
  if (reason.trim().length < 3) throw new AppError('Informe o motivo do estorno.');
  await tx(async (c) => {
    const r = await queryOne<{ competence: string; category_id: string; description: string; amount: string; reverses_id: string | null }>(c,
      'SELECT competence, category_id, description, amount::text, reverses_id FROM revenue_entries WHERE id = $1', [id]);
    if (!r) throw new NotFoundError('Lançamento não encontrado.');
    if (r.reverses_id) throw new AppError('Um estorno não pode ser estornado.');
    await query(c, 'INSERT INTO revenue_entries (competence, received_on, category_id, description, amount, created_by, reverses_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [r.competence, todayLocal(), r.category_id, `Estorno: ${r.description} — ${reason.trim()}`, r.amount, ctx.principal.userId, id])
      .catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('Lançamento já estornado.'); throw e; });
    await audit(c, ctx, { action: 'FIN_RECEITA_ESTORNO', entityType: 'revenue', entityId: id, summary: `Estorno de receita (${r.amount}): ${reason.trim()}` });
  });
}

export async function listRevenues(ctx: Ctx, month?: string) {
  if (!can(ctx.principal, 'financeiro.receitas') && !(scopeFilter(ctx.principal, 'financeiro.ver')?.all)) throw new ForbiddenError();
  return query<{ id: string; competence: string; received_on: string; category: string; description: string; amount: string; reverses_id: string | null; reversed: boolean; created_by_name: string }>(
    getPool(),
    `SELECT r.id, r.competence, r.received_on, c.name AS category, r.description, r.amount::text, r.reverses_id,
            EXISTS (SELECT 1 FROM revenue_entries x WHERE x.reverses_id = r.id) AS reversed, u.display_name AS created_by_name
       FROM revenue_entries r JOIN finance_categories c ON c.id = r.category_id JOIN users u ON u.id = r.created_by
      WHERE ($1::date IS NULL OR r.competence = $1) ORDER BY r.received_on DESC, r.created_at DESC LIMIT 500`,
    [month && /^\d{4}-\d{2}$/.test(month) ? competenceDate(month) : null]);
}

// Relatórios -----------------------------------------------------------------

/**
 * Visão gerencial do período: fluxo de caixa, previsto × realizado, despesas por categoria/centro/setor,
 * projeção dos próximos 6 meses, alertas de contrato e custo de pessoal (somente para quem vê salários).
 */
export async function financeOverview(ctx: Ctx, fromMonth: string, toMonth: string) {
  requireAnyFinance(ctx.principal);
  const db = getPool();
  const ccs = await visibleCostCenters(db, ctx.principal);
  const full = ccs === null;
  const from = competenceDate(fromMonth);
  const toLast = addDays(addMonths(competenceDate(toMonth), 1), -1);
  const months = monthsBetween(from, toMonth);
  const exp = await query<{ id: string; cost_center_id: string; category_id: string; category: string; kind: string; sector: string; cost_center: string; amount: string; status: string;
    competence: string; due_date: string; paid_on: string | null; paid_amount: string | null; contract_id: string | null }>(db,
    `SELECT e.id, e.cost_center_id, e.category_id, fc.name AS category, fc.kind, s.name AS sector, cc.code AS cost_center, e.amount::text, e.status, e.competence, e.due_date,
            p.paid_on, p.amount::text AS paid_amount, e.contract_id
       FROM expenses e JOIN cost_centers cc ON cc.id = e.cost_center_id JOIN sectors s ON s.id = cc.sector_id JOIN finance_categories fc ON fc.id = e.category_id
       LEFT JOIN expense_payments p ON p.expense_id = e.id
      WHERE e.status IN ('SOLICITADA','APROVADA','PAGA') AND ($1::uuid[] IS NULL OR e.cost_center_id = ANY($1::uuid[]))
        AND (e.competence BETWEEN $2 AND $3 OR p.paid_on BETWEEN $2 AND $3 OR (e.status <> 'PAGA' AND e.due_date <= $4))`,
    [ccs, from, toLast, addMonths(toLast, 6)]);
  const inPeriod = exp.filter((e) => e.competence >= from && e.competence <= toLast);
  const budget = await query<{ cost_center_id: string; category_id: string; year: number; month: number; amount: string }>(db,
    `SELECT cost_center_id, category_id, year, month, amount::text FROM budget_lines
      WHERE make_date(year, month, 1) BETWEEN $1 AND $2 AND ($3::uuid[] IS NULL OR cost_center_id = ANY($3::uuid[]))`, [from, addMonths(toLast, 6), ccs]);
  const bmonth = (b: { year: number; month: number }) => `${b.year}-${String(b.month).padStart(2, '0')}`;
  const revenues = full
    ? await query<{ received_on: string; amount: string; reverses_id: string | null }>(db, 'SELECT received_on, amount::text, reverses_id FROM revenue_entries WHERE received_on BETWEEN $1 AND $2', [from, toLast])
    : [];
  const flow = cashFlow(months,
    revenues.map((r) => ({ received_on: r.received_on, cents: r.reverses_id ? -toCents(r.amount) : toCents(r.amount) })),
    exp.filter((e) => e.paid_on).map((e) => ({ paid_on: e.paid_on!, cents: toCents(e.paid_amount) })),
    exp.filter((e) => e.status !== 'PAGA').map((e) => ({ due_date: e.due_date, cents: toCents(e.amount) })));
  const bva = budgetVsActual(
    budget.filter((b) => bmonth(b) >= months[0]! && bmonth(b) <= months.at(-1)!).map((b) => ({ cost_center_id: b.cost_center_id, category_id: b.category_id, cents: toCents(b.amount) })),
    inPeriod.map((e) => ({ cost_center_id: e.cost_center_id, category_id: e.category_id, cents: toCents(e.amount), status: e.status })));
  const sumBy = (keyOf: (e: (typeof inPeriod)[number]) => string) => {
    const m = new Map<string, { paid: number; committed: number; requested: number }>();
    for (const e of inPeriod) {
      const k = keyOf(e);
      const r = m.get(k) ?? { paid: 0, committed: 0, requested: 0 };
      if (e.status === 'PAGA') r.paid += toCents(e.amount); else if (e.status === 'APROVADA') r.committed += toCents(e.amount); else r.requested += toCents(e.amount);
      m.set(k, r);
    }
    return [...m.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.paid + b.committed - (a.paid + a.committed));
  };
  const nextMonths = monthsBetween(addMonths(competenceDate(todayLocal()), 1), addMonths(competenceDate(todayLocal()), 6));
  const contracts = await query<{ id: string; start_date: string; end_date: string | null; monthly_amount: string }>(db,
    `SELECT id, start_date, end_date, monthly_amount::text FROM contracts WHERE status = 'VIGENTE' AND monthly_amount IS NOT NULL AND ($1::uuid[] IS NULL OR cost_center_id = ANY($1::uuid[]))`, [ccs]);
  const projection = projectOutflows(nextMonths,
    budget.map((b) => ({ month: bmonth(b), cents: toCents(b.amount) })),
    contracts.map((k) => ({ id: k.id, start_date: k.start_date, end_date: k.end_date, monthly_cents: toCents(k.monthly_amount) })),
    exp.filter((e) => e.status !== 'PAGA').map((e) => ({ month: e.competence.slice(0, 7), cents: toCents(e.amount), contract_id: e.contract_id })));
  let personnel: { sector: string; employees: number; monthly: number }[] | null = null;
  if (ctx.principal.isOwner || can(ctx.principal, 'pessoas.salario.ver')) {
    const rows = await query<{ sector: string; employees: number; monthly: string }>(db,
      `SELECT s.name AS sector, count(*)::int AS employees, coalesce(sum(sh.monthly_amount), 0)::text AS monthly
         FROM employees e JOIN sectors s ON s.id = e.sector_id
         LEFT JOIN LATERAL (SELECT monthly_amount FROM salary_history h WHERE h.employee_id = e.id AND h.effective_date <= current_date ORDER BY effective_date DESC LIMIT 1) sh ON TRUE
        WHERE e.status <> 'DESLIGADO' GROUP BY s.name ORDER BY s.name`);
    personnel = rows.map((r) => ({ sector: r.sector, employees: r.employees, monthly: toCents(r.monthly) }));
    await audit(db, ctx, { action: 'FIN_CUSTO_PESSOAL_VISTO', entityType: 'relatorio', entityId: null, summary: 'Custo de pessoal por setor exibido no financeiro' });
  }
  const today = todayLocal();
  const days = await getNumberSetting(db, 'financeiro.aviso_vencimento_dias', 5);
  return {
    full, months, flow, budgetVsActual: bva, byCategory: sumBy((e) => e.category), byCostCenter: sumBy((e) => e.cost_center), bySector: sumBy((e) => e.sector),
    totals: {
      paid: inPeriod.filter((e) => e.status === 'PAGA').reduce((a, e) => a + toCents(e.amount), 0),
      committed: inPeriod.filter((e) => e.status === 'APROVADA').reduce((a, e) => a + toCents(e.amount), 0),
      requested: inPeriod.filter((e) => e.status === 'SOLICITADA').reduce((a, e) => a + toCents(e.amount), 0),
      budget: bva.reduce((a, r) => a + r.budget, 0),
      overdue: exp.filter((e) => e.status === 'APROVADA' && e.due_date < today).length,
      dueSoon: exp.filter((e) => e.status === 'APROVADA' && e.due_date >= today && e.due_date <= addDays(today, days)).length,
    },
    projection, personnel,
  };
}

/** Rotina: avisa quem paga sobre despesas aprovadas a vencer (uma vez por vencimento). */
export async function processFinanceReminders(db: Db = getPool()): Promise<number> {
  const days = await getNumberSetting(db, 'financeiro.aviso_vencimento_dias', 5);
  const rows = await query<{ id: string; description: string; due_date: string; sector_id: string; requested_by: string; decided_by: string }>(db,
    `SELECT e.id, e.description, e.due_date, cc.sector_id, e.requested_by, e.decided_by FROM expenses e JOIN cost_centers cc ON cc.id = e.cost_center_id
      WHERE e.status = 'APROVADA' AND e.due_date <= $1
        AND NOT EXISTS (SELECT 1 FROM expense_events x WHERE x.expense_id = e.id AND x.event = 'AVISO_VENCIMENTO' AND x.details->>'vencimento' = e.due_date::text)`,
    [addDays(todayLocal(), days)]);
  for (const r of rows) {
    await tx(async (c) => {
      await query(c, "INSERT INTO expense_events (expense_id, user_id, event, details) VALUES ($1, NULL, 'AVISO_VENCIMENTO', $2)", [r.id, JSON.stringify({ vencimento: r.due_date })]);
      const payers = (await usersWithPermission(c, 'financeiro.pagar', r.sector_id)).filter((u) => u !== r.requested_by && u !== r.decided_by);
      const late = r.due_date < todayLocal();
      await notifyUsers(c, payers, { kind: 'FIN_VENCIMENTO', title: late ? 'Conta vencida' : 'Conta a vencer', body: `${r.description} — ${r.due_date}`, link: `/financeiro/despesas/${r.id}`, priority: late ? 'ALTA' : 'NORMAL' });
    });
  }
  return rows.length;
}
