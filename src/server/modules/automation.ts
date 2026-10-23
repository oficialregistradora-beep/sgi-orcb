import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx, Principal } from '../context.ts';
import { can, requirePermission } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, NotFoundError } from '../errors.ts';
import { addDays, todayLocal } from '../../domain/time.ts';
import { notifyUsers, usersWithPermission } from './notifications.ts';
import { enqueueChat } from './integrations.ts';

// Painel configurável e automações (Fase 5b).
// Automações: regras "quando <gatilho> há <N> dias, então <ação>" sobre um catálogo FIXO de gatilhos e de ações
// seguras — somente avisos e criação de tarefas. Nenhuma automação altera, aprova, paga ou exclui registros.

// ---------------------------------------------------------------------------
// Painel configurável
// ---------------------------------------------------------------------------

/** Blocos disponíveis no painel; cada um só aparece para quem tem a permissão correspondente. */
export const WIDGETS: Record<string, { label: string; allowed: (p: Principal) => boolean }> = {
  tarefas: { label: 'Minhas tarefas', allowed: () => true },
  pendencias: { label: 'Documentos para ciência e aprovação', allowed: () => true },
  jornada: { label: 'Minha jornada e banco de horas', allowed: (p) => !!p.employeeId },
  treinamentos: { label: 'Meus treinamentos', allowed: (p) => !!p.employeeId },
  avaliacoes: { label: 'Minhas avaliações e as que devo fazer', allowed: () => true },
  coordenacao: { label: 'Coordenação (frequência, solicitações, alertas)', allowed: (p) => can(p, 'jornada.ver') },
  capacitacao: { label: 'Capacitação da equipe', allowed: (p) => can(p, 'treinamentos.registrar') || (can(p, 'treinamentos.ver') && p.grants.get('treinamentos.ver')?.scope !== 'PROPRIO') },
  qualidade: { label: 'Qualidade e segurança', allowed: (p) => ['qualidade.ver', 'qualidade.gerenciar', 'incidentes.gerenciar', 'ativos.gerenciar'].some((x) => can(p, x)) },
  financeiro: { label: 'Financeiro (contas a vencer)', allowed: (p) => ['financeiro.ver', 'financeiro.aprovar', 'financeiro.pagar'].some((x) => can(p, x)) },
  administracao: { label: 'Visão da administração (banco de horas, ausências)', allowed: (p) => can(p, 'banco.ocorrencias.tratar') },
};

export function availableWidgets(p: Principal): string[] {
  return Object.keys(WIDGETS).filter((k) => WIDGETS[k]!.allowed(p));
}

/** Blocos escolhidos (na ordem escolhida), filtrados pelas permissões atuais; sem escolha, todos os disponíveis. */
export async function myWidgets(ctx: Ctx): Promise<string[]> {
  const avail = availableWidgets(ctx.principal);
  const pref = await queryOne<{ widgets: string[] }>(getPool(), 'SELECT widgets FROM dashboard_preferences WHERE user_id = $1', [ctx.principal.userId]);
  return pref ? pref.widgets.filter((w) => avail.includes(w)) : avail;
}

export async function saveWidgets(ctx: Ctx, widgets: string[]): Promise<void> {
  const avail = availableWidgets(ctx.principal);
  const list = [...new Set(z.array(z.string().max(40)).max(30).parse(widgets))];
  if (list.some((w) => !avail.includes(w))) throw new AppError('Bloco indisponível para o seu perfil.');
  await query(getPool(), `INSERT INTO dashboard_preferences (user_id, widgets) VALUES ($1,$2)
    ON CONFLICT (user_id) DO UPDATE SET widgets = EXCLUDED.widgets, updated_at = now()`, [ctx.principal.userId, list]);
}

export async function resetWidgets(ctx: Ctx): Promise<void> {
  await query(getPool(), 'DELETE FROM dashboard_preferences WHERE user_id = $1', [ctx.principal.userId]);
}

// ---------------------------------------------------------------------------
// Automações
// ---------------------------------------------------------------------------

