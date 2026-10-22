import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import { audit, verifyAuditChain } from '../../../src/server/audit.ts';
import {
  getEmployeeFor, getSensitiveData, listEmployees, listSalaryHistory, addSalary, updateSensitiveData, terminateEmployee,
} from '../../../src/server/modules/people.ts';
import { getBankOverview, listOccurrences, resolveOccurrence } from '../../../src/server/modules/hourbank.ts';
import { assignRole, listUsers, setUserStatus } from '../../../src/server/modules/admin.ts';
import { createRequest, decideRequest, listRequestsToDecide } from '../../../src/server/modules/requests.ts';
import { punch } from '../../../src/server/modules/timeclock.ts';
import { listAudit } from '../../../src/server/modules/dashboard.ts';
import { createSession, validateSession } from '../../../src/server/auth/session.ts';
import { addDays, todayLocal, weekdayOf } from '../../../src/domain/time.ts';
import { closePool, ctxFor, FULL_DAY, ids, makePerson, pastMonday, resetDatabase, seedPunches } from '../../helpers.ts';

let I: Awaited<ReturnType<typeof ids>>;
type P = { userId: string; employeeId: string };
let owner: P, subst: P, coordRI: P, workerRI: P, workerATD: P;
let ctxOwner: Ctx, ctxSubst: Ctx, ctxCoordRI: Ctx, ctxWorkerRI: Ctx, ctxWorkerATD: Ctx;
let monday: string;

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  monday = await pastMonday(2);
  owner = await makePerson({ name: 'Oficial Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
  subst = await makePerson({ name: 'Substituta Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }, { roleId: I.roles.COLABORADOR }] });
  coordRI = await makePerson({ name: 'Coord RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COORDENACAO_SETOR }, { roleId: I.roles.COLABORADOR }] });
  workerRI = await makePerson({ name: 'Func RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }], admission: monday, scheduleId: I.schedule, agreementMonths: 6 });
  workerATD = await makePerson({ name: 'Func ATD', sectorId: I.sectors.ATD, jobId: I.jobs.atendente, roles: [{ roleId: I.roles.COLABORADOR }], admission: monday, scheduleId: I.schedule, agreementMonths: 6 });
  ctxOwner = await ctxFor(owner.userId);
  ctxSubst = await ctxFor(subst.userId);
  ctxCoordRI = await ctxFor(coordRI.userId);
  ctxWorkerRI = await ctxFor(workerRI.userId);
  ctxWorkerATD = await ctxFor(workerATD.userId);
  // Eventos auditados reais, para que a trilha não esteja vazia nos testes de imutabilidade.
  for (let i = 0; i < 6; i++) {
    await audit(getPool(), ctxOwner, { action: 'TESTE_EVENTO', entityType: 'teste', entityId: String(i), summary: `Evento de teste ${i}` });
  }
  for (const p of [workerRI, workerATD]) {
    for (let d = monday; d < todayLocal(); d = addDays(d, 1)) {
      if (weekdayOf(d) === 0 || weekdayOf(d) === 6) continue;
      if (await queryOne(getPool(), 'SELECT 1 FROM holidays WHERE date = $1', [d])) continue;
      await seedPunches(p.employeeId, d, d === monday ? ['08:00', '12:00', '13:00', '18:00'] : FULL_DAY, owner.userId);
    }
  }
});
afterAll(closePool);

describe('Rodada 2 — imutabilidade garantida pelo banco de dados', () => {
  it.each([
    ['time_punches', 'UPDATE time_punches SET punched_at = now() WHERE true'],
    ['time_punches', 'DELETE FROM time_punches WHERE true'],
    ['audit_log', "UPDATE audit_log SET summary = 'x' WHERE true"],
    ['audit_log', 'DELETE FROM audit_log WHERE true'],
    ['audit_log', 'TRUNCATE audit_log'],
  ])('%s: "%s" é bloqueado', async (_t, sql) => {
    await expect(getPool().query(sql)).rejects.toThrow(/imutável/);
  });

  it('marcação WEB sempre recebe o horário do servidor, mesmo se o cliente tentar informar outro', async () => {
    const r = await queryOne<{ punched_at: Date }>(
      getPool(),
      `INSERT INTO time_punches (employee_id, punched_at, local_date, kind, source, created_by)
       VALUES ($1, '2000-01-01T08:00:00Z', '2000-01-01', 'ENTRADA', 'WEB', $2) RETURNING punched_at`,
      [workerATD.employeeId, workerATD.userId],
    );
    expect(Math.abs(r!.punched_at.getTime() - Date.now())).toBeLessThan(10_000);
  });
});

describe('Rodada 2 — trilha de auditoria encadeada', () => {
  it('cadeia íntegra e verificável', async () => {
    const v = await verifyAuditChain(getPool());
    expect(v.ok).toBe(true);
    expect(v.total).toBeGreaterThan(0);
  });

  it('adulteração direta (mesmo contornando o trigger com privilégio de dono) é DETECTADA', async () => {
    const c = await getPool().connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE audit_log DISABLE TRIGGER trg_audit_immutable');
      await c.query("UPDATE audit_log SET summary = summary || ' (adulterado)' WHERE id = (SELECT min(id) FROM audit_log)");
      const v = await verifyAuditChain(c);
      expect(v.ok).toBe(false);
      expect(v.reason).toContain('hash');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });

  it('consulta da auditoria é restrita', async () => {
    await expect(listAudit(ctxSubst)).rejects.toThrow('permissão');
    expect((await listAudit(ctxOwner, { limit: 5 })).length).toBe(5);
  });
});

describe('Rodada 2 — segregação de informações (IDOR e escopos)', () => {
  it('colaborador acessa somente os próprios dados', async () => {
    await expect(getEmployeeFor(ctxWorkerRI, 'pessoas.ver', workerATD.employeeId)).rejects.toThrow('permissão');
    await expect(getBankOverview(ctxWorkerRI, workerATD.employeeId)).rejects.toThrow('permissão');
    await expect(listOccurrences(ctxWorkerRI, { employeeId: workerATD.employeeId })).rejects.toThrow('permissão');
    expect((await listEmployees(ctxWorkerRI)).map((e) => e.id)).toEqual([workerRI.employeeId]);
    await expect(listOccurrences(ctxWorkerRI)).rejects.toThrow('permissão');
  });

  it('coordenação vê o próprio setor, não os demais', async () => {
    expect((await listEmployees(ctxCoordRI)).map((e) => e.id).sort()).toEqual([coordRI.employeeId, workerRI.employeeId].sort());
    await getBankOverview(ctxCoordRI, workerRI.employeeId);
    await expect(getBankOverview(ctxCoordRI, workerATD.employeeId)).rejects.toThrow('permissão');
  });

  it('dados sensíveis e salário: nem a Substituta Legal acessa sem delegação expressa', async () => {
    await updateSensitiveData(ctxOwner, workerRI.employeeId, { cpf: '529.982.247-25', address: 'Rua Fictícia, 100' });
    await expect(getSensitiveData(ctxSubst, workerRI.employeeId)).rejects.toThrow('permissão');
    await expect(listSalaryHistory(ctxSubst, workerRI.employeeId)).rejects.toThrow('permissão');
    const data = await getSensitiveData(ctxOwner, workerRI.employeeId);
    expect(data).toMatchObject({ cpf: '52998224725', address: 'Rua Fictícia, 100' });
    const logged = await queryOne(getPool(), "SELECT 1 FROM audit_log WHERE action = 'DADO_SENSIVEL_CONSULTADO' AND entity_id = $1", [workerRI.employeeId]);
    expect(logged).not.toBeNull();
  });

  it('dados sensíveis e salário ficam criptografados em repouso e fora da trilha de auditoria', async () => {
    await addSalary(ctxOwner, workerRI.employeeId, { monthlyAmount: '3500.00', effectiveDate: monday, reason: 'Admissão' });
    const raw = await queryOne<Record<string, string>>(getPool(), 'SELECT * FROM employee_sensitive WHERE employee_id = $1', [workerRI.employeeId]);
    expect(JSON.stringify(raw)).not.toContain('52998224725');
    expect(JSON.stringify(raw)).not.toContain('Rua Fictícia');
    const audits = await query<{ data: unknown }>(getPool(), "SELECT data FROM audit_log WHERE action IN ('DADO_SENSIVEL_ALTERADO','SALARIO_REGISTRADO')");
    expect(JSON.stringify(audits)).not.toContain('52998224725');
    expect(JSON.stringify(audits)).not.toContain('3500');
  });

  it('administração de usuários restrita a quem tem permissão', async () => {
    await expect(listUsers(ctxSubst)).rejects.toThrow('permissão');
    await expect(setUserStatus(ctxSubst, { userId: workerRI.userId, status: 'SUSPENSO', reason: 'Tentativa indevida' })).rejects.toThrow('permissão');
  });
});

describe('Rodada 2 — segregação de funções', () => {
  it('ninguém aprova a própria solicitação nem analisa a própria ocorrência', async () => {
    const day = addDays(todayLocal(), 7);
    const ctxSubstWithEmp = ctxSubst;
    // a Substituta (que pode aprovar compensações) não aprova o próprio pedido
    await query(getPool(), 'INSERT INTO employee_schedules (employee_id, schedule_id, valid_from) VALUES ($1,$2,$3)', [subst.employeeId, I.schedule, addDays(todayLocal(), -1)]);
    await query(getPool(), "INSERT INTO hour_bank_agreements (employee_id, kind, compensation_months, valid_from, document_reference) VALUES ($1,'INDIVIDUAL_ESCRITO',6,$2,'Acordo fictício')", [subst.employeeId, addDays(todayLocal(), -1)]);
    let d = day;
    while (weekdayOf(d) === 0 || weekdayOf(d) === 6 || (await queryOne(getPool(), 'SELECT 1 FROM holidays WHERE date = $1', [d]))) d = addDays(d, 1);
    const r = await createRequest(ctxSubstWithEmp, { type: 'COMPENSACAO', referenceDate: d, payload: { mode: 'SAIDA_ANTECIPADA', minutes: 30 }, justification: 'Pedido próprio' });
    await expect(decideRequest(ctxSubst, { requestId: r, approve: true })).rejects.toThrow('própria solicitação');
    expect((await listRequestsToDecide(ctxSubst)).some((x) => x.id === r)).toBe(false);
  });

  it('ninguém atribui papel a si mesmo (exceto a Oficial, autoridade máxima)', async () => {
    await query(getPool(), "INSERT INTO user_roles (user_id, role_id, valid_from) SELECT $1, role_id, current_date FROM role_permissions WHERE permission_code = 'permissoes.gerenciar' AND role_id <> $2 LIMIT 1", [subst.userId, I.roles.OFICIAL]);
    const roleWithPerm = await queryOne<{ id: string }>(getPool(), "SELECT id FROM roles WHERE code = 'COLABORADOR'");
    // concede temporariamente permissoes.gerenciar à Substituta para provar a regra
    await query(getPool(), "INSERT INTO role_permissions (role_id, permission_code, scope) VALUES ($1, 'permissoes.gerenciar', 'TODOS') ON CONFLICT DO NOTHING", [I.roles.SUBSTITUTA_LEGAL]);
    const ctx = await ctxFor(subst.userId);
    await expect(assignRole(ctx, { userId: subst.userId, roleId: roleWithPerm!.id, validFrom: todayLocal(), reason: 'Autoconcessão' })).rejects.toThrow('a si mesmo');
    await query(getPool(), "DELETE FROM role_permissions WHERE role_id = $1 AND permission_code = 'permissoes.gerenciar'", [I.roles.SUBSTITUTA_LEGAL]);
  });

  it('operações críticas exigem reautenticação recente', async () => {
    const stale = await ctxFor(owner.userId, { stepUp: false });
    await expect(updateSensitiveData(stale, workerRI.employeeId, { phone: '48 0000-0000' })).rejects.toThrow('reautenticação');
    await expect(addSalary(stale, workerRI.employeeId, { monthlyAmount: '1.00', effectiveDate: todayLocal(), reason: 'x' + 'yz' })).rejects.toThrow('reautenticação');
    const old = { ...ctxOwner, stepUpAt: new Date(Date.now() - 11 * 60_000) };
    await expect(terminateEmployee(old, workerATD.employeeId, { terminationDate: todayLocal(), reason: 'Teste de expiração' })).rejects.toThrow('reautenticação');
  });
});

describe('Rodada 2 — concorrência', () => {
  it('cliques simultâneos de marcação geram exatamente uma marcação', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => punch(ctxWorkerRI)));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    const n = await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM time_punches WHERE employee_id = $1 AND source = 'WEB'", [workerRI.employeeId]);
    expect(n!.n).toBe(1);
  });

  it('aprovações simultâneas não consomem o mesmo crédito duas vezes', async () => {
    const [occ] = (await listOccurrences(ctxSubst, { employeeId: workerATD.employeeId, status: 'PENDENTE' })).filter((o) => o.type === 'HORA_EXTRA');
    await resolveOccurrence(ctxSubst, { occurrenceId: occ!.id, resolution: 'BANCO_CREDITO' }); // +60
    let d = addDays(todayLocal(), 1);
    const days: string[] = [];
    while (days.length < 2) {
      if (weekdayOf(d) !== 0 && weekdayOf(d) !== 6 && !(await queryOne(getPool(), 'SELECT 1 FROM holidays WHERE date = $1', [d]))) days.push(d);
      d = addDays(d, 1);
    }
    const r1 = await createRequest(ctxWorkerATD, { type: 'COMPENSACAO', referenceDate: days[0]!, payload: { mode: 'SAIDA_ANTECIPADA', minutes: 45 }, justification: 'Concorrência 1' });
    const r2 = await createRequest(ctxWorkerATD, { type: 'COMPENSACAO', referenceDate: days[1]!, payload: { mode: 'SAIDA_ANTECIPADA', minutes: 45 }, justification: 'Concorrência 2' });
    const res = await Promise.allSettled([
      decideRequest(ctxSubst, { requestId: r1, approve: true }),
      decideRequest(ctxOwner, { requestId: r2, approve: true }),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled').length).toBe(1);
    const ov = await getBankOverview(ctxOwner, workerATD.employeeId);
    expect(ov.summary.balance).toBe(15);
    expect(ov.summary.available).toBe(15);
  });

  it('a mesma solicitação decidida em paralelo é processada uma única vez', async () => {
    const r = await createRequest(ctxWorkerRI, { type: 'CORRECAO_PONTO', referenceDate: addDays(monday, 1), payload: { action: 'INCLUIR', time: '18:00' }, justification: 'Teste de concorrência' });
    const res = await Promise.allSettled([
      decideRequest(ctxCoordRI, { requestId: r, approve: true }),
      decideRequest(ctxSubst, { requestId: r, approve: true }),
    ]);
    expect(res.filter((x) => x.status === 'fulfilled').length).toBe(1);
    const n = await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM time_punches WHERE correction_request_id = $1', [r]);
    expect(n!.n).toBe(1);
  });
});

describe('Rodada 2 — desligamento revoga acesso imediatamente', () => {
  it('sessões ativas deixam de valer e os registros são preservados', async () => {
    const { token } = await createSession(getPool(), workerATD.userId, 'DEV', null, null);
    expect((await validateSession(getPool(), token)).ok).toBe(true);
    await expect(terminateEmployee(ctxWorkerATD, workerATD.employeeId, { terminationDate: todayLocal(), reason: 'Autodesligamento' })).rejects.toThrow();
    await terminateEmployee(ctxOwner, workerATD.employeeId, { terminationDate: todayLocal(), reason: 'Pedido de demissão (fictício)' });
    expect((await validateSession(getPool(), token)).ok).toBe(false);
    const kept = await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM time_punches WHERE employee_id = $1', [workerATD.employeeId]);
    expect(kept!.n).toBeGreaterThan(0);
    const ov = await getBankOverview(ctxOwner, workerATD.employeeId);
    expect(ov.summary.balance).toBe(15); // saldo sinalizado para apuração rescisória, nunca descartado
  });
});

describe('Rodada 2 — imutabilidade do razão do banco de horas', () => {
  it.each([
    'UPDATE hour_bank_entries SET minutes = 999 WHERE true',
    'DELETE FROM hour_bank_entries WHERE true',
    'UPDATE hour_bank_allocations SET minutes = 1 WHERE true',
    'DELETE FROM salary_history WHERE true',
  ])('"%s" é bloqueado', async (sql) => {
    const table = sql.split(' ').find((w) => /_/.test(w))!;
    const n = await queryOne<{ n: number }>(getPool(), `SELECT count(*)::int AS n FROM ${table}`);
    expect(n!.n).toBeGreaterThan(0); // garante que o bloqueio é real (há linhas afetáveis)
    await expect(getPool().query(sql)).rejects.toThrow(/imutável/);
  });
});
