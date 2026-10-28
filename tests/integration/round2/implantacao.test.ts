import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import { createEmployee, setControlStart } from '../../../src/server/modules/people.ts';
import { ensureProcessed } from '../../../src/server/modules/timeclock.ts';
import { createRequest, decideRequest } from '../../../src/server/modules/requests.ts';
import {
  cancelPriorVacation, getVacationOverview, registerPriorVacation, requestVacation, reviewVacationPeriod, teamVacations,
} from '../../../src/server/modules/vacation.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { addDays, addMonths, todayLocal, weekdayOf } from '../../../src/domain/time.ts';
import { closePool, ctxFor, DOMAIN, ids, makePerson, resetDatabase, seedPunches } from '../../helpers.ts';

// Implantação com funcionários já em atividade: início do controle no sistema e férias anteriores à implantação.
const today = todayLocal();
let I: Awaited<ReturnType<typeof ids>>;
let cOwner: Ctx, cSubst: Ctx;
let legacyId: string;
const admission = addMonths(today, -38); // três períodos aquisitivos completos
const implant = addDays(today, -20);

async function isHoliday(d: string) { return !!(await queryOne(getPool(), 'SELECT 1 FROM holidays WHERE date = $1', [d])); }
async function vacationMonday(minDays: number): Promise<string> {
  let d = addDays(today, minDays);
  while (weekdayOf(d) !== 1 || (await isHoliday(addDays(d, 1))) || (await isHoliday(addDays(d, 2)))) d = addDays(d, 1);
  return d;
}
const records = async (id: string) => (await queryOne<{ n: number; first: string | null }>(getPool(),
  'SELECT count(*)::int AS n, min(work_date) AS first FROM daily_records WHERE employee_id = $1', [id]))!;

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  cOwner = await ctxFor((await makePerson({ name: 'Oficial', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true })).userId);
  cSubst = await ctxFor((await makePerson({ name: 'Substituta', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] })).userId);
});
afterAll(closePool);

