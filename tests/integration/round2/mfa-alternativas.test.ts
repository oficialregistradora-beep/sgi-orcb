import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import { createSession, type SessionRow } from '../../../src/server/auth/session.ts';
import {
  beginEnrollment, confirmEnrollment, generateBackupCodes, mfaOptions, requestEmailCode, stepUp, verifyLoginMfa,
} from '../../../src/server/auth/mfa.ts';
import { listUsers, resetUserMfa, setUserEmailMfa } from '../../../src/server/modules/admin.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { totpAt, TOTP_STEP_SECONDS } from '../../../src/server/totp.ts';
import { resetConfigCache } from '../../../src/server/config.ts';
import { resetGoogleTokens } from '../../../src/server/google.ts';
import { startFakeGoogle } from '../../fakeGoogle.ts';
import { closePool, ctxFor, DOMAIN, ids, makePerson, resetDatabase } from '../../helpers.ts';

// Alternativas ao aplicativo autenticador: códigos de reserva (todos) e código no e-mail pessoal (liberado pela Oficial).
const SENDER = `sgi@${DOMAIN}`;
const PERSONAL = 'pessoa.ficticia@exemplo.com';
let fake: Awaited<ReturnType<typeof startFakeGoogle>>;
let I: Awaited<ReturnType<typeof ids>>;
let cOwner: Ctx, cSubst: Ctx;
const ENV = ['GOOGLE_SERVICE_ACCOUNT_KEY', 'GMAIL_SENDER', 'GOOGLE_GMAIL_API_URL', 'GOOGLE_OAUTH_TOKEN_URL'];

const sessionOf = async (userId: string): Promise<SessionRow> => {
  const { sessionId } = await createSession(getPool(), userId, 'DEV', null, null);
  return (await queryOne<SessionRow>(getPool(), 'SELECT * FROM sessions WHERE id = $1', [sessionId]))!;
};
const person = (name: string) => makePerson({ name, sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
async function enrolled(name: string) {
  const p = await person(name);
  const s = await sessionOf(p.userId);
  const { secret } = await beginEnrollment(getPool(), p.userId);
  await confirmEnrollment(getPool(), s, totpAt(secret));
  return { ...p, secret, s };
}
const lastCode = () => /código de acesso ao SGI é: (\d{6})/.exec(Buffer.from(fake.mails.at(-1)!.decoded.split('\r\n\r\n')[1]!, 'base64').toString('utf8'))![1]!;

beforeAll(async () => {
  fake = await startFakeGoogle({ calendarId: 'cal@ficticio', sender: SENDER });
  Object.assign(process.env, { GOOGLE_SERVICE_ACCOUNT_KEY: fake.saKey, GMAIL_SENDER: SENDER, GOOGLE_GMAIL_API_URL: fake.base, GOOGLE_OAUTH_TOKEN_URL: `${fake.base}/token` });
  resetConfigCache();
  resetGoogleTokens();
  await resetDatabase();
  I = await ids();
  cOwner = await ctxFor((await makePerson({ name: 'Oficial', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true })).userId);
  cSubst = await ctxFor((await makePerson({ name: 'Substituta', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] })).userId);
});
afterAll(async () => {
  for (const k of ENV) delete process.env[k];
  resetConfigCache();
  await fake.close();
  await closePool();
});

describe('Códigos de reserva', () => {
  it('gerados com um código válido, guardados só como HMAC, cada um vale uma vez; nova lista invalida a anterior', async () => {
    const p = await enrolled('Reserva Fictícia');
    await expect(generateBackupCodes(getPool(), p.s, '000000')).rejects.toThrow('Código inválido');
    const codes = await generateBackupCodes(getPool(), p.s, totpAt(p.secret, Date.now() + TOTP_STEP_SECONDS * 1000));
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes.every((c) => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c))).toBe(true);
    const stored = (await queryOne<{ h: string }>(getPool(), 'SELECT string_agg(code_hash, \',\') AS h FROM mfa_backup_codes WHERE user_id = $1', [p.userId]))!.h;
    expect(codes.some((c) => stored.includes(c.replace('-', '')))).toBe(false);

    const login = await sessionOf(p.userId);
    await verifyLoginMfa(getPool(), login, codes[0]!.toLowerCase().replace('-', ' '));
    expect((await queryOne<{ s: string }>(getPool(), "SELECT summary AS s FROM audit_log WHERE action = 'AUTH_MFA_OK' ORDER BY id DESC LIMIT 1"))!.s).toContain('código de reserva');
    await expect(verifyLoginMfa(getPool(), await sessionOf(p.userId), codes[0]!)).rejects.toThrow('Código inválido');
    await stepUp(getPool(), login, codes[1]!);
    expect((await mfaOptions(getPool(), p.userId)).backupLeft).toBe(8);

    const fresh = await generateBackupCodes(getPool(), login, codes[2]!);
    expect((await mfaOptions(getPool(), p.userId)).backupLeft).toBe(10);
    await expect(stepUp(getPool(), login, codes[3]!)).rejects.toThrow('Código inválido');
    await stepUp(getPool(), login, fresh[0]!);
  });

  it('redefinir o autenticador também invalida os códigos de reserva', async () => {
    const p = await enrolled('Reset Fictícia');
    const codes = await generateBackupCodes(getPool(), p.s, totpAt(p.secret, Date.now() + TOTP_STEP_SECONDS * 1000));
    await resetUserMfa(cOwner, p.userId, 'Troca de celular');
    await expect(verifyLoginMfa(getPool(), await sessionOf(p.userId), codes[0]!)).rejects.toThrow('Autenticador não cadastrado');
  });
});

