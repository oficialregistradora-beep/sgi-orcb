import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import { createEmployee, getJobHistory } from '../../../src/server/modules/people.ts';
import { punch, ensureProcessed, listPunches } from '../../../src/server/modules/timeclock.ts';
import {
  closePeriod, getBankOverview, listOccurrences, payrollReport, registerPayment, reopenPeriod, resolveOccurrence,
} from '../../../src/server/modules/hourbank.ts';
import { createRequest, decideRequest } from '../../../src/server/modules/requests.ts';
import { prepareMonthlyDocument, signVersion, verifyVersion, getVersion } from '../../../src/server/modules/documents.ts';
import { addDays, addMonths, todayLocal, weekdayOf } from '../../../src/domain/time.ts';
import { closePool, ctxFor, DOMAIN, FULL_DAY, ids, makePerson, pastMonday, resetDatabase, seedPunches } from '../../helpers.ts';

let I: Awaited<ReturnType<typeof ids>>;
let owner: { userId: string; employeeId: string };
let subst: { userId: string; employeeId: string };
let coord: { userId: string; employeeId: string };
let worker: { userId: string; employeeId: string };
let worker2: { userId: string; employeeId: string };
let ctxOwner: Ctx, ctxSubst: Ctx, ctxCoord: Ctx, ctxWorker: Ctx, ctxWorker2: Ctx;
let monday: string;
const today = todayLocal();

async function isHoliday(d: string) {
  return !!(await queryOne(getPool(), 'SELECT 1 FROM holidays WHERE date = $1', [d]));
}

/** Preenche dias úteis com jornada exata, exceto as datas informadas. */
async function seedWorkdays(employeeId: string, from: string, to: string, by: string, skip: Set<string> = new Set()) {
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const wd = weekdayOf(d);
    if (wd === 0 || wd === 6 || skip.has(d) || (await isHoliday(d))) continue;
    await seedPunches(employeeId, d, FULL_DAY, by);
  }
}

