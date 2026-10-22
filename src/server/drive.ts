import { createHash } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { getConfig } from './config.ts';
import { AppError } from './errors.ts';

// Armazenamento de arquivos documentais em um Drive compartilhado do Google Workspace (ADR 0010).
// A aplicação é a única via de acesso: o Drive compartilhado não tem membros humanos, só a conta de serviço,
// e os arquivos nunca são compartilhados por link. O hash SHA-256 fica no banco e é conferido a cada leitura.
// Autenticação: chave da conta de serviço (GOOGLE_DRIVE_SA_KEY) ou, no Cloud Run, a identidade do serviço (sem chave).

const SCOPE = 'https://www.googleapis.com/auth/drive';
const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

let token: { value: string; expiresAt: number } | null = null;

/** Somente para testes. */
export function resetDriveToken(): void {
  token = null;
}

async function accessToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const { drive } = getConfig();
  let res: Response;
  if (drive.saKey) {
    const key = JSON.parse(Buffer.from(drive.saKey, 'base64').toString('utf8')) as { client_email: string; private_key: string };
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(key.client_email).setAudience(drive.tokenUrl).setIssuedAt(now).setExpirationTime(now + 3600)
      .sign(await importPKCS8(key.private_key, 'RS256'));
    res = await fetch(drive.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
  } else {
    res = await fetch(`${METADATA_TOKEN_URL}?scopes=${encodeURIComponent(SCOPE)}`, { headers: { 'Metadata-Flavor': 'Google' } });
  }
  if (!res.ok) throw new Error(`token do Google recusado (HTTP ${res.status})`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  return token.value;
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const { drive } = getConfig();
  const res = await fetch(`${drive.apiUrl}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${await accessToken()}` } });
  if (res.status === 401) token = null;
  return res;
}

function unavailable(op: string, err: unknown): AppError {
  console.error(`[drive] falha em ${op}`, err);
  return new AppError('Armazenamento de documentos (Google Drive) indisponível. Tente novamente mais tarde.', 503, 'DRIVE_INDISPONIVEL');
}

/** Envia o arquivo ao Drive compartilhado; confere tamanho e MD5 devolvidos pelo Google. Retorna o id do arquivo no Drive. */
export async function driveUpload(f: { name: string; mime: string; bytes: Uint8Array; sha256: string }): Promise<string> {
  const { drive } = getConfig();
  const boundary = `sgi${createHash('sha256').update(f.sha256 + Date.now()).digest('hex').slice(0, 24)}`;
  const meta = { name: f.name, parents: [drive.folderId || drive.sharedDriveId], appProperties: { sgiSha256: f.sha256 } };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\ncontent-type: ${f.mime}\r\n\r\n`),
    Buffer.from(f.bytes),
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  let r: { id: string; size?: string; md5Checksum?: string };
  try {
    const res = await call('/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,size,md5Checksum', {
      method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    r = (await res.json()) as typeof r;
  } catch (err) {
    throw unavailable('envio', err);
  }
  const md5 = createHash('md5').update(f.bytes).digest('hex');
  if (Number(r.size) !== f.bytes.byteLength || r.md5Checksum !== md5) {
    await driveTrash(r.id).catch(() => undefined);
    throw new AppError('O arquivo gravado no Google Drive não confere com o enviado. Envio cancelado.', 502, 'DRIVE_INTEGRIDADE');
  }
  return r.id;
}

export async function driveDownload(id: string): Promise<Uint8Array> {
  try {
    const res = await call(`/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    throw unavailable('leitura', err);
  }
}

/**
 * Envia o arquivo à lixeira do Drive compartilhado (exige apenas o papel "Gerente de conteúdo"); o Google o exclui
 * definitivamente após 30 dias. Usado no descarte por retenção e para desfazer envios não confirmados.
 */
export async function driveTrash(id: string): Promise<void> {
  try {
    const res = await call(`/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trashed: true }),
    });
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    throw unavailable('descarte', err);
  }
}

/** Diagnóstico para a tela de integrações: acesso ao Drive compartilhado configurado. */
export async function driveCheck(): Promise<{ ok: boolean; detail: string }> {
  const { drive, storage } = getConfig();
  if (storage !== 'drive') return { ok: false, detail: 'Desativado (arquivos no banco de dados).' };
  try {
    const res = await call(`/drive/v3/drives/${encodeURIComponent(drive.sharedDriveId)}?fields=id,name`);
    if (!res.ok) return { ok: false, detail: `Drive compartilhado inacessível (HTTP ${res.status}). Verifique se a conta de serviço é membro.` };
    const j = (await res.json()) as { name: string };
    return { ok: true, detail: `Conectado ao Drive compartilhado "${j.name}".` };
  } catch (err) {
    return { ok: false, detail: `Falha de conexão: ${String(err).slice(0, 160)}` };
  }
}
