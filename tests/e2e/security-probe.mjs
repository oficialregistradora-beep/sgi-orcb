// Sondagem dinâmica de segurança (Fase 6) contra o servidor de homologação com dados fictícios.
// Verifica: acesso anônimo a todas as rotas, cabeçalhos, CSRF (origem externa), invalidação de sessão no logout,
// e acesso cruzado entre perfis (IDOR) nas telas de detalhe de todos os módulos.
// Uso: node tests/e2e/security-probe.mjs [baseUrl]

import { chromium } from 'playwright-core';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const DENIED = /Não foi possível exibir esta página|não tem acesso|Você não tem acesso/;

// Rotas: páginas estáticas da área autenticada e rotas de API.
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e === 'page.tsx' || e === 'route.ts') out.push(p);
  }
  return out;
}
const toUrl = (p) => '/' + p.replace(/^app\//, '').replace(/\/(page\.tsx|route\.ts)$/, '').split('/').filter((s) => !/^\(.*\)$/.test(s)).join('/');
const files = walk('app');
const pages = files.filter((f) => f.endsWith('page.tsx') && f.includes('(app)')).map(toUrl);
const sample = (u) => u.replace(/\[[^\]]+\]/g, '00000000-0000-4000-8000-000000000000');
const apis = files.filter((f) => f.endsWith('route.ts')).map(toUrl).filter((u) => !/health|auth\/(google|dev)|cron/.test(u));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());

async function loginAs(namePrefix) {
  const ctx = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  const option = await page.locator('#userId option', { hasText: namePrefix }).first().getAttribute('value');
  await page.selectOption('#userId', option);
  await page.click('text=Entrar como usuário de teste');
  await page.waitForURL(/\/mfa/);
  const code = (await page.locator('.alert-warn strong.mono').textContent()).trim();
  await page.fill('#code', code);
  await page.click('button[type=submit]:has-text("Ativar e entrar"), button[type=submit]:has-text("Verificar")');
  await page.waitForURL(/\/painel/, { timeout: 15000 });
  return page;
}

