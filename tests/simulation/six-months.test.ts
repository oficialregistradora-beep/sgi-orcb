import { writeFileSync, mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../src/server/db.ts';
import type { Ctx } from '../../src/server/context.ts';
import { verifyAuditChain } from '../../src/server/audit.ts';
import { addAbsence, createEmployee, terminateEmployee, createAgreement } from '../../src/server/modules/people.ts';
import { ensureProcessed, ensureProcessedAll } from '../../src/server/modules/timeclock.ts';
import { closePeriod, getBankOverview, listOccurrences, registerPayment, resolveOccurrence, justifyOccurrence } from '../../src/server/modules/hourbank.ts';
import { createRequest, decideRequest } from '../../src/server/modules/requests.ts';
import { prepareMonthlyDocument, signVersion, verifyVersion } from '../../src/server/modules/documents.ts';
import { getEmployeeFor } from '../../src/server/modules/people.ts';
import { activeAgreement } from '../../src/server/modules/ledger.ts';
import { addDays, addMonths, monthRange, todayLocal, weekdayOf, formatHHMM } from '../../src/domain/time.ts';
import { creditExpiry } from '../../src/domain/hourBank.ts';
import { closePool, ctxFor, DOMAIN, ids, makePerson, resetDatabase, seedPunches } from '../helpers.ts';

// RODADA 3 — Simulação operacional de ~6 meses com dados fictícios, executada pelos serviços reais.

const today = todayLocal();
const start = addDays(today, -190);
let I: Awaited<ReturnType<typeof ids>>;
let ctxOwner: Ctx, ctxSubst: Ctx;
type W = { name: string; userId: string; employeeId: string; profile: string; ctx?: Ctx; terminated?: string };
const workers: W[] = [];
const metrics: Record<string, number> = {};
const bump = (k: string, n = 1) => (metrics[k] = (metrics[k] ?? 0) + n);

let seed = 7;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

async function isOff(d: string) {
  const wd = weekdayOf(d);
  return wd === 0 || wd === 6 || !!(await queryOne(getPool(), 'SELECT 1 FROM holidays WHERE date = $1 AND is_day_off', [d]));
}

async function simulatePunches(w: W, from: string, to: string, ownerId: string) {
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (await isOff(d)) continue;
    if (await queryOne(getPool(), "SELECT 1 FROM absences WHERE employee_id = $1 AND status = 'ATIVA' AND $2 BETWEEN start_date AND end_date", [w.employeeId, d])) continue;
    const r = rnd();
    let m = [480 + Math.round(rnd() * 8 - 4), 720 + Math.round(rnd() * 4 - 2), 780 + Math.round(rnd() * 4 - 2), 1020 + Math.round(rnd() * 8 - 4)];
    if (w.profile === 'extras' && r < 0.2) { m[3] = 1050 + Math.round(rnd() * 60); bump('dias_com_extra'); }
    if (w.profile === 'atrasos' && r < 0.15) { m[0] = 500 + Math.round(rnd() * 40); bump('dias_com_atraso'); }
    if (w.profile === 'esquecido' && r < 0.07) { m = m.slice(0, 3); bump('dias_com_marcacao_esquecida'); }
    if (r > 0.99) { m = []; bump('faltas_integrais'); }
    if (m.length) await seedPunches(w.employeeId, d, m.map(formatHHMM), ownerId);
    bump('dias_uteis_simulados');
  }
}

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  const owner = await makePerson({ name: 'Oficial Simulada', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true, admission: start });
  const subst = await makePerson({ name: 'Substituta Simulada', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }, { roleId: I.roles.COLABORADOR }], admission: start });
  ctxOwner = await ctxFor(owner.userId);
  ctxSubst = await ctxFor(subst.userId);
  const specs: [string, string, string][] = [
    ['Ana RI', I.sectors.RI, 'extras'], ['Bruno RI', I.sectors.RI, 'pontual'], ['Carla RCPN', I.sectors.RCPN, 'esquecido'],
    ['Davi RTD', I.sectors.RTDPJ, 'atrasos'], ['Elisa ATD', I.sectors.ATD, 'extras'], ['Fausto ATD', I.sectors.ATD, 'pontual'],
  ];
  for (const [name, sector, profile] of specs) {
    const p = await makePerson({ name, sectorId: sector, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }], admission: start, scheduleId: I.schedule, agreementMonths: 6 });
    workers.push({ name, ...p, profile });
  }
  // Admissão no meio do período, pelo fluxo real (serviço de admissão + acordo).
  const mid = addDays(today, -80);
  const gId = await createEmployee(ctxSubst, {
    registrationCode: 'SIM-G', fullName: 'Gustavo Admitido', jobTitleId: I.jobs.atendente, sectorId: I.sectors.ATD,
    admissionDate: mid, contractType: 'CLT', weeklyHours: 40, email: `gustavo.admitido@${DOMAIN}`, scheduleId: I.schedule, controlStartDate: mid, // histórico simulado desde a admissão
  });
  const gUser = (await queryOne<{ user_id: string }>(getPool(), 'SELECT user_id FROM employees WHERE id = $1', [gId]))!.user_id;
  await createAgreement(ctxOwner, gId, { kind: 'INDIVIDUAL_ESCRITO', compensationMonths: 6, validFrom: mid, documentReference: 'Acordo simulado' });
  workers.push({ name: 'Gustavo Admitido', userId: gUser, employeeId: gId, profile: 'extras' });

  // Férias e atestado lançados pelo fluxo real.
  await addAbsence(ctxSubst, workers[1]!.employeeId, { type: 'FERIAS', startDate: addDays(start, 60), endDate: addDays(start, 74) });
  await addAbsence(ctxSubst, workers[3]!.employeeId, { type: 'ATESTADO_MEDICO', startDate: addDays(start, 100), endDate: addDays(start, 101) });

  for (const w of workers) {
    const adm = (await queryOne<{ admission_date: string }>(getPool(), 'SELECT admission_date FROM employees WHERE id = $1', [w.employeeId]))!.admission_date;
    await simulatePunches(w, adm, addDays(today, -1), owner.userId);
  }
  // Desligamento no meio do período (Fausto), com revogação de acesso.
  const fausto = workers[5]!;
  fausto.terminated = addDays(today, -40);
  await terminateEmployee(ctxOwner, fausto.employeeId, { terminationDate: fausto.terminated, reason: 'Pedido de demissão (simulação)' });
  for (const w of workers) if (!w.terminated) w.ctx = await ctxFor(w.userId);
}, 600_000);

