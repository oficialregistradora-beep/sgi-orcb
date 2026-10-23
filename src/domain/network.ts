// Regras puras de rede: endereço do cliente atrás de proxies e lista de endereços permitidos (IPv4/IPv6, com CIDR).

/**
 * IP do cliente a partir de X-Forwarded-For. O navegador pode enviar o próprio cabeçalho, e cada proxy ACRESCENTA
 * o endereço de quem o chamou ao final — por isso só os itens da direita são confiáveis. `trustedHops` é o número
 * de proxies da própria infraestrutura além do primeiro (0 = Cloud Run direto ou Caddy/Nginx; 1 = balanceador + Cloud Run).
 */
export function pickClientIp(xff: string | null | undefined, realIp: string | null | undefined, trustedHops = 0): string | null {
  const parts = (xff ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const ip = parts.length ? parts[Math.max(0, parts.length - 1 - trustedHops)] : realIp?.trim();
  return ip ? normalizeIp(ip) : null;
}

/** Remove porta, colchetes e o prefixo IPv4-mapeado (::ffff:a.b.c.d). */
export function normalizeIp(raw: string): string {
  let ip = raw.trim();
  if (ip.startsWith('[')) ip = ip.slice(1, ip.indexOf(']'));
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.split(':')[0]!;
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7);
  return ip.toLowerCase();
}

function v4(ip: string): bigint | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  return o.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
}

function v6(ip: string): bigint | null {
  if (!/^[0-9a-f:.]+$/i.test(ip) || !ip.includes(':')) return null;
  const [head, tail, extra] = ip.split('::');
  if (extra !== undefined) return null;
  const groups = (s: string | undefined) => (s ? s.split(':') : []);
  let h = groups(head), t = groups(tail);
  // IPv4 embutido no final (ex.: 64:ff9b::1.2.3.4)
  const last = (tail !== undefined ? t : h).at(-1);
  if (last?.includes('.')) {
    const n = v4(last);
    if (n === null) return null;
    const hex = [(n >> 16n) & 0xffffn, n & 0xffffn].map((x) => x.toString(16));
    if (tail !== undefined) t = [...t.slice(0, -1), ...hex]; else h = [...h.slice(0, -1), ...hex];
  }
  const missing = 8 - h.length - t.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const all = [...h, ...Array(tail === undefined ? 0 : missing).fill('0'), ...t];
  if (all.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return all.reduce((a, g) => (a << 16n) | BigInt(parseInt(g, 16)), 0n);
}

export type Cidr = { family: 4 | 6; base: bigint; bits: number; text: string };

/** Interpreta "a.b.c.d", "a.b.c.d/24", IPv6 ou IPv6/prefixo. Lança erro com a linha inválida. */
export function parseCidr(text: string): Cidr {
  const t = text.trim();
  const [addr, bitsRaw] = t.split('/');
  const n4 = v4(addr!), n6 = n4 === null ? v6(addr!.toLowerCase()) : null;
  if (n4 === null && n6 === null) throw new Error(`Endereço inválido: ${t}`);
  const family = n4 !== null ? 4 : 6;
  const max = family === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? max : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > max || (bitsRaw !== undefined && !/^\d+$/.test(bitsRaw))) throw new Error(`Prefixo inválido: ${t}`);
  // Faixas amplas demais anulariam a restrição.
  if ((family === 4 && bits < 16) || (family === 6 && bits < 32)) throw new Error(`Faixa ampla demais: ${t}`);
  const value = (n4 ?? n6)!;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits);
  return { family, base: value & mask, bits, text: t };
}

/** Lista de permitidos a partir de texto (uma entrada por linha; aceita comentários após #). */
export function parseAllowList(text: string): Cidr[] {
  return text.split(/\r?\n|,/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean).map(parseCidr);
}

export function ipAllowed(ip: string | null, list: Cidr[]): boolean {
  if (!ip) return false;
  const ipn = normalizeIp(ip);
  const n4 = v4(ipn), n6 = n4 === null ? v6(ipn) : null;
  for (const c of list) {
    const n = c.family === 4 ? n4 : n6;
    if (n === null) continue;
    const max = c.family === 4 ? 32 : 128;
    const mask = c.bits === 0 ? 0n : ((1n << BigInt(c.bits)) - 1n) << BigInt(max - c.bits);
    if ((n & mask) === c.base) return true;
  }
  return false;
}
