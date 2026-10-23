// Carga de dados FICTÍCIOS para desenvolvimento e homologação. Nenhum dado real é utilizado.
// Uso: npm run db:seed   (recusa executar em produção ou em banco que já tenha usuários)

import { getConfig } from '../src/server/config.ts';
import { closePool, getPool, query, queryOne } from '../src/server/db.ts';
import { ensureProcessedAll } from '../src/server/modules/timeclock.ts';
import { createSession, markMfaVerified } from '../src/server/auth/session.ts';
import { loadPrincipal } from '../src/server/authz.ts';
import type { Ctx } from '../src/server/context.ts';
import { createDocument, decideVersion, saveDraft, submitForApproval } from '../src/server/modules/repository.ts';
import { addChecklistItem, createTask, escalate, setStatus } from '../src/server/modules/tasks.ts';
import { addMilestone, addPhase, createProject, saveIndicator, setMember } from '../src/server/modules/projects.ts';
import { generateRoutineTasks, saveProcessTemplate, saveRoutine, startProcess } from '../src/server/modules/routines.ts';
import {
  addFinanceAttachment, addQuote, addRevenue, chooseQuote, decideExpense, generateContractExpenses, listFinanceCategories, registerPayment, requestExpense, saveContract,
  saveCostCenter, saveSupplier, setBudget,
} from '../src/server/modules/finance.ts';
import { addAction, addRequirementEvidence, createAudit, evaluateAuditItem, reviewRequirement, saveRequirement, saveRisk, setRootCause, startAudit } from '../src/server/modules/quality.ts';
import { recordBackup, registerVulnerability, reportIncident, saveAsset, treatIncident } from '../src/server/modules/security.ts';
import { completePopStudy, createSession as createTrainingSession, registerCompletion, saveTraining, selfDeclare, setQuestions, submitAttempt } from '../src/server/modules/training.ts';
import { addPdiItem, createEvaluation, publishTemplate, saveAssessment, saveSchedule, saveTemplate, sendForAcknowledgement, listTemplates } from '../src/server/modules/evaluations.ts';
import { saveRule } from '../src/server/modules/automation.ts';
import { addDays, localToInstant, todayLocal, weekdayOf, formatHHMM } from '../src/domain/time.ts';

const cfg = getConfig();
if (cfg.appEnv === 'producao') throw new Error('Seed proibido em produção.');
const db = getPool();
const existing = await queryOne<{ n: number }>(db, 'SELECT count(*)::int AS n FROM users');
if (existing!.n > 0) {
  console.log('Banco já possui usuários; seed não executado.');
  await closePool();
  process.exit(0);
}

