import { writeFileSync, mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../src/server/db.ts';
import type { Ctx } from '../../src/server/context.ts';
import { listOccurrences, resolveOccurrence } from '../../src/server/modules/hourbank.ts';
import { ensureProcessed } from '../../src/server/modules/timeclock.ts';
import { getVacationOverview, requestVacation, reviewVacationPeriod } from '../../src/server/modules/vacation.ts';
import { decideRequest } from '../../src/server/modules/requests.ts';
import { acquisitivePeriods, entitlementForAbsences } from '../../src/domain/vacation.ts';
import { addDays, todayLocal, weekdayOf } from '../../src/domain/time.ts';
import { closePool, ctxFor, FULL_DAY, ids, makePerson, resetDatabase, seedPunches } from '../helpers.ts';

// RODADA 3 (Fase 2c) — um ano de frequência para 5 funcionários, cada um em uma faixa do art. 130.

const today = todayLocal();
const adm = addDays(today, -380);
let ctxSubst: Ctx;
const people: { name: string; userId: string; employeeId: string; target: number; ctx: Ctx }[] = [];
const metrics: Record<string, number> = {};
let seed = 23;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

beforeAll(async () => {
  await resetDatabase();
  const I = await ids();
  await makePerson({ name: 'Oficial Simulada', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true, admission: adm });
  const subst = await makePerson({ name: 'Substituta Simulada', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }], admission: adm });
  ctxSubst = await ctxFor(subst.userId);
  const holidays = new Set((await query<{ date: string }>(getPool(), 'SELECT date FROM holidays WHERE is_day_off')).map((h) => h.date));
  const period = acquisitivePeriods(adm, today)[0]!;
  for (const [name, target] of [['Faixa 30', 4], ['Faixa 24', 10], ['Faixa 18', 20], ['Faixa 12', 28], ['Perda', 35]] as const) {
    const p = await makePerson({ name, sectorId: I.sectors.ATD, jobId: I.jobs.atendente, roles: [{ roleId: I.roles.COLABORADOR }], admission: adm, scheduleId: I.schedule });
    const workdays: string[] = [];
    for (let d = period.start; d <= period.end; d = addDays(d, 1)) if (weekdayOf(d) !== 0 && weekdayOf(d) !== 6 && !holidays.has(d)) workdays.push(d);
    // Sorteia dias de falta integral (alvo injustificado + alguns abonados) e de atraso.
    const shuffled = [...workdays].sort(() => rnd() - 0.5);
    const abonadas = 3;
    const faltas = new Set(shuffled.slice(0, target + abonadas));
    const atrasos = new Set(shuffled.slice(target + abonadas, target + abonadas + 8));
    for (const d of workdays) {
      if (faltas.has(d)) continue;
      await seedPunches(p.employeeId, d, atrasos.has(d) ? ['09:15', '12:00', '13:00', '17:00'] : FULL_DAY, subst.userId);
    }
    // Após o período: ausência abonada até ontem (foco no período 1).
    await query(getPool(), "INSERT INTO absences (employee_id, type, start_date, end_date) VALUES ($1,'OUTRO',$2,$3)", [p.employeeId, addDays(period.end, 1), addDays(today, -1)]);
    people.push({ name, ...p, target, ctx: await ctxFor(p.userId) });
    metrics.dias_uteis_por_pessoa = workdays.length;
  }
}, 600_000);

afterAll(async () => {
  mkdirSync('docs/test-reports', { recursive: true });
  writeFileSync('docs/test-reports/rodada3-fase2c-metricas.json', JSON.stringify({ executadoEm: new Date().toISOString(), metricas: metrics }, null, 2));
  await closePool();
});

describe('Rodada 3 — Fase 2c (art. 130)', () => {
  it('decisões, conferência e direito de férias conferem com a faixa esperada para cada funcionário', async () => {
    for (const p of people) {
      await ensureProcessed(p.employeeId);
      const pending = (await listOccurrences(ctxSubst, { employeeId: p.employeeId, status: 'PENDENTE' })).filter((o) => o.type === 'DIFERENCA_NEGATIVA');
      // Faltas integrais: as 3 primeiras abonadas, as demais injustificadas; atrasos: decididos como não justificados (não contam).
      const full = pending.filter((o) => o.minutes === 480);
      const partial = pending.filter((o) => o.minutes !== 480);
      for (const [i, o] of full.entries()) await resolveOccurrence(ctxSubst, { occurrenceId: o.id, resolution: i < 3 ? 'ABONO' : 'FALTA_NAO_JUSTIFICADA', notes: 'Simulação' });
      for (const o of partial) await resolveOccurrence(ctxSubst, { occurrenceId: o.id, resolution: 'FALTA_NAO_JUSTIFICADA', notes: 'Atraso (simulação)' });
      metrics[`${p.name}_faltas_integrais`] = full.length;
      metrics[`${p.name}_atrasos`] = partial.length;
      const periodStart = acquisitivePeriods(adm, today)[0]!.start;
      const r = await reviewVacationPeriod(ctxSubst, { employeeId: p.employeeId, periodStart });
      expect(full.length - 3, p.name).toBe(p.target);
      expect(r.entitlement, p.name).toBe(entitlementForAbsences(p.target));
      const ov = await getVacationOverview(p.ctx, p.employeeId);
      expect(ov.periods[0]!.entitlement).toBe(r.entitlement);
      expect(ov.absences.get(periodStart)!.partialNotCounted).toBe(partial.length);
      metrics[`${p.name}_direito`] = r.entitlement;
      if (r.entitlement > 0) {
        let s = addDays(today, 40);
        while (weekdayOf(s) !== 1) s = addDays(s, 1);
        const req = await requestVacation(p.ctx, { start: s, end: addDays(s, r.entitlement - 1), soldDays: 0 });
        await decideRequest(ctxSubst, { requestId: req.id, approve: true });
        expect((await getVacationOverview(p.ctx, p.employeeId)).periods[0]!.remaining).toBe(0);
      } else {
        expect((await getVacationOverview(p.ctx, p.employeeId)).periods[0]!.status).toBe('PERDIDO');
      }
    }
    const alloc = await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM vacation_allocations WHERE cancelled_at IS NULL');
    expect(alloc!.n).toBe(4);
  }, 600_000);
});
