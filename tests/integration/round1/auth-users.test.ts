import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import { createSession, validateSession } from '../../../src/server/auth/session.ts';
import { beginEnrollment, confirmEnrollment, stepUp, verifyLoginMfa } from '../../../src/server/auth/mfa.ts';
import { loginWithGoogleIdentity, validateGoogleClaims } from '../../../src/server/auth/google.ts';
import { createUser, setUserStatus, assignRole, setRolePermission, revokeUserRole } from '../../../src/server/modules/admin.ts';
import { loadPrincipal, can } from '../../../src/server/authz.ts';
import { totpAt, TOTP_STEP_SECONDS } from '../../../src/server/totp.ts';
import { closePool, ctxFor, DOMAIN, ids, makePerson, resetDatabase } from '../../helpers.ts';
import type { SessionRow } from '../../../src/server/auth/session.ts';

let I: Awaited<ReturnType<typeof ids>>;
let owner: { userId: string; employeeId: string };

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  owner = await makePerson({ name: 'Oficial Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
});
afterAll(closePool);

async function sessionRow(id: string): Promise<SessionRow> {
  return (await queryOne<SessionRow>(getPool(), 'SELECT * FROM sessions WHERE id = $1', [id]))!;
}

describe('Rodada 1 — sessões', () => {
  it('sessão válida, revogação imediata ao suspender o usuário', async () => {
    const p = await makePerson({ name: 'Ana Teste', sectorId: I.sectors.ATD, jobId: I.jobs.atendente, roles: [{ roleId: I.roles.COLABORADOR }] });
    const { token } = await createSession(getPool(), p.userId, 'DEV', null, null);
    expect((await validateSession(getPool(), token)).ok).toBe(true);
    const ctx = await ctxFor(owner.userId);
    await setUserStatus(ctx, { userId: p.userId, status: 'SUSPENSO', reason: 'Teste de revogação' });
    const check = await validateSession(getPool(), token);
    expect(check).toEqual({ ok: false, reason: 'REVOGADA' });
  });

  it('bloqueio por inatividade', async () => {
    const p = await makePerson({ name: 'Bruno Teste', sectorId: I.sectors.ATD, jobId: I.jobs.atendente, roles: [{ roleId: I.roles.COLABORADOR }] });
    const { token, sessionId } = await createSession(getPool(), p.userId, 'DEV', null, null);
    await query(getPool(), "UPDATE sessions SET last_seen_at = now() - interval '31 minutes' WHERE id = $1", [sessionId]);
    expect(await validateSession(getPool(), token)).toEqual({ ok: false, reason: 'INATIVIDADE' });
    expect((await sessionRow(sessionId)).revoked_at).not.toBeNull();
  });

  it('expiração absoluta', async () => {
    const p = await makePerson({ name: 'Carla Teste', sectorId: I.sectors.ATD, jobId: I.jobs.atendente, roles: [{ roleId: I.roles.COLABORADOR }] });
    const { token, sessionId } = await createSession(getPool(), p.userId, 'DEV', null, null);
    await query(getPool(), "UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [sessionId]);
    expect(await validateSession(getPool(), token)).toEqual({ ok: false, reason: 'EXPIRADA' });
  });

  it('token inexistente ou malformado', async () => {
    expect(await validateSession(getPool(), 'x'.repeat(43))).toEqual({ ok: false, reason: 'INEXISTENTE' });
    expect(await validateSession(getPool(), undefined)).toEqual({ ok: false, reason: 'INEXISTENTE' });
  });
});

describe('Rodada 1 — MFA (TOTP)', () => {
  it('cadastro, verificação, anti-reuso e bloqueio após 5 falhas', async () => {
    const p = await makePerson({ name: 'Diego Teste', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
    const { sessionId } = await createSession(getPool(), p.userId, 'DEV', null, null);
    const s = await sessionRow(sessionId);
    const { secret, uri } = await beginEnrollment(getPool(), p.userId);
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    // o segredo fica criptografado no banco
    const raw = await queryOne<{ totp_secret_enc: string }>(getPool(), 'SELECT totp_secret_enc FROM users WHERE id = $1', [p.userId]);
    expect(raw!.totp_secret_enc).not.toContain(secret);

    await expect(confirmEnrollment(getPool(), s, '000000')).rejects.toThrow('Código inválido');
    const code = totpAt(secret);
    await confirmEnrollment(getPool(), s, code);
    expect((await sessionRow(sessionId)).mfa_verified_at).not.toBeNull();
    // reuso do mesmo código é recusado
    await expect(verifyLoginMfa(getPool(), s, code)).rejects.toThrow();
    // código do próximo passo é aceito (janela de ±1)
    await verifyLoginMfa(getPool(), s, totpAt(secret, Date.now() + TOTP_STEP_SECONDS * 1000));

    for (let i = 0; i < 5; i++) await expect(stepUp(getPool(), s, '111111')).rejects.toThrow();
    await expect(stepUp(getPool(), s, totpAt(secret, Date.now() + 2 * TOTP_STEP_SECONDS * 1000))).rejects.toThrow('Muitas tentativas');
    const audits = await query(getPool(), "SELECT 1 FROM audit_log WHERE action = 'AUTH_MFA_BLOQUEIO' AND entity_id = $1", [p.userId]);
    expect(audits.length).toBe(1);
  });
});

describe('Rodada 1 — login Google Workspace (regras de aceitação)', () => {
  const base = { sub: 'g-123', email: `pessoa@${DOMAIN}`, email_verified: true, hd: DOMAIN, nonce: 'n1', name: 'Pessoa' };

  it('aceita conta do domínio com e-mail verificado e nonce correto', () => {
    expect(validateGoogleClaims(base, 'n1')).toEqual({ sub: 'g-123', email: `pessoa@${DOMAIN}`, name: 'Pessoa' });
  });
  it('recusa outro domínio, e-mail não verificado e nonce divergente', () => {
    expect(() => validateGoogleClaims({ ...base, hd: 'gmail.com', email: 'x@gmail.com' }, 'n1')).toThrow('domínio institucional');
    expect(() => validateGoogleClaims({ ...base, hd: undefined }, 'n1')).toThrow('domínio institucional');
    expect(() => validateGoogleClaims({ ...base, email_verified: false }, 'n1')).toThrow('não verificado');
    expect(() => validateGoogleClaims(base, 'outro')).toThrow('nonce');
  });

  it('sistema fechado: conta do domínio NÃO cadastrada é recusada e auditada', async () => {
    await expect(loginWithGoogleIdentity(getPool(), { sub: 'g-x', email: `intruso@${DOMAIN}`, name: 'X' }, '10.0.0.1', null)).rejects.toThrow(
      'Acesso não autorizado',
    );
    const a = await queryOne(getPool(), "SELECT 1 FROM audit_log WHERE action = 'AUTH_LOGIN_NEGADO' AND data->>'email' = $1", [`intruso@${DOMAIN}`]);
    expect(a).not.toBeNull();
  });

  it('primeiro acesso vincula o identificador Google; acessos seguintes usam o sub', async () => {
    const p = await makePerson({ name: 'Elisa Teste', sectorId: I.sectors.RCPN, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
    const email = (await queryOne<{ email: string }>(getPool(), 'SELECT email FROM users WHERE id = $1', [p.userId]))!.email;
    const r = await loginWithGoogleIdentity(getPool(), { sub: 'g-elisa', email, name: 'Elisa' }, null, null);
    expect(r.userId).toBe(p.userId);
    const again = await loginWithGoogleIdentity(getPool(), { sub: 'g-elisa', email, name: 'Elisa' }, null, null);
    expect(again.userId).toBe(p.userId);
    // outro sub com o mesmo e-mail não sequestra a conta já vinculada
    await expect(loginWithGoogleIdentity(getPool(), { sub: 'g-outro', email, name: 'X' }, null, null)).rejects.toThrow('Acesso não autorizado');
  });
});

describe('Rodada 1 — administração de usuários e permissões', () => {
  it('cria usuário somente no domínio institucional e exige reautenticação', async () => {
    const ctx = await ctxFor(owner.userId);
    await expect(createUser(ctx, { email: 'alguem@gmail.com', displayName: 'Externo' })).rejects.toThrow('domínio institucional');
    const id = await createUser(ctx, { email: `Novo.Usuario@${DOMAIN}`, displayName: 'Novo Usuário' });
    const u = await queryOne<{ email: string; status: string }>(getPool(), 'SELECT email, status FROM users WHERE id = $1', [id]);
    expect(u).toEqual({ email: `novo.usuario@${DOMAIN}`, status: 'ATIVO' });
    await expect(createUser(ctx, { email: `novo.usuario@${DOMAIN}`, displayName: 'Dup' })).rejects.toThrow('Já existe');
    const noStep = await ctxFor(owner.userId, { stepUp: false });
    await expect(createUser(noStep, { email: `outro@${DOMAIN}`, displayName: 'Outro' })).rejects.toThrow('reautenticação');
  });

  it('substituição temporária: papel com vigência concede e expira permissões', async () => {
    const ctx = await ctxFor(owner.userId);
    const p = await makePerson({ name: 'Fabia Teste', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
    expect(can((await loadPrincipal(getPool(), p.userId))!, 'solicitacoes.compensacao.aprovar')).toBe(false);
    const urId = await assignRole(ctx, { userId: p.userId, roleId: I.roles.SUBSTITUTA_LEGAL, validFrom: '2020-01-01', validUntil: '2099-12-31', reason: 'Substituição por férias' });
    expect(can((await loadPrincipal(getPool(), p.userId))!, 'solicitacoes.compensacao.aprovar')).toBe(true);
    await revokeUserRole(ctx, urId, 'Fim da substituição');
    expect(can((await loadPrincipal(getPool(), p.userId))!, 'solicitacoes.compensacao.aprovar')).toBe(false);
    await assignRole(ctx, { userId: p.userId, roleId: I.roles.SUBSTITUTA_LEGAL, validFrom: '2020-01-01', validUntil: '2020-12-31', reason: 'Vigência encerrada' });
    expect(can((await loadPrincipal(getPool(), p.userId))!, 'solicitacoes.compensacao.aprovar')).toBe(false);
  });

  it('matriz de permissões configurável; papel OFICIAL é protegido', async () => {
    const ctx = await ctxFor(owner.userId);
    await setRolePermission(ctx, { roleId: I.roles.COLABORADOR, permissionCode: 'jornada.ausencias.gerenciar', scope: 'PROPRIO' });
    const r = await queryOne(getPool(), "SELECT scope FROM role_permissions WHERE role_id = $1 AND permission_code = 'jornada.ausencias.gerenciar'", [I.roles.COLABORADOR]);
    expect(r).toEqual({ scope: 'PROPRIO' });
    await setRolePermission(ctx, { roleId: I.roles.COLABORADOR, permissionCode: 'jornada.ausencias.gerenciar', scope: null });
    await expect(setRolePermission(ctx, { roleId: I.roles.OFICIAL, permissionCode: 'auditoria.ver', scope: null })).rejects.toThrow('não pode ser alterado');
    await expect(setRolePermission(ctx, { roleId: I.roles.COLABORADOR, permissionCode: 'auditoria.ver', scope: 'PROPRIO' })).rejects.toThrow('global');
  });
});
