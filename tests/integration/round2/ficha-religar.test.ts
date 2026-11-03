import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import { createEmployee } from '../../../src/server/modules/people.ts';
import { createUser, linkUserToEmployee, listEmployeesForLink } from '../../../src/server/modules/admin.ts';
import { loginWithGoogleIdentity } from '../../../src/server/auth/google.ts';
import { loadPrincipal } from '../../../src/server/authz.ts';
import { createSession } from '../../../src/server/auth/session.ts';
import { punch } from '../../../src/server/modules/timeclock.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { addDays, todayLocal } from '../../../src/domain/time.ts';
import { closePool, ctxFor, DOMAIN, ids, makePerson, resetDatabase } from '../../helpers.ts';

// Caso real da implantação: a ficha foi criada com um e-mail que não é o da conta Google (ex.: nome@), e outra conta
// (nome.sobrenome@) foi criada depois e já entrou no sistema, sem ficha — sem ponto. A Oficial liga a ficha à conta em uso.
let I: Awaited<ReturnType<typeof ids>>;
let cOwner: Ctx, cSubst: Ctx;
let empId: string, usedId: string, oldId: string;

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  cOwner = await ctxFor((await makePerson({ name: 'Oficial', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true })).userId);
  cSubst = await ctxFor((await makePerson({ name: 'Substituta', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] })).userId);
  empId = await createEmployee(cOwner, { registrationCode: 'F-01', fullName: 'Funcionária Fictícia', jobTitleId: I.jobs.escrevente, sectorId: I.sectors.RI,
    admissionDate: addDays(todayLocal(), -5), contractType: 'CLT', weeklyHours: 40, scheduleId: I.schedule, email: `ficticia@${DOMAIN}` });
  oldId = (await queryOne<{ user_id: string }>(getPool(), 'SELECT user_id FROM employees WHERE id = $1', [empId]))!.user_id;
  usedId = await createUser(cOwner, { email: `ficticia.sobrenome@${DOMAIN}`, displayName: 'Funcionária Fictícia' });
  await loginWithGoogleIdentity(getPool(), { sub: 'g-ficticia', email: `ficticia.sobrenome@${DOMAIN}`, name: 'Funcionária Fictícia' }, null, null);
  await query(getPool(), 'UPDATE users SET totp_secret_enc = $2, totp_enabled_at = now() WHERE id = $1', [usedId, 'segredo-cifrado-ficticio']);
});
afterAll(closePool);

describe('Ligar a conta em uso à ficha', () => {
  it('antes: a conta em uso não tem ficha (sem ponto)', async () => {
    expect((await loadPrincipal(getPool(), usedId))!.employeeId).toBeNull();
    expect((await listEmployeesForLink(cOwner)).find((e) => e.id === empId)!.email).toBe(`ficticia@${DOMAIN}`);
  });

  it('só a Oficial liga, com reautenticação; conta da Oficial e conta já ligada são recusadas', async () => {
    await expect(linkUserToEmployee(cSubst, { userId: usedId, employeeId: empId, reason: 'Conta em uso' })).rejects.toThrow();
    await expect(linkUserToEmployee({ ...cOwner, stepUpAt: null }, { userId: usedId, employeeId: empId, reason: 'Conta em uso' })).rejects.toThrow('reautenticação');
    await expect(linkUserToEmployee(cOwner, { userId: cOwner.principal.userId, employeeId: empId, reason: 'Teste' })).rejects.toThrow(/Oficial/);
    await expect(linkUserToEmployee(cOwner, { userId: oldId, employeeId: empId, reason: 'Teste' })).rejects.toThrow(/já está ligada/);
  });

  it('depois: a ficha é da conta em uso, que bate ponto e mantém o autenticador; a conta antiga é revogada; auditoria registra', async () => {
    const { sessionId } = await createSession(getPool(), usedId, 'DEV', null, null);
    await linkUserToEmployee(cOwner, { userId: usedId, employeeId: empId, reason: 'E-mail da ficha não é o da conta Google' });
    const p = (await loadPrincipal(getPool(), usedId))!;
    expect(p.employeeId).toBe(empId);
    expect(p.grants.has('jornada.registrar')).toBe(true);
    expect((await queryOne<{ t: Date | null }>(getPool(), 'SELECT totp_enabled_at AS t FROM users WHERE id = $1', [usedId]))!.t).not.toBeNull();
    expect((await queryOne<{ s: string }>(getPool(), 'SELECT status AS s FROM users WHERE id = $1', [oldId]))!.s).toBe('REVOGADO');
    expect((await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM user_roles WHERE user_id = $1 AND revoked_at IS NULL', [oldId]))!.n).toBe(0);
    expect((await queryOne<{ r: Date | null }>(getPool(), 'SELECT revoked_at AS r FROM sessions WHERE id = $1', [sessionId]))!.r).not.toBeNull();
    await punch(await ctxFor(usedId));
    expect((await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM time_punches WHERE employee_id = $1', [empId]))!.n).toBe(1);
    await expect(loginWithGoogleIdentity(getPool(), { sub: 'g-outra', email: `ficticia@${DOMAIN}`, name: 'X' }, null, null)).rejects.toThrow(/não autorizado/);
    const a = (await queryOne<{ s: string }>(getPool(), "SELECT summary AS s FROM audit_log WHERE action = 'USUARIO_FICHA_RELIGADA' ORDER BY id DESC LIMIT 1"))!.s;
    expect(a).toContain(`ligada à conta ficticia.sobrenome@${DOMAIN}`);
    expect(a).toContain(`antes: ficticia@${DOMAIN}, revogada`);
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
