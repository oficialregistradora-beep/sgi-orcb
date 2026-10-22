import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import { getVacationOverview, requestVacation, reviewVacationPeriod } from '../../../src/server/modules/vacation.ts';
import { decideRequest, createRequest } from '../../../src/server/modules/requests.ts';
import { getBankOverview, listOccurrences, resolveOccurrence } from '../../../src/server/modules/hourbank.ts';
import { ensureProcessed, listPunches } from '../../../src/server/modules/timeclock.ts';
import { closeRule, createRule, getRule, listLegalRegistry, validateRule } from '../../../src/server/modules/legalRules.ts';
import {
  createTemplate, duplicateTemplate, getTemplate, listTemplates, moveItem, newVersion, publishTemplate, saveItem,
} from '../../../src/server/modules/checklistTemplates.ts';
import { listChecklists, setChecklistItem } from '../../../src/server/modules/checklists.ts';
import { createEmployee, addSalary } from '../../../src/server/modules/people.ts';
import { getShift, registerCall } from '../../../src/server/modules/oncall.ts';
import { acquisitivePeriods } from '../../../src/domain/vacation.ts';
import { addDays, addMonths, localToInstant, todayLocal, weekdayOf } from '../../../src/domain/time.ts';
import { expiryByRule } from '../../../src/domain/hourBank.ts';
import { closePool, ctxFor, FULL_DAY, ids, makePerson, resetDatabase, seedPunches } from '../../helpers.ts';

let I: Awaited<ReturnType<typeof ids>>;
type P = { userId: string; employeeId: string };
let owner: P, subst: P, worker: P;
let ctxOwner: Ctx, ctxSubst: Ctx, ctxWorker: Ctx;
const today = todayLocal();
const admission = addDays(today, -400);
let period1: { start: string; end: string };
const fullAbsences: string[] = [];
const lateDays: string[] = [];

async function isOff(d: string) {
  return weekdayOf(d) === 0 || weekdayOf(d) === 6 || !!(await queryOne(getPool(), 'SELECT 1 FROM holidays WHERE date = $1', [d]));
}

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  owner = await makePerson({ name: 'Oficial Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true, admission });
  subst = await makePerson({ name: 'Substituta Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }], admission });
  worker = await makePerson({ name: 'Func Faltas', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }], admission, scheduleId: I.schedule, agreementMonths: 6 });
  ctxOwner = await ctxFor(owner.userId);
  ctxSubst = await ctxFor(subst.userId);
  ctxWorker = await ctxFor(worker.userId);
  period1 = acquisitivePeriods(admission, today)[0]!;
  // Janela de 10 dias úteis no início do período 1: 7 faltas integrais e 3 atrasos; o restante é ausência abonada.
  const window: string[] = [];
  for (let d = addDays(admission, 7); window.length < 10; d = addDays(d, 1)) if (!(await isOff(d))) window.push(d);
  fullAbsences.push(...window.slice(0, 7));
  lateDays.push(...window.slice(7));
  for (const d of lateDays) await seedPunches(worker.employeeId, d, ['09:30', '12:00', '13:00', '17:00'], owner.userId);
  await query(getPool(), "INSERT INTO absences (employee_id, type, start_date, end_date) VALUES ($1,'OUTRO',$2,$3), ($1,'OUTRO',$4,$5)", [
    worker.employeeId, admission, addDays(window[0]!, -1), addDays(window[9]!, 1), addDays(today, -1),
  ]);
  await ensureProcessed(worker.employeeId);
});
afterAll(closePool);

