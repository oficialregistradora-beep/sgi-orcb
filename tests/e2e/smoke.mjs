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

  // 6f. Fase 4b — financeiro gerencial (Oficial)
  await page.goto(`${BASE}/financeiro`);
  check('Financeiro: painel com fluxo de caixa, projeção e custo de pessoal', await page.locator('h2:has-text("Fluxo de caixa gerencial")').isVisible() && await page.locator('h2:has-text("Custo de pessoal")').isVisible());
  check('Financeiro: alerta de contrato próximo do término', await page.locator('text=Locação da sede').first().isVisible());
  await page.screenshot({ path: `${SHOTS}/22-financeiro-painel.png`, fullPage: true });
  await page.click('a:has-text("Manutenção da impressora")');
  await page.waitForURL(/\/financeiro\/despesas\/[0-9a-f-]+$/);
  check('Despesa: pagamento disponível para quem não solicitou nem aprovou', await page.locator('h2:has-text("Registrar pagamento")').isVisible());
  await page.selectOption('select[name=kind]', 'COMPROVANTE');
  await page.setInputFiles('input[name=file]', { name: 'comprovante.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%comprovante E2E\n%%EOF') });
  await page.click('button:has-text("Anexar")');
  await page.waitForSelector('a:has-text("comprovante.pdf")', { timeout: 15000 });
  page.once('dialog', (d) => d.accept());
  await page.click('button:has-text("Registrar pagamento")');
  await page.waitForSelector('.tag:has-text("Paga")', { timeout: 15000 });
  check('Despesa: comprovante anexado e pagamento registrado pela interface', true);
  await page.screenshot({ path: `${SHOTS}/23-despesa-paga.png`, fullPage: true });
  await page.goto(`${BASE}/financeiro?aba=pagar`);
  await page.click('a:has-text("Scanner de mesa")');
  await page.waitForURL(/\/financeiro\/despesas\/[0-9a-f-]+$/);
  check('Compra: cotações com a escolhida destacada', await page.locator('.tag:has-text("Escolhida")').isVisible());
  await page.click('button:has-text("Aprovar")');
  await page.waitForSelector('.tag:has-text("Aprovada")', { timeout: 15000 });
  check('Compra aprovada pela Oficial (não solicitante)', true);
  await page.goto(`${BASE}/financeiro?aba=orcamento`);
  check('Orçamento: previsto × realizado', await page.locator('h2:has-text("Previsto × realizado")').isVisible() && (await page.locator('tbody tr').count()) >= 2);
  const csv = await page.request.get(`${BASE}/api/v1/financeiro/relatorio?de=${new Date().toISOString().slice(0, 7)}&ate=${new Date().toISOString().slice(0, 7)}`);
  check('Relatório CSV exportado como anexo', csv.status() === 200 && /attachment/.test(csv.headers()['content-disposition'] ?? '') && (await csv.text()).includes('Papel A4'));

  // 6g. Fase 4c — agenda e integrações Google
  await page.goto(`${BASE}/agenda`);
  check('Agenda: calendário do mês com plantões e marcos', (await page.locator('.cal [role=gridcell]').count()) === 42 && await page.locator('text=Plantão RCPN').first().isVisible());
  await page.fill('input[name=title]', 'Reunião de planejamento (E2E)');
  await page.fill('input[name=startTime]', '09:00');
  await page.fill('input[name=endTime]', '10:00');
  await page.click('button:has-text("Cadastrar")');
  await page.waitForSelector('text=Reunião: Reunião de planejamento (E2E)', { timeout: 10000 });
  check('Agenda: evento institucional cadastrado', true);
  await page.screenshot({ path: `${SHOTS}/24-agenda.png`, fullPage: true });

  await page.goto(`${BASE}/configuracoes?aba=integracoes`);
  check('Integrações: antivírus ativo e armazenamento informado', await page.locator('tr:has-text("Antivírus") >> text=Ativa').isVisible() && await page.locator('text=Armazenamento dos arquivos').isVisible());
  check('Integrações: escopos do Google registrados na tela', await page.locator('text=https://www.googleapis.com/auth/gmail.send').isVisible() && await page.locator('text=https://www.googleapis.com/auth/calendar.events').isVisible());
  check('Integrações: tudo desligado por padrão', (await page.locator('.tag:has-text("Desligado")').count()) >= 3);
  await page.screenshot({ path: `${SHOTS}/17-integracoes.png`, fullPage: true });

  // 6h. Fase 5a — qualidade e segurança (Oficial)
  await page.goto(`${BASE}/qualidade`);
  check('Qualidade: painel com índice registrado e matrizes de risco', await page.locator('text=Índice de atendimento (registrado)').isVisible() && (await page.locator('.heat').count()) === 2);
  check('Qualidade: alerta de teste de restauração e de vencimento do certificado', await page.locator('.alert:has-text("Teste de restauração em atraso")').isVisible() && await page.locator('text=CERT-A3-01').first().isVisible());
  await page.screenshot({ path: `${SHOTS}/25-qualidade-painel.png`, fullPage: true });
  await page.goto(`${BASE}/qualidade?aba=requisitos`);
  check('Requisitos: exemplos com a fonte indicada', await page.locator('tbody a:has-text("EX-DOC-01")').isVisible() && await page.locator('text=Exemplo fictício — substituir pela fonte oficial').first().isVisible());
  await page.goto(`${BASE}/qualidade?aba=auditorias`);
  await page.click('tbody a:has-text("AUD-")');
  await page.waitForURL(/\/qualidade\/auditorias\/[0-9a-f-]+$/);
  check('Auditoria: NC aberta automaticamente a partir do item', await page.locator('tbody a:has-text("NC-")').isVisible());
  const pendingRow = page.locator('tr:has-text("Protocolo conferido diariamente")');
  await pendingRow.locator('summary').click();
  await pendingRow.locator('textarea[name=evidence]').fill('Livro de protocolo conferido na amostra (E2E)');
  await pendingRow.locator('button:has-text("Registrar")').click();
  await page.waitForSelector('tr:has-text("Protocolo conferido diariamente") >> .tag:has-text("Conforme")', { timeout: 15000 });
  await page.fill('textarea[name=conclusion]', 'Auditoria concluída com uma não conformidade (E2E).');
  page.once('dialog', (d) => d.accept());
  await page.click('button:has-text("Concluir")');
  await page.waitForSelector('.tag:has-text("Concluída")', { timeout: 15000 });
  check('Auditoria: item avaliado e auditoria concluída pela interface', true);
  await page.screenshot({ path: `${SHOTS}/26-auditoria.png`, fullPage: true });
  await page.click('tbody a:has-text("NC-")');
  await page.waitForURL(/\/qualidade\/nc\/[0-9a-f-]+$/);
  check('NC: ação corretiva vinculada como tarefa', await page.locator('tbody a:has-text("Ação corretiva: Cobrar ciência")').isVisible());
  await page.goto(`${BASE}/qualidade?aba=riscos`);
  check('Riscos: classificação pela matriz', await page.locator('text=3×4 = 12 · Alto').isVisible());
  await page.goto(`${BASE}/qualidade?aba=backups`);
  check('Backups: sistema sem teste de restauração aparece em atraso', await page.locator('tr:has-text("Arquivos digitalizados") >> text=Teste em atraso').isVisible());
  await page.goto(`${BASE}/qualidade/incidentes`);
  check('Incidentes: pendência de avaliação LGPD destacada', await page.locator('text=avaliação LGPD pendente').first().isVisible());
  await page.screenshot({ path: `${SHOTS}/27-incidentes.png`, fullPage: true });

  // 6i. Fase 5b — treinamentos, avaliações, automações e painel configurável (Oficial)
  await page.goto(`${BASE}/treinamentos?aba=equipe`);
  check('Treinamentos: matriz de capacitação com vencido destacado', await page.locator('th:has-text("LGPD-01")').isVisible() && (await page.locator('.tag:has-text("Vencido")').count()) >= 1);
  await page.screenshot({ path: `${SHOTS}/29-matriz-capacitacao.png`, fullPage: true });
  await page.goto(`${BASE}/treinamentos?aba=catalogo`);
  await page.click('tbody a:has-text("LGPD-01")');
  await page.waitForURL(/\/treinamentos\/[0-9a-f-]+$/);
  check('Treinamento: turma planejada com inscritos', await page.locator('h2:has-text("Turmas")').isVisible() && await page.locator('text=Sala de reuniões').first().isVisible());
  await page.goto(`${BASE}/agenda`);
  check('Agenda: turma de treinamento no calendário', (await page.locator('text=Treinamento: LGPD').count()) >= 1);
  await page.goto(`${BASE}/avaliacoes?aba=modelos`);
  check('Avaliações: modelos publicados com critérios e pesos', await page.locator('text=Acompanhamento do período de experiência').first().isVisible() && await page.locator('text=Qualidade técnica (peso 2)').first().isVisible());
  await page.goto(`${BASE}/avaliacoes?aba=programacao`);
  check('Avaliações: programação 30/60/90 dias', await page.locator('td:has-text("Acompanhamento 90 dias")').isVisible());
  await page.goto(`${BASE}/automacoes`);
  check('Automações: regras cadastradas', await page.locator('td:has-text("Avisar tarefas atrasadas há 2 dias")').isVisible());
  await page.locator('tr:has-text("Avisar tarefas atrasadas") button:has-text("Executar agora")').click();
  await page.waitForSelector('text=Executado:', { timeout: 15000 });
  check('Automações: execução manual pela tela', true);
  await page.screenshot({ path: `${SHOTS}/30-automacoes.png`, fullPage: true });
  await page.goto(`${BASE}/painel`);
  await page.click('summary:has-text("Personalizar painel")');
  await page.locator('label:has-text("Visão da administração") input[type=checkbox]').uncheck();
  await page.click('button:has-text("Salvar painel")');
  await page.waitForSelector('text=Painel personalizado.', { timeout: 15000 });
  await page.goto(`${BASE}/painel`);
  check('Painel configurável: bloco removido pela pessoa', !(await page.locator('h2:has-text("Visão da administração")').count()) && await page.locator('text=Capacitação obrigatória da equipe em dia').isVisible());
  await page.click('summary:has-text("Personalizar painel")');
  await page.click('button:has-text("Restaurar padrão")');
  await page.waitForSelector('text=Painel restaurado ao padrão.', { timeout: 15000 });

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

  await page.goto(`${BASE}/agenda`);
  check('Colaborador: agenda visível sem cadastro de eventos', await page.locator('h1:has-text("Agenda")').isVisible() && !(await page.locator('h2:has-text("Novo evento institucional")').count()));
  check('Colaborador não vê o menu Financeiro', !(await page.locator('nav >> text=Financeiro').count()));
  await page.goto(`${BASE}/financeiro`);
  check('Colaborador sem acesso ao financeiro', await page.locator('text=não tem acesso ao módulo financeiro').isVisible());
  const finFile = await page.request.get(`${BASE}/api/v1/financeiro/relatorio?de=2026-01&ate=2026-12`);
  check('Colaborador não exporta relatório financeiro', [403, 404].includes(finFile.status()), `HTTP ${finFile.status()}`);

  await page.goto(`${BASE}/documentos`);
  check('Colaborador vê documentos do seu público e não vê o confidencial', await page.locator('tbody a:has-text("Código de Ética")').isVisible() && !(await page.locator('tbody a:has-text("Plano de Continuidade")').count()));
  const conf = await page.goto(`${BASE}${pcnHref}`);
  check('Acesso direto a documento confidencial é bloqueado', await page.locator('text=Não foi possível exibir esta página').isVisible(), `HTTP ${conf?.status()}`);
  const confFile = await page.request.get(`${BASE}${pcnHref.replace('/documentos/', '/api/v1/documentos/')}/exportar/00000000-0000-4000-8000-000000000000`);
  check('Exportação de documento confidencial recusada', [403, 404].includes(confFile.status()), `HTTP ${confFile.status()}`);

  await page.goto(`${BASE}/qualidade/incidentes`);
  check('Colaborador vê o incidente que comunicou', await page.locator('tbody a:has-text("INC-")').isVisible());
  const q = await page.goto(`${BASE}/qualidade`);
  check('Colaborador sem acesso à qualidade é levado à comunicação de incidentes', page.url().endsWith('/qualidade/incidentes'), `HTTP ${q?.status()}`);
  const qFile = await page.request.get(`${BASE}/api/v1/qualidade/arquivos/00000000-0000-4000-8000-000000000000`);
  check('Colaborador não baixa evidências da qualidade', [403, 404].includes(qFile.status()), `HTTP ${qFile.status()}`);

  await page.goto(`${BASE}/treinamentos`);
  check('Colaborador: meus treinamentos com situação e certificado em validação', await page.locator('tr:has-text("LGPD-01") >> .tag:has-text("Válido")').isVisible() && await page.locator('text=certificado em validação').isVisible());
  await page.goto(`${BASE}/avaliacoes`);
  await page.click('tbody a:has-text("Acompanhamento 90 dias")');
  await page.waitForURL(/\/avaliacoes\/[0-9a-f-]+$/);
  check('Avaliação: avaliado vê notas, feedback e PDI enviados', await page.locator('text=Resultado ponderado').isVisible() && await page.locator('text=Cumprir os prazos de qualificação').first().isVisible());
  await page.fill('textarea[name=comment]', 'Recebi a avaliação (E2E).');
  await page.check('input[name=confirmed]');
  await page.click('button:has-text("Registrar manifestação")');
  await page.waitForSelector('text=Ciência de', { timeout: 15000 });
  check('Avaliação: ciência registrada pelo avaliado (sem concordância obrigatória)', await page.locator('text=não implica concordância').first().isVisible());
  await page.screenshot({ path: `${SHOTS}/31-avaliacao-ciencia.png`, fullPage: true });
  await page.goto(`${BASE}/avaliacoes/00000000-0000-4000-8000-000000000000`);
  check('Colaborador não acessa avaliação inexistente/alheia', await page.locator('text=Não foi possível exibir esta página').isVisible());
  check('Colaborador não vê o menu Automações', !(await page.locator('nav >> text=Automações').count()));

  // 8. Celular: sem rolagem horizontal
  await page.context().close();
  page = await newPage({ width: 390, height: 844 });
  await loginAs(page, 'Gabriela');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('Painel em 390 px sem rolagem horizontal', overflow <= 0, `excesso ${overflow}px`);
  await page.screenshot({ path: `${SHOTS}/09-painel-celular.png`, fullPage: true });

  check('Menu do colaborador oferece “Comunicar incidente”', (await page.locator('nav >> text=Comunicar incidente').count()) > 0);
  await page.goto(`${BASE}/qualidade/incidentes`);
  await page.fill('input[name=title]', 'Impressora do balcão sem conexão (E2E)');
  await page.selectOption('select[name=category]', 'INDISPONIBILIDADE');
  await page.fill('textarea[name=description]', 'A impressora parou de responder durante o atendimento.');
  await page.click('button:has-text("Comunicar")');
  await page.waitForURL(/\/qualidade\/incidentes\/[0-9a-f-]+$/, { timeout: 15000 });
  const incOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('Celular: colaboradora comunica incidente (sem rolagem horizontal)', incOverflow <= 0 && await page.locator('h1:has-text("INC-")').isVisible(), `excesso ${incOverflow}px`);
  await page.screenshot({ path: `${SHOTS}/28-incidente-celular.png`, fullPage: true });

  check('Nenhuma violação de CSP no console', cspViolations.length === 0, cspViolations.slice(0, 2).join(' | '));
} catch (err) {
  check('Execução sem exceções', false, String(err).slice(0, 300));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} verificações aprovadas.`);
process.exitCode = failed ? 1 : 0;
