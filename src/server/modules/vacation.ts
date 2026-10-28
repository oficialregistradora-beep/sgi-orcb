import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx } from '../context.ts';
import { can, requirePermission, scopeFilter, scopeSql } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ForbiddenError, NotFoundError } from '../errors.ts';
import { getNumberSetting } from '../settings.ts';
import {
  acquisitivePeriods, ART130_BANDS, balances, entitlementForAbsences, validateVacation, VacationRuleError,
  type AcqPeriod, type Allocation, type VacationCheck,
} from '../../domain/vacation.ts';
import { addDays, todayLocal } from '../../domain/time.ts';
import { findEmployee, getEmployeeFor } from './people.ts';
import { ensureProcessed } from './timeclock.ts';
import { getRule } from './legalRules.ts';
import { requireStepUp } from '../authz.ts';
import { notifyEmployee, notifyUsers, usersWithPermission } from './notifications.ts';

// Férias: o funcionário solicita; quem tem "ferias.aprovar" decide pela tela de Solicitações.
// A aprovação revalida as regras, lança a ausência (abonada) e registra o consumo do período aquisitivo.

export async function loadAllocations(db: Db, employeeId: string): Promise<Allocation[]> {
  const rows = await query<{ period_start: string; enjoyed_days: number; sold_days: number; start_date: string }>(
    db, 'SELECT period_start, enjoyed_days, sold_days, start_date FROM vacation_allocations WHERE employee_id = $1 AND cancelled_at IS NULL', [employeeId]);
  return rows.map((r) => ({ periodStart: r.period_start, enjoyedDays: r.enjoyed_days, soldDays: r.sold_days, startDate: r.start_date }));
}

async function holidaySet(db: Db): Promise<Set<string>> {
  return new Set((await query<{ date: string }>(db, 'SELECT date FROM holidays WHERE is_day_off')).map((h) => h.date));
}

// ---------------------------------------------------------------------------
// J-13 — classificação das faltas do período aquisitivo (CLT arts. 130, 131 e 133)
// ---------------------------------------------------------------------------
export type AbsenceClassification = {
  unjustified: string[]; // faltas integrais confirmadas como injustificadas (contam para o art. 130)
  pending: string[]; // faltas integrais ainda sem decisão (impedem a conferência)
  justified: { date: string; reason: string }[]; // abonadas/compensadas (art. 131) — não contam
  partialNotCounted: number; // atrasos e saídas antecipadas: NÃO convertidos em dias de falta
};

/** Somente dias sem nenhum trabalho, com jornada prevista, contam como falta; a decisão da ocorrência classifica. */
export async function classifyAbsences(db: Db, employeeId: string, period: AcqPeriod): Promise<AbsenceClassification> {
  const rows = await query<{ work_date: string; status: string; resolution: string | null; worked_minutes: number }>(
    db,
    `SELECT o.work_date, o.status, o.resolution, dr.worked_minutes
       FROM daily_occurrences o JOIN daily_records dr ON dr.employee_id = o.employee_id AND dr.work_date = o.work_date
      WHERE o.employee_id = $1 AND o.type = 'DIFERENCA_NEGATIVA' AND o.status <> 'SUPERADA'
        AND o.work_date BETWEEN $2 AND $3 AND dr.expected_minutes > 0
      ORDER BY o.work_date`,
    [employeeId, period.start, period.end],
  );
  const out: AbsenceClassification = { unjustified: [], pending: [], justified: [], partialNotCounted: 0 };
  for (const r of rows) {
    if (r.worked_minutes > 0) { out.partialNotCounted++; continue; }
    if (r.status === 'PENDENTE') out.pending.push(r.work_date);
    else if (r.resolution === 'FALTA_NAO_JUSTIFICADA') out.unjustified.push(r.work_date);
    else out.justified.push({ date: r.work_date, reason: r.resolution === 'ABONO' ? 'Abonada (art. 131)' : 'Compensada com banco de horas' });
  }
  return out;
}

