import { importPKCS8, SignJWT } from 'jose';
import { getConfig } from './config.ts';

// Tokens de acesso às APIs do Google para a conta de serviço da aplicação.
// - Com chave (GOOGLE_SERVICE_ACCOUNT_KEY): JWT assinado localmente.
// - Sem chave (Cloud Run): identidade do serviço pelo servidor de metadados; para agir em nome de uma caixa
//   do domínio (Gmail, delegação em todo o domínio), o JWT é assinado pela API IAM Credentials (signJwt).
// Senhas Google nunca são usadas nem armazenadas.

export const SCOPES = {
  drive: 'https://www.googleapis.com/auth/drive',
  calendar: 'https://www.googleapis.com/auth/calendar.events',
  gmailSend: 'https://www.googleapis.com/auth/gmail.send',
} as const;

const METADATA = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default';
const cache = new Map<string, { value: string; expiresAt: number }>();

/** Somente para testes. */
export function resetGoogleTokens(): void {
  cache.clear();
}

async function exchange(tokenUrl: string, assertion: string) {
  const res = await fetch(tokenUrl, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`token do Google recusado (HTTP ${res.status})`);
  return (await res.json()) as { access_token: string; expires_in: number };
}

export async function googleAccessToken(scope: string, subject?: string): Promise<string> {
  const key = `${scope}|${subject ?? ''}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.value;
  const g = getConfig().google;
  const now = Math.floor(Date.now() / 1000);
  let tok: { access_token: string; expires_in: number };
  if (g.saKey) {
    const k = JSON.parse(Buffer.from(g.saKey, 'base64').toString('utf8')) as { client_email: string; private_key: string };
    const jwt = new SignJWT({ scope, ...(subject ? { sub: subject } : {}) })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).setIssuer(k.client_email).setAudience(g.tokenUrl).setIssuedAt(now).setExpirationTime(now + 3600);
    tok = await exchange(g.tokenUrl, await jwt.sign(await importPKCS8(k.private_key, 'RS256')));
  } else if (!subject) {
    const res = await fetch(`${METADATA}/token?scopes=${encodeURIComponent(scope)}`, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) throw new Error(`servidor de metadados recusou o token (HTTP ${res.status})`);
    tok = (await res.json()) as typeof tok;
  } else {
    const h = { 'Metadata-Flavor': 'Google' };
    const email = await (await fetch(`${METADATA}/email`, { headers: h })).text();
    const base = (await (await fetch(`${METADATA}/token`, { headers: h })).json()) as { access_token: string };
    const payload = JSON.stringify({ iss: email, sub: subject, scope, aud: g.tokenUrl, iat: now, exp: now + 3600 });
    const signed = await fetch(`${g.iamUrl}/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:signJwt`, {
      method: 'POST', headers: { authorization: `Bearer ${base.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ payload }),
    });
    if (!signed.ok) throw new Error(`assinatura IAM recusada (HTTP ${signed.status})`);
    tok = await exchange(g.tokenUrl, ((await signed.json()) as { signedJwt: string }).signedJwt);
  }
  cache.set(key, { value: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 });
  return tok.access_token;
}

/** Chamada autenticada; em 401 descarta o token em cache para a próxima tentativa. */
export async function googleFetch(url: string, scope: string, init: RequestInit = {}, subject?: string): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${await googleAccessToken(scope, subject)}` } });
  if (res.status === 401) cache.delete(`${scope}|${subject ?? ''}`);
  return res;
}