// Gerador pseudoaleatório determinístico (mulberry32) — cenários reproduzíveis.
let state = 20261022;
function rand(): number {
  state |= 0; state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const jitter = (max: number) => Math.round((rand() * 2 - 1) * max);

const id = async (sql: string, p: unknown[] = []) => (await queryOne<{ id: string }>(db, sql, p))!.id;
const sector = (code: string) => id('SELECT id FROM sectors WHERE code = $1', [code]);
const job = (name: string) => id('SELECT id FROM job_titles WHERE name = $1', [name]);
const role = (code: string) => id('SELECT id FROM roles WHERE code = $1', [code]);
const schedule = await id('SELECT id FROM work_schedules LIMIT 1');
const today = todayLocal();
const admission = addDays(today, -95);

type Person = { name: string; local: string; sector: string; job: string; roles: [string, string?][]; owner?: boolean; agreement?: boolean; profile: 'pontual' | 'extras' | 'atrasos' | 'esquecido' };
const people: Person[] = [
  { name: 'Helena Martins (fictícia)', local: 'oficial', sector: 'DIR', job: 'Oficial Registradora', roles: [['OFICIAL']], owner: true, profile: 'pontual' },
  { name: 'Beatriz Souza (fictícia)', local: 'substituta', sector: 'DIR', job: 'Substituta Legal', roles: [['SUBSTITUTA_LEGAL'], ['COLABORADOR']], agreement: true, profile: 'extras' },
  { name: 'Camila Ramos (fictícia)', local: 'camila.ramos', sector: 'RI', job: 'Escrevente Substituta', roles: [['COORDENACAO_SETOR'], ['COLABORADOR']], agreement: true, profile: 'pontual' },
  { name: 'Diego Alves (fictício)', local: 'diego.alves', sector: 'RI', job: 'Escrevente Autorizado', roles: [['COLABORADOR']], agreement: true, profile: 'extras' },
  { name: 'Eduarda Lima (fictícia)', local: 'eduarda.lima', sector: 'RCPN', job: 'Escrevente Autorizado', roles: [['COLABORADOR']], agreement: true, profile: 'pontual' },
  { name: 'Fábio Nunes (fictício)', local: 'fabio.nunes', sector: 'RTDPJ', job: 'Escrevente Autorizado', roles: [['COLABORADOR']], agreement: true, profile: 'esquecido' },
  { name: 'Gabriela Rocha (fictícia)', local: 'gabriela.rocha', sector: 'ATD', job: 'Atendente', roles: [['COLABORADOR']], agreement: true, profile: 'atrasos' },
  { name: 'Henrique Dias (fictício)', local: 'henrique.dias', sector: 'ATD', job: 'Atendente', roles: [['COLABORADOR']], agreement: false, profile: 'pontual' },
  { name: 'Isabel Costa (fictícia)', local: 'isabel.costa', sector: 'DIR', job: 'Auxiliar de Serviços Gerais', roles: [['COLABORADOR']], agreement: true, profile: 'pontual' },
];

let ownerId = '';
let seq = 0;
const holidays = new Set((await query<{ date: string }>(db, 'SELECT date FROM holidays WHERE is_day_off')).map((h) => h.date));

for (const p of people) {
  seq += 1;
  const userId = await id('INSERT INTO users (email, display_name, is_owner) VALUES ($1,$2,$3) RETURNING id', [`${p.local}@${cfg.workspaceDomain}`, p.name, !!p.owner]);
  if (p.owner) ownerId = userId;
  const employeeId = await id(
    `INSERT INTO employees (user_id, registration_code, full_name, job_title_id, sector_id, admission_date, contract_type, weekly_hours, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'CLT',40,$7) RETURNING id`,
    [userId, `F${String(seq).padStart(3, '0')}`, p.name, await job(p.job), await sector(p.sector), admission, ownerId || userId],
  );
  await query(db, `INSERT INTO job_history (employee_id, job_title_id, sector_id, start_date, reason) VALUES ($1,$2,$3,$4,'Admissão (dado fictício)')`, [
    employeeId, await job(p.job), await sector(p.sector), admission,
  ]);
  for (const [code] of p.roles) {
    await query(db, "INSERT INTO user_roles (user_id, role_id, valid_from, reason) VALUES ($1,$2,$3,'Carga inicial de homologação')", [userId, await role(code), admission]);
  }
  await query(db, 'INSERT INTO employee_schedules (employee_id, schedule_id, valid_from) VALUES ($1,$2,$3)', [employeeId, schedule, admission]);
  if (p.agreement) {
    await query(db, `INSERT INTO hour_bank_agreements (employee_id, kind, compensation_months, valid_from, document_reference)
                     VALUES ($1,'INDIVIDUAL_ESCRITO',6,$2,'Acordo individual fictício nº ${seq}/2026')`, [employeeId, admission]);
  }
  // Uma ausência abonada por pessoa (férias ou atestado) para variar o cenário.
  const absStart = addDays(admission, 20 + seq * 5);
  if (seq % 3 === 0) await query(db, "INSERT INTO absences (employee_id, type, start_date, end_date, notes) VALUES ($1,'FERIAS',$2,$3,'Férias (fictício)')", [employeeId, absStart, addDays(absStart, 9)]);
  if (seq % 4 === 1) await query(db, "INSERT INTO absences (employee_id, type, start_date, end_date, notes) VALUES ($1,'ATESTADO_MEDICO',$2,$2,'Atestado (fictício)')", [employeeId, addDays(absStart, 30)]);
  const absences = await query<{ start_date: string; end_date: string }>(db, 'SELECT start_date, end_date FROM absences WHERE employee_id = $1', [employeeId]);

  for (let d = admission; d < today; d = addDays(d, 1)) {
    const wd = weekdayOf(d);
    if (wd === 0 || wd === 6 || holidays.has(d) || absences.some((a) => a.start_date <= d && a.end_date >= d)) continue;
    let marks = [480 + jitter(4), 720 + jitter(3), 780 + jitter(3), 1020 + jitter(4)];
    const r = rand();
    if (p.profile === 'extras' && r < 0.18) marks[3] = 1020 + 30 + Math.round(rand() * 60);
    if (p.profile === 'atrasos' && r < 0.15) marks[0] = 480 + 15 + Math.round(rand() * 30);
    if (p.profile === 'esquecido' && r < 0.08) marks = marks.slice(0, 3);
    if (r > 0.985) marks[3] = 1020 + 45; // extras ocasionais para todos
    for (const m of marks) {
      await query(db, `INSERT INTO time_punches (employee_id, punched_at, local_date, kind, source, created_by) VALUES ($1,$2,$3,'ADICIONAL','IMPORTACAO',$4)`, [
        employeeId, localToInstant(d, formatHHMM(m)), d, userId,
      ]);
    }
  }
  console.log(`✓ ${p.name} (${p.local}@${cfg.workspaceDomain})`);
}

// Plantões RCPN fictícios das últimas 6 semanas (rodízio), com alguns chamados — deixados abertos para o roteiro de fechamento.
const rotation = await query<{ id: string }>(db, `SELECT e.id FROM employees e JOIN users u ON u.id = e.user_id
  WHERE split_part(u.email, '@', 1) IN ('eduarda.lima', 'diego.alves', 'fabio.nunes') ORDER BY e.full_name`);
let k = 0;
for (let d = addDays(today, -42); d < today; d = addDays(d, 1)) {
  const wd = weekdayOf(d);
  if (wd !== 0 && wd !== 6 && !holidays.has(d)) continue;
  const resp = rotation[k % rotation.length]!.id;
  const sub = rotation[(k + 1) % rotation.length]!.id;
  k++;
  const shift = await id(`INSERT INTO oncall_shifts (shift_date, starts_at, ends_at, employee_id, substitute_employee_id, created_by)
                          VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [d, localToInstant(d, '08:00'), localToInstant(d, '18:00'), resp, sub, ownerId]);
  if (rand() < 0.5) {
    const h = 9 + Math.floor(rand() * 6);
    const attended = rand() < 0.6;
    await query(db, `INSERT INTO oncall_calls (shift_id, called_at, responded_at, attended, arrival_at, departure_at, description, registered_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      shift, localToInstant(d, formatHHMM(h * 60)), localToInstant(d, formatHHMM(h * 60 + 5)), attended,
      attended ? localToInstant(d, formatHHMM(h * 60 + 30)) : null, attended ? localToInstant(d, formatHHMM(h * 60 + 90)) : null,
      attended ? 'Registro de óbito (fictício)' : 'Orientação por telefone (fictício)', ownerId,
    ]);
  }
}
console.log(`✓ ${k} plantões RCPN fictícios`);

