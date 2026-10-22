// Teste ponta a ponta da interface (homologação com dados fictícios).
// Pré-requisitos: servidor em execução (npm run start) com APP_ENV=homologacao e AUTH_DEV_LOGIN=true, e seed aplicado.
// Uso: node tests/e2e/smoke.mjs [baseUrl] [pastaDeCapturas]

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const SHOTS = process.argv[3] ?? 'docs/test-reports/telas';
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const cspViolations = [];

async function newPage(viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) cspViolations.push(m.text());
  });
  return page;
}

async function loginAs(page, namePrefix) {
  await page.goto(`${BASE}/login`);
  const option = await page.locator('#userId option', { hasText: namePrefix }).first().getAttribute('value');
  await page.selectOption('#userId', option);
  await page.click('text=Entrar como usuário de teste');
  await page.waitForURL(/\/mfa/);
  const code = (await page.locator('.alert-warn strong.mono').textContent()).trim();
  await page.fill('#code', code);
  await page.click('button[type=submit]:has-text("Ativar e entrar"), button[type=submit]:has-text("Verificar")');
  await page.waitForURL(/\/painel/, { timeout: 15000 });
}

try {
  // 1. Tela de login
  let page = await newPage();
  await page.goto(`${BASE}/login`);
  check('Login exibe acesso institucional Google', await page.locator('text=Entrar com a conta institucional Google').isVisible());
  check('Login de homologação restrito a usuários fictícios', await page.locator('text=usuários FICTÍCIOS').isVisible());
  await page.screenshot({ path: `${SHOTS}/01-login.png` });

  // 2. Rota interna sem sessão
  await page.goto(`${BASE}/banco-de-horas`);
  check('Rota interna sem sessão redireciona ao login', page.url().endsWith('/login'));

  // 3. Oficial: cadastro do autenticador e painel completo
  await loginAs(page, 'Helena');
  check('Oficial chega ao painel após MFA', page.url().endsWith('/painel'));
  check('Painel da Oficial mostra visão da administração', await page.locator('h2:has-text("Visão da administração")').isVisible());
  check('Painel da Oficial mostra coordenação', await page.locator('h2:has-text("Coordenação")').isVisible());
  await page.screenshot({ path: `${SHOTS}/02-painel-oficial.png`, fullPage: true });

  // 4. Ocorrências: registrar decisão
  await page.goto(`${BASE}/ocorrencias`);
  const before = await page.locator('tbody tr').count();
  await page.screenshot({ path: `${SHOTS}/03-ocorrencias.png`, fullPage: true });
  const firstRow = page.locator('tbody tr').first();
  await firstRow.locator('input[name=notes]').fill('Análise de homologação');
  await firstRow.locator('button:has-text("Registrar")').click();
  await page.waitForTimeout(1200);
  const after = await page.locator('tbody tr').count();
  check('Decisão de ocorrência registrada', after === before - 1, `${before} → ${after} pendentes`);

  // 5. Auditoria: verificação da cadeia
  await page.goto(`${BASE}/auditoria`);
  await page.click('button:has-text("Verificar integridade da cadeia")');
  await page.waitForSelector('text=Cadeia íntegra', { timeout: 10000 });
  check('Verificação da cadeia de auditoria pela interface', true);
  await page.screenshot({ path: `${SHOTS}/04-auditoria.png` });

  // 6. Permissões e equipe
  await page.goto(`${BASE}/permissoes?aba=matriz`);
  check('Matriz de permissões editável', (await page.locator('select[name=scope]').count()) > 20);
  await page.screenshot({ path: `${SHOTS}/05-matriz-permissoes.png` });
  await page.goto(`${BASE}/equipe`);
  check('Equipe completa visível à Oficial', (await page.locator('tbody tr').count()) === 9);
  await page.locator('tbody tr a').nth(3).click();
  await page.waitForURL(/\/equipe\/[0-9a-f-]+$/);
  await page.screenshot({ path: `${SHOTS}/06-ficha-funcionario.png`, fullPage: true });
  await page.click('text=Exibir dados sensíveis');
  await page.waitForURL(/sensiveis=1/);
  check('Dados sensíveis exibidos somente sob ação explícita', await page.locator('input[name=cpf]').isVisible());

  // 6b. Fase 2b — plantões, checklists e férias (visão da Oficial)
  await page.goto(`${BASE}/plantoes?mes=${new Date().toISOString().slice(0, 7)}`);
  check('Plantões: escala da competência exibida', (await page.locator('table >> tbody tr').count()) > 0);
  const pastLink = page.locator('tbody tr td a').first();
  await pastLink.click();
  await page.waitForURL(/plantao=/);
  check('Plantões: detalhe com sobreaviso e trabalho efetivo', await page.locator('text=Sobreaviso').first().isVisible());
  await page.screenshot({ path: `${SHOTS}/10-plantao-detalhe.png`, fullPage: true });
  if (await page.locator('button:has-text("Fechar plantão")').count()) {
    page.once('dialog', (d) => d.accept());
    await page.selectOption('select[name=destination]', { index: 1 }).catch(() => undefined);
    await page.click('button:has-text("Fechar plantão")');
    await page.waitForSelector('text=Plantão fechado', { timeout: 10000 }).catch(() => undefined);
    check('Plantões: fechamento pela interface', await page.locator('text=Fechado por').count() > 0 || await page.locator('text=Plantão fechado').count() > 0);
  }
  await page.goto(`${BASE}/ferias`);
  check('Férias: programação da equipe e alertas', await page.locator('h2:has-text("Programação de férias")').isVisible());
  await page.screenshot({ path: `${SHOTS}/11-ferias.png`, fullPage: true });
  await page.goto(`${BASE}/equipe`);
  await page.locator('tbody tr a').nth(2).click();
  await page.waitForURL(/\/equipe\/[0-9a-f-]+$/);
  check('Ficha: checklists e itens entregues', await page.locator('h2:has-text("Itens entregues")').isVisible());

  // 7. Colaborador: marcação e restrições
  await page.context().close();
  page = await newPage();
  await loginAs(page, 'Diego');
  check('Colaborador não vê menu de administração', !(await page.locator('nav >> text=Auditoria').count()));
  await page.goto(`${BASE}/jornada`);
  await page.click('button:has-text("Registrar")');
  await page.waitForSelector('text=registrada às', { timeout: 10000 });
  check('Colaborador registra marcação (horário do servidor)', true);
  await page.screenshot({ path: `${SHOTS}/07-minha-jornada.png`, fullPage: true });
  await page.goto(`${BASE}/banco-de-horas`);
  await page.screenshot({ path: `${SHOTS}/08-banco-de-horas.png`, fullPage: true });
  check('Banco de horas do colaborador', await page.locator('text=Créditos por vencimento').isVisible());
  await page.goto(`${BASE}/auditoria`);
  check('Colaborador bloqueado na auditoria', await page.locator('text=Não foi possível exibir esta página').isVisible());
  await page.goto(`${BASE}/plantoes?mes=${new Date().toISOString().slice(0, 7)}`);
  const rows = await page.locator('tbody tr').allTextContents();
  check('Colaborador vê somente plantões em que é responsável ou substituto', rows.every((r) => r.includes('Diego') || r.includes('Nenhum')), `${rows.length} linha(s)`);
  await page.goto(`${BASE}/ferias`);
  check('Colaborador vê seus períodos aquisitivos', await page.locator('h2:has-text("Períodos aquisitivos")').isVisible());
  const other = await page.request.get(`${BASE}/api/v1/banco-de-horas?funcionario=00000000-0000-4000-8000-000000000000`);
  check('API recusa consulta a outro funcionário', [403, 404].includes(other.status()), `HTTP ${other.status()}`);
  const forged = await page.request.post(`${BASE}/api/v1/ponto`, { headers: { origin: 'https://atacante.example' } });
  check('API recusa escrita de origem externa (CSRF)', forged.status() === 403, `HTTP ${forged.status()}`);

  // 8. Celular: sem rolagem horizontal
  await page.context().close();
  page = await newPage({ width: 390, height: 844 });
  await loginAs(page, 'Gabriela');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('Painel em 390 px sem rolagem horizontal', overflow <= 0, `excesso ${overflow}px`);
  await page.screenshot({ path: `${SHOTS}/09-painel-celular.png`, fullPage: true });

  check('Nenhuma violação de CSP no console', cspViolations.length === 0, cspViolations.slice(0, 2).join(' | '));
} catch (err) {
  check('Execução sem exceções', false, String(err).slice(0, 300));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} verificações aprovadas.`);
process.exitCode = failed ? 1 : 0;
