import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { getConfig } from '../config.ts';
import { type Db, queryOne } from '../db.ts';
import { AppError } from '../errors.ts';
import { audit } from '../audit.ts';
import { createSession } from './session.ts';

// Login corporativo via OpenID Connect do Google (fluxo authorization code + PKCE).
// Escopos mínimos: openid, email, profile. A senha Google nunca passa pelo sistema.

export const GOOGLE_SCOPES = ['openid', 'email', 'profile'] as const;
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export function redirectUri(): string {
  return `${getConfig().appUrl}/api/auth/google/callback`;
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function buildAuthorizationUrl(state: string, nonce: string, codeVerifier: string): string {
  const cfg = getConfig();
  const params = new URLSearchParams({
    client_id: cfg.googleClientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    state,
    nonce,
    hd: cfg.workspaceDomain, // sugestão de domínio; a validação real é feita no token (claim hd)
    code_challenge: pkceChallenge(codeVerifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export async function exchangeCode(code: string, codeVerifier: string): Promise<string> {
  const cfg = getConfig();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.googleClientId,
      client_secret: cfg.googleClientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new AppError('Falha ao concluir a autenticação com o Google.', 502, 'GOOGLE_TOKEN');
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new AppError('Resposta do Google sem id_token.', 502, 'GOOGLE_TOKEN');
  return body.id_token;
}

export type GoogleIdentity = { sub: string; email: string; name: string };

/** Regras de aceitação das claims, separadas para teste: domínio institucional, e-mail verificado, nonce. */
export function validateGoogleClaims(payload: JWTPayload, expectedNonce: string): GoogleIdentity {
  const cfg = getConfig();
  const email = String(payload.email ?? '').toLowerCase();
  if (payload.nonce !== expectedNonce) throw new AppError('Falha de validação da autenticação (nonce).', 401);
  if (payload.email_verified !== true) throw new AppError('E-mail Google não verificado.', 401);
  if (payload.hd !== cfg.workspaceDomain || !email.endsWith(`@${cfg.workspaceDomain}`)) {
    throw new AppError('Somente contas do domínio institucional podem acessar.', 403, 'DOMINIO_NAO_AUTORIZADO');
  }
  if (!payload.sub) throw new AppError('Identificador Google ausente.', 401);
  return { sub: payload.sub, email, name: String(payload.name ?? email) };
}

export async function verifyIdToken(idToken: string, expectedNonce: string): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: getConfig().googleClientId,
    clockTolerance: 30,
  });
  return validateGoogleClaims(payload, expectedNonce);
}

/**
 * Sistema fechado: somente usuários previamente cadastrados e ativos entram. No primeiro acesso,
 * o identificador Google (sub) é vinculado ao cadastro pelo e-mail institucional.
 */
export async function loginWithGoogleIdentity(
  db: Db,
  id: GoogleIdentity,
  ip: string | null,
  userAgent: string | null,
): Promise<{ token: string; sessionId: string; userId: string }> {
  const user = await queryOne<{ id: string; status: string; google_sub: string | null }>(
    db,
    'SELECT id, status, google_sub FROM users WHERE google_sub = $1 OR (google_sub IS NULL AND email = $2) ORDER BY google_sub NULLS LAST LIMIT 1',
    [id.sub, id.email],
  );
  if (!user || user.status !== 'ATIVO') {
    await audit(db, { userId: user?.id ?? null, sessionId: null, ip }, {
      action: 'AUTH_LOGIN_NEGADO', entityType: 'user', entityId: user?.id ?? null,
      summary: user ? `Login negado: usuário ${user.status.toLowerCase()}` : 'Login negado: conta não cadastrada no sistema',
      data: { email: id.email },
    });
    throw new AppError('Acesso não autorizado. Procure a administração da serventia.', 403, 'USUARIO_NAO_AUTORIZADO');
  }
  if (!user.google_sub) {
    await db.query('UPDATE users SET google_sub = $2 WHERE id = $1', [user.id, id.sub]);
  }
  const s = await createSession(db, user.id, 'GOOGLE', ip, userAgent);
  await audit(db, { userId: user.id, sessionId: s.sessionId, ip }, {
    action: 'AUTH_LOGIN', entityType: 'session', entityId: s.sessionId, summary: 'Login via Google Workspace (aguardando segundo fator)',
  });
  return { ...s, userId: user.id };
}

/** Login de desenvolvimento/homologação com usuários fictícios. Bloqueado em produção pela configuração. */
export async function loginDev(db: Db, userId: string, ip: string | null, userAgent: string | null) {
  if (!getConfig().devLogin) throw new AppError('Login de desenvolvimento desabilitado.', 403);
  const user = await queryOne<{ id: string; status: string }>(db, 'SELECT id, status FROM users WHERE id = $1', [userId]);
  if (!user || user.status !== 'ATIVO') throw new AppError('Usuário inválido.', 403);
  const s = await createSession(db, user.id, 'DEV', ip, userAgent);
  await audit(db, { userId: user.id, sessionId: s.sessionId, ip }, {
    action: 'AUTH_LOGIN', entityType: 'session', entityId: s.sessionId, summary: 'Login de DESENVOLVIMENTO (ambiente não produtivo)',
  });
  return s;
}
