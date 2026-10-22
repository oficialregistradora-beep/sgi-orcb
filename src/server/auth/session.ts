import { type Db, query, queryOne } from '../db.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import { getNumberSetting } from '../settings.ts';
import { audit } from '../audit.ts';

export type SessionRow = {
  id: string;
  user_id: string;
  auth_method: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  mfa_verified_at: Date | null;
  step_up_at: Date | null;
  ip: string | null;
  user_agent: string | null;
  revoked_at: Date | null;
};

export async function createSession(
  db: Db,
  userId: string,
  method: 'GOOGLE' | 'DEV',
  ip: string | null,
  userAgent: string | null,
): Promise<{ token: string; sessionId: string }> {
  const maxHours = await getNumberSetting(db, 'sessao.duracao_maxima_horas', 12);
  const token = randomToken(32);
  const row = await queryOne<{ id: string }>(
    db,
    `INSERT INTO sessions (user_id, token_hash, auth_method, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5, $6) RETURNING id`,
    [userId, sha256Hex(token), method, maxHours, ip, userAgent?.slice(0, 400) ?? null],
  );
  await query(db, 'UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  return { token, sessionId: row!.id };
}

export type SessionCheck =
  | { ok: true; session: SessionRow }
  | { ok: false; reason: 'INEXISTENTE' | 'REVOGADA' | 'EXPIRADA' | 'INATIVIDADE' | 'USUARIO_INATIVO' };

/**
 * Valida o token da sessão: existência, revogação, limite absoluto, inatividade e situação do usuário.
 * A revogação de acesso de um usuário tem efeito imediato na próxima requisição.
 */
export async function validateSession(db: Db, token: string | undefined | null): Promise<SessionCheck> {
  if (!token || token.length > 200) return { ok: false, reason: 'INEXISTENTE' };
  const s = await queryOne<SessionRow & { user_status: string }>(
    db,
    `SELECT s.*, u.status AS user_status FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`,
    [sha256Hex(token)],
  );
  if (!s) return { ok: false, reason: 'INEXISTENTE' };
  if (s.revoked_at) return { ok: false, reason: 'REVOGADA' };
  if (s.user_status !== 'ATIVO') {
    await revokeSession(db, s.id, 'USUARIO_INATIVO');
    return { ok: false, reason: 'USUARIO_INATIVO' };
  }
  if (s.expires_at.getTime() <= Date.now()) {
    await revokeSession(db, s.id, 'EXPIRADA');
    return { ok: false, reason: 'EXPIRADA' };
  }
  const idleMinutes = await getNumberSetting(db, 'sessao.inatividade_minutos', 30);
  if (Date.now() - s.last_seen_at.getTime() > idleMinutes * 60_000) {
    await revokeSession(db, s.id, 'INATIVIDADE');
    return { ok: false, reason: 'INATIVIDADE' };
  }
  if (Date.now() - s.last_seen_at.getTime() > 30_000) {
    await query(db, 'UPDATE sessions SET last_seen_at = now() WHERE id = $1', [s.id]);
  }
  return { ok: true, session: s };
}

export async function revokeSession(db: Db, sessionId: string, reason: string): Promise<void> {
  await query(db, 'UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL', [
    sessionId,
    reason,
  ]);
}

export async function revokeAllUserSessions(db: Db, userId: string, reason: string): Promise<number> {
  const rows = await query(
    db,
    'UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL RETURNING id',
    [userId, reason],
  );
  return rows.length;
}

export async function markMfaVerified(db: Db, sessionId: string): Promise<void> {
  await query(db, 'UPDATE sessions SET mfa_verified_at = now(), step_up_at = now() WHERE id = $1', [sessionId]);
}

export async function markStepUp(db: Db, sessionId: string): Promise<void> {
  await query(db, 'UPDATE sessions SET step_up_at = now() WHERE id = $1', [sessionId]);
}

export async function logout(db: Db, session: SessionRow): Promise<void> {
  await revokeSession(db, session.id, 'LOGOUT');
  await audit(db, { userId: session.user_id, sessionId: session.id, ip: session.ip }, {
    action: 'AUTH_LOGOUT', entityType: 'session', entityId: session.id, summary: 'Encerramento de sessão',
  });
}