describe('J-13 — faltas e redução das férias (art. 130)', () => {
  it('classifica: só faltas integrais contam; atrasos não viram faltas; pendentes impedem a conferência', async () => {
    const occ = (await listOccurrences(ctxSubst, { employeeId: worker.employeeId, status: 'PENDENTE' })).sort((a, b) => a.work_date.localeCompare(b.work_date));
    expect(occ.length).toBe(10);
    // 6 faltas integrais injustificadas, 1 abonada; os 3 atrasos também decididos como "não justificados" (mas não contam).
    for (const o of occ) {
      if (o.work_date === fullAbsences[6]) continue; // deixada pendente
      const resolution = o.work_date === fullAbsences[5] ? 'ABONO' : 'FALTA_NAO_JUSTIFICADA';
      await resolveOccurrence(ctxSubst, { occurrenceId: o.id, resolution, notes: 'Decisão de teste' });
    }
    await expect(reviewVacationPeriod(ctxSubst, { employeeId: worker.employeeId, periodStart: period1.start })).rejects.toThrow('sem classificação');
    const pending = occ.find((o) => o.work_date === fullAbsences[6])!;
    await resolveOccurrence(ctxSubst, { occurrenceId: pending.id, resolution: 'FALTA_NAO_JUSTIFICADA', notes: 'Sem justificativa' });
    const r = await reviewVacationPeriod(ctxSubst, { employeeId: worker.employeeId, periodStart: period1.start, notes: 'Conferido' });
    expect(r.entitlement).toBe(24); // 6 faltas injustificadas → 24 dias
    const ov = await getVacationOverview(ctxWorker, worker.employeeId);
    const p = ov.periods[0]!;
    expect(p).toMatchObject({ entitlement: 24, remaining: 24 });
    const review = ov.reviews.get(period1.start)!;
    expect(review.calculation).toMatchObject({ faixaArt130: 'De 6 a 14', diasPelaFaixa: 24, atrasosESaidasNaoConvertidos: 3 });
    expect((review.calculation.faltasInjustificadas as string[]).length).toBe(6);
  });

  it('pedido e aprovação respeitam o direito apurado; conferência desatualizada bloqueia a aprovação', async () => {
    let start = addDays(today, 45);
    while (weekdayOf(start) !== 1 || (await isOff(addDays(start, 1))) || (await isOff(addDays(start, 2)))) start = addDays(start, 1);
    await expect(requestVacation(ctxWorker, { start, end: addDays(start, 29), soldDays: 0 })).rejects.toThrow('restam 24');
    const req = await requestVacation(ctxWorker, { start, end: addDays(start, 23), soldDays: 0 });
    expect(req.warnings.some((w) => w.includes('reduzido a 24'))).toBe(true);
    // Correção posterior altera um dia de atraso para falta integral → nova ocorrência pendente → conferência desatualizada.
    const late = lateDays[0]!;
    const punches = await listPunches(getPool(), worker.employeeId, late, late);
    for (const pu of punches) {
      const r = await createRequest(ctxWorker, { type: 'CORRECAO_PONTO', referenceDate: late, payload: { action: 'DESCONSIDERAR', punchId: pu.id }, justification: 'Registro indevido (teste)' });
      await decideRequest(ctxSubst, { requestId: r, approve: true });
    }
    await expect(decideRequest(ctxSubst, { requestId: req.id, approve: true })).rejects.toThrow('desatualizada');
    const o = (await listOccurrences(ctxSubst, { employeeId: worker.employeeId, status: 'PENDENTE' }))[0]!;
    await resolveOccurrence(ctxSubst, { occurrenceId: o.id, resolution: 'ABONO', notes: 'Abonada' });
    await reviewVacationPeriod(ctxSubst, { employeeId: worker.employeeId, periodStart: period1.start });
    await decideRequest(ctxSubst, { requestId: req.id, approve: true });
  });

  it('perda do direito (art. 133) exige fundamentação, zera o período e bloqueia pedidos', async () => {
    const adm = addDays(today, -500);
    const p = await makePerson({ name: 'Func Art133', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }], admission: adm, scheduleId: I.schedule });
    await query(getPool(), "INSERT INTO absences (employee_id, type, start_date, end_date) VALUES ($1,'AFASTAMENTO_INSS',$2,$3)", [p.employeeId, adm, addDays(today, -1)]);
    const start = acquisitivePeriods(adm, today)[0]!.start;
    await expect(reviewVacationPeriod(ctxSubst, { employeeId: p.employeeId, periodStart: start, art133Loss: true })).rejects.toThrow('Fundamente');
    const r = await reviewVacationPeriod(ctxSubst, { employeeId: p.employeeId, periodStart: start, art133Loss: true, art133Reason: 'Afastamento previdenciário superior a 6 meses (art. 133, IV) — fictício' });
    expect(r.entitlement).toBe(0);
    const ctxP = await ctxFor(p.userId);
    expect((await getVacationOverview(ctxP, p.employeeId)).periods[0]!.status).toBe('PERDIDO');
    let s = addDays(today, 40);
    while (weekdayOf(s) !== 1) s = addDays(s, 1);
    await expect(requestVacation(ctxP, { start: s, end: addDays(s, 19), soldDays: 0 })).rejects.toThrow('período aquisitivo completo');
  });

  it('o próprio funcionário não confere suas faltas', async () => {
    await expect(reviewVacationPeriod(ctxWorker, { employeeId: worker.employeeId, periodStart: period1.start })).rejects.toThrow('permissão');
  });
});

