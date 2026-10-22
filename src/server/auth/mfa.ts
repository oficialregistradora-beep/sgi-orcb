import { type Db, query, queryOne } from '../db.ts';
import { decryptField, encryptField } from '../crypto.ts';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../totp.ts';
import { AppError } from '../errors.ts';
import { audit } from '../audit.ts';
import { markMfaVerified, markStepUp, type SessionRow } from './session.ts';

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const ISSUER = 'SGI Ofício de Registros';

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
};

async function loadUser(db: Db, userId: string): Promise<MfaUser> {
  const u = await queryOne<MfaUser>(
    db,
    `SELECT id, email, totp_secret_enc, totp_enabled_at, totp_last_step, mfa_failed_count, mfa_locked_until
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

async function checkCode(db: Db, u: MfaUser, code: string, session: SessionRow): Promise<void> {
  if (u.mfa_locked_until && u.mfa_locked_until.getTime() > Date.now()) {
    throw new AppError('Muitas tentativas inválidas. Aguarde alguns minutos e tente novamente.', 429, 'BLOQUEADO');
  }
  const secret = decryptField(u.totp_secret_enc);
  if (!secret) throw new AppError('Autenticador não cadastrado.');
  const step = verifyTotp(secret, code.trim(), u.totp_last_step === null ? null : Number(u.totp_last_step));
  const who = { userId: u.id, sessionId: session.id, ip: session.ip };
  if (step === null) {
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
      summary: lock ? `Bloqueio temporário de ${LOCK_MINUTES} min após ${MAX_FAILURES} códigos inválidos` : 'Código do autenticador inválido',
    });
    throw new AppError('Código inválido.', 401, 'MFA_INVALIDO');
  }
  // Atualização condicional e atômica: impede o reuso do mesmo código em requisições concorrentes.
  const accepted = await query(
    db,
    `UPDATE users SET totp_last_step = $2, mfa_failed_count = 0, mfa_locked_until = NULL
      WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id`,
    [u.id, step],
  );
  if (accepted.length === 0) throw new AppError('Código já utilizado. Aguarde o próximo código.', 401, 'MFA_INVALIDO');
}

export async function confirmEnrollment(db: Db, session: SessionRow, code: string): Promise<void> {
  const u = await loadUser(db, session.user_id);
  if (u.totp_enabled_at) throw new AppError('O autenticador já está cadastrado.');
  await checkCode(db, u, code, session);
  await query(db, 'UPDATE users SET totp_enabled_at = now() WHERE id = $1', [u.id]);
  await markMfaVerified(db, session.id);
  await audit(db, { userId: u.id, sessionId: session.id, ip: session.ip }, {
    action: 'AUTH_MFA_CADASTRO', entityType: 'user', entityId: u.id, summary: 'Autenticador (TOTP) cadastrado',
  });
}

/** Segundo fator no login. */
export async function verifyLoginMfa(db: Db, session: SessionRow, code: string): Promise<void> {
  const u = await loadUser(db, session.user_id);
  if (!u.totp_enabled_at) throw new AppError('Autenticador não cadastrado.');
  await checkCode(db, u, code, session);
  await markMfaVerified(db, session.id);
  await audit(db, { userId: u.id, sessionId: session.id, ip: session.ip }, {
    action: 'AUTH_MFA_OK', entityType: 'session', entityId: session.id, summary: 'Segundo fator validado',
  });
}

/** Reautenticação para operações críticas (assinaturas, permissões, dados sensíveis). */
export async function stepUp(db: Db, session: SessionRow, code: string): Promise<void> {
  const u = await loadUser(db, session.user_id);
  await checkCode(db, u, code, session);
  await markStepUp(db, session.id);
  await audit(db, { userId: u.id, sessionId: session.id, ip: session.ip }, {
    action: 'AUTH_REAUTENTICACAO', entityType: 'session', entityId: session.id, summary: 'Reautenticação para operação crítica',
  });
}