type ReviewRow = { id: string; period_start: string; unjustified_days: number; entitlement_days: number; art133_loss: boolean; art133_reason: string | null; reviewed_at: Date; reviewer: string; notes: string | null; calculation: Record<string, unknown> };

async function currentReviews(db: Db, employeeId: string): Promise<Map<string, ReviewRow>> {
  const rows = await query<ReviewRow>(
    db,
    `SELECT r.id, r.period_start, r.unjustified_days, r.entitlement_days, r.art133_loss, r.art133_reason, r.reviewed_at, u.display_name AS reviewer, r.notes, r.calculation
       FROM vacation_period_reviews r JOIN users u ON u.id = r.reviewed_by WHERE r.employee_id = $1 AND r.superseded_at IS NULL`,
    [employeeId],
  );
  return new Map(rows.map((r) => [r.period_start, r]));
}

/** Direito por período: conferido (quando houver) ou preliminar pelas faltas já confirmadas. */
async function entitlementMap(db: Db, employeeId: string, periods: AcqPeriod[]): Promise<Map<string, number>> {
  const reviews = await currentReviews(db, employeeId);
  const map = new Map<string, number>();
  for (const p of periods) {
    const rv = reviews.get(p.start);
    if (rv) map.set(p.start, rv.entitlement_days);
    else if (p.end < todayLocal()) map.set(p.start, entitlementForAbsences((await classifyAbsences(db, employeeId, p)).unjustified.length));
  }
  return map;
}

const reviewSchema = z.object({
  employeeId: z.uuid(),
  periodStart: z.iso.date(),
  art133Loss: z.boolean().default(false),
  art133Reason: z.string().trim().max(1000).optional(),
  notes: z.string().trim().max(1000).optional(),
  // Faltas injustificadas anteriores ao início do controle no sistema (do controle anterior), só para períodos que o antecedem.
  priorUnjustifiedDays: z.number().int().min(0).max(366).default(0),
});

/**
 * Conferência das faltas do período aquisitivo, exigida antes da aprovação das férias. Não há faltas pendentes de
 * classificação; registra a faixa do art. 130 e a memória de cálculo. A perda do direito do art. 133 é manual e fundamentada.
 */
