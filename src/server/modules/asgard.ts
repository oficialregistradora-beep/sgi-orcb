import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx } from '../context.ts';
import { can } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ForbiddenError, NotFoundError } from '../errors.ts';
import { sha256Hex } from '../crypto.ts';
import { scanBytes } from '../antivirus.ts';
import { safeFilename } from '../files.ts';
import { cellTexts, excelDate, readZip, sharedStrings, sheets, writeZip, xmlEscape, type ZipEntries } from '../xlsx.ts';

// Relatório XLS para importação no Asgard: preenche o modelo enviado pela serventia com as despesas PAGAS
// no mês de referência (uma linha por pagamento). Colunas do modelo: Data, Tipo, Descrição, Valor,
// Nº Documento Fiscal, Nº Autorização Prévia. O Tipo vem da lista do próprio modelo.

const COLUMNS = ['Data', 'Tipo', 'Descrição', 'Valor', 'N° Documento Fiscal', 'N° Autorização Prévia'] as const;
const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[º°]/g, 'o').replace(/[\s*]+/g, ' ').trim().toLowerCase();

function requireAsgard(ctx: Ctx): void {
  const p = ctx.principal;
  if (!p.isOwner && !can(p, 'financeiro.cadastros') && !can(p, 'financeiro.pagar')) throw new ForbiddenError();
}

type Parsed = { entries: ZipEntries; outPath: string; types: string[] };

/** Aba no formato do Asgard: primeira linha com Data, Tipo, Descrição, Valor, Nº Documento Fiscal, Nº Autorização Prévia. */
export function findDataSheet(entries: ZipEntries): { name: string; path: string; hidden: boolean } {
  const out = sheets(entries).find((s) => {
    const t = cellTexts(entries, s.path);
    return COLUMNS.every((c, i) => norm(t.get(`${'ABCDEF'[i]}1`) ?? '') === norm(c));
  });
  if (!out) throw new AppError(`Planilha não reconhecida: a primeira linha deve ter as colunas ${COLUMNS.join(', ')}.`);
  return out;
}

/** Valida o modelo e extrai a lista de tipos (aba de configuração, coluna A a partir da linha 2). */
export function parseTemplate(bytes: Buffer): Parsed {
  if (bytes.readUInt32LE(0) !== 0x04034b50) {
    throw new AppError('O arquivo não está no formato de planilha do Excel moderno. Envie o modelo exatamente como exportado do Asgard.');
  }
  const entries = readZip(bytes);
  const all = sheets(entries);
  const out = findDataSheet(entries);
  const conf = all.find((s) => s.path !== out.path && (s.hidden || /config/i.test(s.name)));
  if (!conf) throw new AppError('Modelo sem a aba de configuração com a lista de tipos.');
  const t = cellTexts(entries, conf.path);
  const types: string[] = [];
  for (let r = 2; r <= 1000; r++) {
    const v = t.get(`A${r}`);
    if (v === undefined) { if (r > 2 && t.get(`A${r + 1}`) === undefined) break; continue; }
    if (v.trim() && !types.includes(v)) types.push(v);
  }
  if (!types.length) throw new AppError('A aba de configuração do modelo não traz nenhum tipo.');
  return { entries, outPath: out.path, types };
}

export async function getTemplate(db: Db = getPool()) {
  return queryOne<{ id: string; filename: string; types: string[]; uploaded_at: Date; uploaded_by_name: string; sha256: string }>(db,
    `SELECT t.id, t.filename, t.types, t.uploaded_at, u.display_name AS uploaded_by_name, t.sha256
       FROM asgard_templates t JOIN users u ON u.id = t.uploaded_by WHERE t.replaced_at IS NULL`);
}

