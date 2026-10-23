import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import { AppError } from '../../../src/server/errors.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { addMonths, todayLocal } from '../../../src/domain/time.ts';
import { closePool, ctxFor, resetDatabase } from '../../helpers.ts';

import * as dashboard from '../../../src/server/modules/dashboard.ts';
import * as requests from '../../../src/server/modules/requests.ts';
import * as documents from '../../../src/server/modules/documents.ts';
import * as repository from '../../../src/server/modules/repository.ts';
import * as tasks from '../../../src/server/modules/tasks.ts';
import * as projects from '../../../src/server/modules/projects.ts';
import * as routines from '../../../src/server/modules/routines.ts';
import * as finance from '../../../src/server/modules/finance.ts';
import * as quality from '../../../src/server/modules/quality.ts';
import * as security from '../../../src/server/modules/security.ts';
import * as training from '../../../src/server/modules/training.ts';
import * as evaluations from '../../../src/server/modules/evaluations.ts';
import * as automation from '../../../src/server/modules/automation.ts';
import * as integrations from '../../../src/server/modules/integrations.ts';
import * as vacation from '../../../src/server/modules/vacation.ts';
import * as oncall from '../../../src/server/modules/oncall.ts';
import * as hourbank from '../../../src/server/modules/hourbank.ts';
import * as people from '../../../src/server/modules/people.ts';
import * as admin from '../../../src/server/modules/admin.ts';
import * as legal from '../../../src/server/modules/legalRules.ts';
import * as checklistTemplates from '../../../src/server/modules/checklistTemplates.ts';
import * as notifications from '../../../src/server/modules/notifications.ts';
import * as timeclock from '../../../src/server/modules/timeclock.ts';

// RODADA 2 (Fase 6) — matriz de perfis × consultas de TODOS os módulos sobre a carga fictícia completa (seed).
// Cada pessoa executa cada consulta: só são aceitas a resposta ou uma recusa controlada (AppError: sem permissão,
// não encontrado, regra de negócio). Qualquer outro erro (ex.: SQL inválido num escopo específico) reprova.
// Origem: o teste de carga encontrou erro no painel apenas para perfis com escopo de setor.

