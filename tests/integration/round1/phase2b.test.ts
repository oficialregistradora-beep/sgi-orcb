import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import { assignShift, closeShift, generateSchedule, getShift, listShifts, oncallReport, registerCall, voidCall } from '../../../src/server/modules/oncall.ts';
import { cancelApprovedVacation, getVacationOverview, requestVacation, reviewVacationPeriod } from '../../../src/server/modules/vacation.ts';
import { decideRequest } from '../../../src/server/modules/requests.ts';
import { createEmployee, terminateEmployee, addSalary } from '../../../src/server/modules/people.ts';
import { deliverItem, listChecklists, returnItem, setChecklistItem } from '../../../src/server/modules/checklists.ts';
import { signVersion, listPendingApprovals } from '../../../src/server/modules/documents.ts';
import { updateBooleanSetting } from '../../../src/server/modules/admin.ts';
import { getBankOverview, listOccurrences } from '../../../src/server/modules/hourbank.ts';
import { ensureProcessed } from '../../../src/server/modules/timeclock.ts';
import { addDays, addMonths, localToInstant, todayLocal, weekdayOf } from '../../../src/domain/time.ts';
import { closePool, ctxFor, DOMAIN, ids, makePerson, resetDatabase, seedPunches } from '../../helpers.ts';

let I: Awaited<ReturnType<typeof ids>>;
type P = { userId: string; employeeId: string };
let owner: P, subst: P, rc1: P, rc2: P, rc3: P, other: P;
let ctxOwner: Ctx, ctxSubst: Ctx, ctxRc1: Ctx, ctxRc2: Ctx, ctxRc3: Ctx, ctxOther: Ctx;
const today = todayLocal();
const nextPeriod = addMonths(`${today.slice(0, 7)}-01`, 1).slice(0, 7);

async function isHoliday(d: string) {
  return !!(await queryOne(getPool(), 'SELECT 1 FROM holidays WHERE date = $1', [d]));
}

/** Segunda-feira futura cujo início de férias não antecede feriado em 2 dias. */
async function vacationMonday(minDays: number): Promise<string> {
  let d = addDays(today, minDays);
  while (weekdayOf(d) !== 1 || (await isHoliday(addDays(d, 1))) || (await isHoliday(addDays(d, 2)))) d = addDays(d, 1);
  return d;
}

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  const twoYears = addDays(today, -800);
  owner = await makePerson({ name: 'Oficial Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true, admission: twoYears });
  subst = await makePerson({ name: 'Substituta Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }, { roleId: I.roles.COLABORADOR }], admission: twoYears, scheduleId: I.schedule });
  rc1 = await makePerson({ name: 'Plantonista Um', sectorId: I.sectors.RCPN, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }], admission: twoYears, scheduleId: I.schedule, agreementMonths: 6 });
  rc2 = await makePerson({ name: 'Plantonista Dois', sectorId: I.sectors.RCPN, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }], admission: twoYears, scheduleId: I.schedule, agreementMonths: 6 });
  rc3 = await makePerson({ name: 'Plantonista Tres', sectorId: I.sectors.RCPN, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }], admission: twoYears, scheduleId: I.schedule, agreementMonths: 6 });
  other = await makePerson({ name: 'Atendente Outra', sectorId: I.sectors.ATD, jobId: I.jobs.atendente, roles: [{ roleId: I.roles.COLABORADOR }], admission: twoYears, scheduleId: I.schedule });
  ctxOwner = await ctxFor(owner.userId);
  ctxSubst = await ctxFor(subst.userId);
  ctxRc1 = await ctxFor(rc1.userId);
  ctxRc2 = await ctxFor(rc2.userId);
  ctxRc3 = await ctxFor(rc3.userId);
  ctxOther = await ctxFor(other.userId);
  // Evita ocorrências históricas irrelevantes: ausências abonadas até ontem.
  for (const p of [subst, rc1, rc2, rc3, other]) {
    await query(getPool(), "INSERT INTO absences (employee_id, type, start_date, end_date) VALUES ($1,'OUTRO',$2,$3)", [p.employeeId, twoYears, addDays(today, -1)]);
  }
});
afterAll(closePool);

