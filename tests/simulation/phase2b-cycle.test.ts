import { writeFileSync, mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../src/server/db.ts';
import type { Ctx } from '../../src/server/context.ts';
import { closeShift, oncallReport, registerCall } from '../../src/server/modules/oncall.ts';
import { getBankOverview } from '../../src/server/modules/hourbank.ts';
import { ensureProcessed } from '../../src/server/modules/timeclock.ts';
import { getVacationOverview } from '../../src/server/modules/vacation.ts';
import { computeOncall } from '../../src/domain/oncall.ts';
import { validateVacation, acquisitivePeriods, type Allocation } from '../../src/domain/vacation.ts';
import { addDays, formatHHMM, localToInstant, monthRange, todayLocal, weekdayOf } from '../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../helpers.ts';

// RODADA 3 (Fase 2b) — seis meses de plantões RCPN e dois anos de programação de férias, com invariantes.

const today = todayLocal();
const start = addDays(today, -183);
let ctxSubst: Ctx;
const team: { name: string; userId: string; employeeId: string; ctx: Ctx }[] = [];
const metrics: Record<string, number> = {};
const bump = (k: string, n = 1) => (metrics[k] = (metrics[k] ?? 0) + n);
let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

beforeAll(async () => {
  await resetDatabase();
  const I = await ids();
  await makePerson({ name: 'Oficial Simulada', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true, admission: start });
  const subst = await makePerson({ name: 'Substituta Simulada', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }], admission: start });
  ctxSubst = await ctxFor(subst.userId);
  for (const name of ['RCPN Um', 'RCPN Dois', 'RCPN Tres']) {
    const p = await makePerson({ name, sectorId: I.sectors.RCPN, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }], admission: addDays(today, -900), scheduleId: I.schedule, agreementMonths: 6 });
    // Ausência abonada nos dias úteis do período (foco nos plantões), exceto férias tratadas abaixo.
    await query(getPool(), "INSERT INTO absences (employee_id, type, start_date, end_date) VALUES ($1,'OUTRO',$2,$3)", [p.employeeId, addDays(today, -900), addDays(today, -1)]);
    team.push({ name, ...p, ctx: await ctxFor(p.userId) });
  }
}, 120_000);

afterAll(async () => {
  mkdirSync('docs/test-reports', { recursive: true });
  writeFileSync('docs/test-reports/rodada3-fase2b-metricas.json', JSON.stringify({ executadoEm: new Date().toISOString(), periodo: { de: start, ate: addDays(today, -1) }, metricas: metrics }, null, 2));
  await closePool();
});