await query(db, `INSERT INTO audit_log (actor_user_id, action, entity_type, summary, prev_hash, hash) VALUES ($1,'CARGA_HOMOLOGACAO','sistema','Carga de dados fictícios de homologação','','')`, [ownerId]);
// Documentos institucionais fictícios, criados pelos próprios serviços (com versões, aprovações e assinaturas).
async function seedCtx(local: string): Promise<Ctx> {
  const u = await id('SELECT id FROM users WHERE email = $1', [`${local}@${cfg.workspaceDomain}`]);
  const { sessionId } = await createSession(db, u, 'DEV', '127.0.0.1', 'seed');
  await markMfaVerified(db, sessionId);
  await query(db, 'UPDATE sessions SET step_up_at = now() WHERE id = $1', [sessionId]);
  return { principal: (await loadPrincipal(db, u))!, sessionId, authMethod: 'DEV', mfaVerifiedAt: new Date(), stepUpAt: new Date(), ip: '127.0.0.1', userAgent: 'seed' };
}
const [cHelena, cBeatriz, cCamila] = [await seedCtx('oficial'), await seedCtx('substituta'), await seedCtx('camila.ramos')];
const cat = (code: string) => id('SELECT id FROM document_categories WHERE code = $1', [code]);
async function publish(author: Ctx, approver: Ctx, meta: Parameters<typeof createDocument>[1], texto: string): Promise<string> {
  const docId = await createDocument(author, meta);
  await saveDraft(author, docId, { texto, notaVersao: 'Versão inicial' });
  const v = await submitForApproval(author, docId);
  await decideVersion(approver, docId, { versionId: v, decision: 'APROVADA', confirmed: true, notes: 'Conferido (fictício).' });
  return docId;
}
await publish(cBeatriz, cHelena, { categoryId: await cat('CODIGO_ETICA'), title: 'Código de Ética (modelo fictício)', code: 'CE-001', sectorId: await sector('DIR'),
  audienceType: 'TODOS', requiresAcknowledgement: true, summary: 'Texto fictício para homologação.' },
  '1. Atender com urbanidade e imparcialidade.\n2. Preservar o sigilo das informações.\n3. Comunicar conflitos de interesse à Oficial.\n(Conteúdo fictício de homologação.)');
