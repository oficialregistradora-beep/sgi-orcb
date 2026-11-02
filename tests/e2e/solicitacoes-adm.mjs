// Ponta a ponta das solicitações à administração (seed recém-aplicado): a colaboradora pede, a Oficial responde,
// a colaboradora vê a resposta. Uso: node tests/e2e/solicitacoes-adm.mjs [baseUrl]
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
const browser = await chromium.launch();

async function login(who) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/login`);
  await page.selectOption('#userId', await page.locator('#userId option', { hasText: who }).first().getAttribute('value'));
  await page.click('text=Entrar como usuário de teste');
  await page.waitForURL(/\/mfa/);
  await page.fill('#code', (await page.locator('.alert-warn strong.mono').textContent()).trim());
  await page.click('button[type=submit]');
  await page.waitForURL(/\/painel/);
  return page;
}

try {
  const gabi = await login('Gabriela');
  await gabi.goto(`${BASE}/solicitacoes`);
  check('Aba “À administração” visível para a colaboradora', await gabi.locator('nav a:has-text("À administração")').isVisible());
  check('Colaboradora não vê “Recebidas pela administração”', !(await gabi.locator('nav a:has-text("Recebidas pela administração")').count()));
  await gabi.click('nav a:has-text("À administração")');
  await gabi.selectOption('#ar-c', 'MATERIAL');
  await gabi.fill('#ar-s', 'Cadeira nova (fictício)');
  await gabi.fill('#ar-b', 'A cadeira do balcão 2 está quebrada.');
  await gabi.click('button:has-text("Enviar solicitação")');
  await gabi.waitForSelector('text=Solicitação enviada à administração', { timeout: 15000 });
  check('Solicitação enviada e listada', await gabi.locator('td a:has-text("Cadeira nova (fictício)")').isVisible());

  const helena = await login('Helena');
  await helena.goto(`${BASE}/notificacoes`);
  check('Oficial recebe o aviso', await helena.locator('text=Nova solicitação à administração').first().isVisible());
  await helena.goto(`${BASE}/solicitacoes?aba=recebidas`);
  await helena.click('td a:has-text("Cadeira nova (fictício)")');
  await helena.waitForURL(/\/solicitacoes\/administracao\//);
  await helena.selectOption('#ah-s', 'ATENDIDA');
  await helena.fill('#ah-r', 'Cadeira comprada; chega na sexta.');
  await helena.click('button:has-text("Registrar")');
  // Ao encerrar, o quadro "Atender" sai da tela (com a mensagem): confere a resposta publicada no pedido.
  await helena.waitForSelector('.alert-info:has-text("Cadeira comprada; chega na sexta.")', { timeout: 15000 });
  check('Resposta registrada e quadro “Atender” encerrado', !(await helena.locator('h2:has-text("Atender")').count()));

  await gabi.goto(`${BASE}/solicitacoes?aba=administracao`);
  check('Colaboradora vê a situação “Atendida”', await gabi.locator('.tag:has-text("Atendida")').first().isVisible());
  await gabi.click('td a:has-text("Cadeira nova (fictício)")');
  await gabi.waitForURL(/\/solicitacoes\/administracao\//);
  check('Colaboradora lê a resposta', await gabi.locator('text=Cadeira comprada; chega na sexta.').isVisible());
  check('Colaboradora não tem o quadro “Atender”', !(await gabi.locator('h2:has-text("Atender")').count()));
} catch (e) {
  check('Execução sem exceções', false, String(e).slice(0, 300));
} finally {
  await browser.close();
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} verificações aprovadas.`);
process.exitCode = failed ? 1 : 0;
