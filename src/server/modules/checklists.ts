import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx } from '../context.ts';
import { requirePermission } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, NotFoundError } from '../errors.ts';
import { addDays, todayLocal } from '../../domain/time.ts';
import { getEmployeeFor, findEmployee } from './people.ts';
import { storeVersion } from './documents.ts';

// Checklists de admissão e desligamento (prazos relativos ao evento) e controle de itens entregues
// (uniformes, equipamentos, crachás, chaves) com termo de entrega para ciência eletrônica.

export type ChecklistKind = 'ADMISSAO' | 'DESLIGAMENTO' | 'OUTRO';

/** Cria o checklist a partir do modelo ativo do tipo. Chamada dentro da transação do evento (admissão/desligamento). */
export async function createChecklistFromTemplate(
  c: Db, actorUserId: string, employeeId: string, kind: ChecklistKind, referenceDate: string,
): Promise<string | null> {
  const t = await queryOne<{ id: string; name: string }>(
    c, "SELECT id, name FROM checklist_templates WHERE kind = $1 AND status = 'PUBLICADO' ORDER BY published_at DESC LIMIT 1", [kind]);
  if (!t) return null;
  const cl = await queryOne<{ id: string }>(
    c,
    'INSERT INTO checklists (template_id, employee_id, kind, title, reference_date, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [t.id, employeeId, kind, t.name, referenceDate, actorUserId],
  );
  await query(
    c,
    `INSERT INTO checklist_items (checklist_id, position, title, description, due_date, auto_code, required, evidence_required, responsible_role_id)
     SELECT $1, position, title, description, $2::date + due_offset_days, auto_code, required, evidence_required, responsible_role_id
       FROM checklist_template_items WHERE template_id = $3`,
    [cl!.id, referenceDate, t.id],
  );
  await refreshAutoItems(c, cl!.id);
  return cl!.id;
}

/** Conclui automaticamente itens verificáveis pelo próprio sistema. */
export async function refreshAutoItems(c: Db, checklistId: string): Promise<void> {
  const items = await query<{ id: string; auto_code: string; employee_id: string }>(
    c,
    `SELECT i.id, i.auto_code, cl.employee_id FROM checklist_items i JOIN checklists cl ON cl.id = i.checklist_id
      WHERE i.checklist_id = $1 AND i.status = 'PENDENTE' AND i.auto_code IS NOT NULL`,
    [checklistId],
  );
  for (const it of items) {
    const e = it.employee_id;
    let done = false;
    if (it.auto_code === 'JORNADA') done = !!(await queryOne(c, 'SELECT 1 FROM employee_schedules WHERE employee_id = $1', [e]));
    else if (it.auto_code === 'ACORDO_BANCO') done = !!(await queryOne(c, 'SELECT 1 FROM hour_bank_agreements WHERE employee_id = $1 AND revoked_at IS NULL', [e]));
    else if (it.auto_code === 'ACESSO') done = !!(await queryOne(c, 'SELECT 1 FROM employees x JOIN users u ON u.id = x.user_id WHERE x.id = $1 AND u.totp_enabled_at IS NOT NULL', [e]));
    else if (it.auto_code === 'ACESSO_REVOGADO') done = !!(await queryOne(c, "SELECT 1 FROM employees x LEFT JOIN users u ON u.id = x.user_id WHERE x.id = $1 AND (u.id IS NULL OR u.status <> 'ATIVO')", [e]));
    else if (it.auto_code === 'ITENS_DEVOLVIDOS') done = !(await queryOne(c, 'SELECT 1 FROM employee_items WHERE employee_id = $1 AND returned_at IS NULL', [e]));
    if (done) {
      await query(c, "UPDATE checklist_items SET status = 'CONCLUIDO', done_at = now(), notes = 'Verificado automaticamente pelo sistema' WHERE id = $1", [it.id]);
    }
  }
  await syncChecklistStatus(c, checklistId);
}

async function syncChecklistStatus(c: Db, checklistId: string): Promise<void> {
  const pending = await queryOne(c, "SELECT 1 FROM checklist_items WHERE checklist_id = $1 AND status = 'PENDENTE'", [checklistId]);
  await query(
    c,
    `UPDATE checklists SET status = CASE WHEN $2 THEN 'ABERTO' ELSE 'CONCLUIDO' END,
            completed_at = CASE WHEN $2 THEN NULL ELSE coalesce(completed_at, now()) END WHERE id = $1`,
    [checklistId, !!pending],
  );
}

