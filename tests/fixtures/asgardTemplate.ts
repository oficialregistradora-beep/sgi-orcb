import { writeZip } from '../../src/server/xlsx.ts';

// Modelo FICTÍCIO no mesmo formato do exportado pelo Asgard (aba "Modelo Despesas" + aba oculta "Configuracao"
// com a lista de tipos e validação de lista na coluna B). Nenhum tipo ou nome real.
export const FAKE_TYPES = ['DESPESAS SOFTWARE', 'MATERIAL DE LIMPEZA', 'ENERGIA', 'DESPESAS DE FUNCIONAMENTO ', 'TIPO FICTÍCIO Ç'];
const HEAD = ['Data *', 'Tipo *', 'Descrição *', 'Valor *', 'N° Documento Fiscal', 'N° Autorização Prévia'];
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';

export type FakeRow = { date?: number; type: string; description: string; value?: number };

/** `rows`: linhas já preenchidas (data como número de série do Excel), como no livro de um mês exportado do Asgard. */
export function asgardTemplate(opts: { header?: string[]; types?: string[]; rows?: FakeRow[] } = {}): Buffer {
  const header = opts.header ?? HEAD;
  const types = opts.types ?? FAKE_TYPES;
  const rows = opts.rows ?? [];
  const strings = [...header, 'Categoria', ...types, ...rows.flatMap((r) => [r.type, r.description])];
  const sIdx = (v: string) => strings.indexOf(v);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const cells = 'ABCDEF';
  const dataRow = (r: number) => `<row r="${r}"><c r="A${r}" s="2"/><c r="B${r}" s="3"/><c r="C${r}" s="3"/><c r="D${r}" s="1"/><c r="E${r}" s="3"/><c r="F${r}" s="4"/></row>`;
  const sheet1 = `<?xml version="1.0" encoding="UTF-8"?><worksheet ${NS}><dimension ref="A1:F11"/><sheetData><row r="1">${header.map((_, i) => `<c r="${cells[i]}1" t="s" s="5"><v>${i}</v></c>`).join('')}</row>`
    + `${rows.length ? rows.map((r, i) => { const n = i + 2; return `<row r="${n}">${r.date ? `<c r="A${n}" s="2"><v>${r.date}</v></c>` : ''}<c r="B${n}" t="s"><v>${sIdx(r.type)}</v></c><c r="C${n}" t="s"><v>${sIdx(r.description)}</v></c>${r.value ? `<c r="D${n}" s="1"><v>${r.value}</v></c>` : ''}</row>`; }).join('') : [2, 3, 4].map(dataRow).join('')}</sheetData><dataValidations count="1"><dataValidation type="list" sqref="B2:B12" allowBlank="true"><formula1>Configuracao!$A$2:$A$${types.length + 1}</formula1></dataValidation></dataValidations></worksheet>`;
  const sheet2 = `<?xml version="1.0" encoding="UTF-8"?><worksheet ${NS}><sheetData><row r="1"><c r="A1" t="s"><v>${header.length}</v></c></row>`
    + `${types.map((_, i) => `<row r="${i + 2}"><c r="A${i + 2}" t="s"><v>${header.length + 1 + i}</v></c></row>`).join('')}</sheetData></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><styleSheet ${NS}><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/MM/yyyy"/></numFmts><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs>`
    + '<cellXfs count="6"><xf/><xf numFmtId="4"/><xf numFmtId="164"/><xf numFmtId="49"/><xf numFmtId="3"/><xf numFmtId="49"/></cellXfs></styleSheet>';
  const entries = new Map<string, Buffer>([
    ['[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['xl/workbook.xml', Buffer.from(`<?xml version="1.0"?><workbook ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Modelo Despesas" r:id="rId3" sheetId="1"/><sheet name="Configuracao" r:id="rId4" sheetId="2" state="hidden"/></sheets></workbook>`)],
    ['xl/_rels/workbook.xml.rels', Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Target="worksheets/sheet1.xml" Type="w"/><Relationship Id="rId4" Target="worksheets/sheet2.xml" Type="w"/></Relationships>')],
    ['xl/sharedStrings.xml', Buffer.from(`<?xml version="1.0"?><sst count="${strings.length}" uniqueCount="${strings.length}" ${NS}>${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`)],
    ['xl/styles.xml', Buffer.from(styles)],
    ['xl/worksheets/sheet1.xml', Buffer.from(sheet1)],
    ['xl/worksheets/sheet2.xml', Buffer.from(sheet2)],
  ]);
  return writeZip(entries);
}
