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

  // 6c. Fase 2c — regras jurídicas, modelos de checklist e conferência de faltas
  await page.goto(`${BASE}/configuracoes?aba=regras`);
  check('Regras jurídicas: CCT vigente com leitura pendente', await page.locator('text=SC000957/2026').first().isVisible());
  check('Regras jurídicas: regras históricas sinalizadas como não aplicáveis', (await page.locator('text=Histórico — não aplicar').count()) >= 4);
  await page.screenshot({ path: `${SHOTS}/12-regras-juridicas.png`, fullPage: true });
  await page.goto(`${BASE}/configuracoes?aba=checklists`);
  await page.locator('tbody tr a').first().click();
  await page.waitForURL(/modelo=/);
  check('Modelos de checklist: versão publicada somente leitura', await page.locator('text=somente leitura').isVisible());
  await page.click('button:has-text("Editar (nova versão)")');
  await page.waitForSelector('text=Rascunho da nova versão criado', { timeout: 10000 });
  check('Modelos de checklist: nova versão em rascunho', true);
  await page.screenshot({ path: `${SHOTS}/13-modelo-checklist.png`, fullPage: true });
  await page.goto(`${BASE}/ferias`);
  check('Férias: coluna de faltas do art. 130', await page.locator('th:has-text("Faltas (art. 130)")').isVisible());

  // 6d. Fase 3 — gestão documental
  await page.goto(`${BASE}/painel`);
  check('Painel avisa documentos institucionais para ciência', await page.locator('text=aguardando sua ciência').isVisible());
  await page.goto(`${BASE}/documentos`);
  check('Repositório lista documentos (inclusive confidencial para a Oficial)', await page.locator('text=Plano de Continuidade de Negócios (fictício)').isVisible());
  const pcnHref = await page.locator('a:has-text("Plano de Continuidade")').getAttribute('href');
  await page.screenshot({ path: `${SHOTS}/14-repositorio.png`, fullPage: true });
  await page.goto(`${BASE}/documentos?q=sigilo`);
  check('Pesquisa textual pelo conteúdo', (await page.locator('tbody tr').count()) === 1 && await page.locator('tbody a:has-text("Código de Ética")').isVisible());
  await page.click('a:has-text("Código de Ética")');
  await page.waitForURL(/\/documentos\/[0-9a-f-]+$/);
  await page.check('input[name=confirmed]');
  await page.click('button:has-text("Registrar ciência")');
  await page.waitForSelector('text=Ciência registrada', { timeout: 10000 });
  check('Ciência registrada com assinatura vinculada à versão', true);
  await page.screenshot({ path: `${SHOTS}/15-documento-vigente.png`, fullPage: true });
  await page.goto(`${BASE}/documentos?aba=aprovacoes`);
  await page.click('a:has-text("Prenotação")');
  await page.waitForURL(/\/documentos\/[0-9a-f-]+$/);
  page.once('dialog', (d) => d.accept());
  await page.locator('form:has(input[value=APROVADA]) input[name=confirmed]').check();
  await page.click('button:has-text("Aprovar e tornar vigente")');
  await page.waitForSelector('text=Versão vigente — v2', { timeout: 10000 });
  check('Aprovação de revisão pela interface (v2 vigente)', true);
  await page.goto(`${BASE}/documentos?aba=novo`);
  await page.selectOption('#novo-cat', { label: 'Atas de reunião' });
  await page.fill('#novo-title', 'Ata de reunião E2E (fictícia)');
  await page.selectOption('#novo-sector', { index: 1 });
  await page.click('button:has-text("Criar rascunho")');
  await page.waitForURL(/\/documentos\/[0-9a-f-]+$/, { timeout: 10000 });
  await page.fill('#d-texto', 'Pauta fictícia de homologação.');
  await page.setInputFiles('#d-file', { name: 'ata.txt', mimeType: 'text/plain', buffer: Buffer.from('Ata fictícia — teste E2E\n') });
  await page.click('button:has-text("Salvar rascunho")');
  await page.waitForSelector('text=Rascunho salvo', { timeout: 10000 });
  check('Rascunho com arquivo anexado', await page.locator('a:has-text("ata.txt")').isVisible());
  check('Anexo verificado pelo antivírus (ClamAV)', await page.locator('text=Verificado pelo antivírus').first().isVisible());
  await page.setInputFiles('#d-file', { name: 'leia-me.txt', mimeType: 'text/plain', buffer: Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*') });
  await page.click('button:has-text("Salvar rascunho")');
  await page.waitForSelector('text=conteúdo malicioso', { timeout: 15000 }).catch(() => undefined);
  check('Arquivo de teste EICAR bloqueado pelo antivírus na interface', await page.locator('text=conteúdo malicioso').isVisible());
  await page.screenshot({ path: `${SHOTS}/16-antivirus-bloqueio.png`, fullPage: true });
  const dl = await page.request.get(new URL(await page.locator('a:has-text("ata.txt")').getAttribute('href'), BASE).toString());
  check('Download autorizado como anexo, sem interpretação', dl.status() === 200 && /attachment/.test(dl.headers()['content-disposition'] ?? '') && dl.headers()['x-content-type-options'] === 'nosniff');
  page.once('dialog', (d) => d.accept());
  await page.click('button:has-text("Submeter à aprovação")');
  await page.waitForSelector('text=aguardando aprovação', { timeout: 10000 });
  check('Autor não decide a própria versão (segregação)', await page.locator('text=segregação de funções').isVisible());

  // 6e. Fase 4a — tarefas, projetos, rotinas e processos (Oficial)
  await page.goto(`${BASE}/tarefas?visao=painel`);
  check('Tarefas: painel com indicadores', await page.locator('text=Carga por responsável').isVisible());
  await page.goto(`${BASE}/tarefas?visao=quadro`);
  check('Tarefas: quadro com colunas por situação', (await page.locator('.board-col').count()) === 5);
  await page.screenshot({ path: `${SHOTS}/18-quadro-tarefas.png`, fullPage: true });
  await page.goto(`${BASE}/tarefas?visao=calendario`);
  check('Tarefas: calendário mensal', (await page.locator('.cal [role=gridcell]').count()) === 42);
  await page.goto(`${BASE}/projetos`);
  await page.click('a:has-text("Implantação dos POPs")');
  await page.waitForURL(/\/projetos\/[0-9a-f-]+$/);
  check('Projetos: visão geral com progresso e custos', await page.locator('text=Custo realizado').isVisible());
  await page.click('nav.tabs a:has-text("Cronograma")');
  await page.waitForURL(/aba=gantt/);
  check('Projetos: cronograma (Gantt) com fases e marcos', (await page.locator('.g-bar').count()) >= 3 && (await page.locator('.g-ms').count()) >= 1);
  await page.screenshot({ path: `${SHOTS}/19-gantt.png`, fullPage: true });
  await page.goto(`${BASE}/rotinas`);
  check('Rotinas: verificação das centrais 4×/dia cadastrada', await page.locator('text=09:00, 11:00, 14:00, 16:00').first().isVisible());
  await page.goto(`${BASE}/rotinas?aba=andamento`);
  check('Processos: instância em andamento com etapa atual', await page.locator('text=Admissão — Pessoa Fictícia').first().isVisible());
  await page.screenshot({ path: `${SHOTS}/20-processos.png`, fullPage: true });

  await page.goto(`${BASE}/configuracoes?aba=integracoes`);
  check('Integrações: antivírus ativo e armazenamento informado', await page.locator('tr:has-text("Antivírus") >> text=Ativa').isVisible() && await page.locator('text=Armazenamento dos arquivos').isVisible());
  await page.screenshot({ path: `${SHOTS}/17-integracoes.png`, fullPage: true });

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

  await page.goto(`${BASE}/tarefas`);
  check('Colaborador: minhas tarefas com rotina e tarefa imediata', await page.locator('text=Verificar centrais eletrônicas').first().isVisible() && await page.locator('text=Conferência de averbação designada').isVisible());
  await page.screenshot({ path: `${SHOTS}/21-minhas-tarefas.png`, fullPage: true });
  await page.goto(`${BASE}/tarefas?visao=nova`);
  check('Colaborador: nova tarefa sem campo de atribuição a terceiros', !(await page.locator('#nova-as').count()));
  await page.fill('#nova-title', 'Separar títulos para conferência (E2E)');
  await page.selectOption('#nova-prio', 'URGENTE');
  await page.click('button:has-text("Criar tarefa")');
  await page.waitForURL(/\/tarefas\/[0-9a-f-]+$/, { timeout: 10000 });
  await page.click('button:has-text("Iniciar")');
  await page.waitForSelector('.tag:has-text("Em andamento")', { timeout: 10000 });
  await page.click('button:has-text("Concluir")');
  await page.waitForSelector('.tag:has-text("Concluída")', { timeout: 10000 });
  check('Colaborador: cria, inicia e conclui a própria tarefa', true);
  const pqta = await page.request.get(`${BASE}/projetos`);
  check('Colaborador não vê projeto da diretoria de que não participa', pqta.ok() && !(await pqta.text()).includes('PQTA-2027'));

  await page.goto(`${BASE}/documentos`);
  check('Colaborador vê documentos do seu público e não vê o confidencial', await page.locator('tbody a:has-text("Código de Ética")').isVisible() && !(await page.locator('tbody a:has-text("Plano de Continuidade")').count()));
  const conf = await page.goto(`${BASE}${pcnHref}`);
  check('Acesso direto a documento confidencial é bloqueado', await page.locator('text=Não foi possível exibir esta página').isVisible(), `HTTP ${conf?.status()}`);
  const confFile = await page.request.get(`${BASE}${pcnHref.replace('/documentos/', '/api/v1/documentos/')}/exportar/00000000-0000-4000-8000-000000000000`);
  check('Exportação de documento confidencial recusada', [403, 404].includes(confFile.status()), `HTTP ${confFile.status()}`);

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
