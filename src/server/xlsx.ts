import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { AppError } from './errors.ts';

// Leitura e escrita mínimas de planilhas OOXML (.xlsx) para preencher modelos enviados pela serventia
// (ex.: modelo de importação do Asgard), preservando estilos, abas ocultas e listas de validação do original.

const MAX_ENTRIES = 200;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // proteção contra "zip bomb"

export type ZipEntries = Map<string, Buffer>;

/** Lê um ZIP (métodos 0 = armazenado e 8 = deflate) pelo diretório central. */
export function readZip(buf: Buffer): ZipEntries {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new AppError('Arquivo não é uma planilha válida (ZIP sem diretório central).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new AppError('Planilha com estrutura inesperada (entradas demais).');
  const out: ZipEntries = new Map();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new AppError('Planilha corrompida (diretório central).');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new AppError('Planilha corrompida (cabeçalho local).');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    total += usize;
    if (total > MAX_TOTAL_BYTES) throw new AppError('Planilha grande demais depois de descompactada.');
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: MAX_TOTAL_BYTES }) : null;
    if (!data) throw new AppError('Planilha com compactação não suportada.');
    if (name.endsWith('/')) continue;
    out.set(name, data);
  }
  return out;
}

/** Grava um ZIP (deflate) com as entradas na ordem informada. */
export function writeZip(entries: ZipEntries): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(0, 12); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

export const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlUnescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Textos compartilhados (sharedStrings.xml), na ordem; rich text é concatenado. */
export function sharedStrings(entries: ZipEntries): string[] {
  const xml = entries.get('xl/sharedStrings.xml')?.toString('utf8');
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1]!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => xmlUnescape(t[1]!)).join(''));
}

/** Abas do arquivo: nome, caminho da planilha e se está oculta. */
export function sheets(entries: ZipEntries): { name: string; path: string; hidden: boolean }[] {
  const wb = entries.get('xl/workbook.xml')?.toString('utf8');
  const rels = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if (!wb || !rels) throw new AppError('Planilha sem a estrutura de pastas de trabalho esperada.');
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])?.[1], /Target="([^"]+)"/.exec(m[0])?.[1]]));
  return [...wb.matchAll(/<sheet\b[^>]*\/>/g)].map((m) => {
    const name = xmlUnescape(/name="([^"]*)"/.exec(m[0])?.[1] ?? '');
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    const t = (target.get(rid) ?? '').replace(/^\/?xl\//, '').replace(/^\//, '');
    return { name, path: `xl/${t}`, hidden: /state="(hidden|veryHidden)"/.test(m[0]) };
  });
}

/** Valores de texto das células de uma aba, por referência (ex.: "A1" → "Data *"). */
export function cellTexts(entries: ZipEntries, sheetPath: string): Map<string, string> {
  const xml = entries.get(sheetPath)?.toString('utf8');
  if (!xml) throw new AppError('Aba da planilha não encontrada.');
  const ss = sharedStrings(entries);
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1]!; const body = m[2] ?? '';
    const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (!ref) continue;
    const type = /t="([^"]+)"/.exec(attrs)?.[1];
    if (type === 's') { const v = /<v>(\d+)<\/v>/.exec(body)?.[1]; if (v !== undefined && ss[Number(v)] !== undefined) out.set(ref, ss[Number(v)]!); }
    else if (type === 'inlineStr') out.set(ref, [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => xmlUnescape(t[1]!)).join(''));
    else { const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]; if (v !== undefined) out.set(ref, xmlUnescape(v)); }
  }
  return out;
}

/** Número de série de data do Excel (sistema 1900) para AAAA-MM-DD. */
export function excelDate(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y!, m! - 1, d!) - Date.UTC(1899, 11, 30)) / 86_400_000);
}