describe('Fase 2b — escala de plantões RCPN', () => {
  it('gera escala em rodízio sem responsável igual ao substituto e pula ausentes', async () => {
    const { from } = { from: `${nextPeriod}-01` };
    await query(getPool(), "INSERT INTO absences (employee_id, type, start_date, end_date) VALUES ($1,'FERIAS',$2,$3)", [rc2.employeeId, from, addDays(from, 9)]);
    const r = await generateSchedule(ctxSubst, { period: nextPeriod, participants: [rc1.employeeId, rc2.employeeId, rc3.employeeId] });
    expect(r.created).toBeGreaterThanOrEqual(8);
    const shifts = await listShifts(ctxSubst, nextPeriod);
    for (const s of shifts) {
      expect(s.employee_id).not.toBe(s.substitute_employee_id);
      if (s.shift_date <= addDays(from, 9)) {
        expect(s.employee_id).not.toBe(rc2.employeeId);
        expect(s.substitute_employee_id).not.toBe(rc2.employeeId);
      }
    }
    expect((await generateSchedule(ctxSubst, { period: nextPeriod, participants: [rc1.employeeId, rc2.employeeId] })).created).toBe(0);
  });

  it('colaborador vê apenas os próprios plantões; não monta escala', async () => {
    const mine = await listShifts(ctxRc1, nextPeriod);
    expect(mine.every((s) => s.employee_id === rc1.employeeId || s.substitute_employee_id === rc1.employeeId)).toBe(true);
    await expect(generateSchedule(ctxRc1, { period: nextPeriod, participants: [rc1.employeeId] })).rejects.toThrow('permissão');
  });

  it('substituição: recusa responsável ausente e registra a troca', async () => {
    const s = (await listShifts(ctxSubst, nextPeriod)).find((x) => x.shift_date <= addDays(`${nextPeriod}-01`, 9))!;
    await expect(assignShift(ctxSubst, { shiftId: s.id, employeeId: rc2.employeeId, reason: 'Troca' })).rejects.toThrow('ausente');
    const target = s.employee_id === rc1.employeeId ? rc3 : rc1;
    await assignShift(ctxSubst, { shiftId: s.id, employeeId: target.employeeId, substituteId: s.employee_id, reason: 'Troca solicitada' });
    const a = await queryOne(getPool(), "SELECT 1 FROM audit_log WHERE action = 'PLANTAO_SUBSTITUICAO' AND entity_id = $1", [s.id]);
    expect(a).not.toBeNull();
  });
});

