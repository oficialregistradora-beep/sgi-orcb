import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx } from '../context.ts';
import { can, requirePermission, requireStepUp, scopeFilter, scopeSql } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ForbiddenError, NotFoundError } from '../errors.ts';
import { getNumberSetting } from '../settings.ts';
import { buildLots, estimateCost, summarize, type BankSummary, type CreditLot } from '../../domain/hourBank.ts';
import { monthRange, todayLocal } from '../../domain/time.ts';
import { activeAgreement, assertPeriodOpen, insertCredit, insertDebit, loadLedger, type Agreement } from './ledger.ts';
import { currentSalary, getEmployeeFor } from './people.ts';
import { ensureProcessed } from './timeclock.ts';
import { notifyEmployee } from './notifications.ts';
import { basisText, getRule } from './legalRules.ts';

export type LedgerLine = {
  id: string; entry_date: string; kind: string; minutes: number; expires_on: string | null; notes: string | null;
  created_at: Date; reverses_entry_id: string | null; reversed: boolean; occurrence_id: string | null; request_id: string | null;
};

export type BankOverview = {
  summary: BankSummary;
  lots: CreditLot[];
  lines: LedgerLine[];
  agreement: Agreement | null;
  pendingOccurrences: number;
  highBalanceThreshold: number;
  alertDays: number;
  cost: { available: string; expired: string; basis: string } | null;
};

export async function getBankOverview(ctx: Ctx, employeeId: string): Promise<BankOverview> {
  const e = await getEmployeeFor(ctx, 'banco.ver', employeeId);
  await ensureProcessed(employeeId);
  const db = getPool();
  const today = todayLocal();
  const alertDays = await getNumberSetting(db, 'banco.alerta_vencimento_dias', 30);
  const { entries, allocations } = await loadLedger(db, employeeId);
  const summary = summarize(entries, allocations, today, alertDays);
  const lots = buildLots(entries, allocations, today, alertDays);
  const lines = await query<LedgerLine>(
    db,
    `SELECT h.id, h.entry_date, h.kind, h.minutes, h.expires_on, h.notes, h.created_at, h.reverses_entry_id, h.occurrence_id, h.request_id,
            EXISTS (SELECT 1 FROM hour_bank_entries r WHERE r.reverses_entry_id = h.id) AS reversed
       FROM hour_bank_entries h WHERE h.employee_id = $1 ORDER BY h.entry_date DESC, h.created_at DESC`,
    [employeeId],
  );
  const pending = (await queryOne<{ n: number }>(
    db, "SELECT count(*)::int AS n FROM daily_occurrences WHERE employee_id = $1 AND status = 'PENDENTE'", [employeeId]))!.n;
  let cost: BankOverview['cost'] = null;
  // Custo estimado: estritamente informativo, visível apenas a quem tem a permissão específica (J-05).
  if (can(ctx.principal, 'banco.custos.ver', { employeeId, sectorId: e.sector_id })) {
    const salary = await currentSalary(db, employeeId, today);
    if (salary) {
      const divRule = await getRule(db, 'DIVISOR_SALARIO_HORAS', today, { allowPending: true });
      const pctRule = await getRule(db, 'ADICIONAL_HORA_EXTRA', today, { allowPending: true });
      const divisor = divRule?.value.horas ?? (await getNumberSetting(db, 'banco.divisor_salario_horas', 200));
      const pct = pctRule?.value.percentual ?? (await getNumberSetting(db, 'banco.adicional_extra_percentual', 50));
      cost = {
        available: estimateCost(summary.available, salary, divisor, pct),
        expired: estimateCost(summary.expired, salary, divisor, pct),
        basis: `Estimativa informativa, não é valor devido. Divisor: ${basisText(divRule, `${divisor} h`)}. Adicional: ${basisText(pctRule, `${pct}%`)}`,
      };
    }
  }
  return {
    summary, lots, lines, agreement: await activeAgreement(db, employeeId, today), pendingOccurrences: pending,
    highBalanceThreshold: await getNumberSetting(db, 'banco.alerta_saldo_elevado_minutos', 2400), alertDays, cost,
  };
}

