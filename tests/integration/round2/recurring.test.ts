import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import { addFinanceAttachment, decideExpense, generateContractExpenses, listFinanceCategories, registerPayment, saveCostCenter } from '../../../src/server/modules/finance.ts';
import { guessCategoryCode, importRecurring, listRecurring, removeRecurring, saveRecurring } from '../../../src/server/modules/recurring.ts';
import { listMonth, uploadTemplate } from '../../../src/server/modules/asgard.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { excelDate } from '../../../src/server/xlsx.ts';
import { addMonths, todayLocal } from '../../../src/domain/time.ts';
import { asgardTemplate } from '../../fixtures/asgardTemplate.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';

// Despesas fixas mensais (sem contrato) e importação de planilha no formato do Asgard. Dados fictícios.
const today = todayLocal();
const next = addMonths(`${today.slice(0, 7)}-01`, 1).slice(0, 7);
const RECEIPT = { name: 'c.pdf', bytes: new TextEncoder().encode('%PDF-1.4\n%fictício\n%%EOF') };
const TYPES = ['ENERGIA', 'CHATGPT', 'MATERIAL DE LIMPEZA', 'FUNCIONÁRIA FICTÍCIA', 'WHATSAPP BUSINESS'];
const SHEET = asgardTemplate({
  types: TYPES,
  rows: [
    { date: excelDate('2026-09-10'), type: 'ENERGIA', description: 'Distribuidora de Energia Fictícia', value: 422.61 },
    { date: excelDate('2026-09-07'), type: 'CHATGPT', description: 'Assinatura de IA fictícia', value: 99.9 },
    { date: excelDate('2026-09-01'), type: 'MATERIAL DE LIMPEZA', description: 'Loja de limpeza fictícia', value: 274 },
    { date: excelDate('2026-09-30'), type: 'FUNCIONÁRIA FICTÍCIA', description: 'Funcionária Fictícia - salário', value: 2000 },
    { type: 'WHATSAPP BUSINESS', description: 'Mensageiro fictício' }, // sem data e sem valor
  ],
});
let cOwner: Ctx, cColab: Ctx;
let cc: string, catServ: string;

beforeAll(async () => {
  await resetDatabase();
  const I = await ids();
  cOwner = await ctxFor((await makePerson({ name: 'Oficial', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true })).userId);
  cColab = await ctxFor((await makePerson({ name: 'Colab', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] })).userId);
  cc = await saveCostCenter(cOwner, { code: 'ADM', name: 'ADM', sectorId: I.sectors.DIR, active: true });
  catServ = (await listFinanceCategories()).find((k) => k.code === 'SERVICOS')!.id;
});
afterAll(closePool);

describe('Despesas fixas mensais — importação', () => {
  it('sugere a categoria pelo tipo e pela descrição', () => {
    expect(guessCategoryCode('ENERGIA', 'x')).toBe('ENERGIA_AGUA');
    expect(guessCategoryCode('CHATGPT', 'x')).toBe('SISTEMAS');
    expect(guessCategoryCode('NOME DE PESSOA', 'Fulana - salário')).toBe('FOLHA');
    expect(guessCategoryCode('FGTS', 'x')).toBe('FOLHA');
    expect(guessCategoryCode('PLANO DE SAUDE', 'x')).toBe('BENEFICIOS');
    expect(guessCategoryCode('FIC RCPN', 'x')).toBe('TRIBUTOS');
    expect(guessCategoryCode('QUALQUER', 'sem pista')).toBeNull();
  });

  it('importa uma linha por despesa (dia da data, valor, tipo do Asgard) e não duplica ao reimportar', async () => {
    await expect(importRecurring(cColab, { name: 'set.xlsx', bytes: SHEET }, { costCenterId: cc, defaultCategoryId: catServ })).rejects.toThrow();
    await expect(importRecurring(cOwner, { name: 'set.pdf', bytes: SHEET }, { costCenterId: cc, defaultCategoryId: catServ })).rejects.toThrow(/xls/);
    expect(await importRecurring(cOwner, { name: 'despesas-setembro.xlsx', bytes: SHEET }, { costCenterId: cc, defaultCategoryId: catServ }))
      .toEqual({ created: 5, skipped: 0, withoutAmount: 1 });
    const rows = await listRecurring(cOwner);
    const byDesc = Object.fromEntries(rows.map((r) => [r.description, r]));
    expect(byDesc['Distribuidora de Energia Fictícia']).toMatchObject({ amount: '422.61', due_day: 10, asgard_type: 'ENERGIA', category: 'Energia, água e telefonia' });
    expect(byDesc['Funcionária Fictícia - salário']).toMatchObject({ due_day: 30, category: 'Folha de pagamento e encargos' });
    expect(byDesc['Mensageiro fictício']).toMatchObject({ amount: null, due_day: 10, category: 'Sistemas, internet e licenças' });
    expect(await importRecurring(cOwner, { name: 'de-novo.xlsx', bytes: SHEET }, { costCenterId: cc, defaultCategoryId: catServ })).toEqual({ created: 0, skipped: 5, withoutAmount: 0 });
  });
});