const pop = await publish(cCamila, cBeatriz, { categoryId: await cat('POP'), title: 'POP — Prenotação de títulos (fictício)', code: 'POP-RI-001', sectorId: await sector('RI'),
  audienceType: 'SETORES', audienceSectorIds: [await sector('RI')], requiresAcknowledgement: true },
  '1. Receber o título e conferir os requisitos formais.\n2. Lançar no protocolo.\n3. Observar os prazos de qualificação.\n(Conteúdo fictício.)');
await saveDraft(cCamila, pop, { texto: '1. Receber o título.\n2. Lançar no protocolo.\n3. Observar os prazos.\n4. Comunicar exigências.\n(Conteúdo fictício.)', notaVersao: 'Inclusão do passo 4' });
await submitForApproval(cCamila, pop);
const psi = await createDocument(cBeatriz, { categoryId: await cat('PSI'), title: 'Política de Segurança da Informação (rascunho fictício)', code: 'PSI-001',
  sectorId: await sector('DIR'), audienceType: 'TODOS', requiresAcknowledgement: true });
await saveDraft(cBeatriz, psi, { texto: 'Em elaboração (fictício).', notaVersao: '' });
await publish(cBeatriz, cHelena, { categoryId: await cat('PCN'), title: 'Plano de Continuidade de Negócios (fictício)', code: 'PCN-001', sectorId: await sector('DIR'),
  confidentiality: 'CONFIDENCIAL', audienceType: 'USUARIOS', audienceUserIds: [cHelena.principal.userId, cBeatriz.principal.userId] },
  'Contatos de contingência e procedimentos (fictícios).');
console.log('✓ 4 documentos institucionais fictícios');

// Tarefas, projetos, rotinas e processos fictícios (Fase 4a).
const cDiego = await seedCtx('diego.alves');
const uid = (c: Ctx) => c.principal.userId;
const ri = await sector('RI');
await saveRoutine(cBeatriz, { name: 'Verificar centrais eletrônicas', area: 'RI', sectorId: ri, assigneeUserId: uid(cDiego), frequency: 'DIARIA', times: [540, 660, 840, 960], priority: 'ALTA', startsOn: addDays(today, -7) });
await saveRoutine(cBeatriz, { name: 'Notificações e matrículas eletrônicas', area: 'RI', sectorId: ri, frequency: 'DIARIA', priority: 'URGENTE', blockStart: 960, blockEnd: 1020, startsOn: addDays(today, -7) });
await saveRoutine(cBeatriz, { name: 'Conferir cópias de segurança (backup)', area: 'ADMINISTRACAO', sectorId: await sector('DIR'), assigneeUserId: uid(cBeatriz), frequency: 'SEMANAL', weekdays: [1], priority: 'MEDIA', startsOn: addDays(today, -7) });
await saveRoutine(cBeatriz, { name: 'Fechamento mensal do banco de horas', area: 'PESSOAL', sectorId: await sector('DIR'), assigneeUserId: uid(cBeatriz), frequency: 'MENSAL', monthDay: 5, priority: 'ALTA', startsOn: addDays(today, -40) });
await generateRoutineTasks(addDays(today, -2), addDays(today, 1));
const pops = await createProject(cCamila, { name: 'Implantação dos POPs (fictício)', code: 'POPS-2026', sectorId: ri, startDate: addDays(today, -20), dueDate: addDays(today, 70), estimatedCost: 1200 });
await setMember(cCamila, pops, uid(cDiego), 'MEMBRO');
const ph1 = await addPhase(cCamila, pops, { name: 'Levantamento', startDate: addDays(today, -20), dueDate: addDays(today, 5) });
const ph2 = await addPhase(cCamila, pops, { name: 'Redação e aprovação', startDate: addDays(today, 6), dueDate: addDays(today, 60) });
await addMilestone(cCamila, pops, { title: 'POPs do RI aprovados', dueDate: addDays(today, 45) });
await saveIndicator(cCamila, pops, { name: 'POPs publicados', unit: 'un', target: 8, current: 1 });
const t1 = await createTask(cCamila, { title: 'Mapear rotina de prenotação', projectId: pops, phaseId: ph1, assigneeUserId: uid(cDiego), startDate: addDays(today, -15), dueDate: addDays(today, -1), priority: 'ALTA' });
await addChecklistItem(cDiego, t1, 'Entrevistar escreventes');
await setStatus(cDiego, t1, 'EM_ANDAMENTO');
await createTask(cCamila, { title: 'Redigir POP de registro de imóveis', projectId: pops, phaseId: ph2, assigneeUserId: uid(cCamila), startDate: addDays(today, 6), dueDate: addDays(today, 30), requiresApproval: true, approverUserId: uid(cBeatriz) });
await createProject(cHelena, { name: 'Preparação para o PQTA 2027 (fictício)', code: 'PQTA-2027', sectorId: await sector('DIR'), startDate: today, dueDate: addDays(today, 300) });
const duvida = await createTask(cDiego, { title: 'Dúvida sobre cálculo de emolumentos (fictício)', priority: 'MEDIA', dueDate: today });
await escalate(cDiego, duvida, 'SUBSTITUTA', 'Questão ordinária: confirmar tabela aplicável (fictício)');
await createTask(cDiego, { title: 'Conferência de averbação designada', priority: 'IMEDIATA', dueDate: today });
const tpl = await saveProcessTemplate(cBeatriz, { name: 'Admissão — rotina administrativa (modelo fictício)', sectorId: await sector('DIR'), steps: [
  { title: 'Coletar documentos', slaDays: 2, requiredDocuments: 'Documentos pessoais (fictício)' },
  { title: 'Cadastrar no sistema', slaDays: 1 },
  { title: 'Conferir cadastro', slaDays: 1, requiresApproval: true },
] });
await startProcess(cBeatriz, tpl, 'Admissão — Pessoa Fictícia');
console.log('✓ rotinas, projetos, tarefas e processo fictícios');

