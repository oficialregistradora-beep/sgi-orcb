import { z } from 'zod';
import { type Db, getPool, query, queryOne, tx } from '../db.ts';
import type { Ctx } from '../context.ts';
import { audit } from '../audit.ts';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors.ts';
import { sha256Hex } from '../crypto.ts';
import { scanBytes } from '../antivirus.ts';
import { safeFilename } from '../files.ts';
import { cellTexts, readZip, sheets } from '../xlsx.ts';
import { centsToDb, formatCents, toCents } from '../../domain/money.ts';
import { addDays, addMonths } from '../../domain/time.ts';
import { normalizeProtocol } from '../../domain/cash.ts';
import { canCashTab } from './cash.ts';

// Conciliação mensal: extrato do banco (PIX e depósitos), extrato da máquina de cartão e livro de depósito prévio,
// cruzados com os lançamentos do caixa. O cruzamento automático é conservador (mesmo valor e data próxima; no depósito
// prévio, mesmo protocolo e valor); o que sobrar se concilia à mão ou fica como pendência para a conferência.

export type Source = 'BANCO' | 'CARTAO' | 'DEPOSITO_PREVIO';
export const SOURCE_LABEL: Record<Source, string> = { BANCO: 'Extrato do banco', CARTAO: 'Extrato da máquina de cartão', DEPOSITO_PREVIO: 'Livro de depósito prévio' };
export type ParsedLine = { date: string; cents: number; description: string | null; document: string | null; protocol: string | null };

const MAX_BYTES = 5 * 1024 * 1024;

function requireReconcile(ctx: Ctx) {
  if (!canCashTab(ctx.principal, 'conciliacao')) throw new ForbiddenError();
}

// ---------------------------------------------------------------------------
// Leitura dos arquivos (OFX, CSV e XLSX)
// ---------------------------------------------------------------------------

