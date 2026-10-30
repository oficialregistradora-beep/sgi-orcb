// Ponta a ponta das alternativas ao aplicativo autenticador (seed recém-aplicado, homologação local):
// códigos de reserva em "Minha segurança", entrada e reautenticação com código de reserva, liberação do código por e-mail.
// Uso: node tests/e2e/mfa-alternativas.mjs [baseUrl]
import { execSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
const browser = await chromium.launch();

async function toMfa(page, who) {
  await page.goto(`${BASE}/login`);
  await page.selectOption('#userId', await page.locator('#userId option', { hasText: who }).first().getAttribute('value'));
  await page.click('text=Entrar como usuário de teste');
  await page.waitForURL(/\/mfa/);
}
/** Código atual do usuário fictício, lido numa sessão nova (sem consumi-lo). */
async function devCode(who) {
  const p = await (await browser.newContext()).newPage();
  await toMfa(p, who);
  const code = (await p.locator('.alert-warn strong.mono').textContent()).trim();
  await p.context().close();
  return code;
}

try {
  const page = await (await browser.newContext()).newPage();
  await toMfa(page, 'Helena');
  await page.fill('#code', (await page.locator('.alert-warn strong.mono').textContent()).trim());
  await page.click('button[type=submit]');
  await page.waitForURL(/\/painel/);
  check('Menu oferece “Minha segurança”', await page.locator('nav a:has-text("Minha segurança")').isVisible());

  await page.goto(`${BASE}/seguranca`);
  check('Minha segurança mostra a situação', await page.locator('text=Cadastrado').first().isVisible() && await page.locator('text=Nenhum').first().isVisible());
  await page.waitForTimeout(31_000); // o código usado no login não pode ser reutilizado
  await page.fill('#bc-code', await devCode('Helena'));
  await page.click('button:has-text("Gerar códigos de reserva")');
  await page.waitForSelector('text=Anote ou imprima agora', { timeout: 15000 });
  const codes = await page.locator('ol.mono li').allTextContents();
  check('Dez códigos de reserva exibidos uma única vez', codes.length === 10 && codes.every((c) => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c)));
  await page.reload();
  check('Após recarregar, os códigos não aparecem mais e a situação mostra 10 de 10', (await page.locator('ol.mono li').count()) === 0 && await page.locator('text=10 de 10 disponíveis').isVisible());

  // Reautenticação com código de reserva: liberar o código por e-mail para a Substituta (fictícia).
  // O login recente vale como reautenticação por 10 min; o teste a expira direto no banco local.
  execSync(`su postgres -c "psql -d sgi_dev -qc \\"UPDATE sessions SET step_up_at = now() - interval '1 hour'\\""`);
  await page.goto(`${BASE}/permissoes`);
  await page.click('a:has-text("Beatriz")');
  await page.fill('#em-e', 'beatriz.pessoal@exemplo.com');
  await page.fill('#em-r', 'Teste de ponta a ponta');
  page.on('dialog', (d) => d.accept()); // a confirmação reaparece no reenvio após o código
  await page.click('button:has-text("Liberar código por e-mail")');
  await page.waitForSelector('#stepup-title', { timeout: 10000 });
  check('Diálogo de reautenticação oferece o envio por e-mail', await page.locator('.dialog button:has-text("Enviar código para meu e-mail pessoal")').isVisible());
  await page.fill('.dialog input', codes[0]);
  await page.click('.dialog button:has-text("Confirmar")');
  await page.waitForSelector('text=Código por e-mail liberado para esta pessoa', { timeout: 15000 });
  check('Reautenticação aceita código de reserva e libera o e-mail', true);
  await page.reload();
  check('Painel do usuário mostra o e-mail mascarado', await page.locator('text=liberado (b***@exemplo.com)').isVisible());

  // Sair e entrar com outro código de reserva.
  await page.click('button[aria-label="Sair"]');
  await page.waitForURL(/\/login/);
  await toMfa(page, 'Helena');
  await page.fill('#code', codes[1].toLowerCase());
  await page.click('button[type=submit]');
  await page.waitForURL(/\/painel/, { timeout: 15000 });
  check('Entrada com código de reserva (minúsculas aceitas)', true);
  await page.goto(`${BASE}/seguranca`);
  check('Restam 8 códigos', await page.locator('text=8 de 10 disponíveis').isVisible());

  // A Substituta vê a opção de e-mail; sem GMAIL_SENDER configurado, o sistema explica.
  const p2 = await (await browser.newContext()).newPage();
  await toMfa(p2, 'Beatriz');
  check('Sem autenticador cadastrado, a tela oferece o código no e-mail pessoal (mascarado)', await p2.locator('text=Receba um código no seu e-mail pessoal (b***@exemplo.com)').isVisible());
  await p2.click('button:has-text("Enviar código para meu e-mail pessoal")');
  await p2.waitForSelector('text=envio de e-mail ainda não está configurado', { timeout: 10000 });
  check('Sem Gmail configurado, a mensagem orienta a usar o autenticador ou a reserva', true);

  await page.goto(`${BASE}/auditoria`);
  check('Auditoria registra a geração e o uso dos códigos', await page.locator('text=novos códigos de reserva gerados').first().isVisible() && await page.locator('text=Código de reserva utilizado').first().isVisible());
} catch (e) {
  check('Execução sem exceções', false, String(e).slice(0, 300));
} finally {
  await browser.close();
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} verificações aprovadas.`);
process.exitCode = failed ? 1 : 0;