// Financeiro gerencial fictício (Fase 4b). Segregação: Camila solicita, Beatriz aprova, Helena paga.
const fcat = Object.fromEntries((await listFinanceCategories()).map((c) => [c.code, c.id]));
const ccRI = await saveCostCenter(cBeatriz, { code: 'RI', name: 'Registro de Imóveis', sectorId: ri, active: true });
const ccADM = await saveCostCenter(cBeatriz, { code: 'ADM', name: 'Administração', sectorId: await sector('DIR'), active: true });
await saveCostCenter(cBeatriz, { code: 'ATD', name: 'Atendimento', sectorId: await sector('ATD'), active: true });
const forn1 = await saveSupplier(cBeatriz, { name: 'Imobiliária Fictícia Ltda', document: '11.222.333/0001-81' });
const forn2 = await saveSupplier(cBeatriz, { name: 'Papelaria Exemplo Ltda', document: '45.723.174/0001-10' });
const ym = today.slice(0, 7);
const year = Number(ym.slice(0, 4));
await saveContract(cBeatriz, { supplierId: forn1, object: 'Locação da sede (fictício)', costCenterId: ccADM, categoryId: fcat.ALUGUEL!, startDate: addDays(today, -300),
  endDate: addDays(today, 45), monthlyCents: 420000, dueDay: 10, readjustment: 'Índice previsto no contrato (fictício)', noticeDays: 60 });
await setBudget(cBeatriz, { year, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], costCenterId: ccADM, categoryId: fcat.ALUGUEL!, amountCents: 420000 });
await setBudget(cBeatriz, { year, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], costCenterId: ccRI, categoryId: fcat.MATERIAL!, amountCents: 80000 });
await generateContractExpenses(cBeatriz, ym);
const PDF = (t: string) => ({ name: `${t}.pdf`, bytes: new TextEncoder().encode(`%PDF-1.4\n%${t} (fictício)\n%%EOF`) });
const paid = await requestExpense(cCamila, { kind: 'VARIAVEL', description: 'Papel A4 e toner (fictício)', supplierId: forn2, costCenterId: ccRI, categoryId: fcat.MATERIAL!, amountCents: 45990, competence: ym, dueDate: today });
await decideExpense(cBeatriz, paid, true);
await addFinanceAttachment(cHelena, { expenseId: paid }, 'COMPROVANTE', PDF('comprovante'));
await registerPayment(cHelena, paid, { paidOn: today, amountCents: 45990, method: 'PIX', reference: 'FICT-0001' });
const toPay = await requestExpense(cCamila, { kind: 'VARIAVEL', description: 'Manutenção da impressora (fictício)', supplierId: forn2, costCenterId: ccRI, categoryId: fcat.MANUTENCAO!, amountCents: 32000, competence: ym, dueDate: addDays(today, 3) });
await decideExpense(cBeatriz, toPay, true);
const compra = await requestExpense(cCamila, { kind: 'COMPRA', description: 'Scanner de mesa (fictício)', justification: 'Digitalização administrativa', projectId: pops, costCenterId: ccRI, categoryId: fcat.EQUIPAMENTOS!, amountCents: 300000, competence: ym, dueDate: addDays(today, 20) });
await addQuote(cCamila, compra, { supplierName: 'Loja A (fictícia)', amountCents: 289000 });
await addQuote(cCamila, compra, { supplierName: 'Loja B (fictícia)', amountCents: 305000 });
const quotes = await query<{ id: string }>(db, 'SELECT id FROM expense_quotes WHERE expense_id = $1 ORDER BY amount LIMIT 1', [compra]);
await chooseQuote(cCamila, quotes[0]!.id);
await addRevenue(cHelena, { competence: ym, receivedOn: today, categoryId: fcat.RECEITA_EMOL!, description: 'Receitas do período (valor fictício)', amountCents: 2500000 });
console.log('✓ financeiro fictício (centros, fornecedores, contrato, orçamento, despesas, compra, receita)');

