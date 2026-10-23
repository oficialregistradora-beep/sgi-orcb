// Teste de carga (Fase 6) contra o servidor de homologação com dados fictícios.
// Simula a equipe inteira (todos os usuários do seed) navegando ao mesmo tempo pelas telas mais usadas, várias vezes,
// e mede tempos de resposta (p50/p95/máximo) e erros. Uso:
//   node --env-file-if-exists=.env --experimental-strip-types scripts/load-test.ts [baseUrl] [rodadas] [concorrência por usuário]
import { writeFileSync, mkdirSync } from 'node:fs';
import { getConfig } from '../src/server/config.ts';
import { closePool, getPool, query } from '../src/server/db.ts';
import { createSession, markMfaVerified } from '../src/server/auth/session.ts';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const ROUNDS = Number(process.argv[3] ?? 5);
const PER_USER = Number(process.argv[4] ?? 2);
if (getConfig().appEnv === 'producao') throw new Error('Teste de carga proibido em produção.');

const PAGES = ['/painel', '/tarefas', '/jornada', '/banco-de-horas', '/agenda', '/documentos', '/treinamentos', '/avaliacoes', '/qualidade/incidentes', '/financeiro', '/qualidade', '/notificacoes'];
const db = getPool();
const users = await query<{ id: string; display_name: string }>(db, "SELECT id, display_name FROM users WHERE status = 'ATIVO' ORDER BY display_name");
const cookieName = getConfig().secureCookies ? '__Host-sgi_sessao' : 'sgi_sessao';
const sessions: { name: string; cookie: string }[] = [];
for (const u of users) {
  const { token, sessionId } = await createSession(db, u.id, 'DEV', '127.0.0.1', 'load-test');
  await markMfaVerified(db, sessionId);
  sessions.push({ name: u.display_name, cookie: `${cookieName}=${token}` });
}

const times: Record<string, number[]> = {};
let errors = 0, total = 0;
const errorSamples: string[] = [];
const t0 = Date.now();
async function hit(s: { cookie: string }, path: string) {
  const start = performance.now();
  const r = await fetch(`${BASE}${path}`, { headers: { cookie: s.cookie }, redirect: 'manual' });
  await r.arrayBuffer();
  const ms = performance.now() - start;
  (times[path] ??= []).push(ms);
  total++;
  if (r.status >= 500 || (r.status >= 300 && r.status < 400 && /login|mfa/.test(r.headers.get('location') ?? ''))) {
    errors++;
    if (errorSamples.length < 20) errorSamples.push(`${path} → ${r.status} ${r.headers.get('location') ?? ''}`);
  }
}
for (let round = 0; round < ROUNDS; round++) {
  // Todos os usuários ao mesmo tempo, cada um com PER_USER navegações paralelas.
  await Promise.all(sessions.flatMap((s, i) => Array.from({ length: PER_USER }, (_, k) => (async () => {
    for (let j = 0; j < PAGES.length; j++) await hit(s, PAGES[(i + k + j + round) % PAGES.length]!);
  })())));
}
const elapsed = (Date.now() - t0) / 1000;
const pct = (xs: number[], p: number) => { const a = [...xs].sort((x, y) => x - y); return Math.round(a[Math.min(a.length - 1, Math.floor(p * a.length))]!); };
const all = Object.values(times).flat();
const report = {
  executadoEm: new Date().toISOString(), usuariosSimultaneos: sessions.length, navegacoesParalelasPorUsuario: PER_USER, rodadas: ROUNDS,
  requisicoes: total, erros: errors, duracaoSegundos: Math.round(elapsed * 10) / 10, requisicoesPorSegundo: Math.round((total / elapsed) * 10) / 10,
  amostrasDeErro: errorSamples,
  geral: { p50: pct(all, 0.5), p95: pct(all, 0.95), max: Math.round(Math.max(...all)) },
  porTela: Object.fromEntries(Object.entries(times).map(([k, v]) => [k, { p50: pct(v, 0.5), p95: pct(v, 0.95), max: Math.round(Math.max(...v)) }])),
};
mkdirSync('docs/test-reports', { recursive: true });
writeFileSync('docs/test-reports/fase6-carga.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await query(db, "UPDATE sessions SET revoked_at = now() WHERE user_agent = 'load-test' AND revoked_at IS NULL").catch(() => undefined);
await closePool();
process.exitCode = errors ? 1 : 0;
