import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import { ensureProcessed, recomputeDays } from '../../../src/server/modules/timeclock.ts';
import { listOccurrences, resolveOccurrence } from '../../../src/server/modules/hourbank.ts';
import { createRequest } from '../../../src/server/modules/requests.ts';
import { describeValue, getRule, listLegalRegistry, validateRule, type RuleCode } from '../../../src/server/modules/legalRules.ts';
import { assertNonWorkingCredit } from '../../../src/server/modules/ledger.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { addDays, todayLocal, weekdayOf } from '../../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase, seedPunches } from '../../helpers.ts';

// CCT SC000957/2026 (vigência 01/02/2026 a 31/01/2027): regras pré-cadastradas como pendentes; cláusula 17, §§ 2º, 5º e 6º.
const today = todayLocal();
let I: Awaited<ReturnType<typeof ids>>;
let cOwner: Ctx, cSubst: Ctx, cWorker: Ctx;
let worker: { userId: string; employeeId: string };
const EXTRA = ['08:00', '12:00', '13:00', '18:00']; // 1 h extra
const WEEKEND = ['08:00', '10:00']; // 2 h: dentro do limite diário de extra do acordo

const isHoliday = async (d: string) => !!(await queryOne(getPool(), 'SELECT 1 FROM holidays WHERE is_day_off AND date = $1', [d]));
async function pastDays(weekday: number, n: number): Promise<string[]> {
  const out: string[] = [];
  for (let d = addDays(today, -1); out.length < n; d = addDays(d, -1)) if (weekdayOf(d) === weekday && !(await isHoliday(d))) out.push(d);
  return out;
}
async function nextWorkingMonday(): Promise<string> {
  let d = addDays(today, 3);
  while (weekdayOf(d) !== 1 || (await isHoliday(d)) || (await isHoliday(addDays(d, 1)))) d = addDays(d, 1);
  return d;
}
const pendingOn = async (date: string) => (await listOccurrences(cSubst, { employeeId: worker.employeeId, status: 'PENDENTE' }))
  .find((o) => o.work_date === date && o.type === 'HORA_EXTRA')!;
const cctRule = async (code: RuleCode) => (await listLegalRegistry(cOwner)).rules.find((r) => r.code === code && r.instrument_code === 'SC000957/2026')!;

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  cOwner = await ctxFor((await makePerson({ name: 'Oficial', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true })).userId);
  cSubst = await ctxFor((await makePerson({ name: 'Substituta', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] })).userId);
  worker = await makePerson({ name: 'Func CCT', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }],
    admission: addDays(today, -100), scheduleId: I.schedule, agreementMonths: 6, allowsNegative: true });
  cWorker = await ctxFor(worker.userId);
});
afterAll(closePool);

describe('CCT 2026/2027 — regras pré-cadastradas', () => {
  it('as sete regras da CCT vêm pendentes, com cláusula e vigência; pendente não altera cálculos', async () => {
    const reg = await listLegalRegistry(cOwner);
    const cct = reg.rules.filter((r) => r.instrument_code === 'SC000957/2026');
    expect(cct.map((r) => r.code).sort()).toEqual([
      'ADICIONAL_HORA_EXTRA', 'BANCO_COMUNICACAO_MINIMA', 'BANCO_DIAS_NAO_UTEIS', 'BANCO_FATOR_CONVERSAO', 'BANCO_FOLGA_DIAS_INICIO', 'BANCO_PRAZO',
      'FERIAS_VEDAR_INICIO_FDS_FERIADO',
    ]);
    expect(cct.every((r) => r.status === 'PENDENTE_VALIDACAO' && r.valid_from === '2026-02-01' && r.valid_until === '2027-01-31' && /cl\. \d+/.test(r.legal_basis))).toBe(true);
    expect(reg.instruments.find((i) => i.code === 'SC000957/2026')!.source_url).toContain('MR024577');
    expect(describeValue('BANCO_FOLGA_DIAS_INICIO', { dias: [1, 5] })).toBe('Começa só em: segunda, sexta');
    expect(await getRule(getPool(), 'BANCO_DIAS_NAO_UTEIS', today, { allowPending: false })).toBeNull();
  });

  it('a Oficial valida com nome e cargo (sem OAB), com observação; a regra passa a valer', async () => {
    for (const code of ['BANCO_DIAS_NAO_UTEIS', 'BANCO_FOLGA_DIAS_INICIO'] as const) {
      const r = await cctRule(code);
      await validateRule(cOwner, { ruleId: r.id, validatedBy: 'Oficial Fictícia — Oficial Registradora (delegatária)', validatedAt: today, notes: 'Conferida com a cl. 17 da CCT' });
    }
    expect((await getRule(getPool(), 'BANCO_DIAS_NAO_UTEIS', today, { allowPending: false }))!.value).toEqual({ excluir: true, sabadosCursoPorAno: 4 });
    expect((await cctRule('BANCO_FOLGA_DIAS_INICIO')).validated_by).toContain('Oficial Registradora');
  });
});