describe('J-07/J-14 — regras jurídicas por vigência', () => {
  it('cadastro inicial: CCT vigente com leitura pendente; regras históricas da CCT anterior nunca aplicadas', async () => {
    const reg = await listLegalRegistry(ctxOwner);
    expect(reg.instruments.find((i) => i.code === 'SC000957/2026')!.status).toBe('VIGENTE_LEITURA_PENDENTE');
    expect(reg.rules.filter((r) => r.status === 'HISTORICO_NAO_APLICAR').map((r) => r.code).sort()).toEqual(
      ['BANCO_COMUNICACAO_MINIMA', 'BANCO_FATOR_CONVERSAO', 'BANCO_PRAZO', 'FERIAS_VEDAR_INICIO_FDS_FERIADO'],
    );
    expect(await getRule(getPool(), 'BANCO_FATOR_CONVERSAO', '2025-06-01', { allowPending: true })).toBeNull();
    const hist = reg.rules.find((r) => r.status === 'HISTORICO_NAO_APLICAR')!;
    await expect(getPool().query("UPDATE legal_rules SET status = 'VALIDADO', validated_by = 'x', validated_at = current_date WHERE id = $1", [hist.id])).rejects.toThrow(/histórica/);
    await expect(getPool().query("UPDATE legal_rules SET value = '{}' WHERE id = $1", [hist.id])).rejects.toThrow(/imutável/);
    await expect(getPool().query('DELETE FROM legal_rules WHERE id = $1', [hist.id])).rejects.toThrow(/não podem ser excluídas/);
  });

  it('regra PENDENTE não altera o banco; regra VALIDADA (fator e prazo) passa a valer na vigência', async () => {
    const p = await makePerson({ name: 'Func Regras', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }], admission: addDays(today, -30), scheduleId: I.schedule, agreementMonths: 6 });
    let d1 = addDays(today, -20);
    while (await isOff(d1)) d1 = addDays(d1, 1);
    let d2 = addDays(d1, 1);
    while (await isOff(d2)) d2 = addDays(d2, 1);
    for (let d = addDays(today, -30); d < today; d = addDays(d, 1)) {
      if (await isOff(d)) continue;
      await seedPunches(p.employeeId, d, d === d1 || d === d2 ? ['08:00', '12:00', '13:00', '18:00'] : FULL_DAY, owner.userId);
    }
    await ensureProcessed(p.employeeId);
    const [o1, o2] = (await listOccurrences(ctxSubst, { employeeId: p.employeeId, status: 'PENDENTE' })).sort((a, b) => a.work_date.localeCompare(b.work_date));
    // Pendente: não aplicada
    const pendingId = await createRule(ctxOwner, { code: 'BANCO_FATOR_CONVERSAO', value: { minutosFolgaPorHora: 90 }, validFrom: d2, legalBasis: 'Cláusula X da CCT (teste)', source: 'Teste' });
    await resolveOccurrence(ctxSubst, { occurrenceId: o1!.id, resolution: 'BANCO_CREDITO' });
    expect((await getBankOverview(ctxOwner, p.employeeId)).summary.balance).toBe(60);
    // Validada a partir de d2: conversão 1h → 1h30 e prazo de 90 dias após o mês
    await expect(validateRule({ ...ctxOwner, stepUpAt: null }, { ruleId: pendingId, validatedBy: 'Advogada Fictícia — OAB/SC 00000', validatedAt: today })).rejects.toThrow('reautenticação');
    await validateRule(ctxOwner, { ruleId: pendingId, validatedBy: 'Advogada Fictícia — OAB/SC 00000', validatedAt: today });
    await createRule(ctxOwner, { code: 'BANCO_PRAZO', value: { modo: 'DIAS_APOS_MES', quantidade: 90 }, validFrom: d2, legalBasis: 'Cláusula Y da CCT (teste)', source: 'Teste', validatedBy: 'Advogada Fictícia — OAB/SC 00000', validatedAt: today });
    await resolveOccurrence(ctxSubst, { occurrenceId: o2!.id, resolution: 'BANCO_CREDITO' });
    const ov = await getBankOverview(ctxOwner, p.employeeId);
    expect(ov.summary.balance).toBe(60 + 90);
    const second = ov.lots.find((l) => l.entryDate === d2)!;
    expect(second.minutes).toBe(90);
    expect(second.expiresOn).toBe(expiryByRule(d2, { modo: 'DIAS_APOS_MES', quantidade: 90 }));
    expect(ov.lots.find((l) => l.entryDate === d1)!.expiresOn).toBe(addMonths(d1, 6)); // crédito anterior: prazo do acordo
    // Sobreposição de regras validadas é recusada
    await expect(createRule(ctxOwner, { code: 'BANCO_PRAZO', value: { modo: 'MESES', quantidade: 6 }, validFrom: d2, legalBasis: 'Outra', source: 'Teste', validatedBy: 'Advogada Fictícia — OAB/SC 00000', validatedAt: today })).rejects.toThrow('sobreposta');
    // Encerramento da vigência
    const prazo = (await listLegalRegistry(ctxOwner)).rules.find((r) => r.code === 'BANCO_PRAZO' && r.status === 'VALIDADO')!;
    await closeRule(ctxOwner, prazo.id, today, 'Encerramento de teste');
  });

  it('comunicação mínima validada bloqueia compensação em cima da hora', async () => {
    const p = await makePerson({ name: 'Func Comunica', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }], admission: addDays(today, -5), scheduleId: I.schedule, agreementMonths: 6 });
    const ctxP = await ctxFor(p.userId);
    let tomorrow = addDays(today, 1);
    while (await isOff(tomorrow)) tomorrow = addDays(tomorrow, 1);
    const noticeId = await createRule(ctxOwner, { code: 'BANCO_COMUNICACAO_MINIMA', value: { horas: 48 }, validFrom: today, legalBasis: 'Cláusula Z (teste)', source: 'Teste', validatedBy: 'Advogada Fictícia — OAB/SC 00000', validatedAt: today });
    await expect(createRequest(ctxP, { type: 'COMPENSACAO', referenceDate: tomorrow, payload: { mode: 'SAIDA_ANTECIPADA', minutes: 30 }, justification: 'Em cima da hora' })).rejects.toThrow('48 horas');
    let later = addDays(today, 5);
    while (await isOff(later)) later = addDays(later, 1);
    await createRequest(ctxP, { type: 'COMPENSACAO', referenceDate: later, payload: { mode: 'SAIDA_ANTECIPADA', minutes: 30 }, justification: 'Com antecedência' }).catch((e: Error) => {
      expect(e.message).not.toContain('antecedência'); // pode falhar por falta de saldo, nunca pela comunicação
    });
    await closeRule(ctxOwner, noticeId, today, 'Fim do teste');
  });

  it('estimativas usam regra pendente sinalizada; colaborador não gerencia regras', async () => {
    await addSalary(ctxOwner, worker.employeeId, { monthlyAmount: '3000.00', effectiveDate: admission, reason: 'Teste' });
    const ov = await getBankOverview(ctxOwner, worker.employeeId);
    expect(ov.cost!.basis).toContain('PENDENTE DE VALIDAÇÃO');
    await expect(listLegalRegistry(ctxWorker)).rejects.toThrow('permissão');
    await expect(createRule(ctxSubst, { code: 'DIVISOR_SALARIO_HORAS', value: { horas: 220 }, validFrom: today, legalBasis: 'Teste', source: 'Teste' })).rejects.toThrow('permissão');
    await expect(createRule(ctxOwner, { code: 'DIVISOR_SALARIO_HORAS', value: { horas: 20 }, validFrom: today, legalBasis: 'Teste', source: 'Teste' })).rejects.toThrow();
  });
});

