import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import {
  addFinanceAttachment, addRevenue, decideExpense, financeFileForDownload, generateContractExpenses, getExpense, listExpenses, listFinanceCategories, listSuppliers,
  paymentBlockers, registerPayment, requestExpense, saveContract, saveCostCenter, saveSupplier,
} from '../../../src/server/modules/finance.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { todayLocal } from '../../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';

let I: Awaited<ReturnType<typeof ids>>;
let cOwner: Ctx, cSubst: Ctx, cPayer: Ctx, cCoord: Ctx, cAtdCoord: Ctx, cColab: Ctx;
let ccRI: string, catMat: string, catAlug: string, catRec: string, supplier: string;
const today = todayLocal();
const month = today.slice(0, 7);
const RECEIPT = { name: 'c.pdf', bytes: new TextEncoder().encode('%PDF-1.4\n%fictício\n%%EOF') };

async function approved(desc: string, cents = 10000) {
  const id = await requestExpense(cCoord, { kind: 'VARIAVEL', description: desc, costCenterId: ccRI, categoryId: catMat, amountCents: cents, competence: month, dueDate: today });
  await decideExpense(cSubst, id, true);
  return id;
}

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  const o = await makePerson({ name: 'Oficial Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
  const s = await makePerson({ name: 'Substituta Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] });
  const pay = await makePerson({ name: 'Auxiliar Financeiro', sectorId: I.sectors.DIR, jobId: I.jobs.atendente, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] });
  const c = await makePerson({ name: 'Coord RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }, { roleId: I.roles.COORDENACAO_SETOR }] });
  const a = await makePerson({ name: 'Coord ATD', sectorId: I.sectors.ATD, jobId: I.jobs.atendente, roles: [{ roleId: I.roles.COLABORADOR }, { roleId: I.roles.COORDENACAO_SETOR }] });
  const x = await makePerson({ name: 'Colab', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
  cOwner = await ctxFor(o.userId); cSubst = await ctxFor(s.userId); cPayer = await ctxFor(pay.userId); cCoord = await ctxFor(c.userId); cAtdCoord = await ctxFor(a.userId); cColab = await ctxFor(x.userId);
  const cats = await listFinanceCategories();
  catMat = cats.find((k) => k.code === 'MATERIAL')!.id; catAlug = cats.find((k) => k.code === 'ALUGUEL')!.id; catRec = cats.find((k) => k.code === 'RECEITA_EMOL')!.id;
  ccRI = await saveCostCenter(cOwner, { code: 'RI', name: 'RI', sectorId: I.sectors.RI, active: true });
  supplier = await saveSupplier(cOwner, { name: 'Fornecedor Pessoa Física', document: '529.982.247-25' });
});
afterAll(closePool);

describe('Rodada 2 (4b) — integridade no banco', () => {
  it('pagamento por quem solicitou ou aprovou é barrado no próprio banco', async () => {
    const id = await approved('Barrado no banco');
    for (const who of [cCoord, cSubst]) {
      await expect(query(getPool(), "INSERT INTO expense_payments (expense_id, paid_on, amount, method, paid_by) VALUES ($1, current_date, 100.00, 'PIX', $2)", [id, who.principal.userId]))
        .rejects.toThrow(/Segregação/);
    }
  });

  it('despesa paga, pagamento, receitas e anexos são imutáveis; despesa não se exclui; "paga" sem pagamento é recusada', async () => {
    const id = await approved('Imutável');
    await expect(query(getPool(), "UPDATE expenses SET status = 'PAGA' WHERE id = $1", [id])).rejects.toThrow(/registro de pagamento/);
    await expect(query(getPool(), 'UPDATE expenses SET amount = 1 WHERE id = $1', [id])).rejects.toThrow(/aprovada não pode/);
    await addFinanceAttachment(cPayer, { expenseId: id }, 'COMPROVANTE', RECEIPT);
    await registerPayment(cPayer, id, { paidOn: today, amountCents: 10000, method: 'PIX' });
    for (const sql of ["UPDATE expenses SET description = 'x' WHERE id = $1", 'DELETE FROM expenses WHERE id = $1', 'UPDATE expense_payments SET amount = 1 WHERE expense_id = $1',
      'DELETE FROM expense_payments WHERE expense_id = $1', 'DELETE FROM finance_attachments WHERE expense_id = $1', 'DELETE FROM expense_events WHERE expense_id = $1']) {
      await expect(query(getPool(), sql, [id]), sql).rejects.toThrow();
    }
    const rev = await addRevenue(cOwner, { competence: month, receivedOn: today, categoryId: catRec, description: 'Receita fictícia', amountCents: 100 });
    await expect(query(getPool(), 'UPDATE revenue_entries SET amount = 1 WHERE id = $1', [rev])).rejects.toThrow();
  });

  it('CPF de fornecedor pessoa física não fica em claro no banco nem na trilha de auditoria', async () => {
    const leak = await queryOne<{ n: number }>(getPool(),
      "SELECT (SELECT count(*) FROM suppliers WHERE document_enc LIKE '%52998224725%' OR name LIKE '%52998224725%') + (SELECT count(*) FROM audit_log WHERE summary LIKE '%52998224725%' OR data::text LIKE '%52998224725%') AS n");
    expect(Number(leak!.n)).toBe(0);
    expect((await listSuppliers(cCoord)).find((s) => s.id === supplier)!.document_last4).toBe('4725');
  });
});

describe('Rodada 2 (4b) — autorização e segregação', () => {
  it('pagamento exige reautenticação; colaborador e outro setor não acessam despesas nem arquivos', async () => {
    const id = await approved('Acesso');
    await addFinanceAttachment(cPayer, { expenseId: id }, 'NOTA_FISCAL', RECEIPT);
    await expect(registerPayment(await ctxFor(cPayer.principal.userId, { stepUp: false }), id, { paidOn: today, amountCents: 10000, method: 'PIX' })).rejects.toThrow(/reautenticação/);
    const fileId = (await getExpense(cCoord, id)).attachments[0]!.file_id;
    await expect(getExpense(cColab, id)).rejects.toThrow(/permissão/);
    await expect(financeFileForDownload(cColab, fileId)).rejects.toThrow();
    await expect(getExpense(cAtdCoord, id)).rejects.toThrow(/não encontrada/);
    await expect(financeFileForDownload(cAtdCoord, fileId)).rejects.toThrow(/não encontrada/);
    expect((await listExpenses(cAtdCoord, { status: 'TODAS' })).length).toBe(0);
    await expect(listSuppliers(cColab)).rejects.toThrow(/permissão/);
  });

  it('aviso de bloqueio quando todas as pessoas que pagam já participaram da despesa', async () => {
    // Substituta solicita; Oficial aprova; restam como pagadores possíveis: o Auxiliar Financeiro → não há bloqueio.
    const ccADM = await saveCostCenter(cOwner, { code: 'ADM', name: 'ADM', sectorId: I.sectors.DIR, active: true });
    const id = await requestExpense(cSubst, { kind: 'VARIAVEL', description: 'Sem pagador?', costCenterId: ccADM, categoryId: catMat, amountCents: 500, competence: month, dueDate: today });
    await decideExpense(cOwner, id, true);
    expect((await paymentBlockers(cOwner)).some((b) => b.id === id)).toBe(false);
    // Sem o Auxiliar (papel revogado), ninguém pode pagar sem violar a segregação → bloqueio sinalizado.
    await query(getPool(), 'UPDATE user_roles SET revoked_at = now() WHERE user_id = $1', [cPayer.principal.userId]);
    expect((await paymentBlockers(cOwner)).some((b) => b.id === id)).toBe(true);
    await query(getPool(), 'UPDATE user_roles SET revoked_at = NULL WHERE user_id = $1', [cPayer.principal.userId]);
  });
});

describe('Rodada 2 (4b) — concorrência', () => {
  it('pagamentos simultâneos da mesma despesa: um único pagamento', async () => {
    const id = await approved('Dupla');
    await addFinanceAttachment(cPayer, { expenseId: id }, 'COMPROVANTE', RECEIPT);
    const r = await Promise.allSettled([
      registerPayment(cPayer, id, { paidOn: today, amountCents: 10000, method: 'PIX' }),
      registerPayment(cOwner, id, { paidOn: today, amountCents: 10000, method: 'BOLETO' }),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled').length).toBe(1);
    expect((await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM expense_payments WHERE expense_id = $1', [id]))!.n).toBe(1);
  });

  it('decisões simultâneas (aprovar × rejeitar): uma só prevalece', async () => {
    const id = await requestExpense(cCoord, { kind: 'VARIAVEL', description: 'Decisão dupla', costCenterId: ccRI, categoryId: catMat, amountCents: 100, competence: month, dueDate: today });
    const r = await Promise.allSettled([decideExpense(cSubst, id, true), decideExpense(cOwner, id, false, 'Não')]);
    expect(r.filter((x) => x.status === 'fulfilled').length).toBe(1);
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM expense_events WHERE expense_id = $1 AND event IN ('APROVADA','REJEITADA')", [id]))!.n).toBe(1);
  });

  it('lançamento simultâneo das despesas fixas não duplica a mensalidade', async () => {
    await saveContract(cOwner, { supplierId: supplier, object: 'Contrato concorrente', costCenterId: ccRI, categoryId: catAlug, startDate: '2026-01-01', monthlyCents: 1000, dueDay: 5 });
    const r = await Promise.allSettled([1, 2, 3].map(() => generateContractExpenses(cOwner, '2027-03')));
    const created = r.filter((x) => x.status === 'fulfilled').reduce((a, x) => a + (x as PromiseFulfilledResult<number>).value, 0);
    expect(created).toBe(1);
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM expenses WHERE origin = 'CONTRATO' AND competence = '2027-03-01'"))!.n).toBe(1);
  });

  it('trilha de auditoria íntegra', async () => {
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
