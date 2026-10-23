// Varredura de acessibilidade (Fase 6) com axe-core: WCAG 2.0/2.1 níveis A e AA, em todas as telas, nos temas
// claro e escuro e em largura de celular. Uso: node tests/e2e/a11y.mjs [baseUrl]
import { chromium } from 'playwright-core';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const AXE = readFileSync('node_modules/axe-core/axe.min.js', 'utf8');
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) { const p = join(dir, e); if (statSync(p).isDirectory()) walk(p, out); else if (e === 'page.tsx') out.push(p); }
  return out;
}
const pages = walk('app/(app)').map((p) => '/' + p.replace(/^app\//, '').replace(/\/page\.tsx$/, '').split('/').filter((s) => !/^\(.*\)$/.test(s)).join('/')).filter((u) => !u.includes('['));
const browser = await chromium.launch();

async function login(ctx, who) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.selectOption('#userId', await page.locator('#userId option', { hasText: who }).first().getAttribute('value'));
  await page.click('text=Entrar como usuário de teste');
  await page.waitForURL(/\/mfa/);
  await page.fill('#code', (await page.locator('.alert-warn strong.mono').textContent()).trim());
  await page.click('button[type=submit]');
  await page.waitForURL(/\/painel/, { timeout: 15000 });
  return page;
}
async function audit(page, url) {
  await page.goto(`${BASE}${url}`);
  await page.evaluate(AXE);
  const r = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
    .map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') })));
  return r;
}

const report = {};
const detail = [];
let serious = 0;
try {
  // Cada pessoa entra uma vez (o mesmo código TOTP não pode ser reutilizado); o tema é alternado na mesma sessão.
  for (const [who, schemes, viewport] of [['Helena', ['light', 'dark'], { width: 1366, height: 900 }], ['Diego', ['light'], { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ bypassCSP: true, viewport, locale: 'pt-BR' });
    const page = await login(ctx, who);
    for (const scheme of schemes) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const url of ['/painel', ...pages.filter((u) => u !== '/painel')]) {
        const v = await audit(page, url);
        for (const x of v) {
          const key = `${x.id} (${x.impact})`;
          (report[key] ??= { help: x.help, telas: [] }).telas.push(`${who}/${scheme}/${viewport.width}px ${url} — ${x.nodes} elemento(s), ex.: ${x.sample}`);
          if (x.impact === 'critical' || x.impact === 'serious') serious++;
        }
      }
    }
    if (who === 'Helena') {
      // Telas de detalhe de todos os módulos (identificadores colhidos das listas).
      const links = new Set();
      for (const src of ['/tarefas', '/projetos', '/documentos', '/financeiro?aba=pagar', '/qualidade?aba=requisitos', '/qualidade?aba=auditorias', '/qualidade?aba=nc', '/qualidade/incidentes',
        '/treinamentos?aba=catalogo', '/avaliacoes?aba=equipe', '/plantoes', '/equipe']) {
        await page.goto(`${BASE}${src}`);
        for (const h of await page.locator('main a[href^="/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')))) if (/\/[0-9a-f-]{36}$/.test(h)) links.add(h);
      }
      const byKind = new Map();
      for (const l of links) { const k = l.replace(/[0-9a-f-]{36}$/, ''); if ((byKind.get(k) ?? 0) < 2) { byKind.set(k, (byKind.get(k) ?? 0) + 1); detail.push(l); } }
      for (const url of detail) {
        for (const x of await audit(page, url)) {
          (report[`${x.id} (${x.impact})`] ??= { help: x.help, telas: [] }).telas.push(`${who}/detalhe ${url} — ${x.nodes} elemento(s), ex.: ${x.sample}`);
          if (x.impact === 'critical' || x.impact === 'serious') serious++;
        }
      }
    }
    await ctx.close();
  }
  // Tela de login (sem sessão).
  const anon = await browser.newContext({ bypassCSP: true });
  const p = await anon.newPage();
  for (const x of await audit(p, '/login')) { (report[`${x.id} (${x.impact})`] ??= { help: x.help, telas: [] }).telas.push(`/login — ${x.nodes}`); if (x.impact === 'critical' || x.impact === 'serious') serious++; }
} finally {
  await browser.close();
}
mkdirSync('docs/test-reports', { recursive: true });
writeFileSync('docs/test-reports/fase6-acessibilidade.json', JSON.stringify({ executadoEm: new Date().toISOString(), telas: pages.length + 1, telasDeDetalhe: detail.length, violacoesGravesOuCriticas: serious, achados: report }, null, 2));
for (const [k, v] of Object.entries(report)) console.log(`${k}: ${v.help} — ${v.telas.length} ocorrência(s)\n   ${v.telas.slice(0, 3).join('\n   ')}`);
console.log(`\nViolações graves/críticas: ${serious}`);
process.exitCode = serious ? 1 : 0;