// Qualidade e segurança fictícias (Fase 5a). Requisitos são EXEMPLOS — a serventia cadastra os reais a partir das fontes oficiais.
const reqA = await saveRequirement(cBeatriz, { code: 'EX-DOC-01', title: 'Procedimentos operacionais documentados e vigentes (exemplo)', source: 'Exemplo fictício — substituir pela fonte oficial', area: 'Gestão documental', ownerUserId: uid(cCamila) });
await saveRequirement(cBeatriz, { code: 'EX-DOC-02', title: 'Ciência dos colaboradores sobre os procedimentos (exemplo)', source: 'Exemplo fictício — substituir pela fonte oficial', area: 'Gestão documental', ownerUserId: uid(cCamila) });
await saveRequirement(cBeatriz, { code: 'EX-SI-01', title: 'Cópias de segurança testadas periodicamente (exemplo)', source: 'Exemplo fictício — substituir pela fonte oficial', area: 'Segurança da informação', ownerUserId: uid(cBeatriz) });
await addRequirementEvidence(cCamila, reqA, { description: 'POP de prenotação vigente', documentId: pop });
await reviewRequirement(cCamila, reqA, 'PARCIAL', 'Faltam POPs de outros setores (fictício).');
const aud = await createAudit(cBeatriz, { title: 'Auditoria interna de documentação — RI (fictícia)', kind: 'DOCUMENTAL', scope: 'POPs e ciência no setor de RI', auditedSectorId: ri,
  leadAuditorId: uid(cBeatriz), plannedDate: today, importArea: 'Gestão documental', questions: ['Protocolo conferido diariamente?'] });