export async function uploadTemplate(ctx: Ctx, file: { name: string; bytes: Uint8Array }): Promise<{ types: number }> {
  if (!ctx.principal.isOwner && !can(ctx.principal, 'financeiro.cadastros')) throw new ForbiddenError();
  const filename = safeFilename(file.name);
  if (!/\.xlsx?$/i.test(filename)) throw new AppError('Envie o modelo do Asgard (.xls ou .xlsx).');
  if (!file.bytes.byteLength || file.bytes.byteLength > MAX_TEMPLATE_BYTES) throw new AppError('Modelo vazio ou maior que 2 MB.');
  const bytes = Buffer.from(file.bytes);
  const parsed = parseTemplate(bytes);
  const scan = await scanBytes(file.bytes);
  if (scan.status === 'INFECTADO') throw new AppError(`Arquivo recusado pelo antivírus (${scan.signature}).`, 422);
  return tx(async (c) => {
    await query(c, 'UPDATE asgard_templates SET replaced_at = now() WHERE replaced_at IS NULL');
    await query(c, 'INSERT INTO asgard_templates (filename, content, sha256, types, uploaded_by) VALUES ($1,$2,$3,$4,$5)',
      [filename, bytes, sha256Hex(bytes), parsed.types, ctx.principal.userId]);
    await audit(c, ctx, { action: 'ASGARD_MODELO', entityType: 'asgard', entityId: null, summary: `Modelo do Asgard enviado: ${filename} (${parsed.types.length} tipos)` });
    return { types: parsed.types.length };
  });
}

const mapSchema = z.object({ target: z.enum(['categoria', 'fornecedor']), id: z.uuid(), asgardType: z.string().max(200).optional() });

/** Correspondência padrão de uma categoria ou fornecedor com um tipo do Asgard (vazio = sem correspondência). */
export async function setDefaultType(ctx: Ctx, input: z.input<typeof mapSchema>): Promise<void> {
  if (!ctx.principal.isOwner && !can(ctx.principal, 'financeiro.cadastros')) throw new ForbiddenError();
  const d = mapSchema.parse(input);
  const value = d.asgardType || null;
  if (value) await assertType(getPool(), value);
  await tx(async (c) => {
    const table = d.target === 'categoria' ? 'finance_categories' : 'suppliers';
    const r = await queryOne<{ name: string }>(c, `UPDATE ${table} SET asgard_type = $2 WHERE id = $1 RETURNING name`, [d.id, value]);
    if (!r) throw new NotFoundError('Cadastro não encontrado.');
    await audit(c, ctx, { action: 'ASGARD_CORRESPONDENCIA', entityType: d.target, entityId: d.id, summary: `${r.name} → ${value ?? '(sem tipo)'} no Asgard` });
  });
}

async function assertType(db: Db, value: string): Promise<void> {
  const t = await getTemplate(db);
  if (!t) throw new AppError('Envie primeiro o modelo do Asgard.');
  if (!t.types.includes(value)) throw new AppError('Tipo inexistente no modelo do Asgard.');
}

export type AsgardRow = {
  expense_id: string; paid_on: string; description: string; supplier_name: string | null; amount: string;
  category: string; own_type: string | null; supplier_type: string | null; category_type: string | null;
  fiscal_doc: string | null; prior_auth: string | null; type: string | null; type_source: 'DESPESA' | 'FORNECEDOR' | 'CATEGORIA' | null;
};

/** Despesas pagas no mês (data do pagamento), com o tipo resolvido: despesa → fornecedor → categoria. */
export async function listMonth(ctx: Ctx, month: string): Promise<AsgardRow[]> {
  requireAsgard(ctx);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AppError('Mês inválido.');
  const t = await getTemplate();
  const valid = new Set(t?.types ?? []);
  const rows = await query<Omit<AsgardRow, 'type' | 'type_source'>>(getPool(),
    `SELECT e.id AS expense_id, p.paid_on, e.description, s.name AS supplier_name, p.amount::text AS amount, fc.name AS category,
            x.asgard_type AS own_type, s.asgard_type AS supplier_type, fc.asgard_type AS category_type, x.fiscal_doc, x.prior_auth
       FROM expense_payments p JOIN expenses e ON e.id = p.expense_id JOIN finance_categories fc ON fc.id = e.category_id
       LEFT JOIN suppliers s ON s.id = e.supplier_id LEFT JOIN expense_asgard x ON x.expense_id = e.id
      WHERE to_char(p.paid_on, 'YYYY-MM') = $1 ORDER BY p.paid_on, e.description`, [month]);
  return rows.map((r) => {
    const pick: [string | null, AsgardRow['type_source']][] = [[r.own_type, 'DESPESA'], [r.supplier_type, 'FORNECEDOR'], [r.category_type, 'CATEGORIA']];
    const found = pick.find(([v]) => v && valid.has(v));
    return { ...r, type: found?.[0] ?? null, type_source: found?.[1] ?? null };
  });
}

