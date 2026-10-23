// Ponta a ponta da restrição de rede (seed recém-aplicado). O endereço do cliente é simulado pelo cabeçalho
// X-Forwarded-For, como faria o proxy da infraestrutura. Uso: node tests/e2e/network.mjs [baseUrl]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OFFICE = '200.10.20.30', HOME = '177.1.1.1';
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
const browser = await chromium.launch();

async function loginAs(who, ip) {
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': ip } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.selectOption('#userId', await page.locator('#userId option', { hasText: who }).first().getAttribute('value'));
  await page.click('text=Entrar como usuário de teste');
  await page.waitForURL(/\/mfa/);
  await page.fill('#code', (await page.locator('.alert-warn strong.mono').textContent()).trim());
  await page.click('button[type=submit]');
  await page.waitForURL(/\/(painel|acesso-restrito)/, { timeout: 15000 });
  return page;
}

try {
  const o = await loginAs('Helena', OFFICE);
  await o.goto(`${BASE}/configuracoes?aba=rede`);
  check('Configurações → Rede mostra o endereço atual', await o.locator(`strong:has-text("${OFFICE}")`).first().isVisible());
  await o.fill('textarea[name=ips]', OFFICE);
  await o.check('input[name=active]');
  await o.click('button:has-text("Salvar")');
  await o.waitForSelector('text=Configuração de rede salva.', { timeout: 15000 });
  check('Oficial ativa a restrição de dentro da rede', await o.locator('strong:has-text("ATIVA")').isVisible());

  const fora = await loginAs('Henrique', HOME);
  await fora.waitForLoadState('networkidle');
  check('Colaborador fora da rede cai na página de acesso restrito', fora.url().endsWith('/acesso-restrito') && await fora.locator('h1:has-text("Acesso permitido apenas na rede da serventia")').isVisible(), fora.url());
  await fora.goto(`${BASE}/tarefas`);
  check('Qualquer tela interna continua bloqueada fora da rede', fora.url().endsWith('/acesso-restrito'));
  const api = await fora.request.get(`${BASE}/api/v1/me`);
  check('API recusa fora da rede (403)', api.status() === 403, `HTTP ${api.status()}`);
  const forjado = await fora.request.get(`${BASE}/api/v1/me`, { headers: { 'x-forwarded-for': `${OFFICE}, ${HOME}` } });
  check('Cabeçalho forjado pelo navegador não engana a verificação', forjado.status() === 403, `HTTP ${forjado.status()}`);

  const dentro = await loginAs('Gabriela', OFFICE);
  check('Colaboradora na rede da serventia usa normalmente', dentro.url().endsWith('/painel'));
  await dentro.goto(`${BASE}/jornada`);
  await dentro.click('button:has-text("Registrar")');
  await dentro.waitForSelector('text=registrada às', { timeout: 10000 });
  check('Ponto registrado de dentro da rede', true);

  const sub = await loginAs('Beatriz', HOME);
  check('Substituta (permissão de acesso externo) entra de fora', sub.url().endsWith('/painel'));

  await o.goto(`${BASE}/configuracoes?aba=rede`);
  check('Tentativa recusada aparece na lista de bloqueios', await o.locator('td:has-text("Henrique")').first().isVisible());
  await o.uncheck('input[name=active]');
  await o.click('button:has-text("Salvar")');
  await o.waitForSelector('text=Configuração de rede salva.', { timeout: 15000 });
  await fora.goto(`${BASE}/painel`);
  check('Ao desativar, o acesso volta para todos', fora.url().endsWith('/painel'));
} catch (e) {
  check('Execução sem exceções', false, String(e).slice(0, 300));
} finally {
  await browser.close();
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} verificações aprovadas.`);
process.exitCode = failed ? 1 : 0;
