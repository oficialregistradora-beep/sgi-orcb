import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  decryptField,
  encryptField,
  hmacLookup,
  normalizeCpf,
  signValue,
  verifySignedValue,
} from '../../src/server/crypto.ts';
import { base32Decode, base32Encode, hotp, otpauthUri, verifyTotp } from '../../src/server/totp.ts';
import { addMonths, formatDuration, localToInstant, monthRange, toLocalParts, weekdayOf } from '../../src/domain/time.ts';

describe('criptografia de campos', () => {
  it('cifra e decifra; cada cifragem usa IV distinto', () => {
    const a = encryptField('123.456.789-09')!;
    const b = encryptField('123.456.789-09')!;
    expect(a).not.toBe(b);
    expect(a).not.toContain('123');
    expect(decryptField(a)).toBe('123.456.789-09');
  });
  it('detecta adulteração (GCM)', () => {
    const enc = encryptField('dado sensível')!;
    const parts = enc.split('.');
    const ct = Buffer.from(parts[3]!, 'base64url');
    ct[0] = ct[0]! ^ 1;
    parts[3] = ct.toString('base64url');
    expect(() => decryptField(parts.join('.'))).toThrow();
  });
  it('valores vazios permanecem nulos', () => {
    expect(encryptField('')).toBeNull();
    expect(decryptField(null)).toBeNull();
  });
  it('HMAC determinístico para busca', () => {
    expect(hmacLookup('52998224725')).toBe(hmacLookup('52998224725'));
    expect(hmacLookup('52998224725')).not.toBe(hmacLookup('52998224726'));
  });
  it('valor assinado: aceita íntegro, recusa alterado', () => {
    const s = signValue('state123');
    expect(verifySignedValue(s)).toBe('state123');
    expect(verifySignedValue(s.replace('state123', 'state124'))).toBeNull();
  });
  it('JSON canônico independe da ordem das chaves', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: 'z' } })).toBe(
      canonicalJson({ a: { c: 'z', d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
  });
  it('CPF: valida dígitos verificadores (número fictício de exemplo)', () => {
    expect(normalizeCpf('529.982.247-25')).toBe('52998224725');
    expect(normalizeCpf('529.982.247-24')).toBeNull();
    expect(normalizeCpf('111.111.111-11')).toBeNull();
  });
});

describe('TOTP (RFC 6238)', () => {
  // Vetor de teste da RFC 6238 (SHA-1): segredo ASCII "12345678901234567890".
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('base32 ida e volta', () => {
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });
  it('vetores oficiais (truncados a 6 dígitos)', () => {
    expect(hotp(secret, Math.floor(59 / 30))).toBe('287082');
    expect(hotp(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(hotp(secret, Math.floor(2000000000 / 30))).toBe('279037');
  });
  it('aceita ±1 passo e recusa reuso do mesmo passo', () => {
    const now = 1111111109 * 1000;
    const step = verifyTotp(secret, '081804', null, now);
    expect(step).toBe(Math.floor(1111111109 / 30));
    expect(verifyTotp(secret, '081804', step, now)).toBeNull();
    expect(verifyTotp(secret, '000000', null, now)).toBeNull();
    expect(verifyTotp(secret, 'abc', null, now)).toBeNull();
  });
  it('URI otpauth', () => {
    expect(otpauthUri('ABC', 'a@b.c', 'SGI')).toContain('otpauth://totp/SGI%3Aa%40b.c?secret=ABC');
  });
});

describe('tempo — America/Sao_Paulo', () => {
  it('converte local ↔ UTC (UTC-3)', () => {
    const i = localToInstant('2026-10-22', '08:00');
    expect(i.toISOString()).toBe('2026-10-22T11:00:00.000Z');
    expect(toLocalParts(i)).toMatchObject({ date: '2026-10-22', minutes: 480 });
  });
  it('virada de dia local', () => {
    expect(toLocalParts(new Date('2026-10-23T02:30:00Z')).date).toBe('2026-10-22');
  });
  it('dias da semana e competências', () => {
    expect(weekdayOf('2026-10-22')).toBe(4);
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(() => monthRange('2026-13')).toThrow();
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });
  it('formatação de durações', () => {
    expect(formatDuration(-65)).toBe('-01:05');
    expect(formatDuration(125, true)).toBe('+02:05');
    expect(formatDuration(0, true)).toBe('00:00');
  });
});

import { rateLimit } from '../../src/server/ratelimit.ts';
import { getConfig, resetConfigCache } from '../../src/server/config.ts';

describe('limitação de taxa', () => {
  it('bloqueia acima do limite e libera após a janela', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect(rateLimit('k', 3, 1000, t0 + i)).toBe(true);
    expect(rateLimit('k', 3, 1000, t0 + 10)).toBe(false);
    expect(rateLimit('k', 3, 1000, t0 + 1500)).toBe(true);
  });
});

describe('configuração segura', () => {
  it('recusa login de desenvolvimento em produção (inclusive por padrão em build de produção)', () => {
    const env = process.env as Record<string, string | undefined>;
    const saved = { ...env };
    try {
      Object.assign(env, { NODE_ENV: 'production', APP_ENV: undefined, AUTH_DEV_LOGIN: 'true', APP_URL: 'https://sgi.exemplo' });
      delete env.APP_ENV;
      resetConfigCache();
      expect(() => getConfig()).toThrow('AUTH_DEV_LOGIN');
      Object.assign(env, { AUTH_DEV_LOGIN: 'false', APP_URL: 'http://inseguro.exemplo' });
      resetConfigCache();
      expect(() => getConfig()).toThrow('HTTPS');
    } finally {
      for (const k of Object.keys(env)) if (!(k in saved)) delete env[k];
      Object.assign(env, saved);
      resetConfigCache();
    }
  });
});
