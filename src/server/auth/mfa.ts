import { randomInt } from 'node:crypto';
import { type Db, query, queryOne } from '../db.ts';
import { decryptField, encryptField, hmacLookup } from '../crypto.ts';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../totp.ts';
import { AppError } from '../errors.ts';
import { audit } from '../audit.ts';
import { getConfig } from '../config.ts';
import { markMfaVerified, markStepUp, type SessionRow } from './session.ts';
import { sendAccessCodeEmail } from './mfaEmail.ts';

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const ISSUER = 'SGI Ofício de Registros';

// Alternativas ao aplicativo: códigos de reserva (uso único) e código de 6 dígitos no e-mail pessoal.
const BACKUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const BACKUP_COUNT = 10;
const EMAIL_CODE_MINUTES = 10;
const EMAIL_RESEND_SECONDS = 60;

export type MfaMethod = 'TOTP' | 'RESERVA' | 'EMAIL';
const METHOD_LABEL: Record<MfaMethod, string> = { TOTP: 'aplicativo autenticador', RESERVA: 'código de reserva', EMAIL: 'código enviado ao e-mail pessoal' };

const normalizeBackup = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
const backupHash = (userId: string, code: string) => hmacLookup(`mfa-reserva:${userId}:${normalizeBackup(code)}`);
const emailHash = (userId: string, code: string) => hmacLookup(`mfa-email:${userId}:${code}`);

/** "v***@gmail.com": o e-mail pessoal nunca aparece inteiro em telas e na auditoria. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${(local ?? '').slice(0, 1)}***@${domain ?? ''}`;
}

// Estas funções devem ser chamadas com o pool (autocommit), e não dentro de uma transação:
// o registro de tentativas inválidas precisa persistir mesmo quando a operação falha.

type MfaUser = {
  id: string;
  email: string;
  totp_secret_enc: string | null;
  totp_enabled_at: Date | null;
  totp_last_step: number | null;
  mfa_failed_count: number;
  mfa_locked_until: Date | null;
  mfa_email_enc: string | null;
  mfa_email_code_hash: string | null;
  mfa_email_code_expires_at: Date | null;
  mfa_email_code_sent_at: Date | null;
  backup_left: number;
};

async function loadUser(db: Db, userId: string): Promise<MfaUser> {
  const u = await queryOne<MfaUser>(
    db,
    `SELECT id, email, totp_secret_enc, totp_enabled_at, totp_last_step, mfa_failed_count, mfa_locked_until,
            mfa_email_enc, mfa_email_code_hash, mfa_email_code_expires_at, mfa_email_code_sent_at,
            (SELECT count(*)::int FROM mfa_backup_codes b WHERE b.user_id = users.id AND b.used_at IS NULL) AS backup_left
       FROM users WHERE id = $1`,
    [userId],
  );
  if (!u) throw new AppError('Usuário não encontrado.', 404);
  return u;
}

export async function mfaStatus(db: Db, userId: string): Promise<'ATIVO' | 'PENDENTE_CADASTRO'> {
  const u = await queryOne<{ totp_enabled_at: Date | null }>(db, 'SELECT totp_enabled_at FROM users WHERE id = $1', [userId]);
  return u?.totp_enabled_at ? 'ATIVO' : 'PENDENTE_CADASTRO';
}

/** Inicia (ou reinicia) o cadastro do autenticador. Só é permitido enquanto o MFA não estiver ativo. */
export async function beginEnrollment(db: Db, userId: string): Promise<{ secret: string; uri: string }> {
  const u = await loadUser(db, userId);
  if (u.totp_enabled_at) throw new AppError('O autenticador já está cadastrado.');
  let secret = decryptField(u.totp_secret_enc);
  if (!secret) {
    secret = generateTotpSecret();
    await query(db, 'UPDATE users SET totp_secret_enc = $2 WHERE id = $1', [userId, encryptField(secret)]);
  }
  return { secret, uri: otpauthUri(secret, u.email, ISSUER) };
}

/** Formas aceitas para esta pessoa agora (o app só depois de cadastrado, salvo no próprio cadastro). */
function methodsOf(u: MfaUser, enrolling = false): { totp: boolean; backup: boolean; email: boolean } {
  return { totp: !!u.totp_secret_enc && (enrolling || !!u.totp_enabled_at), backup: !enrolling && u.backup_left > 0, email: !enrolling && !!u.mfa_email_enc };
}

