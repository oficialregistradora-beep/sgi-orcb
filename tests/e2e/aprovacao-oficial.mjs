// Ponta a ponta da especificação da Oficial (seed recém-aplicado): responsável sem pré-seleção, envio com revisão,
// revisora devolve pela aba "Em construção", autoaprovação da Oficial, documentos no projeto e autorização da Substituta.
// Uso: node tests/e2e/aprovacao-oficial.mjs [baseUrl]
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
  page.on('dialog', (d) => d.accept());
  return page;
}

try {
  const of = await login('Helena');
  await of.goto(`${BASE}/documentos?aba=novo`);
  check('Responsável começa em "Selecione…"', (await of.inputValue('#novo-resp')) === '');
  await of.selectOption('#novo-cat', { label: 'POPs por atribuição' });
  await of.fill('#novo-title', 'Padronização do caixa E2E (fictício)');
  await of.selectOption('#novo-sector', { index: 1 });
  await of.selectOption('#novo-resp', { label: 'Helena Martins (fictícia)' });
  await of.click('button:has-text("Criar rascunho")');
  await of.waitForURL(/\/documentos\/[0-9a-f-]+$/, { timeout: 15000 });
  const docUrl = of.url();
  await of.fill('#d-texto', 'Passo 1. Conferir o troco. (fictício)');
  await of.click('button:has-text("Salvar rascunho")');
  await of.waitForSelector('text=Rascunho salvo', { timeout: 15000 });
  await of.selectOption('#sb-mode', 'COM');
  await of.locator('summary:has-text("Revisoras")').click();
  await of.locator('label.check', { hasText: 'Camila' }).locator('input[name=reviewerIds]').check();
  await of.click('button:has-text("Enviar")');
  await of.waitForSelector('text=Revisando', { timeout: 15000 });
  check('Enviado para revisão da Camila', await of.locator('.tag:has-text("Em revisão")').first().isVisible());

  const cam = await login('Camila');
  await cam.goto(`${BASE}/documentos?aba=construcao`);
  check('Revisora vê o documento em "Em construção"', await cam.locator('text=sua revisão').isVisible());
  await cam.click('a:has-text("Padronização do caixa E2E")');
  await cam.waitForURL(/\/documentos\/[0-9a-f-]+$/);
  await cam.fill('#d-texto', 'Passo 1. Conferir o troco.\nPasso 2. Registrar a sangria. (fictício)');
  await cam.click('button:has-text("Salvar rascunho")');
  await cam.waitForSelector('text=Rascunho salvo', { timeout: 15000 });
  await cam.fill('input[name=comment]', 'Incluí o passo 2');
  await cam.click('button:has-text("Devolver à Oficial")');
  await cam.waitForSelector('.tag:has-text("Devolvida")', { timeout: 15000 });
  check('Revisora devolve; segue para a Oficial', await cam.locator('text=aguardando aprovação').first().isVisible());
  check('Revisora não vê Aprovar nem Excluir', !(await cam.locator('button:has-text("Aprovar e tornar vigente")').count()) && !(await cam.locator('button:has-text("Excluir documento")').count()));

  await of.goto(`${BASE}/documentos?aba=aprovacoes`);
  check('Aprovações da Oficial listam o que ela elaborou', await of.locator('tr', { hasText: 'Padronização do caixa E2E' }).locator('text=elaborado por você').isVisible());
  await of.goto(docUrl);
  check('Aviso de autoaprovação', await of.locator('text=A aprovação ficará registrada como autoaprovação').isVisible());
  await of.locator('form:has(input[value=APROVADA]) input[name=confirmed]').check();
  await of.click('button:has-text("Aprovar e tornar vigente")');
  await of.waitForSelector('text=Versão vigente — v1', { timeout: 15000 });
  check('Oficial autoaprova; histórico registra', await of.locator('td:has-text("Versão autoaprovada pela Oficial Registradora")').isVisible());

  await of.goto(`${BASE}/projetos`);
  await of.click('a:has-text("Implantação dos POPs")');
  await of.waitForURL(/\/projetos\/[0-9a-f-]+$/);
  check('Projeto: card de aprovação', await of.locator('button:has-text("Aprovar projeto")').isVisible());
  await of.click('nav.tabs a:has-text("Documentos")');
  await of.setInputFiles('#pa-f', { name: 'pop-recepcao.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% POP ficticio\n%%EOF\n') });
  await of.click('button:has-text("Anexar")');
  await of.waitForSelector('td:has-text("pop-recepcao.pdf")', { timeout: 15000 });
  check('Anexo no projeto com hash', await of.locator('text=Anexo do projeto').isVisible() && await of.locator('text=SHA-256').first().isVisible());
  await of.locator('summary:has-text("Enviar à Gestão documental")').first().click();
  const form = of.locator('form:has(input[value=enviar_doc])').first();
  await form.locator('select[name=categoryId]').selectOption({ label: 'POPs por atribuição' });
  check('Responsável vem do Gestor(a) do projeto', await form.locator('text=vem do Gestor(a) do projeto').isVisible());
  await form.locator('select[name=reviewMode]').selectOption('SEM');
  await form.locator('button:has-text("Criar documento e enviar")').click();
  await of.waitForSelector('.tag:has-text("Em aprovação")', { timeout: 15000 });
  check('Enviado à Gestão documental: situação no projeto', true);
  await of.click('td a:has-text("pop-recepcao")');
  await of.waitForURL(/\/documentos\/[0-9a-f-]+$/);
  check('Documento mostra "Origem: projeto"', await of.locator('text=Origem: projeto').isVisible());

  await of.goto(`${BASE}/configuracoes?aba=documental`);
  check('Configurações → Gestão documental: autorização da Substituta', await of.locator('h2:has-text("Autorizar a Substituta Legal a aprovar")').isVisible());

  const bia = await login('Beatriz');
  await bia.goto(`${BASE}/documentos`);
  check('Substituta sem autorização não tem a aba Aprovações', !(await bia.locator('nav.tabs a:has-text("Aprovações")').count()));
} catch (e) {
  check('Execução sem exceções', false, String(e).slice(0, 300));
} finally {
  await browser.close();
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} verificações aprovadas.`);
process.exitCode = failed ? 1 : 0;
