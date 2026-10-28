// Ponta a ponta da implantação (seed recém-aplicado): admissão de quem já trabalhava antes do sistema,
// início do controle e férias anteriores. Uso: node tests/e2e/implantacao.mjs [baseUrl]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
const browser = await chromium.launch();
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 86400_000));

try {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/login`);
  await page.selectOption('#userId', await page.locator('#userId option', { hasText: 'Helena' }).first().getAttribute('value'));
  await page.click('text=Entrar como usuário de teste');
  await page.waitForURL(/\/mfa/);
  await page.fill('#code', (await page.locator('.alert-warn strong.mono').textContent()).trim());
  await page.click('button[type=submit]');
  await page.waitForURL(/\/painel/);

  const admission = daysAgo(3 * 365 + 20), implant = daysAgo(10);
  await page.goto(`${BASE}/equipe/novo`);
  await page.fill('#f-rc', 'IMPL-01');
  await page.fill('#f-fn', 'Joana Antiga (fictícia)');
  await page.fill('#f-ad', admission);
  await page.click('button:has-text("Admitir")');
  await page.waitForSelector('text=informe o início do controle', { timeout: 15000 });
  check('Admissão antiga sem início do controle é recusada', true);
  await page.fill('#f-cs', implant);
  await page.click('button:has-text("Admitir")');
  await page.waitForURL(/\/equipe\/[0-9a-f-]{36}$/, { timeout: 15000 });
  const empId = page.url().split('/').pop();
  check('Ficha mostra o controle no sistema desde a implantação', await page.locator('text=controle no sistema desde').first().isVisible());
  check('Ficha oferece alterar o início do controle', await page.locator('h2:has-text("Início do controle no sistema")').isVisible());

  await page.goto(`${BASE}/ferias?funcionario=${empId}`);
  check('Férias mostra o quadro de férias anteriores à implantação', await page.locator('h2:has-text("Férias anteriores à implantação")').isVisible());
  const firstPeriodEnd = await page.locator('#pv-p option').first().textContent();
  await page.selectOption('#pv-p', { index: 0 });
  await page.fill('#pv-s', daysAgo(2 * 365 - 100)); // depois do fim do 1º período aquisitivo, antes da implantação
  await page.fill('#pv-n', 'Recibo de férias na pasta funcional (fictício)');
  await page.click('form:has(#pv-n) button[type=submit]');
  await page.waitForSelector('text=Férias anteriores à implantação registradas', { timeout: 10000 });
  check('Férias anteriores registradas e listadas', await page.locator('td:has-text("Recibo de férias na pasta funcional")').isVisible(), firstPeriodEnd ?? '');
  check('Campo de faltas anteriores à implantação na conferência', await page.locator('#rv-pf').isVisible());

  await page.goto(`${BASE}/auditoria`);
  check('Auditoria registra o lançamento', await page.locator('text=férias anteriores à implantação').first().isVisible());
} catch (e) {
  check('Execução sem exceções', false, String(e).slice(0, 300));
} finally {
  await browser.close();
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} verificações aprovadas.`);
process.exitCode = failed ? 1 : 0;