type Hit = { key: string; label: string; responsible: string | null; sectorId: string | null; link: string };

/** Catálogo de gatilhos. `days` = há quantos dias a condição persiste (ou, para vencimentos, com quantos dias de antecedência). */
export const TRIGGERS: Record<string, { label: string; daysMeaning: string; find: (db: Db, days: number, today: string) => Promise<Hit[]> }> = {
  TAREFA_ATRASADA: {
    label: 'Tarefa atrasada', daysMeaning: 'dias de atraso',
    find: async (db, days, today) => (await query<{ id: string; title: string; assignee_user_id: string | null; sector_id: string; due_date: string }>(db,
      "SELECT id, title, assignee_user_id, sector_id, due_date FROM tasks WHERE status NOT IN ('CONCLUIDA','CANCELADA') AND due_date <= $1", [addDays(today, -days)]))
      .map((t) => ({ key: `${t.id}:${t.due_date}`, label: `Tarefa atrasada desde ${t.due_date}: ${t.title}`, responsible: t.assignee_user_id, sectorId: t.sector_id, link: `/tarefas/${t.id}` })),
  },
  TREINAMENTO_VENCENDO: {
    label: 'Treinamento obrigatório vencendo ou vencido', daysMeaning: 'dias de antecedência',
    find: async (db, days, today) => (await query<{ id: string; title: string; user_id: string | null; sector_id: string; expires_on: string }>(db,
      `SELECT r.id, t.title, e.user_id, e.sector_id, r.expires_on FROM training_records r JOIN trainings t ON t.id = r.training_id JOIN employees e ON e.id = r.employee_id
        WHERE r.status = 'CONCLUIDO' AND t.mandatory AND t.active AND e.status <> 'DESLIGADO' AND r.expires_on <= $1
          AND NOT EXISTS (SELECT 1 FROM training_records n WHERE n.training_id = r.training_id AND n.employee_id = r.employee_id AND n.status = 'CONCLUIDO' AND n.completed_on > r.completed_on)`,
      [addDays(today, days)])).map((r) => ({ key: `${r.id}:${r.expires_on}`, label: `Treinamento vence em ${r.expires_on}: ${r.title}`, responsible: r.user_id, sectorId: r.sector_id, link: '/treinamentos' })),
  },
  AVALIACAO_ATRASADA: {
    label: 'Avaliação de desempenho atrasada', daysMeaning: 'dias de atraso',
    find: async (db, days, today) => (await query<{ id: string; evaluator_user_id: string; sector_id: string; due_date: string }>(db,
      "SELECT v.id, v.evaluator_user_id, e.sector_id, v.due_date FROM evaluations v JOIN employees e ON e.id = v.employee_id WHERE v.status = 'PENDENTE' AND v.due_date <= $1", [addDays(today, -days)]))
      // Sem o nome do avaliado: o aviso pode ir a quem não vê a avaliação.
      .map((v) => ({ key: `${v.id}:${v.due_date}`, label: `Avaliação de desempenho com prazo em ${v.due_date} ainda não enviada`, responsible: v.evaluator_user_id, sectorId: v.sector_id, link: `/avaliacoes/${v.id}` })),
  },
  NC_SEM_TRATAMENTO: {
    label: 'Não conformidade sem ação', daysMeaning: 'dias desde a abertura',
    find: async (db, days) => (await query<{ id: string; code: string; responsible_user_id: string; sector_id: string | null }>(db,
      "SELECT id, code, responsible_user_id, sector_id FROM nonconformities WHERE status = 'ABERTA' AND created_at <= now() - make_interval(days => $1)", [days]))
      .map((n) => ({ key: n.id, label: `${n.code} sem ação de tratamento`, responsible: n.responsible_user_id, sectorId: n.sector_id, link: `/qualidade/nc/${n.id}` })),
  },
  INCIDENTE_ABERTO: {
    label: 'Incidente em aberto', daysMeaning: 'dias desde a comunicação',
    find: async (db, days) => (await query<{ id: string; code: string }>(db,
      "SELECT id, code FROM incidents WHERE status <> 'ENCERRADO' AND reported_at <= now() - make_interval(days => $1)", [days]))
      .map((i) => ({ key: i.id, label: `Incidente ${i.code} em aberto`, responsible: null, sectorId: null, link: `/qualidade/incidentes/${i.id}` })),
  },
  DOCUMENTO_REVISAO_VENCIDA: {
    label: 'Documento com revisão vencida', daysMeaning: 'dias após a data de revisão',
    find: async (db, days, today) => (await query<{ id: string; title: string; responsible_user_id: string; sector_id: string | null; next_review_on: string }>(db,
      "SELECT id, title, responsible_user_id, sector_id, next_review_on FROM documents WHERE reference_type = 'REPOSITORIO' AND status = 'VIGENTE' AND next_review_on <= $1", [addDays(today, -days)]))
      .map((d) => ({ key: `${d.id}:${d.next_review_on}`, label: `Revisão vencida: ${d.title}`, responsible: d.responsible_user_id, sectorId: d.sector_id, link: `/documentos/${d.id}` })),
  },
  DESPESA_VENCIDA: {
    label: 'Despesa aprovada vencida e não paga', daysMeaning: 'dias de atraso',
    find: async (db, days, today) => (await query<{ id: string; description: string; decided_by: string | null; sector_id: string; due_date: string }>(db,
      `SELECT x.id, x.description, x.decided_by, cc.sector_id, x.due_date FROM expenses x JOIN cost_centers cc ON cc.id = x.cost_center_id
        WHERE x.status = 'APROVADA' AND x.due_date <= $1`, [addDays(today, -days)]))
      .map((x) => ({ key: `${x.id}:${x.due_date}`, label: `Conta vencida em ${x.due_date} sem pagamento`, responsible: x.decided_by, sectorId: x.sector_id, link: `/financeiro/despesas/${x.id}` })),
  },
};