export async function reviewVacationPeriod(ctx: Ctx, input: z.input<typeof reviewSchema>): Promise<{ entitlement: number }> {
  const d = reviewSchema.parse(input);
  const e = await getEmployeeFor(ctx, 'ferias.aprovar', d.employeeId);
  if (e.user_id === ctx.principal.userId && !ctx.principal.isOwner) throw new ForbiddenError('Não é permitido conferir o próprio período (segregação de funções).');
  if (d.art133Loss && (!d.art133Reason || d.art133Reason.length < 5)) throw new AppError('Fundamente a perda do direito (art. 133).');
  await requireStepUp(getPool(), ctx);
  await ensureProcessed(d.employeeId);
  const period = acquisitivePeriods(e.admission_date, todayLocal()).find((p) => p.start === d.periodStart);
  if (!period) throw new NotFoundError('Período aquisitivo inexistente.');
  if (period.end >= todayLocal()) throw new AppError('O período aquisitivo ainda não terminou.');
  const controlStart = e.control_start_date ?? e.admission_date;
  if (d.priorUnjustifiedDays > 0 && period.start >= controlStart) {
    throw new AppError('Faltas anteriores à implantação só se aplicam a períodos que começaram antes do início do controle no sistema.');
  }
  if (d.priorUnjustifiedDays > 0 && (!d.notes || d.notes.length < 5)) throw new AppError('Informe nas observações a origem das faltas anteriores à implantação.');
  return tx(async (c) => {
    const cls = await classifyAbsences(c, d.employeeId, period);
    if (cls.pending.length) {
      throw new AppError(`Há ${cls.pending.length} falta(s) sem classificação no período (${cls.pending.slice(0, 5).join(', ')}${cls.pending.length > 5 ? '…' : ''}). Analise-as em Ocorrências antes da conferência.`);
    }
    const unjustifiedTotal = cls.unjustified.length + d.priorUnjustifiedDays;
    const entitlement = d.art133Loss ? 0 : entitlementForAbsences(unjustifiedTotal);
    const used = (await loadAllocations(c, d.employeeId)).filter((a) => a.periodStart === period.start).reduce((s, a) => s + a.enjoyedDays + a.soldDays, 0);
    if (used > entitlement) throw new AppError(`Já foram concedidos ${used} dias neste período, acima do direito apurado (${entitlement}). Revise as férias concedidas.`);
    const band = ART130_BANDS.find((b) => b.dias === entitlementForAbsences(unjustifiedTotal))!;
    const calculation = {
      periodo: { inicio: period.start, fim: period.end }, faltasInjustificadas: cls.unjustified, faltasNaoComputadas: cls.justified,
      ...(d.priorUnjustifiedDays ? { faltasAnterioresImplantacao: d.priorUnjustifiedDays, inicioControle: controlStart } : {}),
      atrasosESaidasNaoConvertidos: cls.partialNotCounted, faixaArt130: band.faixa, diasPelaFaixa: band.dias,
      art133: d.art133Loss ? { perda: true, fundamento: d.art133Reason } : null, direitoFinal: entitlement,
    };
    await query(c, 'UPDATE vacation_period_reviews SET superseded_at = now() WHERE employee_id = $1 AND period_start = $2 AND superseded_at IS NULL', [d.employeeId, period.start]);
    await query(
      c,
      `INSERT INTO vacation_period_reviews (employee_id, period_start, unjustified_days, entitlement_days, art133_loss, art133_reason, calculation, notes, reviewed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [d.employeeId, period.start, unjustifiedTotal, entitlement, d.art133Loss, d.art133Reason ?? null, JSON.stringify(calculation), d.notes ?? null, ctx.principal.userId],
    );
    await audit(c, ctx, {
      action: 'FERIAS_CONFERENCIA_FALTAS', entityType: 'employee', entityId: d.employeeId,
      summary: `Conferência do período ${period.index} de ${e.full_name}: ${unjustifiedTotal} falta(s) injustificada(s)${d.priorUnjustifiedDays ? ` (${d.priorUnjustifiedDays} anteriores à implantação)` : ''} → ${entitlement} dias${d.art133Loss ? ' (perda — art. 133)' : ''}`,
    });
    return { entitlement };
  });
}

export async function checkVacation(
  db: Db, employeeId: string, start: string, end: string, soldDays: number, excludeRequestId: string | null = null,
): Promise<VacationCheck> {
  const e = await findEmployee(db, employeeId);
  if (e.status === 'DESLIGADO') throw new AppError('Funcionário desligado.');
  const pending = await query<{ payload: { periodStart: string; days: number; soldDays: number; start: string } }>(
    db, "SELECT payload FROM requests WHERE employee_id = $1 AND type = 'FERIAS' AND status = 'PENDENTE' AND id IS DISTINCT FROM $2",
    [employeeId, excludeRequestId]);
  // Pedidos pendentes também reservam saldo, para evitar dois pedidos que juntos excedam o direito.
  const allocations = [
    ...(await loadAllocations(db, employeeId)),
    ...pending.map((p) => ({ periodStart: p.payload.periodStart, enjoyedDays: p.payload.days, soldDays: p.payload.soldDays, startDate: p.payload.start })),
  ];
  const overlap = await queryOne(
    db,
    "SELECT 1 FROM absences WHERE employee_id = $1 AND status = 'ATIVA' AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')",
    [employeeId, start, end],
  );
  if (overlap) throw new AppError('Já existe ausência lançada no período solicitado.');
  const periods = acquisitivePeriods(e.admission_date, start);
  const blockRule = await getRule(db, 'FERIAS_VEDAR_INICIO_FDS_FERIADO', start, { allowPending: false });
  try {
    return validateVacation({
      admission: e.admission_date, today: todayLocal(), start, end, soldDays, allocations, holidays: await holidaySet(db),
      minNoticeDays: await getNumberSetting(db, 'ferias.aviso_minimo_dias', 30),
      entitlements: await entitlementMap(db, employeeId, periods),
      blockWeekendHolidayStart: blockRule?.value.ativo === true,
    });
  } catch (err) {
    if (err instanceof VacationRuleError) throw new AppError(err.message);
    throw err;
  }
}

const requestSchema = z.object({
  employeeId: z.uuid().optional(),
  start: z.iso.date(),
  end: z.iso.date(),
  soldDays: z.number().int().min(0).max(10).default(0),
  notes: z.string().trim().max(500).optional(),
});

export async function requestVacation(ctx: Ctx, input: z.input<typeof requestSchema>): Promise<{ id: string; warnings: string[] }> {
  const d = requestSchema.parse(input);
  const employeeId = d.employeeId ?? ctx.principal.employeeId;
  if (!employeeId) throw new ForbiddenError('Seu usuário não está vinculado a um cadastro funcional.');
  const e = await findEmployee(getPool(), employeeId);
  requirePermission(ctx, 'solicitacoes.criar', { employeeId, sectorId: e.sector_id });
  return tx(async (c) => {
    await query(c, "SELECT pg_advisory_xact_lock(hashtext('ferias:' || $1))", [employeeId]);
    const check = await checkVacation(c, employeeId, d.start, d.end, d.soldDays);
    const payload = { start: d.start, end: d.end, days: check.days, soldDays: d.soldDays, periodStart: check.period.start, periodIndex: check.period.index, warnings: check.warnings };
    const r = await queryOne<{ id: string }>(
      c,
      `INSERT INTO requests (type, employee_id, requested_by, reference_date, payload, justification)
       VALUES ('FERIAS',$1,$2,$3,$4,$5) RETURNING id`,
      [employeeId, ctx.principal.userId, d.start, JSON.stringify(payload), d.notes && d.notes.length >= 5 ? d.notes : 'Solicitação de férias'],
    );
    await audit(c, ctx, { action: 'FERIAS_SOLICITADAS', entityType: 'request', entityId: r!.id, summary: `Férias de ${e.full_name}: ${d.start} a ${d.end} (${check.days} dias${d.soldDays ? ` + ${d.soldDays} de abono` : ''})` });
    await notifyUsers(c, await usersWithPermission(c, 'ferias.aprovar', e.sector_id, e.user_id), {
      kind: 'SOLICITACAO_PENDENTE', title: 'Nova solicitação de férias', body: `${e.full_name} — ${d.start} a ${d.end}`, link: '/solicitacoes?aba=aprovar',
    });
    return { id: r!.id, warnings: check.warnings };
  });
}

/** Chamado por decideRequest na mesma transação: revalida e efetiva as férias aprovadas. */
export async function applyVacationApproval(
  c: Db, ctx: Ctx, r: { id: string; employee_id: string; payload: Record<string, unknown> },
): Promise<void> {
  const p = r.payload as { start: string; end: string; soldDays: number };
  await query(c, "SELECT pg_advisory_xact_lock(hashtext('ferias:' || $1))", [r.employee_id]);
  // Revalida desconsiderando o próprio pedido (que reservava saldo enquanto pendente).
  const check = await checkVacation(c, r.employee_id, p.start, p.end, p.soldDays, r.id);
  // J-13: a aprovação exige a conferência das faltas do período, ainda atual.
  const review = (await currentReviews(c, r.employee_id)).get(check.period.start);
  if (!review) throw new AppError(`Conferência das faltas do período aquisitivo ${check.period.index} pendente (art. 130). Realize-a em Férias antes de aprovar.`);
  const cls = await classifyAbsences(c, r.employee_id, check.period);
  // Faltas do controle anterior (implantação) entram no total conferido, mas não constam do sistema.
  const prior = Number((review.calculation as { faltasAnterioresImplantacao?: number } | null)?.faltasAnterioresImplantacao ?? 0);
  if (cls.pending.length || cls.unjustified.length + prior !== review.unjustified_days) {
    throw new AppError('A conferência das faltas está desatualizada (houve novas decisões de ocorrências). Refaça a conferência.');
  }
  await query(
    c,
    `INSERT INTO absences (employee_id, type, start_date, end_date, counts_as_worked, notes, created_by, request_id)
     VALUES ($1,'FERIAS',$2,$3,true,$4,$5,$6)`,
    [r.employee_id, p.start, p.end, `Férias — período aquisitivo ${check.period.index} (${check.period.start} a ${check.period.end})`, ctx.principal.userId, r.id],
  );
  await query(
    c,
    `INSERT INTO vacation_allocations (request_id, employee_id, period_start, enjoyed_days, sold_days, start_date, end_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [r.id, r.employee_id, check.period.start, check.days, p.soldDays, p.start, p.end],
  );
}

export async function cancelApprovedVacation(ctx: Ctx, requestId: string, reason: string): Promise<void> {
  z.uuid().parse(requestId);
  if (reason.trim().length < 5) throw new AppError('Informe o motivo.');
  await tx(async (c) => {
    const a = await queryOne<{ id: string; employee_id: string; start_date: string; sector_id: string }>(
      c,
      `SELECT va.id, va.employee_id, va.start_date, e.sector_id FROM vacation_allocations va JOIN employees e ON e.id = va.employee_id
        WHERE va.request_id = $1 AND va.cancelled_at IS NULL FOR UPDATE OF va`,
      [requestId],
    );
    if (!a) throw new NotFoundError('Férias aprovadas não encontradas.');
    requirePermission(ctx, 'ferias.aprovar', { employeeId: a.employee_id, sectorId: a.sector_id });
    if (a.start_date <= todayLocal()) throw new AppError('Férias já iniciadas não podem ser canceladas por aqui.');
    await query(c, 'UPDATE vacation_allocations SET cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1', [a.id, ctx.principal.userId, reason]);
    await query(c, "UPDATE absences SET status = 'CANCELADA', cancelled_by = $2, cancelled_at = now() WHERE request_id = $1", [requestId, ctx.principal.userId]);
    await audit(c, ctx, { action: 'FERIAS_CANCELADAS', entityType: 'request', entityId: requestId, summary: `Férias com início em ${a.start_date} canceladas`, data: { reason } });
    await notifyEmployee(c, a.employee_id, { kind: 'FERIAS_CANCELADAS', title: 'Férias canceladas', body: reason, link: '/ferias' });
  });
}

export async function getVacationOverview(ctx: Ctx, employeeId: string) {
  const e = await getEmployeeFor(ctx, 'ferias.ver', employeeId);
  const db = getPool();
  const today = todayLocal();
  await ensureProcessed(employeeId);
  const acq = acquisitivePeriods(e.admission_date, today);
  const periods = balances(acq, await loadAllocations(db, employeeId), today, 60, await entitlementMap(db, employeeId, acq));
  const reviews = await currentReviews(db, employeeId);
  const absences = new Map<string, AbsenceClassification>();
  for (const p of acq) absences.set(p.start, await classifyAbsences(db, employeeId, p));
  const requests = await query<{ id: string; status: string; payload: Record<string, unknown>; created_at: Date; decision_notes: string | null; cancelled: boolean }>(
    db,
    `SELECT r.id, r.status, r.payload, r.created_at, r.decision_notes,
            EXISTS (SELECT 1 FROM vacation_allocations va WHERE va.request_id = r.id AND va.cancelled_at IS NOT NULL) AS cancelled
       FROM requests r WHERE r.employee_id = $1 AND r.type = 'FERIAS' ORDER BY r.reference_date DESC`,
    [employeeId],
  );
  const prior = await query<{ id: string; period_start: string; start_date: string; end_date: string; enjoyed_days: number; sold_days: number; note: string }>(db,
    `SELECT id, period_start, start_date, end_date, enjoyed_days, sold_days, note FROM vacation_allocations
      WHERE employee_id = $1 AND source = 'IMPLANTACAO' AND cancelled_at IS NULL ORDER BY start_date`, [employeeId]);
  return { employee: e, controlStart: e.control_start_date ?? e.admission_date, prior, periods, requests, reviews, absences, canReview: can(ctx.principal, 'ferias.aprovar', { employeeId, sectorId: e.sector_id }) && e.user_id !== ctx.principal.userId };
}

/** Programação de férias e alertas (períodos a vencer ou vencidos) das pessoas sob a visão do usuário. */
export async function teamVacations(ctx: Ctx) {
  const f = scopeFilter(ctx.principal, 'ferias.ver');
  if (!f || (!f.all && f.sectorIds.length === 0)) return null;
  const db = getPool();
  const params: unknown[] = [];
  const scope = scopeSql(f, 'e', params);
  const employees = await query<{ id: string; full_name: string; admission_date: string }>(
    db, `SELECT e.id, e.full_name, e.admission_date FROM employees e WHERE e.status <> 'DESLIGADO' AND ${scope} ORDER BY e.full_name`, params);
  const today = todayLocal();
  const alerts: { employeeId: string; name: string; period: number; status: string; remaining: number; concessiveEnd: string }[] = [];
  for (const e of employees) {
    const acq = acquisitivePeriods(e.admission_date, today);
    for (const p of balances(acq, await loadAllocations(db, e.id), today, 60, await entitlementMap(db, e.id, acq))) {
      if (p.status === 'A_VENCER' || p.status === 'VENCIDAS') alerts.push({ employeeId: e.id, name: e.full_name, period: p.index, status: p.status, remaining: p.remaining, concessiveEnd: p.concessiveEnd });
    }
  }
  const p2: unknown[] = [today];
  const scope2 = scopeSql(f, 'e', p2);
  const scheduled = await query<{ employee_id: string; full_name: string; start_date: string; end_date: string; enjoyed_days: number; sold_days: number; request_id: string }>(
    db,
    `SELECT va.employee_id, e.full_name, va.start_date, va.end_date, va.enjoyed_days, va.sold_days, va.request_id
       FROM vacation_allocations va JOIN employees e ON e.id = va.employee_id
      WHERE va.cancelled_at IS NULL AND va.end_date >= $1 AND ${scope2} ORDER BY va.start_date`,
    p2,
  );
  return { alerts, scheduled, canApprove: can(ctx.principal, 'ferias.aprovar') };
}

// ---------------------------------------------------------------------------
// Implantação: férias gozadas antes do início do controle no sistema
// ---------------------------------------------------------------------------

const priorSchema = z.object({
  employeeId: z.uuid(),
  periodStart: z.iso.date(),
  startDate: z.iso.date(),
  enjoyedDays: z.number().int().min(0).max(30),
  soldDays: z.number().int().min(0).max(10),
  note: z.string().trim().min(5).max(500),
});

/**
 * Registra férias já gozadas (ou abono pecuniário) antes da implantação, conforme o controle anterior, para que o
 * período aquisitivo apareça quitado. Não gera ausência nem aviso: são fatos anteriores ao sistema.
 */
export async function registerPriorVacation(ctx: Ctx, input: z.input<typeof priorSchema>): Promise<string> {
  const d = priorSchema.parse(input);
  const e = await getEmployeeFor(ctx, 'ferias.aprovar', d.employeeId);
  if (e.user_id === ctx.principal.userId && !ctx.principal.isOwner) throw new ForbiddenError('Não é permitido lançar as próprias férias (segregação de funções).');
  const controlStart = e.control_start_date ?? e.admission_date;
  if (d.enjoyedDays + d.soldDays === 0) throw new AppError('Informe os dias gozados e/ou o abono.');
  if (d.startDate >= controlStart) throw new AppError(`Somente férias iniciadas antes do início do controle no sistema (${controlStart}). As demais seguem pela solicitação.`);
  const period = acquisitivePeriods(e.admission_date, todayLocal()).find((p) => p.start === d.periodStart);
  if (!period) throw new NotFoundError('Período aquisitivo inexistente.');
  if (d.startDate <= period.end) throw new AppError('As férias de um período aquisitivo só podem começar depois que ele termina.');
  const endDate = d.enjoyedDays > 0 ? addDays(d.startDate, d.enjoyedDays - 1) : d.startDate;
  return tx(async (c) => {
    await query(c, "SELECT pg_advisory_xact_lock(hashtext('ferias:' || $1))", [d.employeeId]);
    const used = (await loadAllocations(c, d.employeeId)).filter((a) => a.periodStart === period.start).reduce((s, a) => s + a.enjoyedDays + a.soldDays, 0);
    const entitlement = (await entitlementMap(c, d.employeeId, [period])).get(period.start) ?? 30;
    if (used + d.enjoyedDays + d.soldDays > entitlement) {
      throw new AppError(`O período ${period.index} tem direito a ${entitlement} dias e já há ${used} lançado(s).`);
    }
    const r = await queryOne<{ id: string }>(c,
      `INSERT INTO vacation_allocations (request_id, employee_id, period_start, enjoyed_days, sold_days, start_date, end_date, source, note, created_by)
       VALUES (NULL,$1,$2,$3,$4,$5,$6,'IMPLANTACAO',$7,$8) RETURNING id`,
      [d.employeeId, period.start, d.enjoyedDays, d.soldDays, d.startDate, endDate, d.note, ctx.principal.userId]);
    await audit(c, ctx, {
      action: 'FERIAS_ANTERIORES_REGISTRADAS', entityType: 'employee', entityId: d.employeeId,
      summary: `${e.full_name}: férias anteriores à implantação — período ${period.index}, ${d.enjoyedDays} dia(s) a partir de ${d.startDate}${d.soldDays ? ` + ${d.soldDays} de abono` : ''}`,
      data: { ...d, endDate },
    });
    return r!.id;
  });
}

export async function cancelPriorVacation(ctx: Ctx, allocationId: string, reason: string): Promise<void> {
  z.uuid().parse(allocationId);
  if (reason.trim().length < 5) throw new AppError('Informe o motivo.');
  await tx(async (c) => {
    const a = await queryOne<{ employee_id: string; sector_id: string; user_id: string | null; start_date: string }>(c,
      `SELECT va.employee_id, e.sector_id, e.user_id, va.start_date FROM vacation_allocations va JOIN employees e ON e.id = va.employee_id
        WHERE va.id = $1 AND va.source = 'IMPLANTACAO' AND va.cancelled_at IS NULL FOR UPDATE OF va`, [allocationId]);
    if (!a) throw new NotFoundError('Lançamento não encontrado.');
    requirePermission(ctx, 'ferias.aprovar', { employeeId: a.employee_id, sectorId: a.sector_id });
    if (a.user_id === ctx.principal.userId && !ctx.principal.isOwner) throw new ForbiddenError('Não é permitido alterar as próprias férias (segregação de funções).');
    await query(c, 'UPDATE vacation_allocations SET cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1', [allocationId, ctx.principal.userId, reason]);
    await audit(c, ctx, { action: 'FERIAS_ANTERIORES_CANCELADAS', entityType: 'employee', entityId: a.employee_id, summary: `Lançamento de férias anteriores (início ${a.start_date}) cancelado`, data: { reason } });
  });
}
