import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import {
  addFinanceAttachment, decideExpense, listFinanceCategories, registerPayment, requestExpense, saveCostCenter, saveSupplier,
} from '../../../src/server/modules/finance.ts';
import { buildMonthFile, getTemplate, listMonth, parseTemplate, setDefaultType, setExpenseData, uploadTemplate } from '../../../src/server/modules/asgard.ts';
import { cellTexts, excelDate, readZip, sheets } from '../../../src/server/xlsx.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { todayLocal } from '../../../src/domain/time.ts';
import { asgardTemplate, FAKE_TYPES } from '../../fixtures/asgardTemplate.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';

// Relatório XLS do Asgard: modelo da serventia preenchido com as despesas pagas no mês. Modelo e dados fictícios.
const today = todayLocal();
const month = today.slice(0, 7);
const RECEIPT = { name: 'c.pdf', bytes: new TextEncoder().encode('%PDF-1.4\n%fictício\n%%EOF') };
let cOwner: Ctx, cColab: Ctx;
let cc: string, catMat: string, catAlug: string, supplier: string;

async function paid(desc: string, cents: number, cat: string, supplierId?: string) {
  const id = await requestExpense(cOwner, { kind: 'VARIAVEL', description: desc, costCenterId: cc, categoryId: cat, amountCents: cents, competence: month, dueDate: today, supplierId });
  await decideExpense(cOwner, id, true);
  await addFinanceAttachment(cOwner, { expenseId: id }, 'COMPROVANTE', RECEIPT);
  await registerPayment(cOwner, id, { paidOn: today, amountCents: cents, method: 'PIX' });
  return id;
}

beforeAll(async () => {
  await resetDatabase();
  const I = await ids();
  cOwner = await ctxFor((await makePerson({ name: 'Oficial', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true })).userId);
  cColab = await ctxFor((await makePerson({ name: 'Colab', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] })).userId);
  const cats = await listFinanceCategories();
  catMat = cats.find((k) => k.code === 'MATERIAL')!.id; catAlug = cats.find((k) => k.code === 'ALUGUEL')!.id;
  cc = await saveCostCenter(cOwner, { code: 'ADM', name: 'ADM', sectorId: I.sectors.DIR, active: true });
  supplier = await saveSupplier(cOwner, { name: 'Energia Fictícia SA', document: '11.222.333/0001-81' });
});
afterAll(closePool);

describe('Asgard — modelo', () => {
  it('lê os tipos da aba de configuração e recusa arquivos fora do padrão', async () => {
    expect(parseTemplate(asgardTemplate()).types).toEqual(FAKE_TYPES);
    expect(() => parseTemplate(Buffer.from('%PDF-1.4 não é planilha'))).toThrow(/formato de planilha/);
    expect(() => parseTemplate(asgardTemplate({ header: ['Data', 'Valor', 'Tipo', 'Descrição', 'X', 'Y'] }))).toThrow(/colunas/);
    await expect(uploadTemplate(cColab, { name: 'modelo.xls', bytes: asgardTemplate() })).rejects.toThrow();
    await expect(uploadTemplate(cOwner, { name: 'modelo.pdf', bytes: asgardTemplate() })).rejects.toThrow(/xls/);
    expect(await uploadTemplate(cOwner, { name: 'modelo despesas asgard.xls', bytes: asgardTemplate() })).toEqual({ types: FAKE_TYPES.length });
    expect((await getTemplate())!.filename).toMatch(/\.xls$/);
  });
});