// ---------------------------------------------------------------------------
// Ocorrências pendentes de análise
// ---------------------------------------------------------------------------
export type OccurrenceListItem = {
  id: string; employee_id: string; full_name: string; sector_name: string; work_date: string; type: string; minutes: number;
  status: string; resolution: string | null; resolution_notes: string | null; employee_justification: string | null;
  auto_resolved: boolean; resolved_at: Date | null; resolver_name: string | null; alerts: string[] | null;
  /** Sábado, domingo ou feriado com folga. */
  non_working: boolean;
};

export async function listOccurrences(
  ctx: Ctx,
  opts: { status?: 'PENDENTE' | 'RESOLVIDA'; employeeId?: string; from?: string; to?: string } = {},
): Promise<OccurrenceListItem[]> {
  const db = getPool();
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.employeeId) {
    await getEmployeeFor(ctx, 'banco.ver', opts.employeeId);
    await ensureProcessed(opts.employeeId);
    params.push(opts.employeeId);
    where.push(`o.employee_id = $${params.length}`);
  } else {
    const f = scopeFilter(ctx.principal, 'banco.ocorrencias.tratar');
    if (!f) throw new ForbiddenError();
    where.push(scopeSql(f, 'e', params));
  }
  where.push("o.status <> 'SUPERADA'");
  if (opts.status) { params.push(opts.status); where.push(`o.status = $${params.length}`); }
  if (opts.from) { params.push(opts.from); where.push(`o.work_date >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`o.work_date <= $${params.length}`); }
  return query<OccurrenceListItem>(
    db,
    `SELECT o.id, o.employee_id, e.full_name, s.name AS sector_name, o.work_date, o.type, o.minutes, o.status, o.resolution,
            o.resolution_notes, o.employee_justification, o.auto_resolved, o.resolved_at, u.display_name AS resolver_name, dr.alerts,
            (extract(dow FROM o.work_date) IN (0, 6) OR EXISTS (SELECT 1 FROM holidays h WHERE h.is_day_off AND h.date = o.work_date)) AS non_working
       FROM daily_occurrences o JOIN employees e ON e.id = o.employee_id JOIN sectors s ON s.id = e.sector_id
       LEFT JOIN users u ON u.id = o.resolved_by
       LEFT JOIN daily_records dr ON dr.employee_id = o.employee_id AND dr.work_date = o.work_date
      WHERE ${where.join(' AND ')} ORDER BY o.work_date DESC, e.full_name LIMIT 500`,
    params,
  );
}

/** O próprio funcionário apresenta justificativa para uma ocorrência (antes da análise). */
export async function justifyOccurrence(ctx: Ctx, occurrenceId: string, text: string): Promise<void> {
  z.uuid().parse(occurrenceId);
  if (text.trim().length < 5) throw new AppError('Descreva a justificativa (mínimo de 5 caracteres).');
  await tx(async (c) => {
    const o = await queryOne<{ employee_id: string; status: string; work_date: string }>(
      c, 'SELECT employee_id, status, work_date FROM daily_occurrences WHERE id = $1 FOR UPDATE', [occurrenceId]);
    if (!o) throw new NotFoundError();
    if (o.employee_id !== ctx.principal.employeeId) throw new ForbiddenError('Somente o próprio funcionário pode justificar.');
    if (o.status !== 'PENDENTE') throw new AppError('A ocorrência já foi analisada.');
    await query(c, 'UPDATE daily_occurrences SET employee_justification = $2, justified_at = now() WHERE id = $1', [occurrenceId, text.trim().slice(0, 1000)]);
    await audit(c, ctx, { action: 'OCORRENCIA_JUSTIFICADA', entityType: 'daily_occurrence', entityId: occurrenceId, summary: `Justificativa apresentada (${o.work_date})` });
  });
}

const resolveSchema = z.object({
  occurrenceId: z.uuid(),
  resolution: z.enum(['BANCO_CREDITO', 'PAGAMENTO_EXTRA', 'ABONO', 'BANCO_DEBITO', 'FALTA_NAO_JUSTIFICADA', 'CIENTE']),
  notes: z.string().trim().max(1000).optional(),
  /** Trabalho em sábado/domingo/feriado levado ao banco por exceção da CCT (casamento; curso/palestra em sábado). */
  nonWorkingException: z.enum(['CASAMENTO', 'CURSO']).optional(),
});

const ALLOWED: Record<string, string[]> = {
  HORA_EXTRA: ['BANCO_CREDITO', 'PAGAMENTO_EXTRA'],
  DIFERENCA_NEGATIVA: ['ABONO', 'BANCO_DEBITO', 'FALTA_NAO_JUSTIFICADA'],
  MARCACAO_INCOMPLETA: ['CIENTE'],
};

/**
 * Decisão sobre ocorrência. Nenhum desconto é automático: "falta não justificada" apenas sinaliza o caso
 * para análise da folha (J-06); hora extra só pode ir para o banco ou para pagamento (J-05).
 */
export async function resolveOccurrence(ctx: Ctx, input: z.input<typeof resolveSchema>): Promise<void> {
  const d = resolveSchema.parse(input);
  const today = todayLocal();
  await tx(async (c) => {
    const o = await queryOne<{ id: string; employee_id: string; work_date: string; type: string; minutes: number; status: string; sector_id: string; user_id: string | null; full_name: string }>(
      c,
      `SELECT o.id, o.employee_id, o.work_date, o.type, o.minutes, o.status, e.sector_id, e.user_id, e.full_name
         FROM daily_occurrences o JOIN employees e ON e.id = o.employee_id WHERE o.id = $1 FOR UPDATE OF o`,
      [d.occurrenceId],
    );
    if (!o) throw new NotFoundError('Ocorrência não encontrada.');
    requirePermission(ctx, 'banco.ocorrencias.tratar', { employeeId: o.employee_id, sectorId: o.sector_id });
    if (o.employee_id === ctx.principal.employeeId && !ctx.principal.isOwner) {
      throw new ForbiddenError('Não é permitido analisar ocorrência própria (segregação de funções).');
    }
    if (o.status !== 'PENDENTE') throw new AppError('A ocorrência não está pendente.');
    if (!ALLOWED[o.type]!.includes(d.resolution)) throw new AppError('Resolução incompatível com o tipo de ocorrência.');
    if (['ABONO', 'FALTA_NAO_JUSTIFICADA'].includes(d.resolution) && !d.notes) throw new AppError('Informe a fundamentação da decisão.');
    await assertPeriodOpen(c, o.work_date);

    if (d.resolution === 'BANCO_CREDITO' || d.resolution === 'BANCO_DEBITO') {
      const agreement = await activeAgreement(c, o.employee_id, o.work_date);
      if (!agreement) throw new AppError('Não há acordo de banco de horas vigente na data. Destine a hora para pagamento ou cadastre o acordo.');
      if (d.resolution === 'BANCO_CREDITO') {
        if (o.minutes > agreement.max_daily_extra_minutes) {
          throw new AppError(
            `A hora extra (${o.minutes} min) excede o limite diário do acordo (${agreement.max_daily_extra_minutes} min). Destine-a para pagamento.`,
          );
        }
        await insertCredit(c, { employeeId: o.employee_id, agreement, date: o.work_date, minutes: o.minutes, occurrenceId: o.id, userId: ctx.principal.userId, notes: d.notes || 'Hora extra destinada ao banco de horas', nonWorkingException: d.nonWorkingException ?? null });
      } else {
        await insertDebit(c, {
          employeeId: o.employee_id, agreement, date: o.work_date, minutes: o.minutes, kind: 'DEBITO_FALTA', asOf: o.work_date, today,
          occurrenceId: o.id, userId: ctx.principal.userId, notes: d.notes || 'Diferença negativa compensada com créditos do banco',
        });
      }
    }
    await query(
      c,
      "UPDATE daily_occurrences SET status = 'RESOLVIDA', resolution = $2, resolution_notes = $3, resolved_by = $4, resolved_at = now() WHERE id = $1",
      [o.id, d.resolution, d.notes ?? null, ctx.principal.userId],
    );
    await audit(c, ctx, {
      action: 'OCORRENCIA_RESOLVIDA', entityType: 'daily_occurrence', entityId: o.id,
      summary: `${o.full_name} — ${o.type} de ${o.minutes} min em ${o.work_date}: ${d.resolution}`, data: { notes: d.notes ?? null },
    });
    await notifyEmployee(c, o.employee_id, {
      kind: 'OCORRENCIA_ANALISADA', title: 'Ocorrência de jornada analisada',
      body: `${o.work_date}: ${o.type.replace('_', ' ').toLowerCase()} — decisão: ${d.resolution.replace(/_/g, ' ').toLowerCase()}`,
      link: '/banco-de-horas',
    });
  });
}

const paymentSchema = z.object({
  employeeId: z.uuid(),
  minutes: z.number().int().positive().max(100_000),
  onlyExpired: z.boolean().default(false),
  reference: z.string().trim().min(3).max(300), // ex.: "Folha 10/2026"
});

/** Pagamento de horas do banco em folha (CLT art. 59 §3º para créditos não compensados no prazo). */
export async function registerPayment(ctx: Ctx, input: z.input<typeof paymentSchema>): Promise<void> {
  const d = paymentSchema.parse(input);
  const e = await getEmployeeFor(ctx, 'banco.pagamentos.registrar', d.employeeId);
  await requireStepUp(getPool(), ctx);
  const today = todayLocal();
  await tx(async (c) => {
    const r = await insertDebit(c, {
      employeeId: d.employeeId, agreement: null, date: today, minutes: d.minutes, kind: 'PAGAMENTO', asOf: today, today,
      onlyExpired: d.onlyExpired, userId: ctx.principal.userId, notes: `Pagamento em folha — ${d.reference}`,
    });
    await audit(c, ctx, { action: 'BANCO_PAGAMENTO', entityType: 'employee', entityId: d.employeeId, summary: `Pagamento de ${d.minutes} min do banco de ${e.full_name} (${d.reference})`, data: { entryId: r.entryId } });
  });
}

// ---------------------------------------------------------------------------
// Fechamento de competência e relatório para a contabilidade
// ---------------------------------------------------------------------------
export async function listClosings(db: Db = getPool()) {
  return query<{ id: string; period: string; closed_at: Date; closed_by_name: string; reopened_at: Date | null; reopen_reason: string | null }>(
    db,
    `SELECT pc.id, pc.period, pc.closed_at, u.display_name AS closed_by_name, pc.reopened_at, pc.reopen_reason
       FROM period_closings pc JOIN users u ON u.id = pc.closed_by ORDER BY pc.period DESC, pc.closed_at DESC LIMIT 36`,
  );
}

export async function closePeriod(ctx: Ctx, period: string): Promise<void> {
  requirePermission(ctx, 'banco.periodo.fechar');
  const { to } = monthRange(period);
  if (to >= todayLocal()) throw new AppError('Só é possível fechar competências já encerradas.');
  await requireStepUp(getPool(), ctx);
  const pending = (await queryOne<{ n: number }>(
    getPool(), "SELECT count(*)::int AS n FROM daily_occurrences WHERE status = 'PENDENTE' AND to_char(work_date,'YYYY-MM') = $1", [period]))!.n;
  if (pending > 0) throw new AppError(`Há ${pending} ocorrência(s) pendente(s) de análise na competência.`);
  await tx(async (c) => {
    await query(c, 'INSERT INTO period_closings (period, closed_by) VALUES ($1,$2)', [period, ctx.principal.userId]).catch((e: { code?: string }) => {
      if (e.code === '23505') throw new AppError('Competência já fechada.');
      throw e;
    });
    await audit(c, ctx, { action: 'COMPETENCIA_FECHADA', entityType: 'period', entityId: period, summary: `Competência ${period} fechada` });
  });
}

export async function reopenPeriod(ctx: Ctx, period: string, reason: string): Promise<void> {
  requirePermission(ctx, 'banco.periodo.fechar');
  if (reason.trim().length < 5) throw new AppError('Informe o motivo da reabertura.');
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    const r = await query(c, 'UPDATE period_closings SET reopened_at = now(), reopened_by = $2, reopen_reason = $3 WHERE period = $1 AND reopened_at IS NULL RETURNING id', [
      period, ctx.principal.userId, reason,
    ]);
    if (!r.length) throw new NotFoundError('Competência não está fechada.');
    await audit(c, ctx, { action: 'COMPETENCIA_REABERTA', entityType: 'period', entityId: period, summary: `Competência ${period} reaberta`, data: { reason } });
  });
}

export type PayrollRow = {
  employee_id: string; full_name: string; registration_code: string;
  extra_paid_minutes: number; unjustified_minutes: number; bank_credit_minutes: number; bank_debit_minutes: number;
  payments_minutes: number; pending_occurrences: number;
};

/**
 * Relatório gerencial para a contabilidade/folha. Os valores são INFORMATIVOS: a apuração final
 * de verbas e eventuais descontos depende de validação contábil e jurídica.
 */
export async function payrollReport(ctx: Ctx, period: string): Promise<PayrollRow[]> {
  const f = scopeFilter(ctx.principal, 'banco.ocorrencias.tratar');
  if (!f) throw new ForbiddenError();
  const { from, to } = monthRange(period);
  const params: unknown[] = [from, to];
  const scope = scopeSql(f, 'e', params);
  return query<PayrollRow>(
    getPool(),
    `SELECT e.id AS employee_id, e.full_name, e.registration_code,
            coalesce(sum(o.minutes) FILTER (WHERE o.resolution = 'PAGAMENTO_EXTRA'), 0)::int AS extra_paid_minutes,
            coalesce(sum(o.minutes) FILTER (WHERE o.resolution = 'FALTA_NAO_JUSTIFICADA'), 0)::int AS unjustified_minutes,
            coalesce(sum(o.minutes) FILTER (WHERE o.resolution = 'BANCO_CREDITO'), 0)::int AS bank_credit_minutes,
            coalesce(sum(o.minutes) FILTER (WHERE o.resolution = 'BANCO_DEBITO'), 0)::int AS bank_debit_minutes,
            coalesce((SELECT -sum(h.minutes) FROM hour_bank_entries h WHERE h.employee_id = e.id AND h.kind = 'PAGAMENTO'
                        AND h.entry_date BETWEEN $1 AND $2
                        AND NOT EXISTS (SELECT 1 FROM hour_bank_entries r WHERE r.reverses_entry_id = h.id)), 0)::int AS payments_minutes,
            count(o.id) FILTER (WHERE o.status = 'PENDENTE')::int AS pending_occurrences
       FROM employees e
       LEFT JOIN daily_occurrences o ON o.employee_id = e.id AND o.status <> 'SUPERADA' AND o.work_date BETWEEN $1 AND $2
      WHERE ${scope} AND e.admission_date <= $2 AND (e.termination_date IS NULL OR e.termination_date >= $1)
      GROUP BY e.id ORDER BY e.full_name`,
    params,
  );
}