describe('Despesas fixas mensais — uso mensal', () => {
  it('lança o mês com o tipo do Asgard, sem duplicar e sem os itens sem valor', async () => {
    const before = (await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM expenses WHERE origin = 'RECORRENTE'"))!.n;
    expect(await generateContractExpenses(cOwner, next)).toBe(4);
    expect(await generateContractExpenses(cOwner, next)).toBe(0);
    const gen = await query<{ description: string; due_date: string; asgard_type: string | null; amount: string }>(getPool(),
      `SELECT e.description, e.due_date, x.asgard_type, e.amount::text FROM expenses e LEFT JOIN expense_asgard x ON x.expense_id = e.id
        WHERE e.origin = 'RECORRENTE' ORDER BY e.due_date`);
    expect(gen.length - before).toBe(4);
    expect(gen.find((g) => g.description === 'Distribuidora de Energia Fictícia')).toMatchObject({ due_date: `${next}-10`, asgard_type: 'ENERGIA', amount: '422.61' });
  });

  it('alterar, desativar (se já lançou) ou excluir (se nunca lançou)', async () => {
    const rows = await listRecurring(cOwner);
    const msg = rows.find((r) => r.description === 'Mensageiro fictício')!;
    await saveRecurring(cOwner, { id: msg.id, description: msg.description, costCenterId: cc, categoryId: msg.category_id, amountCents: 3990, dueDay: 5, asgardType: 'WHATSAPP BUSINESS', active: true });
    expect((await listRecurring(cOwner)).find((r) => r.id === msg.id)).toMatchObject({ amount: '39.90', due_day: 5 });
    expect(await removeRecurring(cOwner, msg.id)).toBe('EXCLUIDA');
    const energy = rows.find((r) => r.description === 'Distribuidora de Energia Fictícia')!;
    expect(await removeRecurring(cOwner, energy.id)).toBe('DESATIVADA');
    expect((await listRecurring(cOwner)).find((r) => r.id === energy.id)).toMatchObject({ active: false });
    await expect(saveRecurring(cColab, { description: 'x y z', costCenterId: cc, categoryId: catServ, amountCents: 100, dueDay: 1 })).rejects.toThrow();
  });

  it('pago, entra na planilha do Asgard com o tipo herdado da despesa fixa', async () => {
    await uploadTemplate(cOwner, { name: 'modelo.xls', bytes: asgardTemplate({ types: TYPES }) });
    const e = (await queryOne<{ id: string }>(getPool(), "SELECT id FROM expenses WHERE origin = 'RECORRENTE' AND description = 'Assinatura de IA fictícia'"))!;
    await decideExpense(cOwner, e.id, true);
    await addFinanceAttachment(cOwner, { expenseId: e.id }, 'COMPROVANTE', RECEIPT);
    await registerPayment(cOwner, e.id, { paidOn: today, amountCents: 9990, method: 'CARTAO' });
    expect((await listMonth(cOwner, today.slice(0, 7))).find((r) => r.expense_id === e.id)).toMatchObject({ type: 'CHATGPT', type_source: 'DESPESA', description: 'Assinatura de IA fictícia' });
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