async function checkCode(db: Db, u: MfaUser, code: string, session: SessionRow, allowed: { totp: boolean; backup: boolean; email: boolean }): Promise<MfaMethod> {
  if (u.mfa_locked_until && u.mfa_locked_until.getTime() > Date.now()) {
    throw new AppError('Muitas tentativas inválidas. Aguarde alguns minutos e tente novamente.', 429, 'BLOQUEADO');
  }
  const c = code.trim();
  const who = { userId: u.id, sessionId: session.id, ip: session.ip };
  const ok = async () => { await query(db, 'UPDATE users SET mfa_failed_count = 0, mfa_locked_until = NULL WHERE id = $1', [u.id]); };

  if (/^\d{6}$/.test(c)) {
    if (allowed.totp) {
      const secret = decryptField(u.totp_secret_enc);
      const step = secret ? verifyTotp(secret, c, u.totp_last_step === null ? null : Number(u.totp_last_step)) : null;
      if (step !== null) {
        // Atualização condicional e atômica: impede o reuso do mesmo código em requisições concorrentes.
        const accepted = await query(
          db,
          `UPDATE users SET totp_last_step = $2, mfa_failed_count = 0, mfa_locked_until = NULL
            WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id`,
          [u.id, step],
        );
        if (accepted.length === 0) throw new AppError('Código já utilizado. Aguarde o próximo código.', 401, 'MFA_INVALIDO');
        return 'TOTP';
      }
    }
    if (allowed.email && u.mfa_email_code_hash && u.mfa_email_code_expires_at && u.mfa_email_code_expires_at.getTime() > Date.now()) {
      // Uso único: só quem zera o hash consome o código.
      const used = await query(
        db,
        `UPDATE users SET mfa_email_code_hash = NULL, mfa_email_code_expires_at = NULL, mfa_failed_count = 0, mfa_locked_until = NULL
          WHERE id = $1 AND mfa_email_code_hash = $2 AND mfa_email_code_expires_at > now() RETURNING id`,
        [u.id, emailHash(u.id, c)],
      );
      if (used.length) return 'EMAIL';
    }
  } else if (allowed.backup && normalizeBackup(c).length === 8) {
    const used = await query(db, 'UPDATE mfa_backup_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id', [u.id, backupHash(u.id, c)]);
    if (used.length) {
      await ok();
      await audit(db, who, { action: 'AUTH_MFA_RESERVA_USADO', entityType: 'user', entityId: u.id, summary: `Código de reserva utilizado (restam ${u.backup_left - 1})` });
      return 'RESERVA';
    }
  }

  const failures = u.mfa_failed_count + 1;
  const lock = failures >= MAX_FAILURES;
  await query(
    db,
    `UPDATE users SET mfa_failed_count = $2,
       mfa_locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE mfa_locked_until END
     WHERE id = $1`,
    [u.id, lock ? 0 : failures, lock, LOCK_MINUTES],
  );
  await audit(db, who, {
    action: lock ? 'AUTH_MFA_BLOQUEIO' : 'AUTH_MFA_FALHA', entityType: 'user', entityId: u.id,
    summary: lock ? `Bloqueio temporário de ${LOCK_MINUTES} min após ${MAX_FAILURES} códigos inválidos` : 'Código do segundo fator inválido',
  });
  throw new AppError('Código inválido.', 401, 'MFA_INVALIDO');
}

export async function confirmEnrollment(db: Db, session: SessionRow, code: string): Promise<void> {
  const u = await loadUser(db, session.user_id);
  if (u.totp_enabled_at) throw new AppError('O autenticador já está cadastrado.');
  await checkCode(db, u, code, session, methodsOf(u, true));
  await query(db, 'UPDATE users SET totp_enabled_at = now() WHERE id = $1', [u.id]);
  await markMfaVerified(db, session.id);
  await audit(db, { userId: u.id, sessionId: session.id, ip: session.ip }, {
    action: 'AUTH_MFA_CADASTRO', entityType: 'user', entityId: u.id, summary: 'Autenticador (TOTP) cadastrado',
  });
}

/** Segundo fator no login. */
export async function verifyLoginMfa(db: Db, session: SessionRow, code: string): Promise<void> {
  const u = await loadUser(db, session.user_id);
  const allowed = methodsOf(u);
  if (!allowed.totp && !allowed.backup && !allowed.email) throw new AppError('Autenticador não cadastrado.');
  const method = await checkCode(db, u, code, session, allowed);
  await markMfaVerified(db, session.id);
  await audit(db, { userId: u.id, sessionId: session.id, ip: session.ip }, {
    action: 'AUTH_MFA_OK', entityType: 'session', entityId: session.id, summary: `Segundo fator validado (${METHOD_LABEL[method]})`,
  });
}