describe('Código por e-mail pessoal', () => {
  it('só a Oficial libera, com reautenticação; e-mail institucional é recusado; auditoria mascara o e-mail', async () => {
    const p = await person('Email Fictícia');
    await expect(setUserEmailMfa(cSubst, { userId: p.userId, email: PERSONAL, reason: 'Sem celular' })).rejects.toThrow();
    await expect(setUserEmailMfa({ ...cOwner, stepUpAt: null }, { userId: p.userId, email: PERSONAL, reason: 'Sem celular' })).rejects.toThrow('reautenticação');
    await expect(setUserEmailMfa(cOwner, { userId: p.userId, email: `outra@${DOMAIN}`, reason: 'Sem celular' })).rejects.toThrow(/fora do domínio/);
    await expect(requestEmailCode(getPool(), await sessionOf(p.userId))).rejects.toThrow(/não está liberado/);

    await setUserEmailMfa(cOwner, { userId: p.userId, email: PERSONAL, reason: 'Não pode usar celular no trabalho' });
    const audit = (await queryOne<{ s: string }>(getPool(), "SELECT summary AS s FROM audit_log WHERE action = 'USUARIO_MFA_EMAIL' ORDER BY id DESC LIMIT 1"))!.s;
    expect(audit).toContain('p***@exemplo.com');
    expect(audit).not.toContain(PERSONAL);
    expect((await listUsers(cOwner)).find((u) => u.id === p.userId)!.mfa_email).toBe('p***@exemplo.com');
  });

  it('sem autenticador cadastrado, entra com o código do e-mail; uso único, expira, reenvio limitado', async () => {
    const p = (await listUsers(cOwner)).find((u) => u.mfa_email)!;
    const s1 = await sessionOf(p.id);
    expect(await requestEmailCode(getPool(), s1)).toBe('p***@exemplo.com');
    const mail = fake.mails.at(-1)!;
    expect(mail.sub).toBe(SENDER);
    expect(mail.decoded).toContain(`To: <${PERSONAL}>`);
    const code = lastCode();
    await expect(requestEmailCode(getPool(), s1)).rejects.toThrow(/Aguarde 1 minuto/);

    await verifyLoginMfa(getPool(), s1, code);
    expect((await queryOne<{ s: string }>(getPool(), "SELECT summary AS s FROM audit_log WHERE action = 'AUTH_MFA_OK' ORDER BY id DESC LIMIT 1"))!.s).toContain('e-mail pessoal');
    await expect(verifyLoginMfa(getPool(), await sessionOf(p.id), code)).rejects.toThrow('Código inválido');

    await getPool().query('UPDATE users SET mfa_email_code_sent_at = now() - interval \'2 minutes\' WHERE id = $1', [p.id]);
    await requestEmailCode(getPool(), s1);
    const late = lastCode();
    await getPool().query('UPDATE users SET mfa_email_code_expires_at = now() - interval \'1 second\' WHERE id = $1', [p.id]);
    await expect(verifyLoginMfa(getPool(), await sessionOf(p.id), late)).rejects.toThrow('Código inválido');
  });

  it('falha no Gmail não deixa código válido; retirar a liberação impede novos códigos; cadeia íntegra', async () => {
    const p = (await listUsers(cOwner)).find((u) => u.mfa_email)!;
    await getPool().query('UPDATE users SET mfa_email_code_sent_at = NULL, mfa_failed_count = 0 WHERE id = $1', [p.id]);
    fake.state.gmailStatus = 500;
    await expect(requestEmailCode(getPool(), await sessionOf(p.id))).rejects.toThrow(/Não foi possível enviar/);
    fake.state.gmailStatus = 200;
    expect((await queryOne<{ h: string | null }>(getPool(), 'SELECT mfa_email_code_hash AS h FROM users WHERE id = $1', [p.id]))!.h).toBeNull();

    await setUserEmailMfa(cOwner, { userId: p.id, email: null, reason: 'Já usa o autenticador' });
    await getPool().query('UPDATE users SET mfa_email_code_sent_at = NULL WHERE id = $1', [p.id]);
    await expect(requestEmailCode(getPool(), await sessionOf(p.id))).rejects.toThrow(/não está liberado/);
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