await startAudit(cBeatriz, aud);
const items = await query<{ id: string; position: number }>(db, 'SELECT id, position FROM audit_items WHERE audit_id = $1 ORDER BY position', [aud]);
await evaluateAuditItem(cBeatriz, { itemId: items[0]!.id, result: 'CONFORME', evidence: 'POP-RI-001 vigente' });
await evaluateAuditItem(cBeatriz, { itemId: items[1]!.id, result: 'NAO_CONFORME', evidence: '2 de 3 colaboradores sem ciência registrada (fictício)', ncResponsibleId: uid(cCamila) });
const ncId = (await queryOne<{ id: string }>(db, 'SELECT id FROM nonconformities ORDER BY created_at DESC LIMIT 1'))!.id;
await setRootCause(cCamila, ncId, 'Ciência não acompanhada após publicação (fictício).');
await addAction(cCamila, { kind: 'CORRETIVA', ncId, title: 'Cobrar ciência pendente do POP', responsibleUserId: uid(cDiego), dueDate: addDays(today, 5) });
await saveRisk(cBeatriz, { title: 'Perda de dados por falha de backup (fictício)', category: 'CONTINUIDADE', probability: 2, impact: 5, treatment: 'MITIGAR', controls: 'Backup diário e teste trimestral', residualProbability: 1, residualImpact: 5, ownerUserId: uid(cBeatriz) });
await saveRisk(cBeatriz, { title: 'Acesso indevido a dados pessoais no balcão (fictício)', category: 'DADOS_PESSOAIS', probability: 3, impact: 4, treatment: 'MITIGAR', controls: 'Bloqueio de tela, PSI', ownerUserId: uid(cBeatriz) });
await saveRisk(cBeatriz, { title: 'Indisponibilidade de internet (fictício)', category: 'OPERACIONAL', probability: 3, impact: 2, treatment: 'ACEITAR', ownerUserId: uid(cBeatriz) });
const srv = await saveAsset(cBeatriz, { tag: 'PAT-0001', name: 'Servidor de arquivos (fictício)', kind: 'SERVIDOR', location: 'Sala técnica', sectorId: await sector('DIR'), criticality: 'ALTA', warrantyUntil: addDays(today, 40) });
await saveAsset(cBeatriz, { tag: 'CERT-A3-01', name: 'Certificado digital A3 da Oficial (fictício)', kind: 'CERTIFICADO_DIGITAL', responsibleUserId: uid(cHelena), criticality: 'ALTA', expiresOn: addDays(today, 25) });
await saveAsset(cBeatriz, { tag: 'PAT-0002', name: 'Computador do balcão 1 (fictício)', kind: 'COMPUTADOR', location: 'Atendimento', sectorId: await sector('ATD') });
await recordBackup(cBeatriz, { kind: 'BACKUP', system: 'SGI', performedOn: today, result: 'SUCESSO' });
await recordBackup(cBeatriz, { kind: 'TESTE_RESTAURACAO', system: 'SGI', performedOn: addDays(today, -30), result: 'SUCESSO', notes: 'Restauração em ambiente isolado' });
await recordBackup(cBeatriz, { kind: 'BACKUP', system: 'Arquivos digitalizados', performedOn: addDays(today, -1), result: 'PARCIAL', notes: 'Pasta de rede indisponível (fictício)' });
await registerVulnerability(cBeatriz, { title: 'Atualização de segurança pendente do sistema operacional (fictício)', source: 'Boletim do fabricante', assetId: srv, severity: 'ALTA', detectedOn: addDays(today, -3) });
const inc = await reportIncident(cDiego, { title: 'E-mail com anexo suspeito aberto (fictício)', description: 'Colaborador abriu anexo de remetente desconhecido (fictício).', category: 'SEGURANCA_INFORMACAO',
  severity: 'MEDIA', detectedAt: new Date(), personalDataInvolved: true });
await treatIncident(cBeatriz, inc, { containment: 'Máquina isolada da rede e varredura executada.' });
console.log('✓ qualidade e segurança fictícias (requisitos-exemplo, auditoria, NC, riscos, ativos, backups, vulnerabilidade, incidente)');

// Treinamentos, avaliações e automações fictícios (Fase 5b).
const cGabriela = await seedCtx('gabriela.rocha');
const empOf = async (c: Ctx) => c.principal.employeeId!;
const lgpd = await saveTraining(cBeatriz, { code: 'LGPD-01', title: 'LGPD na rotina da serventia (fictício)', kind: 'CURSO_INTERNO', workloadMinutes: 120, validityMonths: 12, mandatory: true, audienceType: 'TODOS',
  description: 'Conteúdo fictício de homologação.' });
const popTrn = await saveTraining(cBeatriz, { code: 'POP-RI-001-EST', title: 'Estudo do POP de prenotação (fictício)', kind: 'ESTUDO_POP', documentId: pop, mandatory: true, audienceType: 'SETORES', sectorIds: [ri],
  hasAssessment: true, passScore: 70, maxAttempts: 3, workloadMinutes: 30 });
await setQuestions(cBeatriz, popTrn, [
  { question: 'Qual o primeiro passo ao receber um título?', options: ['Arquivar', 'Conferir os requisitos formais', 'Devolver'], correctIndex: 1 },
  { question: 'Onde o título é lançado?', options: ['No protocolo', 'Em planilha pessoal'], correctIndex: 0 },
]);
await saveTraining(cBeatriz, { code: 'EXT-01', title: 'Curso externo de atualização registral (fictício)', kind: 'CURSO_EXTERNO', mandatory: false });
const cIsabel = await seedCtx('isabel.costa');
await registerCompletion(cBeatriz, { trainingId: lgpd, employeeId: await empOf(cCamila), completedOn: addDays(today, -340) }); // vence em breve
await registerCompletion(cBeatriz, { trainingId: lgpd, employeeId: await empOf(cIsabel), completedOn: addDays(today, -400) }); // vencido
await registerCompletion(cCamila, { trainingId: lgpd, employeeId: await empOf(cDiego), completedOn: addDays(today, -30) }, PDF('certificado-lgpd'));
await createTrainingSession(cBeatriz, { trainingId: lgpd, sessionDate: addDays(today, 10), startTime: 540, endTime: 660, location: 'Sala de reuniões', instructor: 'Instrutora fictícia',
  employeeIds: [await empOf(cGabriela), await empOf(cIsabel)] });