/** "31/10/2026", "2026-10-31", "20261031", "31/10/26" ou número de série do Excel → AAAA-MM-DD. */
export function parseDate(v: string): string | null {
  const s = v.trim();
  let m = /^(\d{2})\/(\d{2})\/(\d{4}|\d{2})/.exec(s);
  if (m) return `${m[3]!.length === 2 ? `20${m[3]}` : m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})(\d{2})(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

/** "1.234,56", "-1234.56", "R$ 10,00", "(10,00)" → centavos com sinal. */
export function parseAmount(v: string): number | null {
  let s = v.trim().replace(/R\$\s*/i, '').replace(/\s/g, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = true; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    if (/^\d+\.\d{3,}$/.test(s)) s = String(Math.round(Number(s) * 100) / 100);
    else return null;
  }
  const c = toCents(s);
  return neg ? -c : c;
}

export function parseOfx(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const block of text.split(/<STMTTRN>/i).slice(1)) {
    const tag = (t: string) => new RegExp(`<${t}>([^<\\r\\n]*)`, 'i').exec(block)?.[1]?.trim() ?? null;
    const date = parseDate(tag('DTPOSTED') ?? '');
    const cents = parseAmount(tag('TRNAMT') ?? '');
    if (!date || cents === null) continue;
    out.push({ date, cents, description: tag('MEMO') ?? tag('NAME'), document: tag('CHECKNUM') ?? tag('FITID'), protocol: null });
  }
  return out;
}

function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Descobre as colunas pelo cabeçalho (data, valor bruto/valor/crédito/débito, histórico, NSU/documento, protocolo). */
export function tableToLines(rows: string[][], source: Source): ParsedLine[] {
  let hi = -1;
  let col: Record<string, number> = {};
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const h = rows[i]!.map(norm);
    const find = (...keys: RegExp[]) => { for (const k of keys) { const j = h.findIndex((x) => k.test(x)); if (j >= 0) return j; } return -1; };
    const date = find(/^data( da venda| do lancamento| da transacao| do deposito)?$/, /^data/, /^dt\b/, /^date/);
    const gross = find(/valor bruto/, /^bruto/);
    const amount = gross >= 0 ? gross : find(/^valor( \(r\$\))?$/, /^valor/, /^vlr/, /^montante/, /^amount/);
    const credit = find(/^credito/, /^entrada/);
    const debit = find(/^debito/, /^saida/);
    if (date >= 0 && (amount >= 0 || credit >= 0)) {
      hi = i;
      col = { date, amount, credit, debit, desc: find(/historico/, /descri/, /lancamento/, /memo/, /estabelecimento/, /^tipo/),
        doc: find(/^nsu/, /autoriza/, /documento/, /^doc/, /codigo/, /identificador/), prot: find(/protocolo/, /^prot/) };
      break;
    }
  }
  if (hi < 0) throw new AppError('Não encontrei o cabeçalho do arquivo: é preciso ao menos as colunas "Data" e "Valor" (ou "Crédito").');
  const out: ParsedLine[] = [];
  for (const r of rows.slice(hi + 1)) {
    const date = parseDate(r[col.date!] ?? '');
    if (!date) continue;
    let cents = col.amount! >= 0 ? parseAmount(r[col.amount!] ?? '') : null;
    if (cents === null && col.credit! >= 0) {
      const cr = parseAmount(r[col.credit!] ?? '');
      const db = col.debit! >= 0 ? parseAmount(r[col.debit!] ?? '') : null;
      cents = cr ? Math.abs(cr) : db ? -Math.abs(db) : null;
    }
    if (cents === null || cents === 0) continue;
    out.push({
      date, cents, description: col.desc! >= 0 ? r[col.desc!] || null : null, document: col.doc! >= 0 ? r[col.doc!] || null : null,
      protocol: source === 'DEPOSITO_PREVIO' && col.prot! >= 0 ? r[col.prot!] || null : null,
    });
  }
  if (source === 'DEPOSITO_PREVIO' && col.prot! < 0) throw new AppError('O livro de depósito prévio precisa da coluna "Protocolo".');
  return out;
}

export function parseCsv(text: string, source: Source): ParsedLine[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const sample = lines.slice(0, 10).join('\n');
  const sep = (sample.match(/;/g)?.length ?? 0) >= (sample.match(/,/g)?.length ?? 0) / 2 && sample.includes(';') ? ';' : sample.includes('\t') ? '\t' : ',';
  return tableToLines(lines.map((l) => splitCsvLine(l, sep)), source);
}

export function parseXlsx(bytes: Buffer, source: Source): ParsedLine[] {
  const entries = readZip(bytes);
  const first = sheets(entries).find((s) => !s.hidden) ?? sheets(entries)[0];
  if (!first) throw new AppError('Planilha sem abas.');
  const cells = cellTexts(entries, first.path);
  const grid: string[][] = [];
  for (const [ref, v] of cells) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
    const c = [...m[1]!].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const r = Number(m[2]) - 1;
    (grid[r] ??= [])[c] = v;
  }
  return tableToLines(grid.map((r) => Array.from(r ?? [], (x) => x ?? '')), source);
}

export function parseStatement(filename: string, bytes: Buffer, source: Source): ParsedLine[] {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  if (ext === 'ofx') return parseOfx(bytes.toString('latin1'));
  if (ext === 'xlsx') return parseXlsx(bytes, source);
  if (ext === 'csv' || ext === 'txt') {
    const utf8 = bytes.toString('utf8');
    return parseCsv(utf8.includes('�') ? bytes.toString('latin1') : utf8, source);
  }
  throw new AppError('Formatos aceitos: OFX (banco), CSV ou XLSX. Arquivos .xls antigos: abra e salve como .xlsx ou .csv.');
}

// ---------------------------------------------------------------------------
// Importação e cruzamento
// ---------------------------------------------------------------------------

const importSchema = z.object({ source: z.enum(['BANCO', 'CARTAO', 'DEPOSITO_PREVIO']), month: z.string().regex(/^\d{4}-\d{2}$/), label: z.string().trim().max(120).optional() });

export async function importStatement(ctx: Ctx, file: { name: string; bytes: Uint8Array }, input: z.input<typeof importSchema>): Promise<{ id: string; lines: number; matched: number }> {
  requireReconcile(ctx);
  const d = importSchema.parse(input);
  const filename = safeFilename(file.name);
  if (!file.bytes.byteLength || file.bytes.byteLength > MAX_BYTES) throw new AppError('Arquivo vazio ou maior que 5 MB.');
  const bytes = Buffer.from(file.bytes);
  const lines = parseStatement(filename, bytes, d.source);
  if (!lines.length) throw new AppError('Nenhuma linha com data e valor foi encontrada no arquivo.');
  const scan = await scanBytes(file.bytes);
  if (scan.status === 'INFECTADO') throw new AppError(`Arquivo recusado pelo antivírus (${scan.signature}).`, 422);
  return tx(async (c) => {
    const st = await queryOne<{ id: string }>(c,
      'INSERT INTO cash_statements (source, month, label, filename, file_sha256, imported_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [d.source, `${d.month}-01`, d.label || null, filename, sha256Hex(bytes), ctx.principal.userId])
      .catch((e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('Este arquivo já foi importado.'); throw e; });
    for (const l of lines) {
      await query(c, 'INSERT INTO cash_statement_lines (statement_id, line_date, amount, description, document, protocol) VALUES ($1,$2,$3,$4,$5,$6)',
        [st!.id, l.date, centsToDb(l.cents), l.description?.slice(0, 300) ?? null, l.document?.slice(0, 120) ?? null, l.protocol?.slice(0, 60) ?? null]);
    }
    const matched = await autoMatch(c, st!.id);
    await audit(c, ctx, { action: 'CAIXA_EXTRATO_IMPORTADO', entityType: 'cash_statement', entityId: st!.id,
      summary: `${SOURCE_LABEL[d.source]} ${d.month} (${filename}): ${lines.length} linha(s), ${matched} conciliada(s) automaticamente` });
    return { id: st!.id, lines: lines.length, matched };
  });
}

/** Candidatas de uma linha: lançamentos de entrada ainda não estornados nem conciliados com outra linha da mesma origem. */
async function candidates(c: Db, source: Source, line: { line_date: string; amount: string; protocol: string | null; document: string | null }) {
  const methods = source === 'BANCO' ? ['PIX', 'DEPOSITO'] : source === 'CARTAO' ? ['CARTAO_DEBITO', 'CARTAO_CREDITO'] : ['DINHEIRO', 'PIX', 'DEPOSITO', 'CARTAO_DEBITO', 'CARTAO_CREDITO'];
  const [from, to] = source === 'BANCO' ? [addDays(line.line_date, -3), line.line_date] : source === 'CARTAO' ? [addDays(line.line_date, -1), addDays(line.line_date, 1)]
    : [addDays(line.line_date, -45), addDays(line.line_date, 45)];
  const rows = await query<{ id: string; work_date: string; protocol: string | null; reference: string | null }>(c,
    `SELECT e.id, s.work_date, e.protocol, e.reference FROM cash_entries e JOIN cash_sessions s ON s.id = e.session_id
      WHERE e.kind = 'ENTRADA' AND e.method = ANY($1::text[]) AND e.amount = $2 AND s.work_date BETWEEN $3 AND $4
        AND NOT EXISTS (SELECT 1 FROM cash_entries x WHERE x.reverses_entry_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM cash_statement_lines l JOIN cash_statements st ON st.id = l.statement_id WHERE l.matched_entry_id = e.id AND st.source = $5)
      ORDER BY abs(s.work_date - $6::date), e.created_at`, [methods, line.amount, from, to, source, line.line_date]);
  if (source === 'DEPOSITO_PREVIO') return rows.filter((r) => normalizeProtocol(r.protocol) && normalizeProtocol(r.protocol) === normalizeProtocol(line.protocol));
  if (source === 'CARTAO' && line.document) {
    const nsu = line.document.replace(/\D/g, '');
    const exact = rows.filter((r) => r.reference && r.reference.replace(/\D/g, '') === nsu);
    if (exact.length) return exact;
  }
  return rows;
}

async function autoMatch(c: Db, statementId: string): Promise<number> {
  const st = (await queryOne<{ source: Source }>(c, 'SELECT source FROM cash_statements WHERE id = $1', [statementId]))!;
  const lines = await query<{ id: string; line_date: string; amount: string; protocol: string | null; document: string | null }>(c,
    'SELECT id, line_date, amount::text, protocol, document FROM cash_statement_lines WHERE statement_id = $1 AND matched_entry_id IS NULL AND amount > 0 ORDER BY line_date', [statementId]);
  let n = 0;
  for (const l of lines) {
    const [best] = await candidates(c, st.source, l);
    if (!best) continue;
    await query(c, 'UPDATE cash_statement_lines SET matched_entry_id = $2, matched_at = now() WHERE id = $1', [l.id, best.id]);
    n++;
  }
  return n;
}

export async function listStatements(ctx: Ctx, month: string) {
  requireReconcile(ctx);
  return query<{ id: string; source: Source; label: string | null; filename: string; imported_at: Date; imported_by_name: string; lines: number; matched: number; credits: number }>(getPool(),
    `SELECT st.id, st.source, st.label, st.filename, st.imported_at, u.display_name AS imported_by_name,
            (SELECT count(*)::int FROM cash_statement_lines l WHERE l.statement_id = st.id) AS lines,
            (SELECT count(*)::int FROM cash_statement_lines l WHERE l.statement_id = st.id AND l.matched_entry_id IS NOT NULL) AS matched,
            (SELECT count(*)::int FROM cash_statement_lines l WHERE l.statement_id = st.id AND l.amount > 0) AS credits
       FROM cash_statements st JOIN users u ON u.id = st.imported_by WHERE st.month = $1 ORDER BY st.source, st.imported_at`, [`${month}-01`]);
}

export async function getStatement(ctx: Ctx, statementId: string) {
  requireReconcile(ctx);
  const db = getPool();
  const st = await queryOne<{ id: string; source: Source; month: string; filename: string; label: string | null }>(db,
    'SELECT id, source, to_char(month, \'YYYY-MM\') AS month, filename, label FROM cash_statements WHERE id = $1', [z.uuid().parse(statementId)]);
  if (!st) throw new NotFoundError('Extrato não encontrado.');
  const lines = await query<{ id: string; line_date: string; amount: string; description: string | null; document: string | null; protocol: string | null;
    matched_entry_id: string | null; manual: boolean; entry_date: string | null; entry_register: string | null; entry_protocol: string | null; entry_method: string | null }>(db,
    `SELECT l.id, l.line_date, l.amount::text, l.description, l.document, l.protocol, l.matched_entry_id, (l.matched_by IS NOT NULL) AS manual,
            s.work_date AS entry_date, r.code AS entry_register, e.protocol AS entry_protocol, e.method AS entry_method
       FROM cash_statement_lines l LEFT JOIN cash_entries e ON e.id = l.matched_entry_id LEFT JOIN cash_sessions s ON s.id = e.session_id
       LEFT JOIN cash_registers r ON r.id = s.register_id WHERE l.statement_id = $1 ORDER BY l.line_date, l.amount DESC`, [st.id]);
  // Lançamentos do mês dessa forma de pagamento que nenhum extrato desta origem conciliou: pendências para a conferência.
  const methods = st.source === 'BANCO' ? ['PIX', 'DEPOSITO'] : st.source === 'CARTAO' ? ['CARTAO_DEBITO', 'CARTAO_CREDITO'] : null;
  const unmatched = await query<{ id: string; work_date: string; register_code: string; method: string; amount: string; protocol: string | null; operator_name: string }>(db,
    `SELECT e.id, s.work_date, r.code AS register_code, e.method, e.amount::text, e.protocol, u.display_name AS operator_name
       FROM cash_entries e JOIN cash_sessions s ON s.id = e.session_id JOIN cash_registers r ON r.id = s.register_id JOIN users u ON u.id = e.operator_id
      WHERE e.kind = 'ENTRADA' AND ($1::text[] IS NULL OR e.method = ANY($1::text[])) AND ($4 OR e.protocol IS NOT NULL)
        AND s.work_date >= $2::date AND s.work_date < $3::date
        AND NOT EXISTS (SELECT 1 FROM cash_entries x WHERE x.reverses_entry_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM cash_statement_lines l JOIN cash_statements st ON st.id = l.statement_id WHERE l.matched_entry_id = e.id AND st.source = $5)
      ORDER BY s.work_date, e.created_at`, [methods, `${st.month}-01`, addMonths(`${st.month}-01`, 1), st.source !== 'DEPOSITO_PREVIO', st.source]);
  return { statement: st, lines, unmatched };
}

export async function matchLine(ctx: Ctx, lineId: string, entryId: string | null): Promise<void> {
  requireReconcile(ctx);
  await tx(async (c) => {
    const l = await queryOne<{ id: string; statement_id: string; source: Source; amount: string; line_date: string }>(c,
      'SELECT l.id, l.statement_id, st.source, l.amount::text, l.line_date FROM cash_statement_lines l JOIN cash_statements st ON st.id = l.statement_id WHERE l.id = $1 FOR UPDATE OF l',
      [z.uuid().parse(lineId)]);
    if (!l) throw new NotFoundError('Linha não encontrada.');
    if (entryId) {
      const e = await queryOne<{ amount: string }>(c, "SELECT amount::text FROM cash_entries WHERE id = $1 AND kind = 'ENTRADA'", [z.uuid().parse(entryId)]);
      if (!e) throw new NotFoundError('Lançamento não encontrado.');
      if (await queryOne(c, 'SELECT 1 FROM cash_statement_lines x JOIN cash_statements st ON st.id = x.statement_id WHERE x.matched_entry_id = $1 AND st.source = $2 AND x.id <> $3', [entryId, l.source, l.id])) {
        throw new AppError('Este lançamento já está conciliado com outra linha desta origem.');
      }
      await query(c, 'UPDATE cash_statement_lines SET matched_entry_id = $2, matched_by = $3, matched_at = now() WHERE id = $1', [l.id, entryId, ctx.principal.userId]);
      await audit(c, ctx, { action: 'CAIXA_CONCILIACAO_MANUAL', entityType: 'cash_statement_line', entityId: l.id,
        summary: `${SOURCE_LABEL[l.source]} ${l.line_date} ${formatCents(toCents(l.amount))} conciliado à mão${toCents(e.amount) !== toCents(l.amount) ? ` com lançamento de ${formatCents(toCents(e.amount))}` : ''}` });
    } else {
      await query(c, 'UPDATE cash_statement_lines SET matched_entry_id = NULL, matched_by = $2, matched_at = now() WHERE id = $1', [l.id, ctx.principal.userId]);
      await audit(c, ctx, { action: 'CAIXA_CONCILIACAO_DESFEITA', entityType: 'cash_statement_line', entityId: l.id, summary: `${SOURCE_LABEL[l.source]} ${l.line_date}: conciliação desfeita` });
    }
  });
}

export async function rematchStatement(ctx: Ctx, statementId: string): Promise<number> {
  requireReconcile(ctx);
  return tx((c) => autoMatch(c, z.uuid().parse(statementId)));
}

export async function deleteStatement(ctx: Ctx, statementId: string): Promise<void> {
  requireReconcile(ctx);
  await tx(async (c) => {
    const st = await queryOne<{ source: Source; filename: string }>(c, 'DELETE FROM cash_statements WHERE id = $1 RETURNING source, filename', [z.uuid().parse(statementId)]);
    if (!st) throw new NotFoundError('Extrato não encontrado.');
    await audit(c, ctx, { action: 'CAIXA_EXTRATO_EXCLUIDO', entityType: 'cash_statement', entityId: statementId, summary: `${SOURCE_LABEL[st.source]} ${st.filename} excluído` });
  });
}