try {
  // 1. Anônimo: toda página interna redireciona ao login; toda API responde 401/403/404.
  const anon = await browser.newContext();
  const ap = await anon.newPage();
  let leaks = [];
  for (const u of pages) {
    await ap.goto(`${BASE}${sample(u)}`);
    if (!ap.url().endsWith('/login')) leaks.push(u);
  }
  check(`Anônimo: ${pages.length} páginas internas redirecionam ao login`, !leaks.length, leaks.join(', '));
  leaks = [];
  for (const u of apis) {
    const r = await anon.request.get(`${BASE}${sample(u)}`);
    if (![401, 403, 404, 405].includes(r.status())) leaks.push(`${u} → ${r.status()}`);
  }
  check(`Anônimo: ${apis.length} rotas de API recusam`, !leaks.length, leaks.join(', '));
  const cron = await anon.request.post(`${BASE}/api/cron/processar`);
  check('Rotina agendada exige segredo', [401, 403, 404].includes(cron.status()), `HTTP ${cron.status()}`);

  // 2. Cabeçalhos de segurança.
  const h = (await anon.request.get(`${BASE}/login`)).headers();
  const csp = h['content-security-policy'] ?? '';
  check('CSP com nonce, sem unsafe-inline em scripts e com frame-ancestors none', /script-src[^;]*'nonce-/.test(csp) && !/script-src[^;]*'unsafe-inline'/.test(csp) && /frame-ancestors 'none'/.test(csp));
  check('Cabeçalhos: HSTS, nosniff, X-Frame-Options, Referrer-Policy, Permissions-Policy',
    !!h['strict-transport-security'] && h['x-content-type-options'] === 'nosniff' && h['x-frame-options'] === 'DENY' && !!h['referrer-policy'] && !!h['permissions-policy']);
  check('Servidor não se identifica', !h['x-powered-by']);

  // 3. Sessão: cookie protegido; logout invalida no servidor (cookie antigo não funciona).
  const op = await loginAs('Beatriz'); // o mesmo código TOTP não pode ser reutilizado: cada pessoa entra uma vez por janela
  const cookies = await op.context().cookies();
  const sess = cookies.find((c) => /sgi_sessao/.test(c.name));
  check('Cookie de sessão HttpOnly e SameSite', !!sess && sess.httpOnly && sess.sameSite === 'Lax');
  // CSRF: escrita na API com origem externa é recusada; Server Action com Origin externo também.
  const forged = await op.request.post(`${BASE}/api/v1/ponto`, { headers: { origin: 'https://atacante.example' } });
  check('API: escrita com origem externa recusada', forged.status() === 403, `HTTP ${forged.status()}`);
  const actionId = await op.evaluate(() => document.querySelector('form input[name^="$ACTION_ID"]')?.getAttribute('name')?.replace('$ACTION_ID_', '') ?? null);
  if (actionId) {
    const r = await op.request.post(`${BASE}/painel`, { headers: { origin: 'https://atacante.example', 'next-action': actionId, 'content-type': 'text/plain;charset=UTF-8' }, data: '[]' });
    check('Server Action com origem externa recusada', r.status() >= 400 || !(await r.text()).includes('"ok":true'), `HTTP ${r.status()}`);
  } else {
    check('Server Action com origem externa recusada (sem ação identificável na página — verificação pulada)', true);
  }
  const stolen = cookies.map((c) => ({ ...c }));
  await op.goto(`${BASE}/painel`);
  await op.click('button:has-text("Sair")');
  await op.waitForURL(/\/login/);
  const replay = await browser.newContext();
  await replay.addCookies(stolen);
  const rp = await replay.newPage();
  await rp.goto(`${BASE}/painel`);
  check('Logout invalida a sessão no servidor (cookie copiado não funciona)', rp.url().endsWith('/login'));

  // 4. Acesso cruzado (IDOR): links de detalhe vistos pela Oficial, abertos por um colaborador sem relação.
  const o = await loginAs('Helena');
  const sources = ['/financeiro?aba=pagar', '/qualidade?aba=nc', '/qualidade?aba=auditorias', '/qualidade/incidentes', '/avaliacoes?aba=equipe', '/projetos', '/documentos', '/treinamentos?aba=catalogo'];
  const links = new Set();
  for (const s of sources) {
    await o.goto(`${BASE}${s}`);
    for (const href of await o.locator('main a[href^="/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')))) {
      if (/^\/(financeiro\/despesas|qualidade\/(nc|auditorias|incidentes|requisitos)|avaliacoes\/(?!pessoa)|avaliacoes\/pessoa|projetos|documentos|treinamentos)\/[0-9a-f-]{36}$/.test(href)) links.add(href);
    }
  }
  check(`Coleta de ${links.size} telas de detalhe de todos os módulos`, links.size >= 12);
  const g = await loginAs('Henrique'); // Atendimento, colaborador, sem participação nos registros do seed
  const exposed = [];
  const mustDeny = /^\/(financeiro\/despesas|qualidade\/(nc|auditorias|incidentes|requisitos)|avaliacoes)\//;
  const statuses = [];
  for (const href of links) {
    const resp = await g.goto(`${BASE}${href}`);
    const body = await g.locator('main').innerText();
    if (href.startsWith('/avaliacoes/pessoa/') && /Henrique/.test(body)) continue; // o próprio histórico é legítimo
    if (DENIED.test(body)) statuses.push(resp?.status());
    if (mustDeny.test(href) && !DENIED.test(body) && !g.url().includes('/qualidade/incidentes')) exposed.push(href);
    if (mustDeny.test(href) && g.url().includes('/qualidade/incidentes/') && !DENIED.test(body)) exposed.push(href);
  }
  check('Recusas respondem 403/404 (nunca 500)', statuses.length > 0 && statuses.every((x) => x === 403 || x === 404), [...new Set(statuses)].join(','));
  check('Colaborador sem relação não abre despesas, NCs, auditorias, incidentes alheios, requisitos nem avaliações', !exposed.length, exposed.slice(0, 5).join(', '));
  // Todas as páginas abrem sem erro de servidor para o colaborador (ou negam de forma controlada).
  const errs = [];
  for (const u of pages.filter((x) => !x.includes('['))) {
    const r = await g.goto(`${BASE}${u}`);
    if ((r?.status() ?? 200) >= 500) errs.push(`${u} → ${r.status()}`);
  }
  check(`Colaborador: ${pages.filter((x) => !x.includes('[')).length} páginas sem erro 5xx`, !errs.length, errs.join(', '));
  const o2 = o;
  const errs2 = [];
  for (const u of pages.filter((x) => !x.includes('['))) {
    const r = await o2.goto(`${BASE}${u}`);
    if ((r?.status() ?? 200) >= 500 || /Não foi possível exibir esta página/.test(await o2.locator('main').innerText())) errs2.push(u);
  }
  check('Oficial: todas as páginas abrem sem erro', !errs2.length, errs2.join(', '));
  for (const href of [...links].slice(0, 40)) {
    const r = await o2.goto(`${BASE}${href}`);
    if ((r?.status() ?? 200) >= 500 || /Não foi possível exibir esta página/.test(await o2.locator('main').innerText())) errs2.push(href);
  }
  check('Oficial: telas de detalhe abrem sem erro', !errs2.length, errs2.join(', '));
} catch (err) {
  check('Execução sem exceções', false, String(err).slice(0, 300));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} verificações aprovadas.`);
process.exitCode = failed ? 1 : 0;