await submitAttempt(cCamila, popTrn, [1, 0]);
await completePopStudy(cCamila, popTrn, true).catch(() => undefined); // exige ciência do POP vigente; pode ficar pendente
const extId = (await queryOne<{ id: string }>(db, "SELECT id FROM trainings WHERE code = 'EXT-01'"))!.id;
await selfDeclare(cDiego, { trainingId: extId, completedOn: addDays(today, -5), minutes: 480, notes: 'Curso on-line (fictício)' }, PDF('certificado-externo'));
const evTpl = await saveTemplate(cBeatriz, { name: 'Acompanhamento do período de experiência (modelo fictício)', kind: 'EXPERIENCIA', scaleMax: 5, selfAssessment: false,
  instructions: 'Avalie com base em fatos observados no período.', criteria: [
    { grp: 'COMPETENCIA', title: 'Qualidade técnica', weight: 2 }, { grp: 'COMPORTAMENTO', title: 'Atendimento ao usuário', weight: 1 },
    { grp: 'PRODUTIVIDADE', title: 'Cumprimento de prazos', weight: 2 }, { grp: 'CONHECIMENTO', title: 'Domínio dos POPs do setor', weight: 1 }] });
await publishTemplate(cBeatriz, evTpl);
const anual = await saveTemplate(cBeatriz, { name: 'Avaliação anual de desempenho (modelo fictício)', kind: 'ANUAL', scaleMax: 5, selfAssessment: true, criteria: [
  { grp: 'COMPETENCIA', title: 'Qualidade técnica', weight: 2 }, { grp: 'COMPORTAMENTO', title: 'Trabalho em equipe', weight: 1 }, { grp: 'PRODUTIVIDADE', title: 'Organização e prazos', weight: 1 }] });
await publishTemplate(cBeatriz, anual);
const fam = (await listTemplates(cBeatriz)).find((t) => t.id === evTpl)!.family_key;
for (const d of [30, 60, 90]) await saveSchedule(cBeatriz, { name: `Acompanhamento ${d} dias`, templateFamily: fam, trigger: 'DIAS_APOS_ADMISSAO', daysAfter: d, leadDays: 7 });
const ev = await createEvaluation(cCamila, { templateId: evTpl, employeeId: await empOf(cDiego), periodLabel: 'Acompanhamento 90 dias (fictício)', dueDate: addDays(today, 5) });
const crit = await query<{ id: string }>(db, 'SELECT id FROM evaluation_criteria WHERE template_id = $1 ORDER BY position', [evTpl]);
await saveAssessment(cCamila, ev, { scores: crit.map((k, i) => ({ criterionId: k.id, score: [4, 5, 3, 4][i]! })), strengths: 'Cordialidade no atendimento.', improvements: 'Organização dos prazos.',
  feedback: 'Bom desempenho no período; combinamos foco nos prazos de qualificação (fictício).' });
await addPdiItem(cCamila, { evaluationId: ev, employeeId: await empOf(cDiego), goal: 'Cumprir os prazos de qualificação', action: 'Usar o quadro de tarefas diariamente', trainingId: popTrn, dueDate: addDays(today, 60) });
await sendForAcknowledgement(cCamila, ev);
await createEvaluation(cBeatriz, { templateId: anual, employeeId: await empOf(cCamila), periodLabel: `Anual ${today.slice(0, 4)} (fictício)`, dueDate: addDays(today, 20) });
await saveRule(cBeatriz, { name: 'Avisar tarefas atrasadas há 2 dias', trigger: 'TAREFA_ATRASADA', days: 2, action: 'NOTIFICAR_RESPONSAVEL' });
await saveRule(cBeatriz, { name: 'Treinamento obrigatório a vencer em 30 dias', trigger: 'TREINAMENTO_VENCENDO', days: 30, action: 'NOTIFICAR_RESPONSAVEL' });
console.log('✓ treinamentos, avaliações, PDI e automações fictícios');

console.log('Apurando jornadas…');
await ensureProcessedAll();
console.log('Concluído. Entre pelo login de homologação (AUTH_DEV_LOGIN=true).');
await closePool();