describe('Asgard — despesas pagas no mês', () => {
  let limpeza: string, energia: string;

  it('lista só o que foi pago no mês, com o tipo: despesa > fornecedor > categoria', async () => {
    limpeza = await paid('Material de limpeza', 15000, catMat);
    energia = await paid('Conta de luz', 123456, catAlug, supplier);
    await requestExpense(cOwner, { kind: 'VARIAVEL', description: 'Ainda não paga', costCenterId: cc, categoryId: catMat, amountCents: 999, competence: month, dueDate: today });
    let rows = await listMonth(cOwner, month);
    expect(rows.map((r) => r.description).sort()).toEqual(['Conta de luz', 'Material de limpeza']);
    expect(rows.every((r) => r.type === null)).toBe(true);
    await expect(buildMonthFile(cOwner, month)).rejects.toThrow(/sem tipo/);

    await setDefaultType(cOwner, { target: 'categoria', id: catMat, asgardType: 'MATERIAL DE LIMPEZA' });
    await setDefaultType(cOwner, { target: 'categoria', id: catAlug, asgardType: 'DESPESAS DE FUNCIONAMENTO ' });
    await setDefaultType(cOwner, { target: 'fornecedor', id: supplier, asgardType: 'ENERGIA' });
    await expect(setDefaultType(cOwner, { target: 'categoria', id: catMat, asgardType: 'NÃO EXISTE' })).rejects.toThrow(/inexistente/);
    rows = await listMonth(cOwner, month);
    expect(Object.fromEntries(rows.map((r) => [r.description, [r.type, r.type_source]]))).toEqual({
      'Material de limpeza': ['MATERIAL DE LIMPEZA', 'CATEGORIA'], 'Conta de luz': ['ENERGIA', 'FORNECEDOR'],
    });
    await expect(listMonth(cColab, month)).rejects.toThrow();
  });

  it('ajustes por despesa: tipo próprio, nº do documento fiscal e da autorização prévia', async () => {
    await setExpenseData(cOwner, { expenseId: limpeza, asgardType: 'TIPO FICTÍCIO Ç', fiscalDoc: 'NF 0042', priorAuth: '123' });
    await expect(setExpenseData(cOwner, { expenseId: energia, priorAuth: '12A' })).rejects.toThrow(/somente números/);
    await expect(setExpenseData(cOwner, { expenseId: energia, asgardType: 'NÃO EXISTE' })).rejects.toThrow(/inexistente/);
    const r = (await listMonth(cOwner, month)).find((x) => x.expense_id === limpeza)!;
    expect(r).toMatchObject({ type: 'TIPO FICTÍCIO Ç', type_source: 'DESPESA', fiscal_doc: 'NF 0042', prior_auth: '123' });
  });

  it('gera o modelo preenchido: datas, valores, textos, aba oculta e lista de validação preservadas', async () => {
    const f = await buildMonthFile(cOwner, month);
    expect(f).toMatchObject({ filename: `despesas-asgard-${month}.xls`, rows: 2 });
    const z = readZip(f.bytes);
    const tabs = sheets(z);
    expect(tabs.map((t) => [t.name, t.hidden])).toEqual([['Modelo Despesas', false], ['Configuracao', true]]);
    const c = cellTexts(z, tabs[0]!.path);
    expect(c.get('A1')).toBe('Data *');
    const byDesc = (d: string) => [2, 3].find((n) => c.get(`C${n}`)?.startsWith(d))!;
    const l = byDesc('Material de limpeza'), e = byDesc('Conta de luz');
    expect([c.get(`A${l}`), c.get(`B${l}`), c.get(`D${l}`), c.get(`E${l}`), c.get(`F${l}`)]).toEqual([String(excelDate(today)), 'TIPO FICTÍCIO Ç', '150.00', 'NF 0042', '123']);
    expect([c.get(`B${e}`), c.get(`C${e}`), c.get(`D${e}`)]).toEqual(['ENERGIA', 'Conta de luz - Energia Fictícia SA', '1234.56']);
    expect(c.has('A4')).toBe(false); // sem as linhas em branco do modelo
    const xml = z.get(tabs[0]!.path)!.toString('utf8');
    expect(xml).toContain('sqref="B2:B12"');
    expect(xml).toMatch(/<c r="A2" s="2">/); // estilo de data do modelo
    expect(cellTexts(z, tabs[1]!.path).get('A2')).toBe(FAKE_TYPES[0]);
    const audits = await query(getPool(), "SELECT 1 FROM audit_log WHERE action = 'ASGARD_EXPORTADO'");
    expect(audits).toHaveLength(1);
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