async function nextWorkday(from: string): Promise<string> {
  let d = from;
  while (weekdayOf(d) === 0 || weekdayOf(d) === 6 || (await isHoliday(d))) d = addDays(d, 1);
  return d;
}

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  monday = await pastMonday(3);
  owner = await makePerson({ name: 'Oficial Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
  subst = await makePerson({ name: 'Substituta Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }, { roleId: I.roles.COLABORADOR }] });
  coord = await makePerson({ name: 'Coordenadora RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COORDENACAO_SETOR }, { roleId: I.roles.COLABORADOR }] });
  worker = await makePerson({
    name: 'Joao Escrevente', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }],
    admission: monday, scheduleId: I.schedule, agreementMonths: 6,
  });
  worker2 = await makePerson({
    name: 'Maria Atendente', sectorId: I.sectors.ATD, jobId: I.jobs.atendente, roles: [{ roleId: I.roles.COLABORADOR }],
    admission: monday, scheduleId: I.schedule, agreementMonths: null,
  });
  ctxOwner = await ctxFor(owner.userId);
  ctxSubst = await ctxFor(subst.userId);
  ctxCoord = await ctxFor(coord.userId);
  ctxWorker = await ctxFor(worker.userId);
  ctxWorker2 = await ctxFor(worker2.userId);

  // Semana do cenário (segunda a sexta) + demais dias úteis com jornada exata até ontem.
  const [mon, tue, wed, thu, fri] = [0, 1, 2, 3, 4].map((i) => addDays(monday, i)) as [string, string, string, string, string];
  await seedPunches(worker.employeeId, mon, FULL_DAY, owner.userId);
  await seedPunches(worker.employeeId, tue, ['08:00', '12:00', '13:00', '18:30'], owner.userId); // +90
  await seedPunches(worker.employeeId, wed, ['08:03', '12:00', '13:00', '17:04'], owner.userId); // tolerância
  await seedPunches(worker.employeeId, thu, ['08:45', '12:00', '13:00', '17:00'], owner.userId); // -45
  await seedPunches(worker.employeeId, fri, ['08:00', '12:00', '13:00'], owner.userId); // incompleta
  await seedWorkdays(worker.employeeId, addDays(monday, 7), addDays(today, -1), owner.userId);

  await seedPunches(worker2.employeeId, mon, ['08:00', '12:00', '13:00', '18:00'], owner.userId); // +60
  await seedPunches(worker2.employeeId, tue, ['09:00', '12:00', '13:00', '17:00'], owner.userId); // -60
  await seedWorkdays(worker2.employeeId, wed, addDays(today, -1), owner.userId);
});
afterAll(closePool);

describe('Rodada 1 — cadastro funcional (admissão)', () => {
  it('admissão cria funcionário, usuário, papel básico, jornada e histórico em uma transação', async () => {
    const id = await createEmployee(ctxSubst, {
      registrationCode: 'A100', fullName: 'Pedro Ficticio', jobTitleId: I.jobs.atendente, sectorId: I.sectors.ATD,
      admissionDate: today, contractType: 'CLT', weeklyHours: 40, email: `pedro.ficticio@${DOMAIN}`, scheduleId: I.schedule,
    });
    const row = await queryOne<{ user_id: string; roles: string[] }>(
      getPool(),
      `SELECT e.user_id, array_agg(r.code) AS roles FROM employees e JOIN user_roles ur ON ur.user_id = e.user_id
         JOIN roles r ON r.id = ur.role_id WHERE e.id = $1 GROUP BY e.user_id`,
      [id],
    );
    expect(row!.roles).toEqual(['COLABORADOR']);
    expect((await getJobHistory(ctxSubst, id)).length).toBe(1);
    await expect(
      createEmployee(ctxSubst, {
        registrationCode: 'A100', fullName: 'Outro', jobTitleId: I.jobs.atendente, sectorId: I.sectors.ATD,
        admissionDate: today, contractType: 'CLT', weeklyHours: 40,
      }),
    ).rejects.toThrow('Matrícula já utilizada');
    await expect(
      createEmployee(ctxSubst, {
        registrationCode: 'A101', fullName: 'Externo', jobTitleId: I.jobs.atendente, sectorId: I.sectors.ATD,
        admissionDate: today, contractType: 'CLT', weeklyHours: 40, email: 'x@gmail.com',
      }),
    ).rejects.toThrow('domínio');
  });

  it('colaborador não pode admitir funcionário', async () => {
    await expect(
      createEmployee(ctxWorker, {
        registrationCode: 'A200', fullName: 'Indevido', jobTitleId: I.jobs.atendente, sectorId: I.sectors.RI,
        admissionDate: today, contractType: 'CLT', weeklyHours: 40,
      }),
    ).rejects.toThrow('permissão');
  });
});

describe('Rodada 1 — marcação de jornada', () => {
  it('marcação usa o relógio do servidor e impede duplicidade imediata', async () => {
    const before = Date.now();
    const r = await punch(ctxWorker);
    expect(r.kind).toBe('ENTRADA');
    expect(Math.abs(r.punchedAt.getTime() - before)).toBeLessThan(5000);
    await expect(punch(ctxWorker)).rejects.toThrow('Aguarde');
  });

  it('usuário sem cadastro funcional não registra ponto', async () => {
    const u = await queryOne<{ id: string }>(getPool(), `INSERT INTO users (email, display_name) VALUES ('sem.vinculo@${DOMAIN}', 'Sem Vínculo') RETURNING id`);
    const ctx = await ctxFor(u!.id);
    await expect(punch(ctx)).rejects.toThrow('não está vinculado');
  });
});

describe('Rodada 1 — apuração e ocorrências', () => {
  it('gera somente as ocorrências esperadas da semana do cenário', async () => {
    const occ = await listOccurrences(ctxSubst, { employeeId: worker.employeeId });
    const summary = occ.map((o) => [o.work_date, o.type, o.minutes, o.status]).sort();
    expect(summary).toEqual(
      [
        [addDays(monday, 1), 'HORA_EXTRA', 90, 'PENDENTE'],
        [addDays(monday, 3), 'DIFERENCA_NEGATIVA', 45, 'PENDENTE'],
        [addDays(monday, 4), 'MARCACAO_INCOMPLETA', 0, 'PENDENTE'],
      ].sort(),
    );
    const rec = await queryOne<{ tolerance_applied: boolean; raw_diff_minutes: number }>(
      getPool(), 'SELECT tolerance_applied, raw_diff_minutes FROM daily_records WHERE employee_id = $1 AND work_date = $2', [worker.employeeId, addDays(monday, 2)]);
    expect(rec).toEqual({ tolerance_applied: true, raw_diff_minutes: 1 });
  });

  it('reprocessar não duplica ocorrências', async () => {
    await query(getPool(), 'DELETE FROM daily_records WHERE employee_id = $1', [worker.employeeId]);
    await ensureProcessed(worker.employeeId);
    const n = await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM daily_occurrences WHERE employee_id = $1 AND status <> 'SUPERADA'", [worker.employeeId]);
    expect(n!.n).toBe(3);
  });

  it('funcionário justifica a própria ocorrência; não pode justificar a de outro', async () => {
    const [neg] = (await listOccurrences(ctxSubst, { employeeId: worker.employeeId })).filter((o) => o.type === 'DIFERENCA_NEGATIVA');
    const [other] = await listOccurrences(ctxSubst, { employeeId: worker2.employeeId });
    const { justifyOccurrence } = await import('../../../src/server/modules/hourbank.ts');
    await justifyOccurrence(ctxWorker, neg!.id, 'Consulta médica sem atestado');
    await expect(justifyOccurrence(ctxWorker, other!.id, 'Tentativa indevida')).rejects.toThrow('próprio funcionário');
  });
});

describe('Rodada 1 — banco de horas', () => {
  it('hora extra ao banco gera crédito com vencimento de 6 meses; diferença negativa consome PEPS', async () => {
    const occ = await listOccurrences(ctxSubst, { employeeId: worker.employeeId, status: 'PENDENTE' });
    const extra = occ.find((o) => o.type === 'HORA_EXTRA')!;
    const neg = occ.find((o) => o.type === 'DIFERENCA_NEGATIVA')!;
    await expect(resolveOccurrence(ctxCoord, { occurrenceId: extra.id, resolution: 'BANCO_CREDITO' })).rejects.toThrow('permissão');
    await expect(resolveOccurrence(ctxSubst, { occurrenceId: extra.id, resolution: 'ABONO' })).rejects.toThrow('incompatível');
    await resolveOccurrence(ctxSubst, { occurrenceId: extra.id, resolution: 'BANCO_CREDITO' });
    await expect(resolveOccurrence(ctxSubst, { occurrenceId: extra.id, resolution: 'BANCO_CREDITO' })).rejects.toThrow('não está pendente');
    await resolveOccurrence(ctxSubst, { occurrenceId: neg.id, resolution: 'BANCO_DEBITO', notes: 'Compensa com crédito existente' });
    const ov = await getBankOverview(ctxWorker, worker.employeeId);
    expect(ov.summary).toMatchObject({ balance: 45, available: 45, expired: 0 });
    expect(ov.lots[0]).toMatchObject({ entryDate: addDays(monday, 1), expiresOn: addMonths(addDays(monday, 1), 6), consumed: 45, remaining: 45 });
    expect(ov.cost).toBeNull(); // colaborador não vê custo
  });

  it('sem acordo vigente: crédito em banco é recusado; pagamento e falta não justificada não geram lançamento', async () => {
    const occ = await listOccurrences(ctxSubst, { employeeId: worker2.employeeId, status: 'PENDENTE' });
    const extra = occ.find((o) => o.type === 'HORA_EXTRA')!;
    const neg = occ.find((o) => o.type === 'DIFERENCA_NEGATIVA')!;
    await expect(resolveOccurrence(ctxSubst, { occurrenceId: extra.id, resolution: 'BANCO_CREDITO' })).rejects.toThrow('acordo');
    await resolveOccurrence(ctxSubst, { occurrenceId: extra.id, resolution: 'PAGAMENTO_EXTRA' });
    await expect(resolveOccurrence(ctxSubst, { occurrenceId: neg.id, resolution: 'FALTA_NAO_JUSTIFICADA' })).rejects.toThrow('fundamentação');
    await resolveOccurrence(ctxSubst, { occurrenceId: neg.id, resolution: 'FALTA_NAO_JUSTIFICADA', notes: 'Atraso sem justificativa apresentada' });
    const n = await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM hour_bank_entries WHERE employee_id = $1', [worker2.employeeId]);
    expect(n!.n).toBe(0);
    const report = await payrollReport(ctxSubst, monday.slice(0, 7));
    const row = report.find((r) => r.employee_id === worker2.employeeId);
    if (addDays(monday, 1).slice(0, 7) === monday.slice(0, 7)) {
      expect(row).toMatchObject({ extra_paid_minutes: 60, unjustified_minutes: 60 });
    }
  });
});

describe('Rodada 1 — correções de marcação (original preservado)', () => {
  it('inclusão aprovada completa o dia e supera a ocorrência de marcação incompleta', async () => {
    const fri = addDays(monday, 4);
    const id = await createRequest(ctxWorker, { type: 'CORRECAO_PONTO', referenceDate: fri, payload: { action: 'INCLUIR', time: '17:00' }, justification: 'Esqueci de registrar a saída' });
    await expect(decideRequest(ctxWorker, { requestId: id, approve: true })).rejects.toThrow();
    await decideRequest(ctxCoord, { requestId: id, approve: true });
    const punches = await listPunches(getPool(), worker.employeeId, fri, fri);
    expect(punches.map((p) => p.source)).toEqual(['IMPORTACAO', 'IMPORTACAO', 'IMPORTACAO', 'CORRECAO']);
    const occ = await query<{ type: string; status: string }>(getPool(), 'SELECT type, status FROM daily_occurrences WHERE employee_id = $1 AND work_date = $2', [worker.employeeId, fri]);
    expect(occ).toEqual([{ type: 'MARCACAO_INCOMPLETA', status: 'SUPERADA' }]);
  });

  it('correção posterior a crédito resolvido estorna o lançamento automaticamente', async () => {
    const wed = addDays(monday, 2);
    const [first] = await listPunches(getPool(), worker.employeeId, wed, wed);
    const r1 = await createRequest(ctxWorker, { type: 'CORRECAO_PONTO', referenceDate: wed, payload: { action: 'DESCONSIDERAR', punchId: first!.id }, justification: 'Marcação registrada com atraso' });
    const r2 = await createRequest(ctxWorker, { type: 'CORRECAO_PONTO', referenceDate: wed, payload: { action: 'INCLUIR', time: '07:30' }, justification: 'Cheguei às 07:30 para preparar a abertura' });
    await decideRequest(ctxCoord, { requestId: r1, approve: true });
    await decideRequest(ctxCoord, { requestId: r2, approve: true });
    const [extra] = (await listOccurrences(ctxSubst, { employeeId: worker.employeeId, status: 'PENDENTE' })).filter((o) => o.work_date === wed);
    expect(extra).toMatchObject({ type: 'HORA_EXTRA', minutes: 34 });
    await resolveOccurrence(ctxSubst, { occurrenceId: extra!.id, resolution: 'BANCO_CREDITO' });
    expect((await getBankOverview(ctxSubst, worker.employeeId)).summary.balance).toBe(45 + 34);

    // nova correção desconsidera a marcação de 07:30 → dia incompleto → crédito estornado
    const p0730 = (await listPunches(getPool(), worker.employeeId, wed, wed)).find((p) => p.source === 'CORRECAO')!;
    const r3 = await createRequest(ctxWorker, { type: 'CORRECAO_PONTO', referenceDate: wed, payload: { action: 'DESCONSIDERAR', punchId: p0730.id }, justification: 'Correção anterior equivocada' });
    await decideRequest(ctxCoord, { requestId: r3, approve: true });
    const ov = await getBankOverview(ctxSubst, worker.employeeId);
    expect(ov.summary.balance).toBe(45);
    expect(ov.lines.some((l) => l.kind === 'ESTORNO' && l.minutes === -34)).toBe(true);
    const all = await listPunches(getPool(), worker.employeeId, wed, wed);
    expect(all.length).toBe(5); // nada foi apagado
    expect(all.filter((p) => p.annulled).length).toBe(2);
  });

  it('não permite corrigir data futura nem horário que ainda não ocorreu', async () => {
    await expect(createRequest(ctxWorker, { type: 'CORRECAO_PONTO', referenceDate: addDays(today, 1), payload: { action: 'INCLUIR', time: '08:00' }, justification: 'Data futura' })).rejects.toThrow('futura');
  });
});

describe('Rodada 1 — compensações e autorização prévia', () => {
  it('compensação aprovada debita PEPS; sem saldo suficiente é recusada', async () => {
    const day = await nextWorkday(addDays(today, 1));
    const r = await createRequest(ctxWorker, { type: 'COMPENSACAO', referenceDate: day, payload: { mode: 'SAIDA_ANTECIPADA', minutes: 30 }, justification: 'Compromisso pessoal' });
    await expect(decideRequest(ctxCoord, { requestId: r, approve: true })).rejects.toThrow('permissão');
    await decideRequest(ctxSubst, { requestId: r, approve: true });
    expect((await getBankOverview(ctxWorker, worker.employeeId)).summary).toMatchObject({ balance: 15, available: 15 });
    const r2 = await createRequest(ctxWorker, { type: 'COMPENSACAO', referenceDate: day, payload: { mode: 'COMPENSACAO_PARCIAL', minutes: 60 }, justification: 'Outra compensação' });
    await expect(decideRequest(ctxSubst, { requestId: r2, approve: true })).rejects.toThrow('insuficiente');
    await decideRequest(ctxSubst, { requestId: r2, approve: false, notes: 'Saldo insuficiente' });
  });

  it('compensação exige acordo vigente e dia com jornada', async () => {
    const day = await nextWorkday(addDays(today, 1));
    await expect(createRequest(ctxWorker2, { type: 'COMPENSACAO', referenceDate: day, payload: { mode: 'FOLGA_INTEGRAL' }, justification: 'Sem acordo' })).rejects.toThrow('acordo');
    let sat = addDays(today, 1);
    while (weekdayOf(sat) !== 6) sat = addDays(sat, 1);
    await expect(createRequest(ctxWorker, { type: 'COMPENSACAO', referenceDate: sat, payload: { mode: 'FOLGA_INTEGRAL' }, justification: 'Sábado' })).rejects.toThrow('jornada prevista');
  });

  it('hora extra previamente autorizada é resolvida automaticamente no destino autorizado', async () => {
    const p = await makePerson({
      name: 'Lucas Autorizado', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }],
      admission: monday, scheduleId: I.schedule, agreementMonths: 6,
    });
    await seedWorkdays(p.employeeId, monday, addDays(today, -1), owner.userId, new Set([addDays(monday, 1)]));
    await seedPunches(p.employeeId, addDays(monday, 1), ['08:00', '12:00', '13:00', '18:00'], owner.userId);
    // autorização registrada (e aprovada) antes do dia trabalhado
    await query(
      getPool(),
      `INSERT INTO requests (type, employee_id, requested_by, reference_date, payload, justification, status, decided_by, decided_at)
       VALUES ('AUTORIZACAO_EXTRA', $1, $2, $3, '{"minutes":60,"destination":"BANCO"}', 'Fechamento de matrículas', 'APROVADA', $2, now())`,
      [p.employeeId, subst.userId, addDays(monday, 1)],
    );
    await ensureProcessed(p.employeeId);
    const occ = await queryOne<{ status: string; resolution: string; auto_resolved: boolean }>(
      getPool(), "SELECT status, resolution, auto_resolved FROM daily_occurrences WHERE employee_id = $1 AND type = 'HORA_EXTRA'", [p.employeeId]);
    expect(occ).toEqual({ status: 'RESOLVIDA', resolution: 'BANCO_CREDITO', auto_resolved: true });
    expect((await getBankOverview(ctxSubst, p.employeeId)).summary.balance).toBe(60);
  });
});

