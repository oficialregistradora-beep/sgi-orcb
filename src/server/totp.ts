import { createHmac, randomBytes } from 'node:crypto';

// TOTP conforme RFC 6238 (HMAC-SHA1, 6 dígitos, passo de 30 s) — compatível com Google Authenticator,
// Microsoft Authenticator e similares.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secretBase32: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secretBase32)).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const code = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(code % 1_000_000).padStart(6, '0');
}

export function currentStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpAt(secretBase32: string, nowMs = Date.now()): string {
  return hotp(secretBase32, currentStep(nowMs));
}

/**
 * Verifica um código aceitando ±1 passo (tolerância de relógio). Retorna o passo aceito,
 * ou null. Códigos de passos já utilizados (<= lastUsedStep) são recusados (anti-reuso).
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  lastUsedStep: number | null,
  nowMs = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = currentStep(nowMs);
  for (const s of [step - 1, step, step + 1]) {
    if (lastUsedStep !== null && s <= lastUsedStep) continue;
    if (hotp(secretBase32, s) === code) return s;
  }
  return null;
}

export function otpauthUri(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}
