import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getConfig } from './config.ts';

const KEY_VERSION = 'v1';

/** Criptografa um valor sensível com AES-256-GCM. Formato: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encryptField(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getConfig().fieldKey, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [KEY_VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptField(enc: string | null | undefined): string | null {
  if (!enc) return null;
  const [version, iv, tag, ct] = enc.split('.');
  if (version !== KEY_VERSION || !iv || !tag || !ct) throw new Error('Formato de campo criptografado inválido');
  const decipher = createDecipheriv('aes-256-gcm', getConfig().fieldKey, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** HMAC-SHA256 para busca determinística de valores sensíveis (ex.: CPF) sem armazená-los em claro. */
export function hmacLookup(value: string): string {
  return createHmac('sha256', getConfig().hmacKey).update(value).digest('hex');
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Assina um valor curto (cookies temporários do fluxo OAuth). */
export function signValue(value: string): string {
  const mac = createHmac('sha256', getConfig().hmacKey).update(value).digest('base64url');
  return `${value}.${mac}`;
}

export function verifySignedValue(signed: string): string | null {
  const idx = signed.lastIndexOf('.');
  if (idx <= 0) return null;
  const value = signed.slice(0, idx);
  return safeEqual(signValue(value), signed) ? value : null;
}

/**
 * Serialização JSON canônica (chaves ordenadas), usada para calcular o hash do conteúdo
 * de documentos assinados de forma estável e reprodutível.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** Valida CPF (dígitos verificadores). Retorna somente dígitos ou null. */
export function normalizeCpf(input: string): string | null {
  const d = input.replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return null;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]) ? d : null;
}