export type ChecklistView = {
  id: string; kind: ChecklistKind; title: string; reference_date: string; status: string;
  items: {
    id: string; position: number; title: string; description: string | null; due_date: string | null; status: string; done_at: Date | null;
    done_by_name: string | null; notes: string | null; overdue: boolean; required: boolean; evidence_required: boolean; evidence: string | null;
    responsible_role_name: string | null;
  }[];
  template_version: number | null;
};

export async function listChecklists(ctx: Ctx, employeeId: string): Promise<ChecklistView[]> {
  await getEmployeeFor(ctx, 'pessoas.ver', employeeId);
  const db = getPool();
  const lists = await query<{ id: string; status: string }>(db, 'SELECT id, status FROM checklists WHERE employee_id = $1', [employeeId]);
  await tx(async (c) => { for (const l of lists) if (l.status === 'ABERTO') await refreshAutoItems(c, l.id); });
  const today = todayLocal();
  const out: ChecklistView[] = [];
  for (const l of await query<Omit<ChecklistView, 'items'>>(
    db,
    `SELECT c.id, c.kind, c.title, c.reference_date, c.status, t.version AS template_version
       FROM checklists c LEFT JOIN checklist_templates t ON t.id = c.template_id WHERE c.employee_id = $1 ORDER BY c.created_at DESC`,
    [employeeId],
  )) {
    const items = await query<Omit<ChecklistView['items'][number], 'overdue'>>(
      db,
      `SELECT i.id, i.position, i.title, i.description, i.due_date, i.status, i.done_at, u.display_name AS done_by_name, i.notes,
              i.required, i.evidence_required, i.evidence, r.name AS responsible_role_name
         FROM checklist_items i LEFT JOIN users u ON u.id = i.done_by LEFT JOIN roles r ON r.id = i.responsible_role_id
        WHERE i.checklist_id = $1 ORDER BY i.position`,
      [l.id],
    );
    out.push({ ...l, items: items.map((i) => ({ ...i, overdue: i.status === 'PENDENTE' && !!i.due_date && i.due_date < today })) });
  }
  return out;
}

const itemSchema = z.object({
  itemId: z.uuid(),
  status: z.enum(['PENDENTE', 'CONCLUIDO', 'NAO_APLICAVEL']),
  notes: z.string().trim().max(500).optional(),
  evidence: z.string().trim().max(500).optional(), // descrição/localização da evidência (documento, protocolo, link)
});

export async function setChecklistItem(ctx: Ctx, input: z.input<typeof itemSchema>): Promise<void> {
  const d = itemSchema.parse(input);
  if (d.status === 'NAO_APLICAVEL' && !d.notes) throw new AppError('Justifique por que o item não se aplica.');
  await tx(async (c) => {
    const it = await queryOne<{ checklist_id: string; employee_id: string; title: string; required: boolean; evidence_required: boolean }>(
      c, 'SELECT i.checklist_id, cl.employee_id, i.title, i.required, i.evidence_required FROM checklist_items i JOIN checklists cl ON cl.id = i.checklist_id WHERE i.id = $1 FOR UPDATE OF i', [d.itemId]);
    if (!it) throw new NotFoundError();
    if (it.required && d.status === 'NAO_APLICAVEL') throw new AppError('Item obrigatório: não pode ser marcado como "não se aplica".');
    if (it.evidence_required && d.status === 'CONCLUIDO' && (!d.evidence || d.evidence.length < 3)) throw new AppError('Este item exige a indicação da evidência (documento, protocolo ou local de arquivamento).');
    const e = await findEmployee(c, it.employee_id);
    requirePermission(ctx, 'pessoas.editar', { employeeId: e.id, sectorId: e.sector_id });
    await query(
      c,
      `UPDATE checklist_items SET status = $2, notes = $3, evidence = CASE WHEN $2 = 'PENDENTE' THEN NULL ELSE $5 END,
              done_at = CASE WHEN $2 = 'PENDENTE' THEN NULL ELSE now() END,
              done_by = CASE WHEN $2 = 'PENDENTE' THEN NULL ELSE $4::uuid END WHERE id = $1`,
      [d.itemId, d.status, d.notes ?? null, ctx.principal.userId, d.evidence ?? null],
    );
    await syncChecklistStatus(c, it.checklist_id);
    await audit(c, ctx, { action: 'CHECKLIST_ITEM', entityType: 'employee', entityId: it.employee_id, summary: `Checklist de ${e.full_name}: "${it.title}" → ${d.status}`, data: { notes: d.notes ?? null } });
  });
}

