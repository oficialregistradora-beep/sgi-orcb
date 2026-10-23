import { getConfig } from './config.ts';
import { pickClientIp } from '../domain/network.ts';

// Limitação de taxa em janela deslizante, em memória por instância. Adequado à escala prevista (0–2 instâncias
// no Cloud Run); com mais instâncias, o limite efetivo se multiplica (documentado no manual de segurança).

const buckets = new Map<string, number[]>();

export function rateLimit(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (!v.some((t) => now - t < windowMs)) buckets.delete(k);
  }
  return true;
}

export function clientIp(req: Request): string {
  // O primeiro item de X-Forwarded-For pode ser forjado pelo navegador (o que contornaria o limite): vale o da infraestrutura.
  return pickClientIp(req.headers.get('x-forwarded-for'), req.headers.get('x-real-ip'), getConfig().trustedProxyHops) ?? 'desconhecido';
}