describe('Implantação — início do controle no sistema', () => {
  const base = () => ({ registrationCode: `L${Math.floor(Math.random() * 1e6)}`, fullName: 'Antiga Funcionária', jobTitleId: I.jobs.escrevente,
    sectorId: I.sectors.RI, admissionDate: admission, contractType: 'CLT' as const, weeklyHours: 40, scheduleId: I.schedule });

  it('admissão antiga exige o início do controle; nova admissão não', async () => {
    await expect(createEmployee(cOwner, base())).rejects.toThrow(/início do controle/);
    await expect(createEmployee(cOwner, { ...base(), controlStartDate: addDays(admission, -1) })).rejects.toThrow(/anterior à admissão/);
    const recent = await createEmployee(cOwner, { ...base(), admissionDate: addDays(today, -10) });
    expect((await queryOne<{ c: string | null }>(getPool(), 'SELECT control_start_date AS c FROM employees WHERE id = $1', [recent]))!.c).toBeNull();
    legacyId = await createEmployee(cOwner, { ...base(), email: `antiga@${DOMAIN}`, controlStartDate: implant });
  });

  it('apuração começa no início do controle: nenhum dia anterior vira falta', async () => {
    await ensureProcessed(legacyId);
    const r = await records(legacyId);
    expect(r.first).toBe(implant);
    expect(r.n).toBe(20);
    const before = (await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM daily_occurrences WHERE employee_id = $1 AND work_date < $2', [legacyId, implant]))!.n;
    expect(before).toBe(0);
  });

  it('correção de marcação anterior ao controle é recusada', async () => {
    await expect(createRequest(cOwner, { type: 'CORRECAO_PONTO', employeeId: legacyId, referenceDate: addDays(implant, -3),
      payload: { action: 'INCLUIR', time: '08:00' }, justification: 'Teste de implantação' })).rejects.toThrow(/início do controle/);
  });

  it('alterar o início: descarta apuração anterior; recusado se houver marcações antes da nova data', async () => {
    const later = addDays(implant, 5);
    await setControlStart(cOwner, legacyId, { date: later, reason: 'Ajuste da data de implantação' });
    expect((await records(legacyId)).first).toBe(later);
    await setControlStart(cOwner, legacyId, { date: implant, reason: 'Volta à data original' }); // anterior: reapura o intervalo
    expect((await records(legacyId)).first).toBe(implant);
    await seedPunches(legacyId, addDays(implant, 1), ['08:00', '12:00'], cOwner.principal.userId);
    await expect(setControlStart(cOwner, legacyId, { date: addDays(implant, 3), reason: 'Teste com marcações' })).rejects.toThrow(/marcações/);
    await expect(setControlStart(cOwner, legacyId, { date: addDays(admission, -1), reason: 'Antes da admissão' })).rejects.toThrow(/admissão/);
  });
});

describe('Implantação — férias anteriores', () => {
  it('lança férias já gozadas e quita os períodos; recusa excesso, datas após a implantação e período não encerrado', async () => {
    const ov = await getVacationOverview(cOwner, legacyId);
    expect(ov.controlStart).toBe(implant);
    const [p1, p2] = ov.periods;
    const note = 'Recibos de férias na pasta funcional';
    await registerPriorVacation(cOwner, { employeeId: legacyId, periodStart: p1!.start, startDate: addDays(p1!.end, 30), enjoyedDays: 30, soldDays: 0, note });
    await expect(registerPriorVacation(cOwner, { employeeId: legacyId, periodStart: p1!.start, startDate: addDays(p1!.end, 90), enjoyedDays: 5, soldDays: 0, note }))
      .rejects.toThrow(/direito a 30/);
    await expect(registerPriorVacation(cOwner, { employeeId: legacyId, periodStart: p2!.start, startDate: implant, enjoyedDays: 20, soldDays: 0, note }))
      .rejects.toThrow(/antes do início do controle/);
    await expect(registerPriorVacation(cOwner, { employeeId: legacyId, periodStart: p2!.start, startDate: addDays(p2!.end, -5), enjoyedDays: 20, soldDays: 0, note }))
      .rejects.toThrow(/depois que ele termina/);
    await expect(registerPriorVacation(cSubst, { employeeId: legacyId, periodStart: p2!.start, startDate: addDays(p2!.end, 10), enjoyedDays: 20, soldDays: 0, note: 'x' }))
      .rejects.toThrow();
    const id2 = await registerPriorVacation(cSubst, { employeeId: legacyId, periodStart: p2!.start, startDate: addDays(p2!.end, 10), enjoyedDays: 20, soldDays: 10, note });
    const after = await getVacationOverview(cOwner, legacyId);
    expect(after.prior).toHaveLength(2);
    expect(after.periods.slice(0, 2).map((p) => p.remaining)).toEqual([0, 0]);
    const alerts = (await teamVacations(cOwner))!.alerts.filter((a) => a.employeeId === legacyId);
    expect(alerts.every((a) => a.period >= 3)).toBe(true);
    await expect(query(getPool(), 'DELETE FROM vacation_allocations WHERE id = $1', [id2])).rejects.toThrow();
    await cancelPriorVacation(cOwner, id2, 'Lançado no período errado');
    expect((await getVacationOverview(cOwner, legacyId)).periods[1]!.remaining).toBe(30);
    await registerPriorVacation(cOwner, { employeeId: legacyId, periodStart: p2!.start, startDate: addDays(p2!.end, 10), enjoyedDays: 30, soldDays: 0, note });
  });

  it('conferência do art. 130 aceita faltas do controle anterior (só para período anterior à implantação)', async () => {
    const ov = await getVacationOverview(cOwner, legacyId);
    const p3 = ov.periods[2]!;
    await expect(reviewVacationPeriod(cOwner, { employeeId: legacyId, periodStart: p3.start, priorUnjustifiedDays: 8 })).rejects.toThrow(/origem/);
    const r = await reviewVacationPeriod(cOwner, { employeeId: legacyId, periodStart: p3.start, priorUnjustifiedDays: 8, notes: 'Livro de ponto anterior: 8 faltas' });
    expect(r.entitlement).toBe(24); // 6 a 14 faltas → 24 dias
    const rv = (await queryOne<{ calculation: Record<string, unknown> }>(getPool(),
      'SELECT calculation FROM vacation_period_reviews WHERE employee_id = $1 AND period_start = $2 AND superseded_at IS NULL', [legacyId, p3.start]))!;
    expect(rv.calculation).toMatchObject({ faltasAnterioresImplantacao: 8, inicioControle: implant, direitoFinal: 24 });
  });

  it('férias do período seguinte seguem pela solicitação normal e a trilha fica íntegra', async () => {
    const start = await vacationMonday(40);
    const r = await requestVacation(cOwner, { employeeId: legacyId, start, end: addDays(start, 23), soldDays: 0 });
    await decideRequest(cSubst, { requestId: r.id, approve: true, notes: 'Teste' });
    const ov = await getVacationOverview(cOwner, legacyId);
    expect(ov.periods[2]!.remaining).toBe(0);
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
