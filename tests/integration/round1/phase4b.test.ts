import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import {
  addFinanceAttachment, addQuote, addRevenue, cancelExpense, chooseQuote, closeContract, decideExpense, financeFileForDownload, financeOverview, generateContractExpenses,
  getExpense, listContracts, listExpenses, listFinanceCategories, listRevenues, listSuppliers, processFinanceReminders, registerPayment, requestExpense, reverseRevenue,
  saveContract, saveCostCenter, saveSupplier, setBudget, supplierDocument, updateRequest,
} from '../../../src/server/modules/finance.ts';
import { createProject, getProject } from '../../../src/server/modules/projects.ts';
import { addDays, todayLocal } from '../../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';

let I: Awaited<ReturnType<typeof ids>>;
let cOwner: Ctx, cSubst: Ctx, cCoord: Ctx, cColab: Ctx, cAtdCoord: Ctx;
let ccRI: string, ccDIR: string, catMat: string, catAlug: string, catRec: string, supplier: string;
const today = todayLocal();
const month = today.slice(0, 7);
const RECEIPT = { name: 'comprovante.pdf', bytes: new TextEncoder().encode('%PDF-1.4\n%comprovante fictício\n%%EOF') };

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  const o = await makePerson({ name: 'Oficial Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
  const s = await makePerson({ name: 'Substituta Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] });
  const c = await makePerson({ name: 'Coord RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }, { roleId: I.roles.COORDENACAO_SETOR }] });
  const a = await makePerson({ name: 'Coord ATD', sectorId: I.sectors.ATD, jobId: I.jobs.atendente, roles: [{ roleId: I.roles.COLABORADOR }, { roleId: I.roles.COORDENACAO_SETOR }] });
  const x = await makePerson({ name: 'Colab', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
  cOwner = await ctxFor(o.userId); cSubst = await ctxFor(s.userId); cCoord = await ctxFor(c.userId); cAtdCoord = await ctxFor(a.userId); cColab = await ctxFor(x.userId);
  const cats = await listFinanceCategories();
  catMat = cats.find((k) => k.code === 'MATERIAL')!.id;
  catAlug = cats.find((k) => k.code === 'ALUGUEL')!.id;
  catRec = cats.find((k) => k.code === 'RECEITA_EMOL')!.id;
});
afterAll(closePool);

describe('Fase 4b — cadastros', () => {
  it('centros de custo e fornecedores (documento validado e cifrado)', async () => {
    await expect(saveCostCenter(cCoord, { code: 'RI', name: 'Registro de Imóveis', sectorId: I.sectors.RI, active: true })).rejects.toThrow(/permissão/);
    ccRI = await saveCostCenter(cSubst, { code: 'RI', name: 'Registro de Imóveis', sectorId: I.sectors.RI, active: true });
    ccDIR = await saveCostCenter(cSubst, { code: 'ADM', name: 'Administração', sectorId: I.sectors.DIR, active: true });
    await expect(saveSupplier(cSubst, { name: 'Papelaria', document: '11.222.333/0001-82' })).rejects.toThrow(/inválido/);
    supplier = await saveSupplier(cSubst, { name: 'Papelaria Fictícia Ltda', document: '11.222.333/0001-81', email: 'contato@papelaria.example' });
    await expect(saveSupplier(cSubst, { name: 'Duplicada', document: '11222333000181' })).rejects.toThrow(/já cadastrado/);
    const row = await queryOne<{ document_enc: string; document_last4: string }>(getPool(), 'SELECT document_enc, document_last4 FROM suppliers WHERE id = $1', [supplier]);
    expect(row!.document_enc).not.toContain('11222333');
    expect(row!.document_last4).toBe('0181');
    expect(await supplierDocument(cSubst, supplier)).toBe('11222333000181');
    expect((await listSuppliers(cCoord))[0]!.document_last4).toBe('0181');
    await expect(listSuppliers(cColab)).rejects.toThrow(/permissão/);
  });
});

describe('Fase 4b — despesas: solicitação, aprovação e pagamento com segregação', () => {
  let e1: string;
  it('coordenação solicita no centro de custo do setor; não em outro; colaborador não solicita', async () => {
    const base = { kind: 'VARIAVEL' as const, description: 'Papel A4 e toner', supplierId: supplier, costCenterId: ccRI, categoryId: catMat, amountCents: 45990, competence: month, dueDate: addDays(today, 10) };
    e1 = await requestExpense(cCoord, base);
    await expect(requestExpense(cCoord, { ...base, costCenterId: ccDIR })).rejects.toThrow(/centro de custo/);
    await expect(requestExpense(cColab, base)).rejects.toThrow(/centro de custo|permissão/);
    await expect(requestExpense(cCoord, { ...base, categoryId: catRec })).rejects.toThrow(/Categoria/);
    await expect(requestExpense(cCoord, { ...base, kind: 'COMPRA' })).rejects.toThrow(/justificativa/);
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM notifications WHERE kind = 'FIN_APROVACAO'"))!.n).toBeGreaterThanOrEqual(2);
  });

  it('quem solicitou altera enquanto pendente; aprovação exige reautenticação; solicitante não aprova', async () => {
    await updateRequest(cCoord, e1, { kind: 'VARIAVEL', description: 'Papel A4 e toner (revisado)', supplierId: supplier, costCenterId: ccRI, categoryId: catMat, amountCents: 47990, competence: month, dueDate: addDays(today, 10) });
    await expect(decideExpense(await ctxFor(cSubst.principal.userId, { stepUp: false }), e1, true)).rejects.toThrow(/reautenticação/);
    await expect(decideExpense(cCoord, e1, true)).rejects.toThrow(/permissão/);
    await decideExpense(cSubst, e1, true, 'Ok');
    await expect(updateRequest(cCoord, e1, { kind: 'VARIAVEL', description: 'Trocar valor', costCenterId: ccRI, categoryId: catMat, amountCents: 1, competence: month, dueDate: today })).rejects.toThrow(/pendentes/);
  });

  it('pagamento: comprovante obrigatório; aprovador não paga; valor igual ao aprovado; data não futura', async () => {
    await expect(registerPayment(cOwner, e1, { paidOn: today, amountCents: 47990, method: 'PIX' })).rejects.toThrow(/comprovante/);
    await addFinanceAttachment(cOwner, { expenseId: e1 }, 'COMPROVANTE', RECEIPT);
    await expect(registerPayment(cSubst, e1, { paidOn: today, amountCents: 47990, method: 'PIX' })).rejects.toThrow(/Segregação/);
    await expect(registerPayment(cOwner, e1, { paidOn: today, amountCents: 40000, method: 'PIX' })).rejects.toThrow(/igual ao valor aprovado/);
    await expect(registerPayment(cOwner, e1, { paidOn: addDays(today, 1), amountCents: 47990, method: 'PIX' })).rejects.toThrow(/futura/);
    await registerPayment(cOwner, e1, { paidOn: today, amountCents: 47990, method: 'PIX', reference: 'E2E-FICT-1' });
    const { expense } = await getExpense(cCoord, e1);
    expect(expense).toMatchObject({ status: 'PAGA', paid_amount: '479.90', method: 'PIX' });
    await expect(cancelExpense(cSubst, e1, 'Tentativa')).rejects.toThrow(/paga não é cancelada/);
    const dl = await financeFileForDownload(cCoord, (await getExpense(cCoord, e1)).attachments[0]!.file_id);
    expect(dl.data.toString()).toContain('%PDF');
  });

  it('rejeição exige motivo; cancelamento pelo solicitante enquanto pendente', async () => {
    const e2 = await requestExpense(cCoord, { kind: 'VARIAVEL', description: 'Cadeiras', costCenterId: ccRI, categoryId: catMat, amountCents: 100000, competence: month, dueDate: today });
    await expect(decideExpense(cSubst, e2, false)).rejects.toThrow(/motivo/);
    await decideExpense(cSubst, e2, false, 'Fora do orçamento');
    expect((await getExpense(cCoord, e2)).expense.status).toBe('REJEITADA');
    const e3 = await requestExpense(cCoord, { kind: 'VARIAVEL', description: 'Lanche', costCenterId: ccRI, categoryId: catMat, amountCents: 3000, competence: month, dueDate: today });
    await cancelExpense(cCoord, e3, 'Desistência');
    expect((await getExpense(cCoord, e3)).expense.status).toBe('CANCELADA');
  });

  it('limite de aprovação delegada: acima do valor, somente a Oficial', async () => {
    await query(getPool(), "UPDATE settings SET value = '1000' WHERE key = 'financeiro.limite_aprovacao_delegada'");
    const { invalidateSettingsCache } = await import('../../../src/server/settings.ts');
    invalidateSettingsCache();
    const big = await requestExpense(cCoord, { kind: 'VARIAVEL', description: 'Reforma', costCenterId: ccRI, categoryId: catMat, amountCents: 250000, competence: month, dueDate: today });
    await expect(decideExpense(cSubst, big, true)).rejects.toThrow(/Oficial/);
    await decideExpense(cOwner, big, true);
    await query(getPool(), "UPDATE settings SET value = '0' WHERE key = 'financeiro.limite_aprovacao_delegada'");
    invalidateSettingsCache();
  });

  it('compras: cotações; escolher a mais cara exige justificativa; valor da solicitação segue a escolhida', async () => {
    const p = await requestExpense(cCoord, { kind: 'COMPRA', description: 'Scanner de mesa', justification: 'Digitalização administrativa', costCenterId: ccRI, categoryId: catMat, amountCents: 300000, competence: month, dueDate: addDays(today, 20) });
    await expect(decideExpense(cSubst, p, true)).rejects.toThrow(/cotações/);
    await addQuote(cCoord, p, { supplierName: 'Loja A', amountCents: 280000 });
    await addQuote(cCoord, p, { supplierName: 'Loja B', amountCents: 310000 }, { name: 'orcamento-b.pdf', bytes: new TextEncoder().encode('%PDF-1.4\n%orçamento\n%%EOF') });
    const q = (await getExpense(cCoord, p)).quotes;
    const b = q.find((x) => x.supplier_name === 'Loja B')!;
    await expect(chooseQuote(cCoord, b.id)).rejects.toThrow(/justifique/);
    await chooseQuote(cCoord, b.id, 'Garantia estendida e assistência local');
    expect((await getExpense(cCoord, p)).expense.amount).toBe('3100.00');
    await decideExpense(cSubst, p, true);
    await expect(addQuote(cCoord, p, { supplierName: 'Loja C', amountCents: 1 })).rejects.toThrow(/pendente/);
  });

  it('visibilidade por setor: coordenação de outro setor não vê despesas do RI', async () => {
    expect((await listExpenses(cAtdCoord, { status: 'TODAS' })).length).toBe(0);
    await expect(getExpense(cAtdCoord, e1)).rejects.toThrow(/não encontrada/);
    expect((await listExpenses(cCoord, { status: 'TODAS' })).length).toBeGreaterThanOrEqual(5);
  });
});

describe('Fase 4b — contratos, orçamento, receitas e relatórios', () => {
  let contract: string;
  it('contrato mensal gera despesas fixas da competência uma única vez; alerta de término', async () => {
    contract = await saveContract(cSubst, { supplierId: supplier, object: 'Locação do imóvel (fictício)', costCenterId: ccDIR, categoryId: catAlug, startDate: addDays(today, -200),
      endDate: addDays(today, 30), monthlyCents: 350000, dueDay: 31, readjustment: 'IGP-M anual (fictício)', noticeDays: 60 });
    await expect(saveContract(cSubst, { supplierId: supplier, object: 'Sem dia', costCenterId: ccDIR, categoryId: catAlug, startDate: today, monthlyCents: 100 })).rejects.toThrow(/vencimento/);
    expect(await generateContractExpenses(cSubst, month)).toBe(1);
    expect(await generateContractExpenses(cSubst, month)).toBe(0);
    const { alerts } = await listContracts(cSubst);
    expect(alerts.map((a) => a.id)).toContain(contract);
    const fixed = (await listExpenses(cSubst, { month })).find((e) => e.contract_id === contract)!;
    expect(fixed.status).toBe('SOLICITADA');
    expect(fixed.due_date.slice(0, 7)).toBe(month);
    await closeContract(cSubst, contract, 'Fim da locação (fictício)');
    expect(await generateContractExpenses(cSubst, addDays(`${month}-01`, 40).slice(0, 7))).toBe(0);
  });

  it('orçamento por centro e categoria; previsto × realizado e totais do período', async () => {
    await setBudget(cSubst, { year: Number(month.slice(0, 4)), months: [Number(month.slice(5))], costCenterId: ccRI, categoryId: catMat, amountCents: 100000 });
    const o = await financeOverview(cOwner, month, month);
    const line = o.budgetVsActual.find((r) => r.cost_center_id === ccRI && r.category_id === catMat)!;
    expect(line.budget).toBe(100000);
    expect(line.paid).toBe(47990);
    expect(line.committed).toBe(250000 + 310000);
    expect(o.totals.paid).toBe(47990);
    expect(o.full).toBe(true);
    expect(o.projection.length).toBe(6);
  });

  it('receitas gerenciais e estorno por lançamento vinculado; fluxo de caixa considera o estorno', async () => {
    const r = await addRevenue(cOwner, { competence: month, receivedOn: today, categoryId: catRec, description: 'Receita do mês (fictícia)', amountCents: 1000000 });
    await expect(addRevenue(cSubst, { competence: month, receivedOn: today, categoryId: catRec, description: 'X sem permissão', amountCents: 1 })).rejects.toThrow(/permissão/);
    await expect(addRevenue(cOwner, { competence: month, receivedOn: today, categoryId: catMat, description: 'Categoria errada', amountCents: 1 })).rejects.toThrow(/receita/);
    await reverseRevenue(cOwner, r, 'Lançado em duplicidade');
    await expect(reverseRevenue(cOwner, r, 'De novo')).rejects.toThrow(/já estornado/);
    expect((await listRevenues(cOwner, month)).length).toBe(2);
    const o = await financeOverview(cOwner, month, month);
    expect(o.flow[0]!.inflow).toBe(0);
    expect(o.flow[0]!.outflow).toBe(47990);
  });

  it('coordenação vê relatório só do próprio setor e sem receitas nem custo de pessoal', async () => {
    const o = await financeOverview(cCoord, month, month);
    expect(o.full).toBe(false);
    expect(o.personnel).toBeNull();
    expect(o.flow[0]!.inflow).toBe(0);
    expect(o.byCostCenter.every((x) => x.name === 'RI')).toBe(true);
    expect((await financeOverview(cOwner, month, month)).personnel).not.toBeNull();
  });

  it('despesa paga vinculada a projeto entra no custo realizado do projeto', async () => {
    const pid = await createProject(cCoord, { name: 'Digitalização administrativa', sectorId: I.sectors.RI });
    const e = await requestExpense(cCoord, { kind: 'VARIAVEL', description: 'Serviço de digitalização', projectId: pid, costCenterId: ccRI, categoryId: catMat, amountCents: 12345, competence: month, dueDate: today });
    await decideExpense(cSubst, e, true);
    await addFinanceAttachment(cOwner, { expenseId: e }, 'COMPROVANTE', RECEIPT);
    await registerPayment(cOwner, e, { paidOn: today, amountCents: 12345, method: 'BOLETO' });
    expect((await getProject(cCoord, pid)).project.actual_cost).toBe('123.45');
  });

  it('aviso de vencimento a quem paga (uma vez por vencimento)', async () => {
    expect(await processFinanceReminders()).toBeGreaterThan(0);
    expect(await processFinanceReminders()).toBe(0);
  });
});
