import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx } from '../context.ts';
import { can, requirePermission, requireStepUp } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors.ts';

// Modelos de checklist versionados: edição somente em RASCUNHO; a publicação (permissão própria + reautenticação)
// substitui a versão anterior da mesma família. Checklists já iniciados guardam a cópia da versão usada.

export const AUTO_CODES = {
  JORNADA: 'Jornada contratual definida',
  ACORDO_BANCO: 'Acordo de banco de horas cadastrado',
  ACESSO: 'Autenticador do funcionário ativo',
  ACESSO_REVOGADO: 'Acessos ao sistema revogados',
  ITENS_DEVOLVIDOS: 'Todos os itens entregues devolvidos',
} as const;

export type TemplateRow = {
  id: string; family_id: string; kind: string; name: string; version: number; status: string;
  published_at: Date | null; published_by_name: string | null; items: number; in_use: number;
};

export async function listTemplates(ctx: Ctx): Promise<TemplateRow[]> {
  if (!can(ctx.principal, 'checklists.modelos.editar') && !can(ctx.principal, 'checklists.modelos.publicar')) throw new ForbiddenError();
  return query<TemplateRow>(
    getPool(),
    `SELECT t.id, t.family_id, t.kind, t.name, t.version, t.status, t.published_at, u.display_name AS published_by_name,
            (SELECT count(*)::int FROM checklist_template_items i WHERE i.template_id = t.id) AS items,
            (SELECT count(*)::int FROM checklists c WHERE c.template_id = t.id) AS in_use
       FROM checklist_templates t LEFT JOIN users u ON u.id = t.published_by
      ORDER BY t.kind, t.name, t.version DESC`,
  );
}

export type TemplateItem = {
  id: string; position: number; title: string; description: string | null; due_offset_days: number; auto_code: string | null;
  required: boolean; evidence_required: boolean; responsible_role_id: string | null; responsible_role_name: string | null;
};

export async function getTemplate(ctx: Ctx, id: string) {
  if (!can(ctx.principal, 'checklists.modelos.editar') && !can(ctx.principal, 'checklists.modelos.publicar')) throw new ForbiddenError();
  z.uuid().parse(id);
  const db = getPool();
  const t = await queryOne<Omit<TemplateRow, 'items' | 'in_use' | 'published_by_name'>>(db, 'SELECT id, family_id, kind, name, version, status, published_at FROM checklist_templates WHERE id = $1', [id]);
  if (!t) throw new NotFoundError('Modelo não encontrado.');
  const items = await query<TemplateItem>(
    db,
    `SELECT i.id, i.position, i.title, i.description, i.due_offset_days, i.auto_code, i.required, i.evidence_required, i.responsible_role_id,
            r.name AS responsible_role_name
       FROM checklist_template_items i LEFT JOIN roles r ON r.id = i.responsible_role_id WHERE i.template_id = $1 ORDER BY i.position`,
    [id],
  );
  return { template: t, items };
}

async function loadDraft(c: Db, id: string): Promise<{ id: string; name: string; family_id: string }> {
  const t = await queryOne<{ id: string; name: string; family_id: string; status: string }>(c, 'SELECT id, name, family_id, status FROM checklist_templates WHERE id = $1 FOR UPDATE', [id]);
  if (!t) throw new NotFoundError('Modelo não encontrado.');
  if (t.status !== 'RASCUNHO') throw new AppError('Somente rascunhos podem ser editados. Crie uma nova versão.');
  return t;
}

const createSchema = z.object({ kind: z.enum(['ADMISSAO', 'DESLIGAMENTO', 'OUTRO']), name: z.string().trim().min(3).max(120) });

export async function createTemplate(ctx: Ctx, input: z.input<typeof createSchema>): Promise<string> {
  requirePermission(ctx, 'checklists.modelos.editar');
  const d = createSchema.parse(input);
  return tx(async (c) => {
    const id = (await queryOne<{ id: string }>(c, `INSERT INTO checklist_templates (kind, name, status, family_id, version, created_by)
      VALUES ($1,$2,'RASCUNHO',gen_random_uuid(),1,$3) RETURNING id`, [d.kind, d.name, ctx.principal.userId]))!.id;
    await query(c, 'UPDATE checklist_templates SET family_id = id WHERE id = $1', [id]);
    await audit(c, ctx, { action: 'CHECKLIST_MODELO_CRIADO', entityType: 'checklist_template', entityId: id, summary: `Modelo "${d.name}" criado (rascunho)` });
    return id;
  });
}

async function copyItems(c: Db, fromId: string, toId: string): Promise<void> {
  await query(
    c,
    `INSERT INTO checklist_template_items (template_id, position, title, description, due_offset_days, auto_code, required, evidence_required, responsible_role_id)
     SELECT $2, position, title, description, due_offset_days, auto_code, required, evidence_required, responsible_role_id
       FROM checklist_template_items WHERE template_id = $1`,
    [fromId, toId],
  );
}

