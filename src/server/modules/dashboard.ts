import { getPool, query, queryOne } from '../db.ts';
import type { Ctx } from '../context.ts';
import { can, requirePermission, scopeFilter, scopeSql } from '../authz.ts';
import { getNumberSetting } from '../settings.ts';
import { summarize } from '../../domain/hourBank.ts';
import { addDays, todayLocal } from '../../domain/time.ts';
import { loadLedger } from './ledger.ts';
import { ensureProcessed, getTodayStatus } from './timeclock.ts';
import { listMyRequests, listRequestsToDecide } from './requests.ts';
import { listPendingApprovals } from './documents.ts';

export async function personalDashboard(ctx: Ctx) {
  const employeeId = ctx.principal.employeeId;
  if (!employeeId) return null;
  await ensureProcessed(employeeId);
  const db = getPool();
  const today = todayLocal();
  const alertDays = await getNumberSetting(db, 'banco.alerta_vencimento_dias', 30);
  const { entries, allocations } = await loadLedger(db, employeeId);
  const bank = summarize(entries, allocations, today, alertDays);
  const pendingOccurrences = await query<{ id: string; work_date: string; type: string; minutes: number; employee_justification: string | null }>(
    db,
    "SELECT id, work_date, type, minutes, employee_justification FROM daily_occurrences WHERE employee_id = $1 AND status = 'PENDENTE' ORDER BY work_date DESC LIMIT 10",
    [employeeId],
  );
  const docsToSign = (await queryOne<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM documents d
       JOIN LATERAL (SELECT id FROM document_versions x WHERE x.document_id = d.id ORDER BY version_number DESC LIMIT 1) v ON TRUE
      WHERE d.owner_employee_id = $1 AND d.reference_type IN ('ESPELHO','EXTRATO_BANCO','TERMO_ENTREGA')
        AND NOT EXISTS (SELECT 1 FROM signatures s WHERE s.document_version_id = v.id AND s.act IN ('CIENCIA','CONTESTACAO','CONCORDANCIA'))`,
    [employeeId],
  ))!.n;
  const myRequests = (await listMyRequests(ctx)).filter((r) => r.status === 'PENDENTE').length;
  const upcomingAbsences = await query<{ type: string; start_date: string; end_date: string }>(
    db, "SELECT type, start_date, end_date FROM absences WHERE employee_id = $1 AND status = 'ATIVA' AND end_date >= $2 ORDER BY start_date LIMIT 5",
    [employeeId, today]);
  return { today: await getTodayStatus(ctx), bank, pendingOccurrences, docsToSign, myRequests, upcomingAbsences };
}

export async function managementDashboard(ctx: Ctx) {
  const f = scopeFilter(ctx.principal, 'jornada.ver');
  if (!f || (!f.all && f.sectorIds.length === 0)) return null;
  const db = getPool();
  const today = todayLocal();
  const params: unknown[] = [today];
  const scope = scopeSql(f, 'e', params);
  const team = await query<{ id: string; full_name: string; sector_name: string; punches_today: number; absence: string | null }>(
    db,
    `SELECT e.id, e.full_name, s.name AS sector_name,
            (SELECT count(*)::int FROM time_punches p WHERE p.employee_id = e.id AND p.local_date = $1
               AND NOT EXISTS (SELECT 1 FROM punch_annulments a WHERE a.punch_id = p.id)) AS punches_today,
            (SELECT a.type FROM absences a WHERE a.employee_id = e.id AND a.status = 'ATIVA' AND $1 BETWEEN a.start_date AND a.end_date LIMIT 1) AS absence
       FROM employees e JOIN sectors s ON s.id = e.sector_id
      WHERE e.status <> 'DESLIGADO' AND ${scope} ORDER BY s.name, e.full_name`,
    params,
  );
  for (const m of team) await ensureProcessed(m.id);
  const occParams: unknown[] = [];
  const occScope = scopeSql(scopeFilter(ctx.principal, 'banco.ocorrencias.tratar') ?? { all: false, sectorIds: [], employeeId: null }, 'e', occParams);
  const pendingOccurrences = can(ctx.principal, 'banco.ocorrencias.tratar')
    ? (await queryOne<{ n: number }>(
        db, `SELECT count(*)::int AS n FROM daily_occurrences o JOIN employees e ON e.id = o.employee_id WHERE o.status = 'PENDENTE' AND ${occScope}`, occParams))!.n
    : 0;
  // Parâmetros próprios: reaproveitar a lista da consulta anterior deixaria parâmetros sem uso (erro no PostgreSQL).
  const alertParams: unknown[] = [today];
  const alerts = await query<{ full_name: string; work_date: string; alerts: string[] }>(
    db,
    `SELECT e.full_name, d.work_date, d.alerts FROM daily_records d JOIN employees e ON e.id = d.employee_id
      WHERE cardinality(d.alerts) > 0 AND d.work_date >= $1::date - 14 AND ${scopeSql(f, 'e', alertParams)}
      ORDER BY d.work_date DESC LIMIT 15`,
    alertParams,
  );
  return {
    team,
    requestsToDecide: (await listRequestsToDecide(ctx)).length,
    documentsToApprove: (await listPendingApprovals(ctx)).length,
    pendingOccurrences,
    alerts,
  };
}

/** Visão consolidada da Oficial / gestão: saldos de banco, vencimentos e indicadores de pessoal. */
export async function executiveIndicators(ctx: Ctx) {
  if (!can(ctx.principal, 'banco.ocorrencias.tratar') || scopeFilter(ctx.principal, 'banco.ver')?.all !== true) return null;
  const db = getPool();
  const today = todayLocal();
  const alertDays = await getNumberSetting(db, 'banco.alerta_vencimento_dias', 30);
  const highBalance = await getNumberSetting(db, 'banco.alerta_saldo_elevado_minutos', 2400);
  const employees = await query<{ id: string; full_name: string; sector_name: string }>(
    db, "SELECT e.id, e.full_name, s.name AS sector_name FROM employees e JOIN sectors s ON s.id = e.sector_id WHERE e.status <> 'DESLIGADO' ORDER BY e.full_name");
  const balances = [];
  for (const e of employees) {
    const { entries, allocations } = await loadLedger(db, e.id);
    balances.push({ ...e, ...summarize(entries, allocations, today, alertDays) });
  }
  const bySector = await query<{ name: string; n: number }>(
    db, "SELECT s.name, count(e.id)::int AS n FROM sectors s LEFT JOIN employees e ON e.sector_id = s.id AND e.status <> 'DESLIGADO' WHERE s.active GROUP BY s.name ORDER BY s.name");
  const absencesNext30 = await query<{ full_name: string; type: string; start_date: string; end_date: string }>(
    db,
    `SELECT e.full_name, a.type, a.start_date, a.end_date FROM absences a JOIN employees e ON e.id = a.employee_id
      WHERE a.status = 'ATIVA' AND a.end_date >= $1 AND a.start_date <= $2 ORDER BY a.start_date`,
    [today, addDays(today, 30)],
  );
  return {
    headcount: employees.length,
    bySector,
    balances,
    totals: {
      available: balances.reduce((a, b) => a + b.available, 0),
      expiringSoon: balances.reduce((a, b) => a + b.expiringSoon, 0),
      expired: balances.reduce((a, b) => a + b.expired, 0),
      highBalances: balances.filter((b) => b.balance >= highBalance).length,
    },
    absencesNext30,
  };
}

export type AuditRow = {
  id: number; occurred_at: Date; actor_name: string | null; action: string; entity_type: string; entity_id: string | null;
  summary: string; ip: string | null; hash: string;
};

export async function listAudit(ctx: Ctx, opts: { q?: string; action?: string; limit?: number; before?: number } = {}): Promise<AuditRow[]> {
  requirePermission(ctx, 'auditoria.ver');
  const params: unknown[] = [];
  const where: string[] = ['TRUE'];
  if (opts.q) { params.push(`%${opts.q}%`); where.push(`(a.summary ILIKE $${params.length} OR a.entity_id ILIKE $${params.length})`); }
  if (opts.action) { params.push(opts.action); where.push(`a.action = $${params.length}`); }
  if (opts.before) { params.push(opts.before); where.push(`a.id < $${params.length}`); }
  params.push(Math.min(opts.limit ?? 100, 500));
  return query<AuditRow>(
    getPool(),
    `SELECT a.id, a.occurred_at, u.display_name AS actor_name, a.action, a.entity_type, a.entity_id, a.summary, a.ip, a.hash
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT $${params.length}`,
    params,
  );
}