/** Reautenticação para operações críticas (assinaturas, permissões, dados sensíveis). */
export async function stepUp(db: Db, session: SessionRow, code: string): Promise<void> {
  const u = await loadUser(db, session.user_id);
  const method = await checkCode(db, u, code, session, methodsOf(u));
  await markStepUp(db, session.id);
  await audit(db, { userId: u.id, sessionId: session.id, ip: session.ip }, {
    action: 'AUTH_REAUTENTICACAO', entityType: 'session', entityId: session.id, summary: `Reautenticação para operação crítica (${METHOD_LABEL[method]})`,
  });
}

/** Formas disponíveis para a tela de código (sem revelar segredos). */
export async function mfaOptions(db: Db, userId: string): Promise<{ totp: boolean; backupLeft: number; email: string | null }> {
  const u = await loadUser(db, userId);
  const personal = decryptField(u.mfa_email_enc);
  return { totp: !!u.totp_enabled_at, backupLeft: u.backup_left, email: personal ? maskEmail(personal) : null };
}

/** Envia um código de 6 dígitos ao e-mail pessoal liberado pela Oficial (vale 10 minutos, uso único). */
export async function requestEmailCode(db: Db, session: SessionRow): Promise<string> {
  const u = await loadUser(db, session.user_id);
  const to = decryptField(u.mfa_email_enc);
  if (!to) throw new AppError('O código por e-mail não está liberado para você. Fale com a Oficial.');
  if (u.mfa_locked_until && u.mfa_locked_until.getTime() > Date.now()) {
    throw new AppError('Muitas tentativas inválidas. Aguarde alguns minutos e tente novamente.', 429, 'BLOQUEADO');
  }
  if (u.mfa_email_code_sent_at && Date.now() - u.mfa_email_code_sent_at.getTime() < EMAIL_RESEND_SECONDS * 1000) {
    throw new AppError('Um código acabou de ser enviado. Aguarde 1 minuto para pedir outro.');
  }
  if (!getConfig().google.gmailSender) throw new AppError('O envio de e-mail ainda não está configurado no sistema. Use o autenticador ou um código de reserva.');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await query(
    db,
    `UPDATE users SET mfa_email_code_hash = $2, mfa_email_code_expires_at = now() + make_interval(mins => $3), mfa_email_code_sent_at = now() WHERE id = $1`,
    [u.id, emailHash(u.id, code), EMAIL_CODE_MINUTES],
  );
  try {
    await sendAccessCodeEmail(to, code, EMAIL_CODE_MINUTES);
  } catch {
    await query(db, 'UPDATE users SET mfa_email_code_hash = NULL, mfa_email_code_expires_at = NULL WHERE id = $1', [u.id]);
    throw new AppError('Não foi possível enviar o e-mail agora. Tente de novo em instantes ou use um código de reserva.', 502);
  }
  await audit(db, { userId: u.id, sessionId: session.id, ip: session.ip }, {
    action: 'AUTH_MFA_EMAIL_ENVIADO', entityType: 'user', entityId: u.id, summary: `Código de acesso enviado ao e-mail pessoal (${maskEmail(to)})`,
  });
  return maskEmail(to);
}

function newBackupCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += BACKUP_ALPHABET[randomInt(0, BACKUP_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/**
 * Gera 10 novos códigos de reserva (os anteriores deixam de valer). Exige um código válido no mesmo pedido.
 * Os códigos são mostrados uma única vez; o banco guarda apenas o HMAC.
 */
export async function generateBackupCodes(db: Db, session: SessionRow, currentCode: string): Promise<string[]> {
  const u = await loadUser(db, session.user_id);
  const allowed = methodsOf(u);
  if (!allowed.totp && !allowed.backup && !allowed.email) throw new AppError('Cadastre o autenticador antes de gerar códigos de reserva.');
  await checkCode(db, u, currentCode, session, allowed);
  const codes = Array.from({ length: BACKUP_COUNT }, newBackupCode);
  await query(db, 'DELETE FROM mfa_backup_codes WHERE user_id = $1', [u.id]);
  for (const c of codes) await query(db, 'INSERT INTO mfa_backup_codes (user_id, code_hash) VALUES ($1, $2)', [u.id, backupHash(u.id, c)]);
  await audit(db, { userId: u.id, sessionId: session.id, ip: session.ip }, {
    action: 'AUTH_MFA_RESERVA_GERADOS', entityType: 'user', entityId: u.id, summary: `${BACKUP_COUNT} novos códigos de reserva gerados (os anteriores foram invalidados)`,
  });
  return codes;
}