/** Nova versão em rascunho a partir de uma versão existente (editar um modelo publicado). */
export async function newVersion(ctx: Ctx, templateId: string): Promise<string> {
  requirePermission(ctx, 'checklists.modelos.editar');
  z.uuid().parse(templateId);
  return tx(async (c) => {
    const t = await queryOne<{ family_id: string; kind: string; name: string }>(c, 'SELECT family_id, kind, name FROM checklist_templates WHERE id = $1', [templateId]);
    if (!t) throw new NotFoundError();
    const draft = await queryOne(c, "SELECT 1 FROM checklist_templates WHERE family_id = $1 AND status = 'RASCUNHO'", [t.family_id]);
    if (draft) throw new ConflictError('Já existe um rascunho deste modelo. Edite-o ou descarte-o.');
    const next = (await queryOne<{ v: number }>(c, 'SELECT max(version) + 1 AS v FROM checklist_templates WHERE family_id = $1', [t.family_id]))!.v;
    const id = (await queryOne<{ id: string }>(c, `INSERT INTO checklist_templates (kind, name, status, family_id, version, created_by)
      VALUES ($1,$2,'RASCUNHO',$3,$4,$5) RETURNING id`, [t.kind, t.name, t.family_id, next, ctx.principal.userId]))!.id;
    await copyItems(c, templateId, id);
    await audit(c, ctx, { action: 'CHECKLIST_MODELO_VERSAO', entityType: 'checklist_template', entityId: id, summary: `Rascunho da versão ${next} de "${t.name}"` });
    return id;
  });
}

/** Duplicar: cria uma nova família (modelo independente) a partir de uma versão. */
export async function duplicateTemplate(ctx: Ctx, templateId: string, name: string): Promise<string> {
  requirePermission(ctx, 'checklists.modelos.editar');
  z.uuid().parse(templateId);
  const n = z.string().trim().min(3).max(120).parse(name);
  return tx(async (c) => {
    const t = await queryOne<{ kind: string; name: string }>(c, 'SELECT kind, name FROM checklist_templates WHERE id = $1', [templateId]);
    if (!t) throw new NotFoundError();
    const id = (await queryOne<{ id: string }>(c, `INSERT INTO checklist_templates (kind, name, status, family_id, version, created_by)
      VALUES ($1,$2,'RASCUNHO',gen_random_uuid(),1,$3) RETURNING id`, [t.kind, n, ctx.principal.userId]))!.id;
    await query(c, 'UPDATE checklist_templates SET family_id = id WHERE id = $1', [id]);
    await copyItems(c, templateId, id);
    await audit(c, ctx, { action: 'CHECKLIST_MODELO_DUPLICADO', entityType: 'checklist_template', entityId: id, summary: `"${t.name}" duplicado como "${n}"` });
    return id;
  });
}

const itemSchema = z.object({
  templateId: z.uuid(),
  itemId: z.uuid().optional(),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(500).optional(),
  dueOffsetDays: z.number().int().min(-60).max(365),
  required: z.boolean(),
  evidenceRequired: z.boolean(),
  responsibleRoleId: z.uuid().nullable().optional(),
  autoCode: z.enum(Object.keys(AUTO_CODES) as [keyof typeof AUTO_CODES]).nullable().optional(),
});