describe('Rodada 3 — Fase 2b', () => {
  it('seis meses de plantões: chamados, fechamento e invariantes de sobreaviso/efetivo/banco', async () => {
    const holidays = new Set((await query<{ date: string }>(getPool(), 'SELECT date FROM holidays WHERE is_day_off')).map((h) => h.date));
    let k = 0;
    const expected = new Map<string, { standby: number; bank: number; paid: number }>();
    for (let d = start; d < today; d = addDays(d, 1)) {
      if (weekdayOf(d) !== 0 && weekdayOf(d) !== 6 && !holidays.has(d)) continue;
      const resp = team[k % 3]!;
      k++;
      const shiftId = (await queryOne<{ id: string }>(getPool(),
        'INSERT INTO oncall_shifts (shift_date, starts_at, ends_at, employee_id, substitute_employee_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [d, localToInstant(d, '08:00'), localToInstant(d, '18:00'), resp.employeeId, team[k % 3]!.employeeId]))!.id;
      bump('plantoes');
      const calls: { attended: boolean; arrival: Date | null; departure: Date | null; voided: boolean }[] = [];
      const n = Math.floor(rnd() * 3);
      for (let c = 0; c < n; c++) {
        const h = 8 * 60 + 15 + Math.floor(rnd() * 500);
        const attended = rnd() < 0.6;
        const arr = Math.min(h + 20, 17 * 60 + 30);
        const dep = arr + 30 + Math.floor(rnd() * 90);
        if (h >= 18 * 60) continue;
        await registerCall(resp.ctx, {
          shiftId, calledAt: formatHHMM(h), respondedAt: formatHHMM(h + 3), attended,
          arrivalAt: attended ? formatHHMM(arr) : undefined, departureAt: attended ? formatHHMM(Math.min(dep, 23 * 60)) : undefined,
          description: attended ? 'Registro de nascimento (simulação)' : 'Orientação por telefone (simulação)',
        });
        calls.push({ attended, arrival: attended ? localToInstant(d, formatHHMM(arr)) : null, departure: attended ? localToInstant(d, formatHHMM(Math.min(dep, 23 * 60))) : null, voided: false });
        bump(attended ? 'chamados_com_comparecimento' : 'chamados_sem_comparecimento');
      }
      const t = computeOncall(localToInstant(d, '08:00'), localToInstant(d, '18:00'), calls);
      const destination = t.effectiveMinutes > 0 ? (rnd() < 0.7 ? 'BANCO' : 'PAGAMENTO') : undefined;
      const r = await closeShift(ctxSubst, { shiftId, destination });
      expect(r).toEqual({ standby: t.standbyMinutes, effective: t.effectiveMinutes });
      const e = expected.get(resp.employeeId) ?? { standby: 0, bank: 0, paid: 0 };
      e.standby += t.standbyMinutes;
      if (destination === 'BANCO') e.bank += t.effectiveMinutes;
      if (destination === 'PAGAMENTO') e.paid += t.effectiveMinutes;
      expected.set(resp.employeeId, e);
    }
    // Invariante 1: banco de horas de cada plantonista = soma do efetivo destinado ao banco (créditos ainda não consumidos).
    for (const m of team) {
      await ensureProcessed(m.employeeId);
      const ov = await getBankOverview(ctxSubst, m.employeeId);
      expect(ov.summary.balance, m.name).toBe(expected.get(m.employeeId)?.bank ?? 0);
      // Invariante 2: nenhuma ocorrência comum nos dias de plantão do próprio plantonista.
      const occ = await queryOne<{ n: number }>(getPool(),
        `SELECT count(*)::int AS n FROM daily_occurrences o JOIN oncall_shifts s ON s.shift_date = o.work_date AND s.employee_id = o.employee_id
          WHERE o.employee_id = $1 AND o.status <> 'SUPERADA'`, [m.employeeId]);
      expect(occ!.n).toBe(0);
    }
    // Invariante 3: relatório mensal soma exatamente os plantões fechados (sobreaviso e efetivo separados).
    const totals = new Map<string, { standby: number; bank: number; paid: number }>();
    for (let m = start.slice(0, 7); m <= addDays(today, -1).slice(0, 7); m = monthRange(m).to === m ? m : addDays(monthRange(m).to, 1).slice(0, 7)) {
      for (const r of await oncallReport(ctxSubst, m)) {
        const t = totals.get(r.employee_id) ?? { standby: 0, bank: 0, paid: 0 };
        t.standby += r.standby_minutes; t.bank += r.effective_bank; t.paid += r.effective_paid;
        totals.set(r.employee_id, t);
      }
    }
    for (const [emp, e] of expected) expect(totals.get(emp), emp).toEqual(e);
    metrics.minutos_sobreaviso = [...expected.values()].reduce((a, e) => a + e.standby, 0);
    metrics.minutos_efetivo_banco = [...expected.values()].reduce((a, e) => a + e.bank, 0);
    metrics.minutos_efetivo_pagamento = [...expected.values()].reduce((a, e) => a + e.paid, 0);
  }, 600_000);

  it('dois anos de programação de férias: saldo nunca negativo, máximo de 3 frações e uma de 14+ por período', async () => {
    // Simulação pura sobre o domínio (datas sintéticas), seguida de conferência das regras para cada período.
    const admission = '2022-01-03';
    const allocations: Allocation[] = [];
    let cursor = '2023-02-06';
    const holidays = new Set<string>();
    let attempts = 0;
    while (cursor < '2025-12-01' && attempts < 200) {
      attempts++;
      const days = [30, 20, 14, 10, 5, 15][Math.floor(rnd() * 6)]!;
      let s = cursor;
      while (weekdayOf(addDays(s, 1)) === 0 || weekdayOf(addDays(s, 2)) === 0) s = addDays(s, 1);
      try {
        const r = validateVacation({ admission, today: addDays(s, -45), start: s, end: addDays(s, days - 1), soldDays: 0, allocations, holidays, minNoticeDays: 30 });
        allocations.push({ periodStart: r.period.start, enjoyedDays: r.days, soldDays: 0, startDate: s });
        bump('ferias_simuladas_aceitas');
        cursor = addDays(s, days + 60 + Math.floor(rnd() * 60));
      } catch {
        bump('ferias_simuladas_recusadas');
        cursor = addDays(cursor, 7);
      }
    }
    for (const p of acquisitivePeriods(admission, '2025-12-01')) {
      const mine = allocations.filter((a) => a.periodStart === p.start);
      const used = mine.reduce((a, x) => a + x.enjoyedDays, 0);
      expect(used).toBeLessThanOrEqual(30);
      expect(mine.length).toBeLessThanOrEqual(3);
      if (used === 30 && mine.length > 1) expect(mine.some((x) => x.enjoyedDays >= 14)).toBe(true);
      for (const x of mine) expect(x.enjoyedDays).toBeGreaterThanOrEqual(5);
      for (const x of mine) expect(x.startDate > p.end).toBe(true); // só após completar o período aquisitivo
    }
    expect(metrics.ferias_simuladas_aceitas).toBeGreaterThan(3);
  });

  it('visão de férias pelo serviço respeita o escopo e reflete o histórico', async () => {
    const ov = await getVacationOverview(team[0]!.ctx, team[0]!.employeeId);
    expect(ov.periods.length).toBeGreaterThanOrEqual(2);
    await expect(getVacationOverview(team[0]!.ctx, team[1]!.employeeId)).rejects.toThrow('permissão');
  });
});