export const ACTIONS = {
  NOTIFICAR_RESPONSAVEL: 'Avisar o responsável pelo item',
  NOTIFICAR_PAPEL: 'Avisar quem tem um papel',
  NOTIFICAR_USUARIO: 'Avisar uma pessoa',
  CRIAR_TAREFA: 'Criar tarefa para uma pessoa',
  AVISO_CHAT: 'Aviso no Google Chat (sem detalhes)',
} as const;

const ruleSchema = z.object({
  id: z.uuid().optional(), name: z.string().trim().min(3).max(150),
  trigger: z.string().refine((t) => t in TRIGGERS, 'Gatilho desconhecido.'), days: z.number().int().min(0).max(365).default(0),
  sectorId: z.uuid().nullable().optional(), action: z.enum(['NOTIFICAR_RESPONSAVEL', 'NOTIFICAR_PAPEL', 'NOTIFICAR_USUARIO', 'CRIAR_TAREFA', 'AVISO_CHAT']),
  targetRoleId: z.uuid().nullable().optional(), targetUserId: z.uuid().nullable().optional(), message: z.string().trim().max(300).optional(), active: z.boolean().default(true),
});

export async function saveRule(ctx: Ctx, input: z.input<typeof ruleSchema>): Promise<string> {
  requirePermission(ctx, 'automacoes.gerenciar');
  const d = ruleSchema.parse(input);
  if (d.action === 'NOTIFICAR_PAPEL' && !d.targetRoleId) throw new AppError('Escolha o papel.');
  if ((d.action === 'NOTIFICAR_USUARIO' || d.action === 'CRIAR_TAREFA') && !d.targetUserId) throw new AppError('Escolha a pessoa.');
  return tx(async (c) => {
    if (d.targetUserId && !(await queryOne(c, "SELECT 1 FROM users WHERE id = $1 AND status = 'ATIVO'", [d.targetUserId]))) throw new AppError('Pessoa inexistente ou inativa.');
    const vals = [d.name, d.trigger, d.days, d.sectorId ?? null, d.action, d.action === 'NOTIFICAR_PAPEL' ? d.targetRoleId : null,
      d.action === 'NOTIFICAR_USUARIO' || d.action === 'CRIAR_TAREFA' ? d.targetUserId : null, d.message || null, d.active];
    const id = d.id
      ? (await queryOne<{ id: string }>(c, `UPDATE automation_rules SET name=$1, trigger=$2, days=$3, sector_id=$4, action=$5, target_role_id=$6, target_user_id=$7, message=$8, active=$9, updated_at=now()
          WHERE id=$10 RETURNING id`, [...vals, d.id]))?.id
      : (await queryOne<{ id: string }>(c, `INSERT INTO automation_rules (name, trigger, days, sector_id, action, target_role_id, target_user_id, message, active, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [...vals, ctx.principal.userId]))!.id;
    if (!id) throw new NotFoundError('Regra não encontrada.');
    await audit(c, ctx, { action: d.id ? 'AUTOMACAO_ALTERADA' : 'AUTOMACAO_CRIADA', entityType: 'automation_rule', entityId: id,
      summary: `${d.name}: ${TRIGGERS[d.trigger]!.label} (${d.days} ${TRIGGERS[d.trigger]!.daysMeaning}) → ${ACTIONS[d.action]}${d.active ? '' : ' [inativa]'}` });
    return id;
  });
}

export async function listRules(ctx: Ctx) {
  requirePermission(ctx, 'automacoes.gerenciar');
  return query<{ id: string; name: string; trigger: string; days: number; sector_id: string | null; sector_name: string | null; action: string; target_role_id: string | null; role_name: string | null;
    target_user_id: string | null; user_name: string | null; message: string | null; active: boolean; last_run_at: Date | null; runs: number }>(getPool(),
    `SELECT r.id, r.name, r.trigger, r.days, r.sector_id, s.name AS sector_name, r.action, r.target_role_id, ro.name AS role_name, r.target_user_id, u.display_name AS user_name,
            r.message, r.active, r.last_run_at, (SELECT count(*)::int FROM automation_runs x WHERE x.rule_id = r.id) AS runs
       FROM automation_rules r LEFT JOIN sectors s ON s.id = r.sector_id LEFT JOIN roles ro ON ro.id = r.target_role_id LEFT JOIN users u ON u.id = r.target_user_id
      ORDER BY r.active DESC, r.name`);
}

export async function recentRuns(ctx: Ctx, limit = 50) {
  requirePermission(ctx, 'automacoes.gerenciar');
  return query<{ rule_name: string; entity_key: string; ran_at: Date; outcome: string }>(getPool(),
    'SELECT r.name AS rule_name, x.entity_key, x.ran_at, x.outcome FROM automation_runs x JOIN automation_rules r ON r.id = x.rule_id ORDER BY x.ran_at DESC LIMIT $1', [limit]);
}

const MAX_PER_RULE = 50;

/** Executa as regras ativas: cada item dispara uma única vez por regra (automation_runs). */
export async function runAutomations(db: Db = getPool(), onlyRuleId?: string): Promise<{ rules: number; fired: number }> {
  const today = todayLocal();
  const rules = await query<{ id: string; name: string; trigger: string; days: number; sector_id: string | null; action: keyof typeof ACTIONS; target_role_id: string | null;
    target_user_id: string | null; message: string | null; created_by: string }>(db,
    'SELECT id, name, trigger, days, sector_id, action, target_role_id, target_user_id, message, created_by FROM automation_rules WHERE active AND ($1::uuid IS NULL OR id = $1)', [onlyRuleId ?? null]);
  let fired = 0;
  for (const r of rules) {
    const t = TRIGGERS[r.trigger];
    if (!t) continue;
    const hits = (await t.find(db, r.days, today)).filter((h) => !r.sector_id || h.sectorId === r.sector_id);
    let n = 0;
    for (const h of hits) {
      if (n >= MAX_PER_RULE) break;
      await tx(async (c) => {
        const run = await queryOne<{ id: string }>(c, "INSERT INTO automation_runs (rule_id, entity_key, outcome) VALUES ($1,$2,'EM_EXECUCAO') ON CONFLICT (rule_id, entity_key) DO NOTHING RETURNING id", [r.id, h.key]);
        if (!run) return;
        const outcome = await perform(c, r, h);
        await query(c, 'UPDATE automation_runs SET outcome = $2 WHERE id = $1', [run.id, outcome]);
        n++;
      });
    }
    fired += n;
    await query(db, 'UPDATE automation_rules SET last_run_at = now() WHERE id = $1', [r.id]);
  }
  return { rules: rules.length, fired };
}

async function perform(c: Db, r: { id: string; name: string; action: keyof typeof ACTIONS; target_role_id: string | null; target_user_id: string | null; message: string | null; created_by: string },
  h: Hit): Promise<string> {
  const title = `Automação “${r.name}”`;
  // Para quem não é o responsável, o aviso não traz detalhes: só o link (que respeita as permissões de acesso).
  const generic = r.message || 'Há um item que requer atenção.';
  switch (r.action) {
    case 'NOTIFICAR_RESPONSAVEL': {
      const to = h.responsible ? [h.responsible] : await usersWithPermission(c, 'incidentes.gerenciar', '00000000-0000-0000-0000-000000000000');
      await notifyUsers(c, to, { kind: 'AUTOMACAO', title, body: r.message ? `${r.message} — ${h.label}` : h.label, link: h.link });
      return `aviso a ${to.length} pessoa(s)`;
    }
    case 'NOTIFICAR_PAPEL': {
      const to = (await query<{ user_id: string }>(c, `SELECT DISTINCT ur.user_id FROM user_roles ur JOIN users u ON u.id = ur.user_id
        WHERE ur.role_id = $1 AND ur.revoked_at IS NULL AND ur.valid_from <= current_date AND (ur.valid_until IS NULL OR ur.valid_until >= current_date) AND u.status = 'ATIVO'`, [r.target_role_id])).map((x) => x.user_id);
      await notifyUsers(c, to, { kind: 'AUTOMACAO', title, body: generic, link: h.link });
      return `aviso a ${to.length} pessoa(s) do papel`;
    }
    case 'NOTIFICAR_USUARIO':
      await notifyUsers(c, [r.target_user_id!], { kind: 'AUTOMACAO', title, body: generic, link: h.link });
      return 'aviso enviado';
    case 'CRIAR_TAREFA': {
      const sector = (await queryOne<{ sector_id: string }>(c, "SELECT sector_id FROM employees WHERE user_id = $1 AND status <> 'DESLIGADO'", [r.target_user_id]))?.sector_id ?? h.sectorId;
      if (!sector) return 'tarefa não criada: pessoa sem setor';
      const t = await queryOne<{ id: string }>(c, `INSERT INTO tasks (title, description, priority, sector_id, assignee_user_id, due_date, created_by)
        VALUES ($1,$2,'ALTA',$3,$4,$5,$6) RETURNING id`, [`[Automação] ${r.name}`.slice(0, 200), `${generic}\nItem: ${h.link}`, sector, r.target_user_id, addDays(todayLocal(), 2), r.created_by]);
      await query(c, "INSERT INTO task_events (task_id, user_id, event, details) VALUES ($1, NULL, 'CRIADA', $2)", [t!.id, JSON.stringify({ automacao: r.name })]);
      await notifyUsers(c, [r.target_user_id!], { kind: 'TAREFA', title: `Nova tarefa: [Automação] ${r.name}`, link: `/tarefas/${t!.id}` });
      return `tarefa ${t!.id}`;
    }
    case 'AVISO_CHAT':
      await enqueueChat(c, `auto:${r.id}:${h.key}`, `🔔 ${r.name}: ${generic}`);
      return 'aviso no Chat enfileirado (se ativo)';
  }
}