describe('Modelos de checklist editáveis e versionados', () => {
  it('criar, ordenar e publicar; versão anterior inativada; checklists antigos preservados', async () => {
    const before = await createEmployee(ctxOwner, { registrationCode: 'V1', fullName: 'Admitido Versao Um', jobTitleId: I.jobs.atendente, sectorId: I.sectors.ATD, admissionDate: today, contractType: 'CLT', weeklyHours: 40 });
    const oldItems = (await listChecklists(ctxOwner, before))[0]!.items.length;
    const published = (await listTemplates(ctxOwner)).find((t) => t.kind === 'ADMISSAO' && t.status === 'PUBLICADO')!;
    const draft = await newVersion(ctxSubst, published.id);
    await expect(newVersion(ctxSubst, published.id)).rejects.toThrow('rascunho');
    const it1 = await saveItem(ctxSubst, { templateId: draft, title: 'Assinatura do termo de uso de certificado digital', dueOffsetDays: 3, required: true, evidenceRequired: true, responsibleRoleId: I.roles.SUBSTITUTA_LEGAL });
    await moveItem(ctxSubst, draft, it1, 'UP');
    const view = await getTemplate(ctxSubst, draft);
    expect(view.items.length).toBe(oldItems + 1);
    expect(view.items.at(-2)!.id).toBe(it1);
    await expect(publishTemplate(ctxSubst, draft)).rejects.toThrow('permissão'); // editar ≠ publicar
    await publishTemplate(ctxOwner, draft);
    const all = await listTemplates(ctxOwner);
    expect(all.find((t) => t.id === published.id)!.status).toBe('INATIVO');
    expect(all.find((t) => t.id === draft)!).toMatchObject({ status: 'PUBLICADO', version: 2 });
    // Publicado é imutável (serviço e banco)
    await expect(saveItem(ctxOwner, { templateId: draft, title: 'Indevido', dueOffsetDays: 0, required: false, evidenceRequired: false })).rejects.toThrow('rascunhos');
    await expect(getPool().query("UPDATE checklist_template_items SET title = 'x' WHERE template_id = $1", [draft])).rejects.toThrow(/imutáveis/);
    // Nova admissão usa a versão 2; a anterior permanece como estava
    const after = await createEmployee(ctxOwner, { registrationCode: 'V2', fullName: 'Admitido Versao Dois', jobTitleId: I.jobs.atendente, sectorId: I.sectors.ATD, admissionDate: today, contractType: 'CLT', weeklyHours: 40 });
    const [clNew] = await listChecklists(ctxOwner, after);
    expect(clNew!.template_version).toBe(2);
    expect(clNew!.items.length).toBe(oldItems + 1);
    expect((await listChecklists(ctxOwner, before))[0]!.items.length).toBe(oldItems);
    // Exigências: obrigatório não admite "não se aplica"; evidência exigida
    const req = clNew!.items.find((i) => i.title.startsWith('Assinatura do termo'))!;
    expect(req).toMatchObject({ required: true, evidence_required: true, responsible_role_name: 'Substituta Legal' });
    await expect(setChecklistItem(ctxOwner, { itemId: req.id, status: 'NAO_APLICAVEL', notes: 'x'.repeat(10) })).rejects.toThrow('obrigatório');
    await expect(setChecklistItem(ctxOwner, { itemId: req.id, status: 'CONCLUIDO' })).rejects.toThrow('evidência');
    await setChecklistItem(ctxOwner, { itemId: req.id, status: 'CONCLUIDO', evidence: 'Termo arquivado na pasta funcional, folha 3' });
  });

  it('duplicar cria modelo independente; colaborador não acessa modelos', async () => {
    const pub = (await listTemplates(ctxOwner)).find((t) => t.kind === 'DESLIGAMENTO' && t.status === 'PUBLICADO')!;
    const dup = await duplicateTemplate(ctxSubst, pub.id, 'Desligamento — estagiários');
    const t = await getTemplate(ctxOwner, dup);
    expect(t.template).toMatchObject({ version: 1, status: 'RASCUNHO', name: 'Desligamento — estagiários' });
    expect(t.template.family_id).not.toBe(pub.family_id);
    await expect(listTemplates(ctxWorker)).rejects.toThrow('permissão');
    await expect(createTemplate(ctxWorker, { kind: 'OUTRO', name: 'Indevido' })).rejects.toThrow('permissão');
  });
});

describe('Plantão — regra do substituto (determinação da Oficial)', () => {
  it('chamado registrado pelo substituto gera aviso para trocar o responsável antes do fechamento', async () => {
    const resp = await makePerson({ name: 'Plantonista R', sectorId: I.sectors.RCPN, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }], admission });
    const sub = await makePerson({ name: 'Plantonista S', sectorId: I.sectors.RCPN, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }], admission });
    let sat = addDays(today, -1);
    while (weekdayOf(sat) !== 6) sat = addDays(sat, -1);
    const id = (await queryOne<{ id: string }>(getPool(), 'INSERT INTO oncall_shifts (shift_date, starts_at, ends_at, employee_id, substitute_employee_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [sat, localToInstant(sat, '08:00'), localToInstant(sat, '18:00'), resp.employeeId, sub.employeeId]))!.id;
    const ctxSub = await ctxFor(sub.userId);
    expect((await getShift(ctxOwner, id)).warnings).toEqual([]);
    await registerCall(ctxSub, { shiftId: id, calledAt: '10:00', attended: true, arrivalAt: '10:20', departureAt: '11:00', description: 'Atendido pelo substituto' });
    expect((await getShift(ctxOwner, id)).warnings[0]).toContain('troque o responsável');
  });
});