describe('Rodada 1 — vencimento, pagamento, espelho assinado e fechamento', () => {
  let veteran: { userId: string; employeeId: string };
  let extraDay: string;
  let period: string;

  beforeAll(async () => {
    const admission = addDays(today, -260);
    veteran = await makePerson({ name: 'Rita Veterana', sectorId: I.sectors.RCPN, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }], admission, scheduleId: I.schedule, agreementMonths: 6 });
    extraDay = await nextWorkday(addDays(today, -230));
    period = extraDay.slice(0, 7);
    // Todo o período coberto por ausência abonada, exceto o dia da hora extra.
    await query(getPool(), `INSERT INTO absences (employee_id, type, start_date, end_date) VALUES ($1,'OUTRO',$2,$3), ($1,'OUTRO',$4,$5)`, [
      veteran.employeeId, admission, addDays(extraDay, -1), addDays(extraDay, 1), addDays(today, -1),
    ]);
    await seedPunches(veteran.employeeId, extraDay, ['08:00', '12:00', '13:00', '18:00'], owner.userId);
  });

  it('crédito não compensado em 6 meses fica VENCIDO (não desaparece) e pode ser pago', async () => {
    const [o] = await listOccurrences(ctxSubst, { employeeId: veteran.employeeId, status: 'PENDENTE' });
    await resolveOccurrence(ctxSubst, { occurrenceId: o!.id, resolution: 'BANCO_CREDITO' });
    const ov = await getBankOverview(ctxOwner, veteran.employeeId);
    expect(ov.summary).toMatchObject({ balance: 60, available: 0, expired: 60 });
    expect(ov.lots[0]!.status).toBe('VENCIDO');
    await expect(registerPayment(ctxSubst, { employeeId: veteran.employeeId, minutes: 60, onlyExpired: true, reference: 'Folha teste' })).rejects.toThrow('permissão');
    await expect(registerPayment(ctxOwner, { employeeId: veteran.employeeId, minutes: 61, onlyExpired: true, reference: 'Folha teste' })).rejects.toThrow('insuficientes');
    await registerPayment(ctxOwner, { employeeId: veteran.employeeId, minutes: 60, onlyExpired: true, reference: 'Folha teste' });
    expect((await getBankOverview(ctxOwner, veteran.employeeId)).summary).toMatchObject({ balance: 0, expired: 0 });
  });

  it('espelho mensal: versão com hash, ciência do funcionário, dupla conferência e verificação', async () => {
    const ctxVet = await ctxFor(veteran.userId);
    const v1 = await prepareMonthlyDocument(ctxVet, 'ESPELHO', veteran.employeeId, period);
    expect(await prepareMonthlyDocument(ctxVet, 'ESPELHO', veteran.employeeId, period)).toBe(v1); // conteúdo igual → mesma versão
    const view = await getVersion(ctxVet, v1);
    expect(view.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(String(view.content.ressalva)).toContain('Controle administrativo interno');

    await expect(signVersion(ctxOwner, { versionId: v1, act: 'APROVACAO', confirmed: true })).rejects.toThrow('Dupla conferência');
    await expect(signVersion(ctxVet, { versionId: v1, act: 'APROVACAO', confirmed: true })).rejects.toThrow('não pode aprovar');
    await expect(signVersion(ctxOwner, { versionId: v1, act: 'CIENCIA', confirmed: true })).rejects.toThrow('titular');
    const noStep = await ctxFor(veteran.userId, { stepUp: false });
    await expect(signVersion(noStep, { versionId: v1, act: 'CIENCIA', confirmed: true })).rejects.toThrow('reautenticação');
    await signVersion(ctxVet, { versionId: v1, act: 'CIENCIA', confirmed: true });
    await expect(signVersion(ctxVet, { versionId: v1, act: 'CONTESTACAO', comment: 'Mudei de ideia', confirmed: true })).rejects.toThrow('incompatível');
    await signVersion(ctxOwner, { versionId: v1, act: 'APROVACAO', confirmed: true });
    const check = await verifyVersion(ctxOwner, v1);
    expect(check.contentOk).toBe(true);
    expect(check.signatures.map((s) => s.ok)).toEqual([true, true]);

    // extrato do banco também pode ser contestado, com motivo obrigatório
    const ex = await prepareMonthlyDocument(ctxVet, 'EXTRATO_BANCO', veteran.employeeId, period);
    await expect(signVersion(ctxVet, { versionId: ex, act: 'CONTESTACAO', confirmed: true })).rejects.toThrow('motivos');
    await signVersion(ctxVet, { versionId: ex, act: 'CONTESTACAO', comment: 'Discordo do lançamento do dia', confirmed: true });
    await expect(signVersion(ctxOwner, { versionId: ex, act: 'APROVACAO', confirmed: true })).rejects.toThrow('contestado');
  });

  it('fechamento de competência bloqueia correções; reabertura é registrada', async () => {
    await closePeriod(ctxOwner, period);
    const ctxVet = await ctxFor(veteran.userId);
    await expect(createRequest(ctxVet, { type: 'CORRECAO_PONTO', referenceDate: extraDay, payload: { action: 'INCLUIR', time: '07:00' }, justification: 'Período fechado' })).rejects.toThrow('fechada');
    await reopenPeriod(ctxOwner, period, 'Ajuste solicitado pela contabilidade');
    await createRequest(ctxVet, { type: 'CORRECAO_PONTO', referenceDate: extraDay, payload: { action: 'INCLUIR', time: '07:00' }, justification: 'Período reaberto' });
    const rows = await query(getPool(), "SELECT 1 FROM audit_log WHERE action IN ('COMPETENCIA_FECHADA','COMPETENCIA_REABERTA') AND entity_id = $1", [period]);
    expect(rows.length).toBe(2);
  });
});