type Call = [string, (c: Ctx, me: { employeeId: string | null }) => Promise<unknown>];
const today = todayLocal();
const month = today.slice(0, 7);
const prev = addMonths(`${month}-01`, -1).slice(0, 7);
const CALLS: Call[] = [
  ['painel pessoal', (c) => dashboard.personalDashboard(c)], ['painel coordenação', (c) => dashboard.managementDashboard(c)],
  ['painel administração', (c) => dashboard.executiveIndicators(c)], ['auditoria', (c) => dashboard.listAudit(c)],
  ['minhas solicitações', (c) => requests.listMyRequests(c)], ['solicitações a decidir', (c) => requests.listRequestsToDecide(c)],
  ['solicitações decididas', (c) => requests.listRequestsToDecide(c, 'DECIDIDAS')],
  ['espelhos a aprovar', (c) => documents.listPendingApprovals(c)], ['meus documentos', (c, m) => (m.employeeId ? documents.listEmployeeDocuments(c, m.employeeId) : Promise.resolve())],
  ['repositório', (c) => repository.listDocuments(c, {})], ['ciências pendentes', (c) => repository.listPendingAcknowledgements(c)],
  ['aprovações de documentos', (c) => repository.listPendingDocApprovals(c)], ['revisões vencidas', (c) => repository.listReviewsDue(c)],
  ['minhas tarefas', (c) => tasks.listTasks(c, { scope: 'minhas' })], ['tarefas visíveis', (c) => tasks.listTasks(c, { scope: 'visiveis', status: 'TODAS' })],
  ['painel de tarefas', (c) => tasks.taskDashboard(c)], ['projetos', (c) => projects.listProjects(c)],
  ['rotinas', (c) => routines.listRoutines(c)], ['processos', (c) => routines.listProcessInstances(c)],
  ['despesas', (c) => finance.listExpenses(c, {})], ['despesas abertas', (c) => finance.listExpenses(c, { status: 'ABERTAS', mine: true })],
  ['fluxo financeiro', (c) => finance.financeOverview(c, prev, month)], ['contratos', (c) => finance.listContracts(c)],
  ['fornecedores', (c) => finance.listSuppliers(c)], ['receitas', (c) => finance.listRevenues(c)], ['bloqueios de pagamento', (c) => finance.paymentBlockers(c)],
  ['requisitos', (c) => quality.listRequirements(c)], ['auditorias internas', (c) => quality.listAudits(c)], ['não conformidades', (c) => quality.listNcs(c)],
  ['riscos', (c) => quality.listRisks(c)], ['incidentes', (c) => security.listIncidents(c)], ['ativos', (c) => security.listAssets(c)],
  ['backups', (c) => security.listBackups(c)], ['vulnerabilidades', (c) => security.listVulnerabilities(c)], ['painel da qualidade', (c) => security.qualityOverview(c)],
  ['meus treinamentos', (c) => training.myTrainings(c)], ['matriz de capacitação', (c) => training.complianceMatrix(c)],
  ['catálogo', (c) => training.listTrainings(c)], ['validações', (c) => training.pendingValidations(c)], ['pessoas treináveis', (c) => training.trainablePeople(c)],
  ['avaliações', (c) => evaluations.listEvaluations(c)], ['avaliações a fazer', (c) => evaluations.listEvaluations(c, { scope: 'avaliar' })],
  ['modelos de avaliação', (c) => evaluations.listTemplates(c)], ['avaliáveis', (c) => evaluations.evaluablePeople(c)],
  ['programação de avaliações', (c) => evaluations.listSchedules(c)], ['meu histórico', (c, m) => (m.employeeId ? evaluations.developmentHistory(c, m.employeeId) : Promise.resolve())],
  ['painel configurado', (c) => automation.myWidgets(c)], ['automações', (c) => automation.listRules(c)], ['disparos', (c) => automation.recentRuns(c)],
  ['agenda', (c) => integrations.agendaFor(c, `${prev}-01`, `${month}-28`)], ['férias da equipe', (c) => vacation.teamVacations(c)],
  ['minhas férias', (c, m) => (m.employeeId ? vacation.getVacationOverview(c, m.employeeId) : Promise.resolve())],
  ['plantões', (c) => oncall.listShifts(c, month)], ['participantes de plantão', (c) => oncall.eligibleParticipants(c)], ['relatório de plantões', (c) => oncall.oncallReport(c, prev)],
  ['meu banco de horas', (c, m) => (m.employeeId ? hourbank.getBankOverview(c, m.employeeId) : Promise.resolve())], ['folha', (c) => hourbank.payrollReport(c, prev)],
  ['funcionários', (c) => people.listEmployees(c)], ['usuários', (c) => admin.listUsers(c)], ['papéis', (c) => admin.listPermissionsAndRoles(c)],
  ['parâmetros', (c) => admin.listSettings(c)], ['regras jurídicas', (c) => legal.listLegalRegistry(c)], ['modelos de checklist', (c) => checklistTemplates.listTemplates(c)],
  ['notificações', (c) => notifications.listMyNotifications(c)], ['não lidas', (c) => notifications.unreadCount(c)], ['jornada de hoje', (c) => timeclock.getTodayStatus(c)],
];

let users: { id: string; display_name: string; is_owner: boolean; employee_id: string | null }[] = [];
const outcome: Record<string, { ok: number; denied: number }> = {};

beforeAll(async () => {
  await resetDatabase();
  // Carga fictícia completa: o mesmo seed da homologação, aplicado ao banco de testes.
  execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/seed.ts'], { env: { ...process.env }, stdio: 'pipe', timeout: 240_000 });
  users = await query(getPool(), "SELECT u.id, u.display_name, u.is_owner, e.id AS employee_id FROM users u LEFT JOIN employees e ON e.user_id = u.id WHERE u.status = 'ATIVO' ORDER BY u.display_name");
}, 300_000);
afterAll(closePool);

describe('Rodada 2 (Fase 6) — todas as consultas × todos os perfis', () => {
  it('nenhuma consulta falha de forma inesperada para nenhum perfil', async () => {
    expect(users.length).toBeGreaterThanOrEqual(9);
    const failures: string[] = [];
    for (const u of users) {
      const c = await ctxFor(u.id);
      const o = (outcome[u.display_name] = { ok: 0, denied: 0 });
      for (const [name, fn] of CALLS) {
        try { await fn(c, { employeeId: u.employee_id }); o.ok++; } catch (e) {
          if (e instanceof AppError) { o.denied++; if (u.is_owner) failures.push(`${u.display_name} › ${name}: recusa para a Oficial (${e.message})`); }
          else failures.push(`${u.display_name} › ${name}: ${(e as Error).message}`);
        }
      }
    }
    console.log(JSON.stringify(outcome));
    expect(failures).toEqual([]);
  }, 300_000);

  it('perfis restritos recebem recusas (e não dados) nas áreas de gestão', () => {
    const colab = Object.entries(outcome).find(([n]) => n.startsWith('Diego'))![1];
    const owner = Object.entries(outcome).find(([n]) => n.startsWith('Helena'))![1];
    expect(colab.denied).toBeGreaterThan(10);
    expect(owner.denied).toBe(0);
  });

  it('trilha de auditoria íntegra após a carga completa', async () => {
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
