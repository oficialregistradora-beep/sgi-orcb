import { z } from 'zod';
import { getPool, query, queryOne, tx } from '../db.ts';
import type { Ctx } from '../context.ts';
import { can, requirePermission } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ForbiddenError, NotFoundError } from '../errors.ts';
import { scanBytes } from '../antivirus.ts';
import { safeFilename } from '../files.ts';
import { centsToDb } from '../../domain/money.ts';
import { cellTexts, readZip } from '../xlsx.ts';
import { findDataSheet } from './asgard.ts';

// Despesas fixas mensais sem contrato (assinaturas, tributos, folha, benefícios…). Cada item gera, ao "Lançar
// despesas fixas do mês", uma solicitação de despesa para aprovação. Valores variáveis (energia, encargos) são
// estimativas: conferir e ajustar na solicitação antes de aprovar.

export type RecurringRow = {
  id: string; description: string; supplier_id: string | null; supplier_name: string | null; cost_center_id: string; cost_center: string;
  category_id: string; category: string; amount: string | null; due_day: number; asgard_type: string | null; notes: string | null; active: boolean; generated: number;
};

function requireView(ctx: Ctx): void {
  if (!ctx.principal.isOwner && !can(ctx.principal, 'financeiro.cadastros') && !can(ctx.principal, 'financeiro.aprovar')) throw new ForbiddenError();
}

export async function listRecurring(ctx: Ctx): Promise<RecurringRow[]> {
  requireView(ctx);
  return query<RecurringRow>(getPool(),
    `SELECT r.id, r.description, r.supplier_id, s.name AS supplier_name, r.cost_center_id, cc.code || ' — ' || cc.name AS cost_center,
            r.category_id, fc.name AS category, r.amount::text, r.due_day, r.asgard_type, r.notes, r.active,
            (SELECT count(*)::int FROM expenses e WHERE e.recurring_id = r.id) AS generated
       FROM recurring_expenses r JOIN cost_centers cc ON cc.id = r.cost_center_id JOIN finance_categories fc ON fc.id = r.category_id
       LEFT JOIN suppliers s ON s.id = r.supplier_id
      ORDER BY r.active DESC, r.due_day, r.description`);
}

const saveSchema = z.object({
  id: z.uuid().optional(),
  description: z.string().trim().min(3).max(200),
  supplierId: z.uuid().nullable().optional(),
  costCenterId: z.uuid(),
  categoryId: z.uuid(),
  amountCents: z.number().int().positive().max(99_999_999_999_99).nullable(),
  dueDay: z.number().int().min(1).max(31),
  asgardType: z.string().max(200).nullable().optional(),
  notes: z.string().trim().max(500).optional(),
  active: z.boolean().default(true),
});

