import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import {
  decideExpense, financeOverview, generateContractExpenses, getExpense, listExpenses, listFinanceCategories, listRevenues, requestExpense, saveCostCenter,
} from '../../../src/server/modules/finance.ts';
import { listRecurring, saveRecurring } from '../../../src/server/modules/recurring.ts';
import { listMonth } from '../../../src/server/modules/asgard.ts';
import { getFinanceAccess, hasFinanceAccess, setFinanceAccess } from '../../../src/server/modules/financeAccess.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { todayLocal } from '../../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';

// Financeiro só com o alcance habilitado pela Oficial: todo o financeiro ("administração") ou centros de custo escolhidos.
let I: Awaited<ReturnType<typeof ids>>;
let cOwner: Ctx, cSubst: Ctx, cCoord: Ctx;
let ccRI: string, ccPES: string, catMat: string, catFolha: string;
let eRI: string, ePES: string;
const today = todayLocal();
const month = today.slice(0, 7);

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  cOwner = await ctxFor((await makePerson({ name: 'Oficial', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true })).userId);
  cSubst = await ctxFor((await makePerson({ name: 'Substituta', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] })).userId);
  cCoord = await ctxFor((await makePerson({ name: 'Coord RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }, { roleId: I.roles.COORDENACAO_SETOR }] })).userId);
  const cats = await listFinanceCategories();
  catMat = cats.find((k) => k.code === 'MATERIAL')!.id;
  catFolha = cats.find((k) => k.code === 'FOLHA')!.id;
  ccRI = await saveCostCenter(cOwner, { code: 'RI', name: 'Registro de Imóveis', sectorId: I.sectors.RI, active: true });
  ccPES = await saveCostCenter(cOwner, { code: 'PES', name: 'Pessoal', sectorId: I.sectors.DIR, active: true });
  const base = { kind: 'VARIAVEL' as const, categoryId: catMat, amountCents: 10000, competence: month, dueDate: today };
  eRI = await requestExpense(cOwner, { ...base, description: 'Material do RI', costCenterId: ccRI });
  ePES = await requestExpense(cOwner, { ...base, description: 'Salário (fictício)', costCenterId: ccPES, categoryId: catFolha, amountCents: 300000 });
  await saveRecurring(cOwner, { description: 'Salário fixo (fictício)', costCenterId: ccPES, categoryId: catFolha, amountCents: 300000, dueDay: 5 });
  await saveRecurring(cOwner, { description: 'Papelaria mensal', costCenterId: ccRI, categoryId: catMat, amountCents: 5000, dueDay: 10 });
});
afterAll(closePool);

describe('Sem habilitação, ninguém além da Oficial vê o financeiro', () => {
  it('Substituta (aprova, paga e cadastra pelo papel) não vê nada nem decide enquanto a Oficial não habilitar', async () => {
    expect(await hasFinanceAccess(getPool(), cSubst.principal)).toBe(false);
    expect(await listExpenses(cSubst, {})).toHaveLength(0);
    expect((await financeOverview(cSubst, month, month)).totals.requested).toBe(0);
    await expect(getExpense(cSubst, ePES)).rejects.toThrow(/não encontrada/);
    await expect(decideExpense(cSubst, eRI, true)).rejects.toThrow(/não encontrada/);
    expect(await listRecurring(cSubst)).toHaveLength(0);
    await expect(listRevenues(cSubst)).rejects.toThrow(/administração/);
    await expect(listMonth(cSubst, month)).rejects.toThrow(/administração/);
    await expect(generateContractExpenses(cSubst, month)).rejects.toThrow(/administração/);
    await expect(saveCostCenter(cSubst, { code: 'X', name: 'Outro', sectorId: I.sectors.DIR, active: true })).rejects.toThrow(/administração/);
    await expect(requestExpense(cCoord, { kind: 'VARIAVEL', description: 'Sem acesso', costCenterId: ccRI, categoryId: catMat, amountCents: 100, competence: month, dueDate: today }))
      .rejects.toThrow(/não está habilitado/);
  });
});

describe('A Oficial define o alcance de cada pessoa', () => {
  it('só a Oficial define, com reautenticação; a própria Oficial não precisa; auditoria lista os centros', async () => {
    await expect(setFinanceAccess(cSubst, { userId: cCoord.principal.userId, all: true, costCenterIds: [], reason: 'Tentativa indevida' })).rejects.toThrow();
    await expect(setFinanceAccess({ ...cOwner, stepUpAt: null }, { userId: cCoord.principal.userId, all: false, costCenterIds: [ccRI], reason: 'Coordenação do RI' })).rejects.toThrow('reautenticação');
    await expect(setFinanceAccess(cOwner, { userId: cOwner.principal.userId, all: false, costCenterIds: [], reason: 'Teste' })).rejects.toThrow(/sempre todo/);
    await setFinanceAccess(cOwner, { userId: cCoord.principal.userId, all: false, costCenterIds: [ccRI], reason: 'Coordenação do RI' });
    expect(await getFinanceAccess(cOwner, cCoord.principal.userId)).toEqual({ all: false, costCenterIds: [ccRI] });
    expect((await queryOne<{ s: string }>(getPool(), "SELECT summary AS s FROM audit_log WHERE action = 'FIN_ACESSO_DEFINIDO' ORDER BY id DESC LIMIT 1"))!.s).toContain('centros de custo RI');
  });

  it('com o centro RI, a coordenação vê e solicita só no RI; salários (PES) continuam invisíveis', async () => {
    expect((await listExpenses(cCoord, {})).map((e) => e.id)).toEqual([eRI]);
    await expect(getExpense(cCoord, ePES)).rejects.toThrow(/não encontrada/);
    await requestExpense(cCoord, { kind: 'VARIAVEL', description: 'Toner', costCenterId: ccRI, categoryId: catMat, amountCents: 900, competence: month, dueDate: today });
    await expect(requestExpense(cCoord, { kind: 'VARIAVEL', description: 'Fora', costCenterId: ccPES, categoryId: catMat, amountCents: 900, competence: month, dueDate: today }))
      .rejects.toThrow(/não está habilitado/);
  });

  it('Substituta com o RI aprova no RI, mas não alcança o PES; avisos de aprovação só para quem alcança o centro', async () => {
    await setFinanceAccess(cOwner, { userId: cSubst.principal.userId, all: false, costCenterIds: [ccRI], reason: 'Aprova o RI' });
    await decideExpense(cSubst, eRI, true, 'Ok');
    await expect(decideExpense(cSubst, ePES, true)).rejects.toThrow(/não encontrada/);
    expect((await listRecurring(cSubst)).map((r) => r.description)).toEqual(['Papelaria mensal']);
    await requestExpense(cCoord, { kind: 'VARIAVEL', description: 'Aviso RI', costCenterId: ccRI, categoryId: catMat, amountCents: 700, competence: month, dueDate: today });
    const notified = await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'FIN_APROVACAO' AND body = 'Aviso RI'", [cSubst.principal.userId]);
    expect(notified!.n).toBe(1);
  });

  it('"ver todo o financeiro" (administração) libera tudo; retirar volta a esconder; cadeia íntegra', async () => {
    await setFinanceAccess(cOwner, { userId: cSubst.principal.userId, all: true, costCenterIds: [], reason: 'Administração' });
    expect((await listExpenses(cSubst, {})).length).toBeGreaterThanOrEqual(3);
    await listRevenues(cSubst);
    expect(await listRecurring(cSubst)).toHaveLength(2);
    await setFinanceAccess(cOwner, { userId: cSubst.principal.userId, all: false, costCenterIds: [], reason: 'Retirado' });
    expect(await hasFinanceAccess(getPool(), cSubst.principal)).toBe(false);
    expect(await listExpenses(cSubst, {})).toHaveLength(0);
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
