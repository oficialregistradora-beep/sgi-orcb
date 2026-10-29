// Ponta a ponta do relatório XLS do Asgard (seed recém-aplicado, modelo FICTÍCIO).
// Uso: node --experimental-strip-types tests/e2e/asgard.mjs [baseUrl]
import { chromium } from 'playwright-core';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asgardTemplate } from '../fixtures/asgardTemplate.ts';
import { cellTexts, readZip, sheets } from '../../src/server/xlsx.ts';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
const dir = mkdtempSync(path.join(tmpdir(), 'asgard-'));
const tpl = path.join(dir, 'modelo-despesas-asgard.xls');
writeFileSync(tpl, asgardTemplate());
const month = new Date().toISOString().slice(0, 7);
const browser = await chromium.launch();

try {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.selectOption('#userId', await page.locator('#userId option', { hasText: 'Helena' }).first().getAttribute('value'));
  await page.click('text=Entrar como usuário de teste');
  await page.waitForURL(/\/mfa/);
  await page.fill('#code', (await page.locator('.alert-warn strong.mono').textContent()).trim());
  await page.click('button[type=submit]');
  await page.waitForURL(/\/painel/);

  await page.goto(`${BASE}/financeiro?aba=relatorios`);
  await page.click('a:has-text("Gerar relatório XLS Asgard")');
  await page.waitForSelector('h2:has-text("Modelo do Asgard")');
  check('Relatórios tem a aba "Gerar relatório XLS Asgard"', true);
  await page.setInputFiles('#as-f', tpl);
  await page.click('form:has(#as-f) button[type=submit]');
  await page.waitForSelector('text=Modelo recebido', { timeout: 15000 });
  check('Modelo enviado e tipos lidos', await page.locator('text=5 tipos disponíveis').isVisible());

  await page.goto(`${BASE}/financeiro?aba=relatorios&sub=asgard&mes=${month}`);
  const semTipo = await page.locator('.tag:has-text("Sem tipo")').count();
  check('Despesa paga do mês aparece sem tipo, e a geração fica bloqueada', semTipo > 0 && !(await page.locator('a:has-text("Gerar relatório XLS Asgard").btn-primary').count()), `${semTipo} sem tipo`);
  // Correspondência padrão da categoria "Material…" (despesa paga do seed).
  const form = page.locator('form:has(input[name=target][value=categoria])', { hasText: 'Material' }).first();
  await form.locator('select').selectOption('MATERIAL DE LIMPEZA');
  await form.locator('button[type=submit]').click();
  await page.waitForSelector('text=Correspondência salva', { timeout: 10000 });
  await page.goto(`${BASE}/financeiro?aba=relatorios&sub=asgard&mes=${month}`);
  const left = await page.locator('.tag:has-text("Sem tipo")').count();
  for (let i = 0; i < left; i++) { // demais despesas pagas do seed: tipo próprio
    const f = page.locator('tr:has(.tag:has-text("Sem tipo")) form').first();
    await f.locator('select').selectOption('DESPESAS SOFTWARE');
    await f.locator('button[type=submit]').click();
    await page.waitForSelector('text=Despesa atualizada', { timeout: 10000 });
    await page.goto(`${BASE}/financeiro?aba=relatorios&sub=asgard&mes=${month}`);
  }
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('a.btn-primary:has-text("Gerar relatório XLS Asgard")')]);
  const file = path.join(dir, dl.suggestedFilename());
  await dl.saveAs(file);
  const z = readZip(readFileSync(file));
  const tabs = sheets(z);
  const c = cellTexts(z, tabs[0].path);
  check('Planilha baixada com o nome do mês', dl.suggestedFilename() === `despesas-asgard-${month}.xls`, dl.suggestedFilename());
  check('Linha preenchida com tipo e valor', c.get('A1') === 'Data *' && !!c.get('B2') && !!c.get('D2'), `${c.get('B2')} · ${c.get('C2')} · ${c.get('D2')}`);
  check('Aba de configuração continua oculta', tabs[1]?.hidden === true);
} catch (e) {
  check('Execução sem exceções', false, String(e).slice(0, 300));
} finally {
  await browser.close();
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} verificações aprovadas.`);
process.exitCode = failed ? 1 : 0;