export async function saveRecurring(ctx: Ctx, input: z.input<typeof saveSchema>): Promise<string> {
  requirePermission(ctx, 'financeiro.cadastros');
  const d = saveSchema.parse(input);
  return tx(async (c) => {
    const params = [d.description, d.supplierId ?? null, d.costCenterId, d.categoryId, d.amountCents != null ? centsToDb(d.amountCents) : null,
      d.dueDay, d.asgardType || null, d.notes || null, d.active, ctx.principal.userId];
    let id = d.id;
    if (id) {
      const r = await queryOne<{ id: string }>(c, `UPDATE recurring_expenses SET description=$1, supplier_id=$2, cost_center_id=$3, category_id=$4, amount=$5, due_day=$6,
          asgard_type=$7, notes=$8, active=$9, updated_by=$10, updated_at=now() WHERE id=$11 RETURNING id`, [...params, id]);
      if (!r) throw new NotFoundError('Despesa fixa não encontrada.');
    } else {
      id = (await queryOne<{ id: string }>(c, `INSERT INTO recurring_expenses (description, supplier_id, cost_center_id, category_id, amount, due_day, asgard_type, notes, active, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, params))!.id;
    }
    await audit(c, ctx, { action: d.id ? 'FIN_FIXA_ALTERADA' : 'FIN_FIXA_CRIADA', entityType: 'recurring_expense', entityId: id,
      summary: `Despesa fixa mensal ${d.description}: ${d.amountCents != null ? (d.amountCents / 100).toFixed(2) : 'valor a informar'}, dia ${d.dueDay}${d.active ? '' : ' (inativa)'}` });
    return id;
  });
}

/** Exclui (se nunca gerou lançamento) ou desativa (mantém o histórico dos lançamentos já gerados). */
export async function removeRecurring(ctx: Ctx, id: string): Promise<'EXCLUIDA' | 'DESATIVADA'> {
  requirePermission(ctx, 'financeiro.cadastros');
  z.uuid().parse(id);
  return tx(async (c) => {
    const r = await queryOne<{ description: string; generated: number }>(c,
      'SELECT description, (SELECT count(*)::int FROM expenses e WHERE e.recurring_id = r.id) AS generated FROM recurring_expenses r WHERE id = $1 FOR UPDATE', [id]);
    if (!r) throw new NotFoundError('Despesa fixa não encontrada.');
    const result = r.generated ? 'DESATIVADA' : 'EXCLUIDA';
    if (result === 'EXCLUIDA') await query(c, 'DELETE FROM recurring_expenses WHERE id = $1', [id]);
    else await query(c, 'UPDATE recurring_expenses SET active = false, updated_by = $2, updated_at = now() WHERE id = $1', [id, ctx.principal.userId]);
    await audit(c, ctx, { action: 'FIN_FIXA_REMOVIDA', entityType: 'recurring_expense', entityId: id, summary: `Despesa fixa mensal ${r.description} ${result === 'EXCLUIDA' ? 'excluída' : 'desativada (já tinha lançamentos)'}` });
    return result;
  });
}

// Categoria sugerida a partir do tipo do Asgard e da descrição (regras genéricas; ajustável depois item a item).
const RULES: [RegExp, string][] = [
  [/sal[aá]rio|bonifica|f[ée]rias|13[ºo°]? sal|rescis|fgts|inss|gps|despesa de pessoal|folha de pagamento/i, 'FOLHA'],
  [/aux[ií]lio|plano de sa[uú]de|benef[ií]cio|vale/i, 'BENEFICIOS'],
  [/aluguel|alugueis|loca[cç][aã]o/i, 'ALUGUEL'],
  [/energia|[aá]gua|telefone|celular|m[oó]vel/i, 'ENERGIA_AGUA'],
  [/internet|software|sistema|workspace|adobe|chatgpt|claud|asgard|officer|firewall|whatsapp|licen[cç]a/i, 'SISTEMAS'],
  [/material/i, 'MATERIAL'],
  [/manuten[cç][aã]o|conserva[cç][aã]o/i, 'MANUTENCAO'],
  [/fic |fic$|fundo|tribut|imposto|taxa|munic[ií]pio|n[aã]o dedut/i, 'TRIBUTOS'],
  [/limpeza|seguran[cç]a|vigil[aâ]ncia|contab|assessoria|associa[cç][aã]o|servi[cç]o/i, 'SERVICOS'],
];
export function guessCategoryCode(asgardType: string, description: string): string | null {
  // Primeiro pelo tipo (mais confiável), depois pela descrição.
  for (const text of [asgardType, description]) {
    for (const [re, code] of RULES) if (re.test(text)) return code;
  }
  return null;
}

const importSchema = z.object({ costCenterId: z.uuid(), defaultCategoryId: z.uuid() });

/**
 * Carrega despesas fixas de uma planilha no formato do Asgard (Data, Tipo, Descrição, Valor…): uma despesa fixa por
 * linha, com o dia do vencimento tirado da data, o valor como estimativa e o tipo do Asgard. Ignora linhas idênticas a
 * itens já cadastrados.
 */
export async function importRecurring(ctx: Ctx, file: { name: string; bytes: Uint8Array }, input: z.input<typeof importSchema>) {
  requirePermission(ctx, 'financeiro.cadastros');
  const d = importSchema.parse(input);
  if (!/\.xlsx?$/i.test(safeFilename(file.name))) throw new AppError('Envie a planilha no formato do Asgard (.xls ou .xlsx).');
  if (!file.bytes.byteLength || file.bytes.byteLength > 2 * 1024 * 1024) throw new AppError('Planilha vazia ou maior que 2 MB.');
  const bytes = Buffer.from(file.bytes);
  if (bytes.readUInt32LE(0) !== 0x04034b50) throw new AppError('O arquivo não está no formato de planilha do Excel moderno.');
  const entries = readZip(bytes);
  const t = cellTexts(entries, findDataSheet(entries).path);
  const scan = await scanBytes(file.bytes);
  if (scan.status === 'INFECTADO') throw new AppError(`Arquivo recusado pelo antivírus (${scan.signature}).`, 422);

  const rows: { description: string; type: string; day: number; cents: number | null }[] = [];
  for (let r = 2, blank = 0; r <= 2000 && blank < 5; r++) {
    const description = (t.get(`C${r}`) ?? '').trim();
    if (!description) { blank++; continue; }
    blank = 0;
    const serial = Number(t.get(`A${r}`));
    const day = Number.isFinite(serial) && serial > 0 ? new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).getUTCDate() : 10;
    const value = Number((t.get(`D${r}`) ?? '').replace(',', '.'));
    rows.push({ description: description.slice(0, 200), type: t.get(`B${r}`) ?? '', day, cents: Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null });
  }
  if (!rows.length) throw new AppError('Nenhuma linha com descrição encontrada na planilha.');

  return tx(async (c) => {
    const cats = new Map((await query<{ id: string; code: string }>(c, "SELECT id, code FROM finance_categories WHERE active AND kind <> 'RECEITA'")).map((x) => [x.code, x.id]));
    const existing = await query<{ description: string; amount: string | null; due_day: number }>(c, 'SELECT description, amount::text, due_day FROM recurring_expenses WHERE active');
    const key = (desc: string, cents: number | null, day: number) => `${desc.toLowerCase()}|${cents ?? ''}|${day}`;
    const seen = new Set(existing.map((e) => key(e.description, e.amount != null ? Math.round(Number(e.amount) * 100) : null, e.due_day)));
    let created = 0, skipped = 0, withoutAmount = 0;
    for (const r of rows) {
      const k = key(r.description, r.cents, r.day);
      if (seen.has(k)) { skipped++; continue; }
      seen.add(k);
      const code = guessCategoryCode(r.type, r.description);
      await query(c, `INSERT INTO recurring_expenses (description, cost_center_id, category_id, amount, due_day, asgard_type, notes, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,'Importada de planilha',$7)`,
        [r.description, d.costCenterId, (code && cats.get(code)) || d.defaultCategoryId, r.cents != null ? centsToDb(r.cents) : null, r.day, r.type || null, ctx.principal.userId]);
      created++;
      if (r.cents == null) withoutAmount++;
    }
    await audit(c, ctx, { action: 'FIN_FIXAS_IMPORTADAS', entityType: 'recurring_expense', entityId: null,
      summary: `Despesas fixas importadas de ${safeFilename(file.name)}: ${created} criada(s), ${skipped} já existente(s), ${withoutAmount} sem valor` });
    return { created, skipped, withoutAmount };
  });
}