// ---------------------------------------------------------------------------
// Itens entregues (uniformes, equipamentos) com termo de entrega
// ---------------------------------------------------------------------------
export async function listEmployeeItems(ctx: Ctx, employeeId: string) {
  await getEmployeeFor(ctx, 'pessoas.ver', employeeId);
  return query<{ id: string; kind: string; description: string; quantity: number; delivered_at: string; returned_at: string | null; notes: string | null }>(
    getPool(), 'SELECT id, kind, description, quantity, delivered_at, returned_at, notes FROM employee_items WHERE employee_id = $1 ORDER BY returned_at NULLS FIRST, delivered_at DESC', [employeeId]);
}

const deliverSchema = z.object({
  kind: z.enum(['UNIFORME', 'EQUIPAMENTO', 'CRACHA', 'CHAVE', 'OUTRO']),
  description: z.string().trim().min(2).max(200),
  quantity: z.number().int().min(1).max(100),
  deliveredAt: z.iso.date(),
  notes: z.string().trim().max(300).optional(),
});

/** Registra a entrega e gera o termo de entrega para ciência eletrônica do funcionário. */
export async function deliverItem(ctx: Ctx, employeeId: string, input: z.input<typeof deliverSchema>): Promise<{ itemId: string; termVersionId: string }> {
  const d = deliverSchema.parse(input);
  const e = await getEmployeeFor(ctx, 'pessoas.editar', employeeId);
  if (e.status === 'DESLIGADO') throw new AppError('Funcionário desligado.');
  if (d.deliveredAt > todayLocal()) throw new AppError('A data de entrega não pode ser futura.');
  return tx(async (c) => {
    const item = await queryOne<{ id: string }>(
      c,
      'INSERT INTO employee_items (employee_id, kind, description, quantity, delivered_at, delivered_by, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [employeeId, d.kind, d.description, d.quantity, d.deliveredAt, ctx.principal.userId, d.notes ?? null],
    );
    const content = {
      tipo: 'TERMO_ENTREGA', layout: 1,
      funcionario: { nome: e.social_name || e.full_name, matricula: e.registration_code, cargo: e.job_title, setor: e.sector_name },
      item: { tipo: d.kind, descricao: d.description, quantidade: d.quantity, dataEntrega: d.deliveredAt, observacao: d.notes ?? null },
      declaracao: 'Declaro ter recebido o(s) item(ns) acima, em condições de uso, comprometendo-me a zelar por sua conservação e a devolvê-lo(s) quando solicitado ou no desligamento.',
    };
    const termVersionId = await storeVersion(c, ctx, {
      kind: 'TERMO_ENTREGA', refKey: `item:${item!.id}`, title: `Termo de entrega — ${d.description}`, employeeId, sectorId: e.sector_id, ownerName: e.full_name, content,
    });
    await audit(c, ctx, { action: 'ITEM_ENTREGUE', entityType: 'employee', entityId: employeeId, summary: `Entrega a ${e.full_name}: ${d.quantity}× ${d.description}` });
    return { itemId: item!.id, termVersionId };
  });
}

export async function returnItem(ctx: Ctx, itemId: string, returnedAt: string, notes?: string): Promise<void> {
  z.uuid().parse(itemId);
  z.iso.date().parse(returnedAt);
  await tx(async (c) => {
    const it = await queryOne<{ employee_id: string; delivered_at: string; returned_at: string | null; description: string }>(
      c, 'SELECT employee_id, delivered_at, returned_at, description FROM employee_items WHERE id = $1 FOR UPDATE', [itemId]);
    if (!it) throw new NotFoundError();
    const e = await findEmployee(c, it.employee_id);
    requirePermission(ctx, 'pessoas.editar', { employeeId: e.id, sectorId: e.sector_id });
    if (it.returned_at) throw new AppError('Item já devolvido.');
    if (returnedAt < it.delivered_at || returnedAt > addDays(todayLocal(), 0)) throw new AppError('Data de devolução inválida.');
    await query(c, 'UPDATE employee_items SET returned_at = $2, returned_by = $3, notes = coalesce($4, notes) WHERE id = $1', [itemId, returnedAt, ctx.principal.userId, notes ?? null]);
    await audit(c, ctx, { action: 'ITEM_DEVOLVIDO', entityType: 'employee', entityId: e.id, summary: `Devolução de ${it.description} por ${e.full_name}` });
    const open = await query<{ id: string }>(c, "SELECT id FROM checklists WHERE employee_id = $1 AND status = 'ABERTO'", [e.id]);
    for (const cl of open) await refreshAutoItems(c, cl.id);
  });
}
