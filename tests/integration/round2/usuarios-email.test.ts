import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import { correctUserEmail, createUser } from '../../../src/server/modules/admin.ts';
import { loginWithGoogleIdentity } from '../../../src/server/auth/google.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { closePool, ctxFor, DOMAIN, ids, makePerson, resetDatabase } from '../../helpers.ts';

// Cadastro com apelido do Google Workspace: o Google devolve o e-mail principal, que não bate com o cadastro.
let I: Awaited<ReturnType<typeof ids>>;
let cOwner: Ctx, cSubst: Ctx;
let ownerId: string;

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  ownerId = (await makePerson({ name: 'Oficial', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true })).userId;
  cOwner = await ctxFor(ownerId);
  cSubst = await ctxFor((await makePerson({ name: 'Substituta', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] })).userId);
});
afterAll(closePool);

const lastSummary = async (action: string) => (await queryOne<{ summary: string }>(getPool(),
  'SELECT summary FROM audit_log WHERE action = $1 ORDER BY id DESC LIMIT 1', [action]))!.summary;

describe('Correção de e-mail antes do primeiro acesso', () => {
  it('login com o e-mail principal é negado e a auditoria mostra o e-mail tentado', async () => {
    await createUser(cOwner, { email: `apelido@${DOMAIN}`, displayName: 'Funcionária Fictícia' });
    await expect(loginWithGoogleIdentity(getPool(), { sub: 'g-ficticio-1', email: `principal.completo@${DOMAIN}`, name: 'Funcionária Fictícia' }, null, null))
      .rejects.toThrow(/não autorizado/);
    expect(await lastSummary('AUTH_LOGIN_NEGADO')).toContain(`principal.completo@${DOMAIN}`);
  });

  it('a Oficial corrige o e-mail (com reautenticação) e o login passa a funcionar; depois do acesso não muda mais', async () => {
    const u = (await queryOne<{ id: string }>(getPool(), 'SELECT id FROM users WHERE email = $1', [`apelido@${DOMAIN}`]))!;
    await expect(correctUserEmail(cSubst, { userId: u.id, email: `principal.completo@${DOMAIN}`, reason: 'Apelido do Google' })).rejects.toThrow();
    await expect(correctUserEmail({ ...cOwner, stepUpAt: null }, { userId: u.id, email: `principal.completo@${DOMAIN}`, reason: 'Apelido do Google' })).rejects.toThrow('reautenticação');
    await expect(correctUserEmail(cOwner, { userId: u.id, email: 'principal@gmail.com', reason: 'Apelido do Google' })).rejects.toThrow(/domínio institucional/);
    await expect(correctUserEmail(cOwner, { userId: ownerId, email: `outra@${DOMAIN}`, reason: 'Teste indevido' })).rejects.toThrow(/Oficial/);

    await correctUserEmail(cOwner, { userId: u.id, email: ` Principal.Completo@${DOMAIN} `, reason: 'E-mail principal no Google Workspace' });
    expect(await lastSummary('USUARIO_EMAIL_CORRIGIDO')).toBe(`E-mail corrigido: apelido@${DOMAIN} → principal.completo@${DOMAIN}`);
    const s = await loginWithGoogleIdentity(getPool(), { sub: 'g-ficticio-1', email: `principal.completo@${DOMAIN}`, name: 'Funcionária Fictícia' }, null, null);
    expect(s.userId).toBe(u.id);

    await expect(correctUserEmail(cOwner, { userId: u.id, email: `outra@${DOMAIN}`, reason: 'Depois do acesso' })).rejects.toThrow(/já entrou no sistema/);
  });

  it('não permite e-mail já usado por outra pessoa; cadeia íntegra', async () => {
    const other = await createUser(cOwner, { email: `segunda@${DOMAIN}`, displayName: 'Outra Fictícia' });
    await expect(correctUserEmail(cOwner, { userId: other, email: `principal.completo@${DOMAIN}`, reason: 'Duplicado' })).rejects.toThrow(/Já existe/);
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