const expenseSchema = z.object({
  expenseId: z.uuid(),
  asgardType: z.string().max(200).optional(),
  fiscalDoc: z.string().trim().max(60).optional(),
  priorAuth: z.string().trim().regex(/^\d{0,15}$/, 'Nº da autorização prévia: somente números.').optional(),
});

/** Ajusta, para uma despesa paga, o tipo (vazio = usa o padrão), o nº do documento fiscal e o da autorização prévia. */
export async function setExpenseData(ctx: Ctx, input: z.input<typeof expenseSchema>): Promise<void> {
  requireAsgard(ctx);
  const d = expenseSchema.parse(input);
  if (d.asgardType) await assertType(getPool(), d.asgardType);
  await tx(async (c) => {
    const e = await queryOne<{ description: string; status: string }>(c, 'SELECT description, status FROM expenses WHERE id = $1', [d.expenseId]);
    if (!e) throw new NotFoundError('Despesa não encontrada.');
    if (e.status !== 'PAGA') throw new AppError('Somente despesas pagas entram no relatório do Asgard.');
    await query(c,
      `INSERT INTO expense_asgard (expense_id, asgard_type, fiscal_doc, prior_auth, updated_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (expense_id) DO UPDATE SET asgard_type = EXCLUDED.asgard_type, fiscal_doc = EXCLUDED.fiscal_doc,
         prior_auth = EXCLUDED.prior_auth, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [d.expenseId, d.asgardType || null, d.fiscalDoc || null, d.priorAuth || null, ctx.principal.userId]);
    await audit(c, ctx, { action: 'ASGARD_DESPESA', entityType: 'expense', entityId: d.expenseId,
      summary: `${e.description}: tipo ${d.asgardType || '(padrão)'}; doc. fiscal ${d.fiscalDoc || '—'}; autorização ${d.priorAuth || '—'}` });
  });
}

/** Preenche o modelo com as linhas, mantendo cabeçalho, estilos, aba de configuração e validação de lista. */
export function fillTemplate(parsed: Parsed, rows: { date: string; type: string; description: string; amount: string; fiscalDoc: string | null; priorAuth: string | null }[]): Buffer {
  const { entries, outPath } = parsed;
  let xml = entries.get(outPath)!.toString('utf8');
  const header = /<row\b[^>]*\br="1"[^>]*>[\s\S]*?<\/row>/.exec(xml)?.[0] ?? '';
  // Estilos de cada coluna, copiados da primeira linha de dados do modelo (data, texto, valor, número).
  const row2 = /<row\b[^>]*\br="2"[^>]*>[\s\S]*?<\/row>/.exec(xml)?.[0] ?? '';
  const style = (col: string) => { const s = new RegExp(`<c r="${col}2"[^>]*?\\bs="(\\d+)"`).exec(row2)?.[1]; return s ? ` s="${s}"` : ''; };
  const st = Object.fromEntries([...'ABCDEF'].map((c) => [c, style(c)]));

  // Textos em sharedStrings.xml (como faz o Excel), acrescentados ao fim da tabela existente; se o modelo não tem
  // essa tabela (alguns geradores gravam o texto na própria célula), o texto vai na célula (inlineStr).
  const inline = !entries.has('xl/sharedStrings.xml');
  const ssXml = entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"></sst>';
  const existing = sharedStrings(entries);
  const added: string[] = [];
  const sidx = (s: string) => { const i = existing.indexOf(s); if (i >= 0) return i; const j = added.indexOf(s); if (j >= 0) return existing.length + j; added.push(s); return existing.length + added.length - 1; };
  let used = 0;
  const str = (ref: string, col: string, v: string | null) => {
    if (v === null || v === '') return `<c r="${ref}"${st[col]}/>`;
    if (inline) return `<c r="${ref}"${st[col]} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
    used++;
    return `<c r="${ref}"${st[col]} t="s"><v>${sidx(v)}</v></c>`;
  };
  const num = (ref: string, col: string, v: string | number | null) => (v === null || v === '' ? `<c r="${ref}"${st[col]}/>` : `<c r="${ref}"${st[col]}><v>${v}</v></c>`);

  const body = rows.map((r, i) => {
    const n = i + 2;
    return `<row r="${n}">${num(`A${n}`, 'A', excelDate(r.date))}${str(`B${n}`, 'B', r.type)}${str(`C${n}`, 'C', r.description)}`
      + `${num(`D${n}`, 'D', Number(r.amount).toFixed(2))}${str(`E${n}`, 'E', r.fiscalDoc)}`
      + `${r.priorAuth && /^\d+$/.test(r.priorAuth) ? num(`F${n}`, 'F', r.priorAuth) : str(`F${n}`, 'F', r.priorAuth)}</row>`;
  }).join('');
  const last = Math.max(1, rows.length + 1);
  xml = xml.replace(/<sheetData>[\s\S]*?<\/sheetData>|<sheetData\/>/, `<sheetData>${header}${body}</sheetData>`)
    .replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:F${last}"/>`)
    .replace(/(<dataValidation\b[^>]*\bsqref=")B2:B\d+(")/, `$1B2:B${Math.max(last, 12)}$2`);
  const out: ZipEntries = new Map(entries);
  out.set(outPath, Buffer.from(xml, 'utf8'));
  const countAttr = (s: string, name: string, v: number) => s.replace(new RegExp(`${name}="\\d+"`), `${name}="${v}"`);
  let sst = ssXml.replace('</sst>', `${added.map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`).join('')}</sst>`);
  const prevCount = Number(/count="(\d+)"/.exec(ssXml)?.[1] ?? 0);
  sst = countAttr(countAttr(sst, 'uniqueCount', existing.length + added.length), 'count', prevCount + used);
  if (!inline) out.set('xl/sharedStrings.xml', Buffer.from(sst, 'utf8'));
  return writeZip(out);
}

/** Gera a planilha do mês. Recusa se faltar tipo em alguma despesa paga. Exportação auditada. */
export async function buildMonthFile(ctx: Ctx, month: string): Promise<{ filename: string; bytes: Buffer; rows: number }> {
  requireAsgard(ctx);
  const rows = await listMonth(ctx, month);
  const tpl = await queryOne<{ filename: string; content: Buffer }>(getPool(), 'SELECT filename, content FROM asgard_templates WHERE replaced_at IS NULL');
  if (!tpl) throw new AppError('Envie primeiro o modelo do Asgard (Financeiro → Relatórios → Gerar relatório XLS Asgard).');
  const missing = rows.filter((r) => !r.type);
  if (missing.length) throw new AppError(`${missing.length} despesa(s) paga(s) sem tipo do Asgard (ex.: ${missing.slice(0, 3).map((r) => r.description).join('; ')}). Defina o tipo antes de gerar.`);
  const bytes = fillTemplate(parseTemplate(tpl.content), rows.map((r) => ({
    date: r.paid_on, type: r.type!, description: r.supplier_name && !r.description.includes(r.supplier_name) ? `${r.description} - ${r.supplier_name}` : r.description,
    amount: r.amount, fiscalDoc: r.fiscal_doc, priorAuth: r.prior_auth,
  })));
  const ext = /\.xlsx$/i.test(tpl.filename) ? 'xlsx' : 'xls';
  await audit(getPool(), ctx, { action: 'ASGARD_EXPORTADO', entityType: 'relatorio', entityId: `asgard:${month}`, summary: `Planilha do Asgard de ${month} gerada (${rows.length} despesa(s) paga(s))` });
  return { filename: `despesas-asgard-${month}.${ext}`, bytes, rows: rows.length };
}

/** Categorias e fornecedores ativos com a correspondência atual (tela de configuração). */
export async function listDefaults(ctx: Ctx) {
  requireAsgard(ctx);
  const db = getPool();
  const [categories, suppliers] = await Promise.all([
    query<{ id: string; name: string; asgard_type: string | null }>(db, "SELECT id, name, asgard_type FROM finance_categories WHERE active AND kind <> 'RECEITA' ORDER BY sort_order, name"),
    query<{ id: string; name: string; asgard_type: string | null }>(db, 'SELECT id, name, asgard_type FROM suppliers WHERE active ORDER BY name'),
  ]);
  return { categories, suppliers };
}