export async function saveItem(ctx: Ctx, input: z.input<typeof itemSchema>): Promise<string> {
  requirePermission(ctx, 'checklists.modelos.editar');
  const d = itemSchema.parse(input);
  return tx(async (c) => {
    const t = await loadDraft(c, d.templateId);
    let id: string;
    if (d.itemId) {
      const r = await queryOne<{ id: string }>(
        c,
        `UPDATE checklist_template_items SET title=$3, description=$4, due_offset_days=$5, required=$6, evidence_required=$7, responsible_role_id=$8, auto_code=$9
          WHERE id = $1 AND template_id = $2 RETURNING id`,
        [d.itemId, d.templateId, d.title, d.description ?? null, d.dueOffsetDays, d.required, d.evidenceRequired, d.responsibleRoleId ?? null, d.autoCode ?? null],
      );
      if (!r) throw new NotFoundError('Item não encontrado.');
      id = r.id;
    } else {
      const pos = (await queryOne<{ p: number }>(c, 'SELECT coalesce(max(position), 0) + 1 AS p FROM checklist_template_items WHERE template_id = $1', [d.templateId]))!.p;
      id = (await queryOne<{ id: string }>(
        c,
        `INSERT INTO checklist_template_items (template_id, position, title, description, due_offset_days, required, evidence_required, responsible_role_id, auto_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [d.templateId, pos, d.title, d.description ?? null, d.dueOffsetDays, d.required, d.evidenceRequired, d.responsibleRoleId ?? null, d.autoCode ?? null],
      ))!.id;
    }
    await audit(c, ctx, { action: 'CHECKLIST_MODELO_ITEM', entityType: 'checklist_template', entityId: d.templateId, summary: `Item "${d.title}" salvo em "${t.name}"` });
    return id;
  });
}

export async function removeItem(ctx: Ctx, templateId: string, itemId: string): Promise<void> {
  requirePermission(ctx, 'checklists.modelos.editar');
  await tx(async (c) => {
    const t = await loadDraft(c, templateId);
    const r = await query(c, 'DELETE FROM checklist_template_items WHERE id = $1 AND template_id = $2 RETURNING title', [itemId, templateId]);
    if (!r.length) throw new NotFoundError();
    await query(c, `UPDATE checklist_template_items i SET position = s.rn FROM
      (SELECT id, row_number() OVER (ORDER BY position) AS rn FROM checklist_template_items WHERE template_id = $1) s WHERE i.id = s.id`, [templateId]);
    await audit(c, ctx, { action: 'CHECKLIST_MODELO_ITEM_REMOVIDO', entityType: 'checklist_template', entityId: templateId, summary: `Item removido de "${t.name}"` });
  });
}

/** Ordenação: move o item uma posição para cima ou para baixo. */
export async function moveItem(ctx: Ctx, templateId: string, itemId: string, direction: 'UP' | 'DOWN'): Promise<void> {
  requirePermission(ctx, 'checklists.modelos.editar');
  await tx(async (c) => {
    await loadDraft(c, templateId);
    const it = await queryOne<{ position: number }>(c, 'SELECT position FROM checklist_template_items WHERE id = $1 AND template_id = $2', [itemId, templateId]);
    if (!it) throw new NotFoundError();
    const other = await queryOne<{ id: string; position: number }>(
      c,
      `SELECT id, position FROM checklist_template_items WHERE template_id = $1 AND position ${direction === 'UP' ? '<' : '>'} $2
        ORDER BY position ${direction === 'UP' ? 'DESC' : 'ASC'} LIMIT 1`,
      [templateId, it.position],
    );
    if (!other) return;
    await query(c, 'UPDATE checklist_template_items SET position = $2 WHERE id = $1', [itemId, other.position]);
    await query(c, 'UPDATE checklist_template_items SET position = $2 WHERE id = $1', [other.id, it.position]);
  });
}

export async function renameDraft(ctx: Ctx, templateId: string, name: string): Promise<void> {
  requirePermission(ctx, 'checklists.modelos.editar');
  const n = z.string().trim().min(3).max(120).parse(name);
  await tx(async (c) => {
    await loadDraft(c, templateId);
    await query(c, 'UPDATE checklist_templates SET name = $2 WHERE id = $1', [templateId, n]);
  });
}

export async function discardDraft(ctx: Ctx, templateId: string): Promise<void> {
  requirePermission(ctx, 'checklists.modelos.editar');
  await tx(async (c) => {
    const t = await loadDraft(c, templateId);
    await query(c, 'DELETE FROM checklist_template_items WHERE template_id = $1', [templateId]);
    await query(c, "UPDATE checklist_templates SET status = 'INATIVO' WHERE id = $1", [templateId]);
    await audit(c, ctx, { action: 'CHECKLIST_MODELO_DESCARTADO', entityType: 'checklist_template', entityId: templateId, summary: `Rascunho de "${t.name}" descartado` });
  });
}

/** Publicação: a versão anterior publicada da mesma família é inativada (checklists já criados não mudam). */
export async function publishTemplate(ctx: Ctx, templateId: string): Promise<void> {
  requirePermission(ctx, 'checklists.modelos.publicar');
  z.uuid().parse(templateId);
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    const t = await loadDraft(c, templateId);
    const n = (await queryOne<{ n: number }>(c, 'SELECT count(*)::int AS n FROM checklist_template_items WHERE template_id = $1', [templateId]))!.n;
    if (n === 0) throw new AppError('O modelo precisa ter ao menos um item.');
    await query(c, "UPDATE checklist_templates SET status = 'INATIVO' WHERE family_id = $1 AND status = 'PUBLICADO'", [t.family_id]);
    await query(c, "UPDATE checklist_templates SET status = 'PUBLICADO', published_by = $2, published_at = now() WHERE id = $1", [templateId, ctx.principal.userId]);
    await audit(c, ctx, { action: 'CHECKLIST_MODELO_PUBLICADO', entityType: 'checklist_template', entityId: templateId, summary: `Modelo "${t.name}" publicado (${n} itens)` });
  });
}

export async function inactivateTemplate(ctx: Ctx, templateId: string): Promise<void> {
  requirePermission(ctx, 'checklists.modelos.publicar');
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    const r = await query<{ name: string }>(c, "UPDATE checklist_templates SET status = 'INATIVO' WHERE id = $1 AND status = 'PUBLICADO' RETURNING name", [templateId]);
    if (!r.length) throw new AppError('Somente modelos publicados podem ser inativados.');
    await audit(c, ctx, { action: 'CHECKLIST_MODELO_INATIVADO', entityType: 'checklist_template', entityId: templateId, summary: `Modelo "${r[0]!.name}" inativado` });
  });
}

/** Nomes dos papéis (não sensíveis) para designar responsáveis por itens. */
export async function listRoleNames(): Promise<{ id: string; name: string }[]> {
  return query<{ id: string; name: string }>(getPool(), 'SELECT id, name FROM roles ORDER BY name');
}
