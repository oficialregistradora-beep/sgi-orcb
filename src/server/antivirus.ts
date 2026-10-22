import { createConnection } from 'node:net';
import { getConfig } from './config.ts';
import { AppError } from './errors.ts';

// Verificação antivírus dos anexos pelo ClamAV (clamd), protocolo INSTREAM via TCP.
// Política "falha fechada": antivírus configurado e indisponível → anexo recusado. Em produção, sem antivírus → anexo recusado.
// Fora de produção, sem antivírus configurado, o anexo é aceito e marcado como NAO_VERIFICADO.

export type ScanResult =
  | { status: 'LIMPO'; engine: string }
  | { status: 'INFECTADO'; engine: string; signature: string }
  | { status: 'NAO_VERIFICADO'; engine: null };

const CHUNK = 64 * 1024;

/** Envia um comando ao clamd e devolve a resposta (terminada em NUL). */
function clamd(host: string, port: number, timeoutMs: number, write: (sock: import('node:net').Socket) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host, port });
    const parts: Buffer[] = [];
    const fail = (err: Error) => { sock.destroy(); reject(err); };
    sock.setTimeout(timeoutMs, () => fail(new Error('tempo esgotado')));
    sock.on('error', fail);
    sock.on('data', (d: Buffer) => parts.push(d));
    sock.on('end', () => resolve(Buffer.concat(parts).toString('utf8').replace(/\0+$/, '').trim()));
    sock.on('connect', () => write(sock));
  });
}

/** Versão do mecanismo e da base de assinaturas (ex.: "ClamAV 1.5.4/27800/…"). */
export async function antivirusVersion(): Promise<string | null> {
  const c = getConfig().clamav;
  if (!c) return null;
  return clamd(c.host, c.port, c.timeoutMs, (s) => s.end('zVERSION\0'));
}

/** Interpreta a resposta do INSTREAM. Exportada para teste. */
export function parseScanReply(reply: string, engine: string): ScanResult {
  const m = /^stream: (.+) FOUND$/.exec(reply);
  if (m) return { status: 'INFECTADO', engine, signature: m[1]! };
  if (reply === 'stream: OK') return { status: 'LIMPO', engine };
  throw new Error(`resposta inesperada do antivírus: ${reply.slice(0, 120)}`);
}

export async function scanBytes(bytes: Uint8Array): Promise<ScanResult> {
  const cfg = getConfig();
  const c = cfg.clamav;
  if (!c) {
    if (cfg.appEnv === 'producao') throw new AppError('Antivírus não configurado: o envio de arquivos está bloqueado. Informe o administrador.', 503, 'ANTIVIRUS_INDISPONIVEL');
    return { status: 'NAO_VERIFICADO', engine: null };
  }
  try {
    const engine = (await antivirusVersion()) ?? 'ClamAV';
    const reply = await clamd(c.host, c.port, c.timeoutMs, (s) => {
      s.write('zINSTREAM\0');
      for (let i = 0; i < bytes.byteLength; i += CHUNK) {
        const chunk = bytes.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.byteLength);
        s.write(len);
        s.write(chunk);
      }
      s.end(Buffer.alloc(4)); // tamanho zero encerra o fluxo
    });
    if (/size limit exceeded/i.test(reply)) throw new Error('arquivo acima do limite do antivírus (StreamMaxLength)');
    return parseScanReply(reply, engine);
  } catch (err) {
    console.error('[antivirus] falha na verificação', err);
    throw new AppError('Não foi possível verificar o arquivo com o antivírus. Envio recusado; tente novamente mais tarde.', 503, 'ANTIVIRUS_INDISPONIVEL');
  }
}
