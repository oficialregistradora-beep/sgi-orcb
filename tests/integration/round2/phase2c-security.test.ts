import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import { reviewVacationPeriod } from '../../../src/server/modules/vacation.ts';
import { listTemplates, newVersion } from '../../../src/server/modules/checklistTemplates.ts';
import { createRule, validateRule } from '../../../src/server/modules/legalRules.ts';
import { acquisitivePeriods } from '../../../src/domain/vacation.ts';
import { addDays, todayLocal } from '../../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';

let I: Awaited<ReturnType<typeof ids>>;
let ctxOwner: Ctx, ctxSubst: Ctx;
let emp: { userId: string; employeeId: string };
const today = todayLocal();
const adm = addDays(today, -420);

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  const owner = await makePerson({ name: 'Oficial Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true, admission: adm });
  const subst = await makePerson({ name: 'Substituta Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }], admission: adm });
  emp = await makePerson({ name: 'Func', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }], admission: adm, scheduleId: I.schedule });
  await query(getPool(), "INSERT INTO absences (employee_id, type, start_date, end_date) VALUES ($1,'OUTRO',$2,$3)", [emp.employeeId, adm, addDays(today, -1)]);
  ctxOwner = await ctxFor(owner.userId);
  ctxSubst = await ctxFor(subst.userId);
});
afterAll(closePool);

describe('Rodada 2 — Fase 2c', () => {
  it('conferências simultâneas do mesmo período: apenas uma vigente', async () => {
    const start = acquisitivePeriods(adm, today)[0]!.start;
    await Promise.allSettled([
      reviewVacationPeriod(ctxSubst, { employeeId: emp.employeeId, periodStart: start }),
      reviewVacationPeriod(ctxOwner, { employeeId: emp.employeeId, periodStart: start }),
    ]);
    const n = await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM vacation_period_reviews WHERE employee_id = $1 AND superseded_at IS NULL', [emp.employeeId]);
    expect(n!.n).toBe(1);
    await expect(getPool().query('DELETE FROM vacation_period_reviews WHERE employee_id = $1', [emp.employeeId])).rejects.toThrow(/imutável/);
  });

  it('rascunhos simultâneos do mesmo modelo: apenas um', async () => {
    const pub = (await listTemplates(ctxOwner)).find((t) => t.kind === 'ADMISSAO' && t.status === 'PUBLICADO')!;
    const res = await Promise.allSettled([newVersion(ctxOwner, pub.id), newVersion(ctxSubst, pub.id)]);
    expect(res.filter((r) => r.status === 'fulfilled').length).toBe(1);
  });

  it('validações simultâneas de regras sobrepostas: apenas uma passa a valer', async () => {
    const a = await createRule(ctxOwner, { code: 'DIVISOR_SALARIO_HORAS', value: { horas: 220 }, validFrom: today, legalBasis: 'Teste A', source: 'Teste' });
    const b = await createRule(ctxOwner, { code: 'DIVISOR_SALARIO_HORAS', value: { horas: 200 }, validFrom: today, legalBasis: 'Teste B', source: 'Teste' });
    await Promise.allSettled([
      validateRule(ctxOwner, { ruleId: a, validatedBy: 'Advogada Fictícia — OAB/SC 00000', validatedAt: today }),
      validateRule(ctxOwner, { ruleId: b, validatedBy: 'Advogada Fictícia — OAB/SC 00000', validatedAt: today }),
    ]);
    const n = await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM legal_rules WHERE code = 'DIVISOR_SALARIO_HORAS' AND status = 'VALIDADO'");
    expect(n!.n).toBe(1);
  });
});
