// Ponta a ponta do controle de caixa (seed recém-aplicado, homologação local): abertura, entrada em dinheiro com troco,
// PIX, despesa, fechamento; conferência da Bárbara (Substituta fictícia) com divergência e confirmação num clique;
// calculadora de troco; relatórios; colaboradora sem caixa não vê o menu. Uso: node tests/e2e/caixa.mjs [baseUrl]
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
/** Lança e espera a nova linha aparecer na tabela (a mensagem de sucesso do lançamento anterior pode ainda estar na tela). */
async function lancar(page, fill, expectCell) {
  await fill();
  await page.click('button:has-text("Lançar")');
  await page.waitForSelector(`td:has-text("${expectCell}")`, { timeout: 15000 });
}

try {
  const gabi = await login('Gabriela');
  check('Menu “Controle de caixa” para quem opera caixa', await gabi.locator('nav a:has-text("Controle de caixa")').isVisible());
  await gabi.goto(`${BASE}/caixa`);
  await gabi.click('nav[aria-label="Caixa"] a:has-text("Caixa Gabriela")').catch(() => undefined);
  await gabi.click('button:has-text("Abrir caixa")');
  await gabi.waitForSelector('h2:has-text("Novo lançamento")', { timeout: 15000 });
  check('Caixa aberto com fundo de troco', await gabi.locator('text=R$ 100,00').first().isVisible());

  await gabi.fill('#ce-p', '1001');
  await gabi.fill('#ce-a', '158,47');
  await gabi.fill('#ce-r', '200,00');
  check('Troco calculado na hora, com as cédulas', await gabi.locator('text=Troco: R$ 41,53').isVisible() && await gabi.locator('text=2 notas de R$ 20').isVisible());
  await gabi.click('button:has-text("Lançar")');
  await gabi.waitForSelector('td:has-text("1001")', { timeout: 15000 });
  check('Formulário volta para Entrada em dinheiro depois do lançamento', (await gabi.inputValue('#ce-m')) === 'DINHEIRO' && (await gabi.inputValue('#ce-a')) === '');
  await lancar(gabi, async () => { await gabi.selectOption('#ce-m', 'PIX'); await gabi.fill('#ce-p', '1002'); await gabi.fill('#ce-a', '300,00'); }, '1002');
  await lancar(gabi, async () => { await gabi.selectOption('#ce-k', 'SAIDA_DESPESA'); await gabi.fill('#ce-f', 'CASAN – água (fictício)'); await gabi.fill('#ce-a', '80,00'); }, 'CASAN');
  await gabi.reload();
  check('Três lançamentos e troco gravado', (await gabi.locator('h2:has-text("Lançamentos") + p').textContent()).includes('3') && await gabi.locator('td:has-text("R$ 41,53")').isVisible());
  check('Dinheiro esperado: 100,00 + 158,47 − 80,00', await gabi.locator('text=R$ 178,47').first().isVisible());
  // pagamento dividido: protocolo de 1.000,00 = 500,00 em dinheiro + 500,00 no cartão
  await gabi.fill('#ce-p', '1005'); await gabi.fill('#ce-a', '1000,00'); await gabi.fill('#ce-r', '500,00');
  await gabi.click('button:has-text("Lançar")');
  await gabi.waitForSelector('text=Falta R$ 500,00', { timeout: 15000 });
  await gabi.selectOption('#ce-m', 'CARTAO_CREDITO'); await gabi.fill('#ce-p', '1005'); await gabi.fill('#ce-a', '1000,00'); await gabi.fill('#ce-r', '500,00');
  await gabi.click('button:has-text("Lançar")');
  await gabi.waitForFunction(() => document.querySelectorAll('td').length && [...document.querySelectorAll('td')].filter((t) => t.textContent?.trim() === '1005').length === 2, null, { timeout: 15000 });
  check('Pagamento dividido aceito (500 dinheiro + 500 cartão de um protocolo de 1.000)', await gabi.locator('text=de R$ 1.000,00').first().isVisible());
  const tabs = await gabi.locator('nav[aria-label="Abas do caixa"] a, .tabs a').allTextContents();
  check('Caixa vê só Frente de caixa e Troco; sem sangria nem fechamento', !tabs.some((t) => /Mês|Ano|Conferência|Relatórios/.test(t)) && !(await gabi.locator('button:has-text("Fechar o caixa")').count()) && !(await gabi.locator('h2:has-text("Sangria")').count()), tabs.join(','));

  const bia = await login('Beatriz');
  bia.on('dialog', (d) => d.accept());
  await bia.goto(`${BASE}/caixa`);
  await bia.click('a:has-text("Sangria e fechamento")');
  await bia.waitForURL(/dia=/);
  await bia.fill('#sg-a', '500,00'); await bia.fill('#sg-d', 'cofre');
  await bia.click('button:has-text("Lançar sangria")');
  await bia.waitForSelector('td:has-text("cofre")', { timeout: 15000 });
  await bia.fill('#cf-c', '178,47');
  await bia.fill('#cf-d', '100,00');
  await bia.click('button:has-text("Fechar o caixa")');
  await bia.waitForSelector('text=Fechado — aguardando conferência', { timeout: 15000 });
  check('Bárbara faz sangria e fechamento sem diferença', await bia.locator('text=diferença').first().isVisible());
  await bia.goto(`${BASE}/caixa?aba=conferencia`);
  check('Conferência lista o dia fechado', await bia.locator('td:has-text("Caixa Gabriela")').isVisible());
  await bia.click('a:has-text("Conferir")');
  await bia.waitForURL(/dia=/);
  const pixRow = bia.locator('tr', { hasText: 'PIX' });
  await pixRow.locator('input[name=note]').fill('PIX não localizado no extrato (teste)');
  await pixRow.locator('button:has-text("Apontar")').click();
  await bia.waitForSelector('text=Divergência anotada', { timeout: 15000 });
  await bia.click('button:has-text("Confirmar dia")');
  await bia.waitForSelector('text=Conferido', { timeout: 15000 });
  await bia.reload();
  check('Dia conferido num clique; divergência registrada', await bia.locator('.tag:has-text("Conferido")').isVisible() && await bia.locator('text=Divergência: PIX não localizado').isVisible());

  await bia.goto(`${BASE}/caixa?aba=troco`);
  await bia.fill('#tc-a', '158,47');
  await bia.fill('#tc-r', '200,00');
  check('Aba Troco calcula notas e moedas', await bia.locator('text=Troco: R$ 41,53').isVisible() && await bia.locator('text=3 moedas de R$ 0,01').isVisible());
  await bia.goto(`${BASE}/caixa?aba=relatorios`);
  check('Fluxo de caixa mensal com as entradas', await bia.locator('h1:has-text("Controle de caixa")').isVisible() && await bia.locator('text=Entradas realizadas').isVisible());
  await bia.goto(`${BASE}/caixa?aba=relatorios&relatorio=dre`);
  check('DRE gerencial: receita, repasses, despesas e resultado', await bia.locator('text=Resultado do período').isVisible());

  const diego = await login('Diego');
  check('Quem não opera caixa não vê o menu', !(await diego.locator('nav a:has-text("Controle de caixa")').count()));
} catch (e) {
  check('Execução sem exceções', false, String(e).slice(0, 300));
} finally {
  await browser.close();
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} verificações aprovadas.`);
process.exitCode = failed ? 1 : 0;