afterAll(async () => {
  mkdirSync('docs/test-reports', { recursive: true });
  writeFileSync('docs/test-reports/rodada3-metricas.json', JSON.stringify({ executadoEm: new Date().toISOString(), periodo: { de: start, ate: addDays(today, -1) }, metricas: metrics }, null, 2));
  await closePool();
});

describe('Rodada 3 — simulação operacional de 6 meses', () => {
  it('ciclo mensal completo: correções, decisões, espelhos assinados e fechamento', async () => {
    await ensureProcessedAll();
    const months: string[] = [];
    for (let m = start.slice(0, 7); monthRange(m).to < today; m = addMonths(`${m}-01`, 1).slice(0, 7)) months.push(m);
    expect(months.length).toBeGreaterThanOrEqual(5);

    for (const period of months) {
      const { from, to } = monthRange(period);
      // 1) Marcações esquecidas: o funcionário solicita a inclusão e a coordenação aprova.
      for (const w of workers.filter((x) => x.ctx)) {
        const incompletes = (await listOccurrences(ctxSubst, { employeeId: w.employeeId, status: 'PENDENTE', from, to })).filter((o) => o.type === 'MARCACAO_INCOMPLETA');
        for (const o of incompletes) {
          const r = await createRequest(w.ctx!, { type: 'CORRECAO_PONTO', referenceDate: o.work_date, payload: { action: 'INCLUIR', time: '17:00' }, justification: 'Esqueci a saída (simulação)' });
          await decideRequest(ctxSubst, { requestId: r, approve: true });
          bump('correcoes_aprovadas');
        }
      }
      // 2) Justificativas de funcionários para algumas diferenças negativas.
      for (const w of workers.filter((x) => x.ctx)) {
        const negs = (await listOccurrences(ctxSubst, { employeeId: w.employeeId, status: 'PENDENTE', from, to })).filter((o) => o.type === 'DIFERENCA_NEGATIVA');
        for (const o of negs.filter((_, i) => i % 3 === 0)) {
          await justifyOccurrence(w.ctx!, o.id, 'Consulta médica (simulação)');
          bump('justificativas');
        }
      }
      // 3) Decisões da Substituta Legal em ordem cronológica.
      const pending = (await listOccurrences(ctxSubst, { status: 'PENDENTE', from, to })).sort((a, b) => a.work_date.localeCompare(b.work_date));
      for (const o of pending) {
        let resolution: string;
        let notes: string | undefined;
        if (o.type === 'HORA_EXTRA') {
          const ag = await activeAgreement(getPool(), o.employee_id, o.work_date);
          resolution = ag && o.minutes <= ag.max_daily_extra_minutes ? 'BANCO_CREDITO' : 'PAGAMENTO_EXTRA';
        } else if (o.type === 'DIFERENCA_NEGATIVA') {
          if (o.employee_justification) { resolution = 'ABONO'; notes = 'Justificativa aceita'; }
          else {
            const ov = await getBankOverview(ctxSubst, o.employee_id);
            const covered = ov.lots.filter((l) => l.entryDate <= o.work_date && l.expiresOn >= o.work_date && l.remaining > 0).reduce((a, l) => a + l.remaining, 0);
            if (covered >= o.minutes) resolution = 'BANCO_DEBITO';
            else { resolution = 'FALTA_NAO_JUSTIFICADA'; notes = 'Sem justificativa e sem crédito (análise da folha)'; }
          }
        } else { resolution = 'CIENTE'; }
        await resolveOccurrence(ctxSubst, { occurrenceId: o.id, resolution: resolution as 'ABONO', notes });
        bump(`decisao_${resolution}`);
      }
      // 4) Espelho mensal: ciência (ou contestação) e aprovação com dupla conferência.
      for (const w of workers.filter((x) => x.ctx)) {
        const adm = (await queryOne<{ admission_date: string }>(getPool(), 'SELECT admission_date FROM employees WHERE id = $1', [w.employeeId]))!.admission_date;
        if (adm > to) continue;
        const v = await prepareMonthlyDocument(w.ctx!, 'ESPELHO', w.employeeId, period);
        const contest = rnd() < 0.1;
        await signVersion(w.ctx!, contest
          ? { versionId: v, act: 'CONTESTACAO', comment: 'Divergência em um dia (simulação)', confirmed: true }
          : { versionId: v, act: 'CIENCIA', confirmed: true });
        await signVersion(ctxOwner, { versionId: v, act: 'APROVACAO', comment: contest ? 'Contestação analisada' : undefined, confirmed: true });
        bump(contest ? 'espelhos_contestados' : 'espelhos_com_ciencia');
      }
      await closePeriod(ctxOwner, period);
      bump('competencias_fechadas');
    }
  }, 600_000);

  it('compensação futura aprovada e pagamento de créditos vencidos', async () => {
    const w = workers.find((x) => x.name === 'Ana RI')!;
    let day = addDays(today, 3);
    while (await isOff(day)) day = addDays(day, 1);
    const ov = await getBankOverview(ctxOwner, w.employeeId);
    if (ov.summary.available >= 60) {
      const r = await createRequest(w.ctx!, { type: 'COMPENSACAO', referenceDate: day, payload: { mode: 'SAIDA_ANTECIPADA', minutes: 60 }, justification: 'Compensação simulada' });
      await decideRequest(ctxSubst, { requestId: r, approve: true });
      bump('compensacoes_aprovadas');
    }
    for (const x of workers) {
      const o = await getBankOverview(ctxOwner, x.employeeId);
      if (o.summary.expired > 0) {
        await registerPayment(ctxOwner, { employeeId: x.employeeId, minutes: o.summary.expired, onlyExpired: true, reference: 'Folha simulada' });
        bump('minutos_vencidos_pagos', o.summary.expired);
        expect((await getBankOverview(ctxOwner, x.employeeId)).summary.expired).toBe(0);
      }
    }
  });

  it('invariante: saldo de cada funcionário confere com o recálculo independente a partir das decisões', async () => {
    for (const w of workers) {
      await ensureProcessed(w.employeeId);
      const ov = await getBankOverview(ctxOwner, w.employeeId);
      const occ = await queryOne<{ cred: number; deb: number }>(
        getPool(),
        `SELECT coalesce(sum(minutes) FILTER (WHERE resolution = 'BANCO_CREDITO'), 0)::int AS cred,
                coalesce(sum(minutes) FILTER (WHERE resolution = 'BANCO_DEBITO'), 0)::int AS deb
           FROM daily_occurrences WHERE employee_id = $1 AND status = 'RESOLVIDA'`, [w.employeeId]);
      const other = await queryOne<{ comp: number; pay: number }>(
        getPool(),
        `SELECT coalesce(-sum(minutes) FILTER (WHERE kind = 'DEBITO_COMPENSACAO'), 0)::int AS comp,
                coalesce(-sum(minutes) FILTER (WHERE kind = 'PAGAMENTO'), 0)::int AS pay
           FROM hour_bank_entries h WHERE employee_id = $1 AND NOT EXISTS (SELECT 1 FROM hour_bank_entries r WHERE r.reverses_entry_id = h.id)`, [w.employeeId]);
      expect(ov.summary.balance, w.name).toBe(occ!.cred - occ!.deb - other!.comp - other!.pay);
      for (const l of ov.lots) expect(l.consumed, `${w.name} lote ${l.id}`).toBeLessThanOrEqual(l.minutes);
    }
  });

  it('invariante: todo crédito tem vencimento de 6 meses e corresponde exatamente a uma hora extra decidida', async () => {
    const rows = await query<{ entry_date: string; expires_on: string; minutes: number; occ_minutes: number; resolution: string }>(
      getPool(),
      `SELECT h.entry_date, h.expires_on, h.minutes, o.minutes AS occ_minutes, o.resolution
         FROM hour_bank_entries h JOIN daily_occurrences o ON o.id = h.occurrence_id WHERE h.kind = 'CREDITO'`);
    expect(rows.length).toBeGreaterThan(0);
    bump('creditos_conferidos', rows.length);
    for (const r of rows) {
      expect(r.expires_on).toBe(creditExpiry(r.entry_date, 6));
      expect(r.minutes).toBe(r.occ_minutes);
      expect(r.resolution).toBe('BANCO_CREDITO');
    }
  });

  it('invariante: nenhuma ocorrência pendente em competência fechada; nada apurado após o desligamento', async () => {
    const n = await queryOne<{ n: number }>(getPool(), `SELECT count(*)::int AS n FROM daily_occurrences o JOIN period_closings pc
       ON pc.period = to_char(o.work_date,'YYYY-MM') AND pc.reopened_at IS NULL WHERE o.status = 'PENDENTE'`);
    expect(n!.n).toBe(0);
    const f = workers.find((w) => w.terminated)!;
    const after = await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM daily_records WHERE employee_id = $1 AND work_date > $2', [f.employeeId, f.terminated]);
    expect(after!.n).toBe(0);
    const u = await queryOne<{ status: string }>(getPool(), 'SELECT status FROM users WHERE id = $1', [f.userId]);
    expect(u!.status).toBe('REVOGADO');
  });

  it('invariante: todas as assinaturas e conteúdos verificam; trilha de auditoria íntegra', async () => {
    const versions = await query<{ id: string }>(getPool(), 'SELECT DISTINCT document_version_id AS id FROM signatures');
    for (const v of versions) {
      const r = await verifyVersion(ctxOwner, v.id);
      expect(r.contentOk).toBe(true);
      expect(r.signatures.every((s) => s.ok)).toBe(true);
    }
    bump('versoes_verificadas', versions.length);
    const chain = await verifyAuditChain(getPool());
    expect(chain.ok).toBe(true);
    metrics.registros_auditoria = chain.total;
  });

  it('perfis distintos: cada colaborador só alcança os próprios dados', async () => {
    const [a, b] = workers.filter((w) => w.ctx);
    await expect(getEmployeeFor(a!.ctx!, 'banco.ver', b!.employeeId)).rejects.toThrow('permissão');
    await getEmployeeFor(a!.ctx!, 'banco.ver', a!.employeeId);
  });
});
