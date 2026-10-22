import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import { generateSchedule, getShift, listShifts, closeShift } from '../../../src/server/modules/oncall.ts';
import { requestVacation } from '../../../src/server/modules/vacation.ts';
import { decideRequest } from '../../../src/server/modules/requests.ts';
import { deliverItem, listChecklists, listEmployeeItems } from '../../../src/server/modules/checklists.ts';
import { addDays, addMonths, localToInstant, todayLocal, weekdayOf } from '../../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';

let I: Awaited<ReturnType<typeof ids>>;
type P = { userId: string; employeeId: string };
let owner: P, subst: P, a: P, b: P, coordAtd: P;
let ctxOwner: Ctx, ctxSubst: Ctx, ctxA: Ctx, ctxB: Ctx, ctxCoordAtd: Ctx;
const today = todayLocal();

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  const adm = addDays(today, -500);
  owner = await makePerson({ name: 'Oficial Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true, admission: adm });
  subst = await makePerson({ name: 'Substituta Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }], admission: adm });
  a = await makePerson({ name: 'Func A', sectorId: I.sectors.RCPN, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }], admission: adm, scheduleId: I.schedule, agreementMonths: 6 });
  b = await makePerson({ name: 'Func B', sectorId: I.sectors.RCPN, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }], admission: adm, scheduleId: I.schedule, agreementMonths: 6 });
  coordAtd = await makePerson({ name: 'Coord ATD', sectorId: I.sectors.ATD, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COORDENACAO_SETOR }, { roleId: I.roles.COLABORADOR }], admission: adm });
  ctxOwner = await ctxFor(owner.userId);
  ctxSubst = await ctxFor(subst.userId);
  ctxA = await ctxFor(a.userId);
  ctxB = await ctxFor(b.userId);
  ctxCoordAtd = await ctxFor(coordAtd.userId);
  for (const p of [a, b]) await query(getPool(), "INSERT INTO absences (employee_id, type, start_date, end_date) VALUES ($1,'OUTRO',$2,$3)", [p.employeeId, adm, addDays(today, -1)]);
});
afterAll(closePool);

async function monday(min: number) {
  let d = addDays(today, min);
  while (weekdayOf(d) !== 1 || (await queryOne(getPool(), 'SELECT 1 FROM holidays WHERE date IN ($1,$2)', [addDays(d, 1), addDays(d, 2)]))) d = addDays(d, 1);
  return d;
}

describe('Rodada 2 — Fase 2b', () => {
  it('pedidos de férias simultâneos não excedem o saldo do período', async () => {
    const s1 = await monday(40);
    const s2 = await monday(80);
    // 3 pedidos de 20 dias em paralelo: há 1 período completo (30 dias) — no máximo um pode usá-lo integralmente
    const res = await Promise.allSettled([s1, s2, addDays(s2, 35)].map((s) => requestVacation(ctxA, { start: s, end: addDays(s, 19), soldDays: 0 })));
    const ok = res.filter((r) => r.status === 'fulfilled').length;
    const reserved = await query<{ payload: { periodStart: string; days: number } }>(getPool(), "SELECT payload FROM requests WHERE employee_id = $1 AND type = 'FERIAS' AND status = 'PENDENTE'", [a.employeeId]);
    const byPeriod = new Map<string, number>();
    for (const r of reserved) byPeriod.set(r.payload.periodStart, (byPeriod.get(r.payload.periodStart) ?? 0) + r.payload.days);
    for (const v of byPeriod.values()) expect(v).toBeLessThanOrEqual(30);
    expect(ok).toBeLessThan(3);
  });

  it('geração simultânea de escala não duplica plantões no mesmo dia', async () => {
    const period = addMonths(`${today.slice(0, 7)}-01`, 2).slice(0, 7);
    await Promise.allSettled([
      generateSchedule(ctxSubst, { period, participants: [a.employeeId, b.employeeId] }),
      generateSchedule(ctxOwner, { period, participants: [b.employeeId, a.employeeId] }),
    ]);
    const dup = await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM (SELECT shift_date FROM oncall_shifts WHERE status <> 'CANCELADO' GROUP BY shift_date HAVING count(*) > 1) x");
    expect(dup!.n).toBe(0);
  });

  it('coordenação de outro setor não vê nem fecha plantões do RCPN; colaborador não vê plantão alheio (IDOR)', async () => {
    const period = addMonths(`${today.slice(0, 7)}-01`, 2).slice(0, 7);
    expect(await listShifts(ctxCoordAtd, period)).toEqual([]);
    const shifts = await listShifts(ctxSubst, period);
    const notMine = shifts.find((s) => s.employee_id !== a.employeeId && s.substitute_employee_id !== a.employeeId);
    if (notMine) await expect(getShift(ctxA, notMine.id)).rejects.toThrow('permissão');
    let sat = addDays(today, -1);
    while (weekdayOf(sat) !== 6) sat = addDays(sat, -1);
    const past = (await queryOne<{ id: string }>(getPool(), 'INSERT INTO oncall_shifts (shift_date, starts_at, ends_at, employee_id) VALUES ($1,$2,$3,$4) RETURNING id',
      [sat, localToInstant(sat, '08:00'), localToInstant(sat, '18:00'), b.employeeId]))!.id;
    await expect(closeShift(ctxCoordAtd, { shiftId: past })).rejects.toThrow('permissão');
    await expect(closeShift(ctxB, { shiftId: past })).rejects.toThrow('permissão');
  });

  it('autoaprovação de férias bloqueada; checklists e itens restritos', async () => {
    const s = await monday(120);
    const r = await requestVacation(ctxB, { start: s, end: addDays(s, 29), soldDays: 0 });
    await expect(decideRequest(ctxB, { requestId: r.id, approve: true })).rejects.toThrow();
    await expect(listChecklists(ctxA, b.employeeId)).rejects.toThrow('permissão');
    await expect(listEmployeeItems(ctxA, b.employeeId)).rejects.toThrow('permissão');
    await expect(deliverItem(ctxA, a.employeeId, { kind: 'OUTRO', description: 'Autoentrega', quantity: 1, deliveredAt: today })).rejects.toThrow('permissão');
  });

  it('plantão fechado e chamados são imutáveis no banco; exclusões bloqueadas', async () => {
    let sat = addDays(today, -8);
    while (weekdayOf(sat) !== 6) sat = addDays(sat, -1);
    const id = (await queryOne<{ id: string }>(getPool(), 'INSERT INTO oncall_shifts (shift_date, starts_at, ends_at, employee_id) VALUES ($1,$2,$3,$4) RETURNING id',
      [sat, localToInstant(sat, '08:00'), localToInstant(sat, '18:00'), a.employeeId]))!.id;
    await query(getPool(), 'INSERT INTO oncall_calls (shift_id, called_at, attended, description, registered_by) VALUES ($1,$2,false,$3,$4)',
      [id, localToInstant(sat, '09:00'), 'Orientação', a.userId]);
    await expect(getPool().query('UPDATE oncall_calls SET description = $1 WHERE shift_id = $2', ['Alterado', id])).rejects.toThrow(/imutável/);
    await expect(getPool().query('DELETE FROM oncall_calls WHERE shift_id = $1', [id])).rejects.toThrow(/não podem ser excluídos/);
    await expect(getPool().query('DELETE FROM oncall_shifts WHERE id = $1', [id])).rejects.toThrow(/não podem ser excluídos/);
    await closeShift(ctxSubst, { shiftId: id });
    await expect(getPool().query("UPDATE oncall_shifts SET standby_minutes = 1 WHERE id = $1", [id])).rejects.toThrow(/imutável/);
  });
});