describe('Fase 2b — plantão realizado: chamados, fechamento e separação de cálculos', () => {
  let shiftId: string;
  let sat: string;

  beforeAll(async () => {
    sat = addDays(today, -1);
    while (weekdayOf(sat) !== 6) sat = addDays(sat, -1);
    shiftId = (await queryOne<{ id: string }>(
      getPool(),
      `INSERT INTO oncall_shifts (shift_date, starts_at, ends_at, employee_id, substitute_employee_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [sat, localToInstant(sat, '08:00'), localToInstant(sat, '18:00'), rc1.employeeId, rc3.employeeId],
    ))!.id;
    // Plantonista também registrou ponto no sábado: não deve virar hora extra comum.
    await query(getPool(), "UPDATE absences SET end_date = $2 WHERE employee_id = $1 AND type = 'OUTRO'", [rc1.employeeId, addDays(sat, -1)]);
    await query(getPool(), "INSERT INTO absences (employee_id, type, start_date, end_date) VALUES ($1,'OUTRO',$2,$3)", [rc1.employeeId, addDays(sat, 1), addDays(today, -1)]);
    await seedPunches(rc1.employeeId, sat, ['10:00', '11:30'], owner.userId);
  });

  it('registro de chamados: somente plantonista/substituto/gestão; dentro da janela; horários coerentes', async () => {
    await expect(registerCall(ctxOther, { shiftId, calledAt: '09:00', attended: false, description: 'Teste' })).rejects.toThrow('permissão');
    await expect(registerCall(ctxRc1, { shiftId, calledAt: '19:00', attended: false, description: 'Fora' })).rejects.toThrow('horário do plantão');
    await expect(registerCall(ctxRc1, { shiftId, calledAt: '09:00', attended: true, description: 'Sem horário' })).rejects.toThrow('chegada e saída');
    await registerCall(ctxRc1, { shiftId, calledAt: '09:40', respondedAt: '09:45', attended: true, arrivalAt: '10:00', departureAt: '11:30', description: 'Registro de óbito' });
    await registerCall(ctxRc1, { shiftId, calledAt: '14:00', respondedAt: '14:02', attended: false, description: 'Orientação por telefone' });
    const wrong = await registerCall(ctxRc1, { shiftId, calledAt: '15:00', attended: true, arrivalAt: '15:10', departureAt: '17:00', description: 'Lançado por engano' });
    await voidCall(ctxRc1, wrong, 'Lançamento em duplicidade');
    const v = await getShift(ctxRc1, shiftId);
    expect(v.totals).toMatchObject({ effectiveMinutes: 90, standbyMinutes: 510 });
  });

  it('dia de plantão não gera hora extra comum (sem dupla contagem)', async () => {
    await ensureProcessed(rc1.employeeId);
    const occ = await listOccurrences(ctxSubst, { employeeId: rc1.employeeId, from: sat, to: sat });
    expect(occ).toEqual([]);
    const rec = await queryOne<{ alerts: string[] }>(getPool(), 'SELECT alerts FROM daily_records WHERE employee_id = $1 AND work_date = $2', [rc1.employeeId, sat]);
    expect(rec!.alerts).toContain('DIA_DE_PLANTAO');
  });

  it('fechamento: segregação, destino obrigatório, crédito único no banco', async () => {
    await expect(closeShift(ctxRc1, { shiftId, destination: 'BANCO' })).rejects.toThrow('permissão');
    await expect(closeShift(ctxSubst, { shiftId })).rejects.toThrow('destino');
    const r = await closeShift(ctxSubst, { shiftId, destination: 'BANCO' });
    expect(r).toEqual({ standby: 510, effective: 90 });
    await expect(closeShift(ctxSubst, { shiftId, destination: 'BANCO' })).rejects.toThrow('já fechado');
    await expect(registerCall(ctxRc1, { shiftId, calledAt: '16:00', attended: false, description: 'Após fechamento' })).rejects.toThrow('fechado');
    const ov = await getBankOverview(ctxRc1, rc1.employeeId);
    expect(ov.summary.balance).toBe(90);
    expect(ov.lines.find((l) => l.kind === 'CREDITO')!.notes).toContain('plantão');
  });

  it('relatório separa sobreaviso e trabalho efetivo; valores só com permissão de custos', async () => {
    await addSalary(ctxOwner, rc1.employeeId, { monthlyAmount: '3000.00', effectiveDate: addDays(today, -700), reason: 'Admissão (fictício)' });
    const period = sat.slice(0, 7);
    const forSubst = (await oncallReport(ctxSubst, period)).find((r) => r.employee_id === rc1.employeeId)!;
    expect(forSubst).toMatchObject({ shifts: 1, standby_minutes: 510, effective_bank: 90, effective_paid: 0, standby_value: null });
    const forOwner = (await oncallReport(ctxOwner, period)).find((r) => r.employee_id === rc1.employeeId)!;
    expect(forOwner.standby_value).toBe('42.50'); // 8,5 h × R$ 15 ÷ 3
    await expect(oncallReport(ctxRc1, period)).rejects.toThrow('permissão');
  });
});

describe('Fase 2b — férias', () => {
  it('solicitação válida, reserva de saldo, aprovação gera ausência e consumo do período aquisitivo', async () => {
    const start = await vacationMonday(45);
    const r = await requestVacation(ctxRc3, { start, end: addDays(start, 19), soldDays: 10 });
    expect(r.warnings.some((w) => w.includes('art. 130'))).toBe(false); // sem faltas: direito integral
    // segundo pedido que, somado ao pendente, excederia o saldo do período mais antigo → usa o próximo período
    const start2 = await vacationMonday(90);
    const r2 = await requestVacation(ctxRc3, { start: start2, end: addDays(start2, 29), soldDays: 0 });
    const payload2 = (await queryOne<{ payload: { periodIndex: number } }>(getPool(), 'SELECT payload FROM requests WHERE id = $1', [r2.id]))!.payload;
    expect(payload2.periodIndex).toBe(2);
    await expect(decideRequest(ctxRc3, { requestId: r.id, approve: true })).rejects.toThrow();
    await expect(decideRequest(ctxSubst, { requestId: r.id, approve: true })).rejects.toThrow('Conferência das faltas');
    const periodStart = (await getVacationOverview(ctxRc3, rc3.employeeId)).periods[0]!.start;
    await reviewVacationPeriod(ctxSubst, { employeeId: rc3.employeeId, periodStart });
    await decideRequest(ctxSubst, { requestId: r.id, approve: true });
    const abs = await queryOne<{ type: string; counts_as_worked: boolean }>(getPool(), 'SELECT type, counts_as_worked FROM absences WHERE request_id = $1', [r.id]);
    expect(abs).toEqual({ type: 'FERIAS', counts_as_worked: true });
    const ov = await getVacationOverview(ctxRc3, rc3.employeeId);
    expect(ov.periods[0]).toMatchObject({ enjoyed: 20, sold: 10, remaining: 0, status: 'QUITADO' });
  });

  it('regras legais aplicadas no pedido (início antes do repouso semanal)', async () => {
    let fri = addDays(today, 50);
    while (weekdayOf(fri) !== 5) fri = addDays(fri, 1);
    await expect(requestVacation(ctxRc2, { start: fri, end: addDays(fri, 19), soldDays: 0 })).rejects.toThrow('art. 134, §3º');
  });

  it('colaborador não consulta férias de outro; cancelamento antes do início desfaz a ausência', async () => {
    await expect(getVacationOverview(ctxRc1, rc2.employeeId)).rejects.toThrow('permissão');
    const start = await vacationMonday(60);
    const r = await requestVacation(ctxRc2, { start, end: addDays(start, 14), soldDays: 0 });
    await reviewVacationPeriod(ctxOwner, { employeeId: rc2.employeeId, periodStart: (await getVacationOverview(ctxOwner, rc2.employeeId)).periods[0]!.start });
    await decideRequest(ctxOwner, { requestId: r.id, approve: true });
    await cancelApprovedVacation(ctxSubst, r.id, 'Necessidade do serviço, com concordância');
    const abs = await queryOne<{ status: string }>(getPool(), 'SELECT status FROM absences WHERE request_id = $1', [r.id]);
    expect(abs!.status).toBe('CANCELADA');
    expect((await getVacationOverview(ctxRc2, rc2.employeeId)).periods[0]!.remaining).toBe(30);
  });
});

describe('Fase 2b — checklists e itens entregues', () => {
  let newId: string;
  let newUser: string;

  it('admissão abre checklist com prazos; itens automáticos são verificados pelo sistema', async () => {
    newId = await createEmployee(ctxSubst, {
      registrationCode: 'CK1', fullName: 'Novo Checklist', jobTitleId: I.jobs.atendente, sectorId: I.sectors.ATD,
      admissionDate: today, contractType: 'CLT', weeklyHours: 40, email: `novo.checklist@${DOMAIN}`, scheduleId: I.schedule,
    });
    newUser = (await queryOne<{ user_id: string }>(getPool(), 'SELECT user_id FROM employees WHERE id = $1', [newId]))!.user_id;
    const [cl] = await listChecklists(ctxSubst, newId);
    expect(cl!.kind).toBe('ADMISSAO');
    expect(cl!.items.length).toBe(15);
    expect(cl!.items.find((i) => i.title.startsWith('Jornada contratual'))!.status).toBe('CONCLUIDO');
    expect(cl!.items.find((i) => i.title.includes('90 dias'))!.due_date).toBe(addDays(today, 89));
    const item = cl!.items[0]!;
    await expect(setChecklistItem(ctxSubst, { itemId: item.id, status: 'NAO_APLICAVEL' })).rejects.toThrow('Justifique');
    await setChecklistItem(ctxSubst, { itemId: item.id, status: 'CONCLUIDO', notes: 'Contrato arquivado' });
    await expect(setChecklistItem(ctxOther, { itemId: cl!.items[1]!.id, status: 'CONCLUIDO' })).rejects.toThrow('permissão');
  });

  it('entrega de uniforme gera termo; ciência sem aprovação (configurável por tipo)', async () => {
    const { termVersionId } = await deliverItem(ctxSubst, newId, { kind: 'UNIFORME', description: 'Camisa institucional', quantity: 2, deliveredAt: today });
    const ctxNew = await ctxFor(newUser);
    await signVersion(ctxNew, { versionId: termVersionId, act: 'CIENCIA', confirmed: true });
    await expect(signVersion(ctxOwner, { versionId: termVersionId, act: 'APROVACAO', confirmed: true })).rejects.toThrow('não exige aprovação');
    expect((await listPendingApprovals(ctxOwner)).some((p) => p.version_id === termVersionId)).toBe(false);
    await updateBooleanSetting(ctxOwner, 'documentos.aprovacao.TERMO_ENTREGA', true);
    await signVersion(ctxOwner, { versionId: termVersionId, act: 'APROVACAO', confirmed: true });
    await updateBooleanSetting(ctxOwner, 'documentos.aprovacao.TERMO_ENTREGA', false);
    await expect(updateBooleanSetting(ctxOwner, 'sessao.inatividade_minutos', true)).rejects.toThrow('não editável');
  });

  it('desligamento abre checklist: acesso revogado automático; devolução conclui o item de itens', async () => {
    await terminateEmployee(ctxOwner, newId, { terminationDate: today, reason: 'Fim do contrato de experiência (fictício)' });
    const cl = (await listChecklists(ctxSubst, newId)).find((c) => c.kind === 'DESLIGAMENTO')!;
    expect(cl.items.find((i) => i.title.startsWith('Acessos ao sistema'))!.status).toBe('CONCLUIDO');
    const devol = () => cl.items.find((i) => i.title.startsWith('Devolução'))!;
    expect(devol().status).toBe('PENDENTE');
    const item = (await query<{ id: string }>(getPool(), 'SELECT id FROM employee_items WHERE employee_id = $1', [newId]))[0]!;
    await returnItem(ctxSubst, item.id, today);
    const after = (await listChecklists(ctxSubst, newId)).find((c) => c.kind === 'DESLIGAMENTO')!;
    expect(after.items.find((i) => i.title.startsWith('Devolução'))!.status).toBe('CONCLUIDO');
  });
});