describe('Cl. 17, §§ 5º e 6º — sábado, domingo e feriado fora do banco', () => {
  it('dia útil continua indo ao banco; sábado, domingo e feriado sem exceção são recusados', async () => {
    const [tue] = await pastDays(2, 1);
    const [sun] = await pastDays(0, 1);
    await seedPunches(worker.employeeId, tue!, EXTRA, cOwner.principal.userId);
    await seedPunches(worker.employeeId, sun!, WEEKEND, cOwner.principal.userId);
    const holiday = (await queryOne<{ d: string }>(getPool(), "SELECT max(date)::text AS d FROM holidays WHERE is_day_off AND date < $1 AND date > $2 AND extract(dow FROM date) BETWEEN 1 AND 5", [today, addDays(today, -95)]))!.d;
    await seedPunches(worker.employeeId, holiday, WEEKEND, cOwner.principal.userId);
    await ensureProcessed(worker.employeeId);

    await resolveOccurrence(cSubst, { occurrenceId: (await pendingOn(tue!)).id, resolution: 'BANCO_CREDITO' });
    for (const d of [sun!, holiday]) {
      await expect(resolveOccurrence(cSubst, { occurrenceId: (await pendingOn(d)).id, resolution: 'BANCO_CREDITO' })).rejects.toThrow(/sábado, domingo ou feriado não entra no banco/);
    }
    await expect(resolveOccurrence(cSubst, { occurrenceId: (await pendingOn(sun!)).id, resolution: 'BANCO_CREDITO', nonWorkingException: 'CURSO' })).rejects.toThrow(/só entra no banco quando realizado em sábado/);
    await resolveOccurrence(cSubst, { occurrenceId: (await pendingOn(sun!)).id, resolution: 'PAGAMENTO_EXTRA' });
    await resolveOccurrence(cSubst, { occurrenceId: (await pendingOn(holiday)).id, resolution: 'BANCO_CREDITO', nonWorkingException: 'CASAMENTO' });
    const e = (await queryOne<{ x: string; notes: string }>(getPool(), 'SELECT non_working_exception AS x, notes FROM hour_bank_entries WHERE entry_date = $1 AND employee_id = $2', [holiday, worker.employeeId]))!;
    expect(e.x).toBe('CASAMENTO');
    expect(e.notes).toContain('atendimento de casamento');
  });

  it('curso/palestra: até 4 sábados por ano no banco; o 5º é recusado', async () => {
    const sats = await pastDays(6, 5);
    for (const d of sats) await seedPunches(worker.employeeId, d, WEEKEND, cOwner.principal.userId);
    await recomputeDays(getPool(), null, worker.employeeId, sats[4]!, sats[0]!);
    for (const d of sats.slice(0, 4)) await resolveOccurrence(cSubst, { occurrenceId: (await pendingOn(d)).id, resolution: 'BANCO_CREDITO', nonWorkingException: 'CURSO' });
    await expect(resolveOccurrence(cSubst, { occurrenceId: (await pendingOn(sats[4]!)).id, resolution: 'BANCO_CREDITO', nonWorkingException: 'CURSO' })).rejects.toThrow(/Limite de 4 sábados/);
  });

  it('plantão é exceção automática', async () => {
    const [sat] = await pastDays(6, 1);
    expect(await assertNonWorkingCredit(getPool(), { employeeId: worker.employeeId, date: sat!, oncallShiftId: '00000000-0000-0000-0000-000000000000' })).toBe('PLANTAO');
  });
});

describe('Cl. 17, § 2º — folga integral começa na segunda ou na sexta', () => {
  it('terça avulsa é recusada; segunda e a terça seguinte (folga contínua) são aceitas; compensação parcial não é afetada', async () => {
    const mon = await nextWorkingMonday();
    const tue = addDays(mon, 1);
    const wed = addDays(mon, 2);
    const ask = (date: string, mode: 'FOLGA_INTEGRAL' | 'SAIDA_ANTECIPADA') =>
      createRequest(cWorker, { type: 'COMPENSACAO', referenceDate: date, payload: { mode, minutes: 60 }, justification: 'Folga do banco de horas' });
    await expect(ask(tue, 'FOLGA_INTEGRAL')).rejects.toThrow(/só pode começar em: segunda ou sexta/);
    await ask(mon, 'FOLGA_INTEGRAL');
    await ask(tue, 'FOLGA_INTEGRAL');
    await ask(addDays(wed, 7), 'SAIDA_ANTECIPADA');
    await expect(ask(addDays(wed, 7), 'FOLGA_INTEGRAL')).rejects.toThrow(/segunda ou sexta/);
  });

  it('cadeia de auditoria íntegra', async () => {
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
