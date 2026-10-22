import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx } from '../context.ts';
import { can, requirePermission, scopeFilter } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors.ts';
import { getNumberSetting } from '../settings.ts';
import { buildRotation, computeOncall, oncallValues } from '../../domain/oncall.ts';
import { formatHHMM, localToInstant, monthRange, todayLocal, weekdayOf } from '../../domain/time.ts';
import { activeAgreement, assertPeriodOpen, insertCredit } from './ledger.ts';
import { findEmployee, currentSalary } from './people.ts';
import { notifyEmployee } from './notifications.ts';
import { recomputeDays } from './timeclock.ts';

// Plantões de Registro Civil das Pessoas Naturais (sábados, domingos e feriados, 08h–18h por padrão).
// Sobreaviso, trabalho efetivo e banco de horas permanecem SEPARADOS (J-07). Gratificações não compensam
// o sobreaviso automaticamente.

const uuid = z.uuid();
const isoDate = z.iso.date();
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

export type ShiftRow = {
  id: string; shift_date: string; starts_at: Date; ends_at: Date; status: string; notes: string | null;
  employee_id: string; employee_name: string; employee_sector: string;
  substitute_employee_id: string | null; substitute_name: string | null;
  standby_minutes: number | null; effective_minutes: number | null; effective_destination: string | null;
  closed_at: Date | null; closed_by_name: string | null; calls: number;
};

const SHIFT_SELECT = `
  SELECT s.id, s.shift_date, s.starts_at, s.ends_at, s.status, s.notes, s.employee_id, e.full_name AS employee_name,
         e.sector_id AS employee_sector, s.substitute_employee_id, sub.full_name AS substitute_name, s.standby_minutes,
         s.effective_minutes, s.effective_destination, s.closed_at, u.display_name AS closed_by_name,
         (SELECT count(*)::int FROM oncall_calls c WHERE c.shift_id = s.id AND c.voided_at IS NULL) AS calls
    FROM oncall_shifts s JOIN employees e ON e.id = s.employee_id
    LEFT JOIN employees sub ON sub.id = s.substitute_employee_id
    LEFT JOIN users u ON u.id = s.closed_by`;

function canSeeShift(ctx: Ctx, s: { employee_id: string; employee_sector: string; substitute_employee_id: string | null }): boolean {
  if (can(ctx.principal, 'plantoes.ver', { employeeId: s.employee_id, sectorId: s.employee_sector })) return true;
  return !!ctx.principal.employeeId && s.substitute_employee_id === ctx.principal.employeeId && can(ctx.principal, 'plantoes.ver');
}

export async function listShifts(ctx: Ctx, period: string): Promise<ShiftRow[]> {
  if (!scopeFilter(ctx.principal, 'plantoes.ver')) throw new ForbiddenError();
  const { from, to } = monthRange(period);
  const rows = await query<ShiftRow>(getPool(), `${SHIFT_SELECT} WHERE s.shift_date BETWEEN $1 AND $2 ORDER BY s.shift_date`, [from, to]);
  return rows.filter((r) => canSeeShift(ctx, r));
}

async function loadShift(db: Db, id: string, lock = false): Promise<ShiftRow> {
  uuid.parse(id);
  const s = await queryOne<ShiftRow>(db, `${SHIFT_SELECT} WHERE s.id = $1${lock ? ' FOR UPDATE OF s' : ''}`, [id]);
  if (!s) throw new NotFoundError('Plantão não encontrado.');
  return s;
}

export async function getShift(ctx: Ctx, id: string) {
  const db = getPool();
  const s = await loadShift(db, id);
  if (!canSeeShift(ctx, s)) throw new ForbiddenError();
  const calls = await query<{
    id: string; called_at: Date; responded_at: Date | null; attended: boolean; arrival_at: Date | null; departure_at: Date | null;
    description: string; registered_by_name: string; voided_at: Date | null; void_reason: string | null;
  }>(
    db,
    `SELECT c.id, c.called_at, c.responded_at, c.attended, c.arrival_at, c.departure_at, c.description, u.display_name AS registered_by_name,
            c.voided_at, c.void_reason
       FROM oncall_calls c JOIN users u ON u.id = c.registered_by WHERE c.shift_id = $1 ORDER BY c.called_at`,
    [id],
  );
  const totals = computeOncall(s.starts_at, s.ends_at, calls.map((c) => ({
    attended: c.attended, arrival: c.arrival_at, departure: c.departure_at, voided: !!c.voided_at,
  })));
  return { shift: s, calls, totals };
}

/** Datas de plantão de uma competência: sábados, domingos e feriados com dispensa. */
export async function oncallDates(db: Db, period: string): Promise<string[]> {
  const { from, to } = monthRange(period);
  const holidays = new Set((await query<{ date: string }>(db, 'SELECT date FROM holidays WHERE is_day_off AND date BETWEEN $1 AND $2', [from, to])).map((h) => h.date));
  const out: string[] = [];
  for (let d = from; d <= to; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
    if (weekdayOf(d) === 0 || weekdayOf(d) === 6 || holidays.has(d)) out.push(d);
  }
  return out;
}

async function window(db: Db, date: string): Promise<{ startsAt: Date; endsAt: Date }> {
  const s = await getNumberSetting(db, 'plantao.horario_inicio_minutos', 480);
  const e = await getNumberSetting(db, 'plantao.horario_fim_minutos', 1080);
  return { startsAt: localToInstant(date, formatHHMM(s)), endsAt: localToInstant(date, formatHHMM(e)) };
}

async function unavailableOn(db: Db, employeeId: string, date: string): Promise<boolean> {
  const e = await queryOne<{ admission_date: string; termination_date: string | null; status: string }>(
    db, 'SELECT admission_date, termination_date, status FROM employees WHERE id = $1', [employeeId]);
  if (!e || e.admission_date > date || (e.termination_date && e.termination_date < date)) return true;
  return !!(await queryOne(db, "SELECT 1 FROM absences WHERE employee_id = $1 AND status = 'ATIVA' AND $2 BETWEEN start_date AND end_date", [employeeId, date]));
}

async function assertManageable(ctx: Ctx, db: Db, employeeIds: (string | null | undefined)[]): Promise<void> {
  for (const id of employeeIds) {
    if (!id) continue;
    const e = await findEmployee(db, id);
    requirePermission(ctx, 'plantoes.gerenciar', { employeeId: e.id, sectorId: e.sector_id });
  }
}

const generateSchema = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), participants: z.array(uuid).min(1) });

/** Monta a escala do mês em rodízio, sem sobrescrever plantões já existentes. */
export async function generateSchedule(ctx: Ctx, input: z.input<typeof generateSchema>): Promise<{ created: number; uncovered: string[] }> {
  const d = generateSchema.parse(input);
  const db = getPool();
  await assertManageable(ctx, db, d.participants);
  const dates = (await oncallDates(db, d.period)).filter((x) => x > todayLocal());
  return tx(async (c) => {
    const existing = new Set((await query<{ shift_date: string }>(c, "SELECT shift_date FROM oncall_shifts WHERE status <> 'CANCELADO' AND shift_date = ANY($1::date[])", [dates])).map((r) => r.shift_date));
    const free = dates.filter((x) => !existing.has(x));
    const last = await queryOne<{ employee_id: string }>(c, "SELECT employee_id FROM oncall_shifts WHERE status <> 'CANCELADO' AND shift_date < $1 ORDER BY shift_date DESC LIMIT 1", [free[0] ?? '9999-12-31']);
    const startIndex = last ? d.participants.indexOf(last.employee_id) + 1 : 0;
    const unavailable = new Map<string, boolean>();
    for (const p of d.participants) for (const date of free) unavailable.set(`${p}|${date}`, await unavailableOn(c, p, date));
    const plan = buildRotation(free, d.participants, (p, date) => unavailable.get(`${p}|${date}`) ?? true, Math.max(0, startIndex));
    let created = 0;
    const uncovered: string[] = [];
    for (const item of plan) {
      if (!item.employeeId) { uncovered.push(item.date); continue; }
      const w = await window(c, item.date);
      await query(c, `INSERT INTO oncall_shifts (shift_date, starts_at, ends_at, employee_id, substitute_employee_id, created_by)
                      VALUES ($1,$2,$3,$4,$5,$6)`, [item.date, w.startsAt, w.endsAt, item.employeeId, item.substituteId, ctx.principal.userId]);
      created++;
      await notifyEmployee(c, item.employeeId, { kind: 'PLANTAO_DESIGNADO', title: 'Plantão designado', body: `Plantão RCPN em ${item.date}`, link: `/plantoes?mes=${d.period}` });
    }
    await audit(c, ctx, { action: 'PLANTAO_ESCALA_GERADA', entityType: 'oncall', entityId: d.period, summary: `Escala de ${d.period}: ${created} plantão(ões) criados${uncovered.length ? `; sem cobertura: ${uncovered.join(', ')}` : ''}` });
    return { created, uncovered };
  });
}

const assignSchema = z.object({
  shiftId: uuid.optional(),
  date: isoDate.optional(),
  employeeId: uuid,
  substituteId: uuid.nullable().optional(),
  reason: z.string().trim().min(5).max(500),
});

/** Cria um plantão avulso ou altera responsável/substituto (substituição por férias, afastamento ou ausência). */
export async function assignShift(ctx: Ctx, input: z.input<typeof assignSchema>): Promise<string> {
  const d = assignSchema.parse(input);
  const db = getPool();
  await assertManageable(ctx, db, [d.employeeId, d.substituteId]);
  if (d.substituteId && d.substituteId === d.employeeId) throw new AppError('Responsável e substituto devem ser pessoas diferentes.');
  return tx(async (c) => {
    let id: string;
    let date: string;
    if (d.shiftId) {
      const s = await loadShift(c, d.shiftId, true);
      await assertManageable(ctx, c, [s.employee_id]);
      if (s.status !== 'PLANEJADO') throw new AppError('Somente plantões planejados podem ser alterados.');
      date = s.shift_date;
      if (await unavailableOn(c, d.employeeId, date)) throw new AppError('O responsável está ausente ou sem vínculo nesta data.');
      await query(c, 'UPDATE oncall_shifts SET employee_id = $2, substitute_employee_id = $3 WHERE id = $1', [s.id, d.employeeId, d.substituteId ?? null]);
      id = s.id;
      await audit(c, ctx, { action: 'PLANTAO_SUBSTITUICAO', entityType: 'oncall_shift', entityId: id, summary: `Plantão ${date}: ${s.employee_name} → novo responsável`, data: { reason: d.reason, from: s.employee_id, to: d.employeeId } });
      if (s.employee_id !== d.employeeId) await notifyEmployee(c, s.employee_id, { kind: 'PLANTAO_ALTERADO', title: 'Plantão reatribuído', body: `Você não é mais o responsável pelo plantão de ${date}.` });
    } else {
      if (!d.date) throw new AppError('Informe a data.');
      date = d.date;
      if (date <= todayLocal()) throw new AppError('Plantões avulsos são criados para datas futuras.');
      if (await unavailableOn(c, d.employeeId, date)) throw new AppError('O responsável está ausente ou sem vínculo nesta data.');
      const w = await window(c, date);
      try {
        id = (await queryOne<{ id: string }>(c, `INSERT INTO oncall_shifts (shift_date, starts_at, ends_at, employee_id, substitute_employee_id, notes, created_by)
                                                 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [date, w.startsAt, w.endsAt, d.employeeId, d.substituteId ?? null, d.reason, ctx.principal.userId]))!.id;
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictError('Já existe plantão nesta data.');
        throw e;
      }
      await audit(c, ctx, { action: 'PLANTAO_CRIADO', entityType: 'oncall_shift', entityId: id, summary: `Plantão avulso em ${date}`, data: { reason: d.reason } });
    }
    await notifyEmployee(c, d.employeeId, { kind: 'PLANTAO_DESIGNADO', title: 'Plantão designado', body: `Plantão RCPN em ${date}`, link: `/plantoes?plantao=${id}` });
    return id;
  });
}

export async function cancelShift(ctx: Ctx, shiftId: string, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new AppError('Informe o motivo.');
  await tx(async (c) => {
    const s = await loadShift(c, shiftId, true);
    await assertManageable(ctx, c, [s.employee_id]);
    if (s.status !== 'PLANEJADO') throw new AppError('Somente plantões planejados podem ser cancelados.');
    if (s.calls > 0) throw new AppError('Há chamados registrados: o plantão deve ser fechado, não cancelado.');
    await query(c, "UPDATE oncall_shifts SET status = 'CANCELADO', notes = coalesce(notes || ' | ', '') || $2 WHERE id = $1", [s.id, `Cancelado: ${reason}`]);
    await audit(c, ctx, { action: 'PLANTAO_CANCELADO', entityType: 'oncall_shift', entityId: s.id, summary: `Plantão ${s.shift_date} cancelado`, data: { reason } });
  });
}

const callSchema = z.object({
  shiftId: uuid,
  calledAt: hhmm,
  respondedAt: hhmm.optional(),
  attended: z.boolean(),
  arrivalAt: hhmm.optional(),
  departureAt: hhmm.optional(),
  description: z.string().trim().min(3).max(500),
});

function canRegister(ctx: Ctx, s: ShiftRow): boolean {
  const mine = !!ctx.principal.employeeId && (s.employee_id === ctx.principal.employeeId || s.substitute_employee_id === ctx.principal.employeeId);
  return (mine && can(ctx.principal, 'plantoes.registrar')) || can(ctx.principal, 'plantoes.gerenciar', { employeeId: s.employee_id, sectorId: s.employee_sector });
}

/** Registro de chamado. Descrever o serviço (ex.: "registro de óbito"), sem dados pessoais dos usuários. */
export async function registerCall(ctx: Ctx, input: z.input<typeof callSchema>): Promise<string> {
  const d = callSchema.parse(input);
  return tx(async (c) => {
    const s = await loadShift(c, d.shiftId, true);
    if (!canRegister(ctx, s)) throw new ForbiddenError();
    if (s.status !== 'PLANEJADO') throw new AppError('Plantão fechado ou cancelado: não aceita novos registros.');
    const at = (t: string) => localToInstant(s.shift_date, t);
    const calledAt = at(d.calledAt);
    if (calledAt < s.starts_at || calledAt > s.ends_at) throw new AppError('O chamado deve ocorrer dentro do horário do plantão.');
    if (calledAt.getTime() > Date.now()) throw new AppError('O horário do chamado ainda não ocorreu.');
    if (d.attended && (!d.arrivalAt || !d.departureAt)) throw new AppError('Informe chegada e saída do comparecimento.');
    const arrival = d.attended ? at(d.arrivalAt!) : null;
    const departure = d.attended ? at(d.departureAt!) : null;
    if (arrival && departure && (departure <= arrival || arrival < calledAt)) throw new AppError('Horários de comparecimento inconsistentes.');
    if (departure && departure.getTime() > Date.now()) throw new AppError('A saída informada ainda não ocorreu.');
    const r = await queryOne<{ id: string }>(
      c,
      `INSERT INTO oncall_calls (shift_id, called_at, responded_at, attended, arrival_at, departure_at, description, registered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [s.id, calledAt, d.respondedAt ? at(d.respondedAt) : null, d.attended, arrival, departure, d.description, ctx.principal.userId],
    );
    await audit(c, ctx, { action: 'PLANTAO_CHAMADO', entityType: 'oncall_shift', entityId: s.id, summary: `Chamado às ${d.calledAt} no plantão de ${s.shift_date}${d.attended ? ` (comparecimento ${d.arrivalAt}–${d.departureAt})` : ''}` });
    return r!.id;
  });
}

export async function voidCall(ctx: Ctx, callId: string, reason: string): Promise<void> {
  uuid.parse(callId);
  if (reason.trim().length < 5) throw new AppError('Informe o motivo.');
  await tx(async (c) => {
    const call = await queryOne<{ shift_id: string; voided_at: Date | null }>(c, 'SELECT shift_id, voided_at FROM oncall_calls WHERE id = $1 FOR UPDATE', [callId]);
    if (!call) throw new NotFoundError();
    const s = await loadShift(c, call.shift_id, true);
    if (!canRegister(ctx, s)) throw new ForbiddenError();
    if (s.status !== 'PLANEJADO' || call.voided_at) throw new AppError('Registro não pode ser anulado.');
    await query(c, 'UPDATE oncall_calls SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1', [callId, ctx.principal.userId, reason]);
    await audit(c, ctx, { action: 'PLANTAO_CHAMADO_ANULADO', entityType: 'oncall_shift', entityId: s.id, summary: `Registro de chamado anulado (${s.shift_date})`, data: { reason } });
  });
}

const closeSchema = z.object({ shiftId: uuid, destination: z.enum(['BANCO', 'PAGAMENTO']).optional(), notes: z.string().trim().max(500).optional() });

/**
 * Fechamento: congela sobreaviso e trabalho efetivo. O efetivo vai para o banco (com acordo vigente) ou para
 * pagamento. Quem fecha não pode ser o próprio plantonista (segregação), salvo a Oficial.
 */
export async function closeShift(ctx: Ctx, input: z.input<typeof closeSchema>): Promise<{ standby: number; effective: number }> {
  const d = closeSchema.parse(input);
  return tx(async (c) => {
    const s = await loadShift(c, d.shiftId, true);
    requirePermission(ctx, 'plantoes.fechar', { employeeId: s.employee_id, sectorId: s.employee_sector });
    if (s.employee_id === ctx.principal.employeeId && !ctx.principal.isOwner) throw new ForbiddenError('Não é permitido fechar o próprio plantão (segregação de funções).');
    if (s.status !== 'PLANEJADO') throw new AppError('Plantão já fechado ou cancelado.');
    if (s.ends_at.getTime() > Date.now()) throw new AppError('O plantão ainda não terminou.');
    await assertPeriodOpen(c, s.shift_date);
    const calls = await query<{ attended: boolean; arrival_at: Date | null; departure_at: Date | null; voided_at: Date | null }>(
      c, 'SELECT attended, arrival_at, departure_at, voided_at FROM oncall_calls WHERE shift_id = $1', [s.id]);
    const t = computeOncall(s.starts_at, s.ends_at, calls.map((x) => ({ attended: x.attended, arrival: x.arrival_at, departure: x.departure_at, voided: !!x.voided_at })));
    if (t.effectiveMinutes > 0 && !d.destination) throw new AppError('Houve trabalho efetivo: informe o destino (banco de horas ou pagamento).');
    const destination = t.effectiveMinutes > 0 ? d.destination! : null;
    if (destination === 'BANCO') {
      const agreement = await activeAgreement(c, s.employee_id, s.shift_date);
      if (!agreement) throw new AppError('Sem acordo de banco de horas vigente: destine o trabalho efetivo para pagamento.');
      await insertCredit(c, {
        employeeId: s.employee_id, agreement, date: s.shift_date, minutes: t.effectiveMinutes, oncallShiftId: s.id, userId: ctx.principal.userId,
        notes: 'Trabalho efetivo em plantão RCPN',
      });
    }
    await query(
      c,
      `UPDATE oncall_shifts SET status = 'REALIZADO', standby_minutes = $2, effective_minutes = $3, effective_destination = $4,
              closed_by = $5, closed_at = now(), notes = coalesce($6, notes) WHERE id = $1`,
      [s.id, t.standbyMinutes, t.effectiveMinutes, destination, ctx.principal.userId, d.notes ?? null],
    );
    await audit(c, ctx, {
      action: 'PLANTAO_FECHADO', entityType: 'oncall_shift', entityId: s.id,
      summary: `Plantão ${s.shift_date} de ${s.employee_name}: sobreaviso ${t.standbyMinutes} min, efetivo ${t.effectiveMinutes} min${destination ? ` → ${destination}` : ''}`,
    });
    // A apuração comum do dia não gera hora extra para o plantonista (sem dupla contagem).
    await recomputeDays(c, ctx, s.employee_id, s.shift_date, s.shift_date);
    await notifyEmployee(c, s.employee_id, { kind: 'PLANTAO_FECHADO', title: 'Plantão fechado', body: `${s.shift_date}: sobreaviso ${formatHHMM(t.standbyMinutes)}, efetivo ${formatHHMM(t.effectiveMinutes)}`, link: `/plantoes?plantao=${s.id}` });
    return { standby: t.standbyMinutes, effective: t.effectiveMinutes };
  });
}

export type OncallReportRow = {
  employee_id: string; full_name: string; shifts: number; standby_minutes: number; effective_bank: number; effective_paid: number;
  standby_value: string | null; effective_paid_value: string | null;
};

/** Relatório mensal: sobreaviso e trabalho efetivo SEPARADOS; valores estimados apenas com permissão de custos. */
export async function oncallReport(ctx: Ctx, period: string): Promise<OncallReportRow[]> {
  const f = scopeFilter(ctx.principal, 'plantoes.fechar');
  if (!f) throw new ForbiddenError();
  const { from, to } = monthRange(period);
  const db = getPool();
  const rows = await query<Omit<OncallReportRow, 'standby_value' | 'effective_paid_value'> & { sector_id: string }>(
    db,
    `SELECT e.id AS employee_id, e.full_name, e.sector_id, count(*)::int AS shifts, sum(s.standby_minutes)::int AS standby_minutes,
            coalesce(sum(s.effective_minutes) FILTER (WHERE s.effective_destination = 'BANCO'), 0)::int AS effective_bank,
            coalesce(sum(s.effective_minutes) FILTER (WHERE s.effective_destination = 'PAGAMENTO'), 0)::int AS effective_paid
       FROM oncall_shifts s JOIN employees e ON e.id = s.employee_id
      WHERE s.status = 'REALIZADO' AND s.shift_date BETWEEN $1 AND $2
      GROUP BY e.id ORDER BY e.full_name`,
    [from, to],
  );
  const divisor = await getNumberSetting(db, 'banco.divisor_salario_horas', 200);
  const standbyDiv = await getNumberSetting(db, 'plantao.sobreaviso_divisor', 3);
  const premium = await getNumberSetting(db, 'plantao.adicional_efetivo_percentual', 100);
  const out: OncallReportRow[] = [];
  for (const r of rows) {
    const res = { employeeId: r.employee_id, sectorId: r.sector_id };
    if (!can(ctx.principal, 'plantoes.fechar', res)) continue;
    let standby_value: string | null = null;
    let effective_paid_value: string | null = null;
    if (can(ctx.principal, 'banco.custos.ver', res)) {
      const salary = await currentSalary(db, r.employee_id, to);
      if (salary) {
        const v = oncallValues(r.standby_minutes, r.effective_paid, salary, divisor, standbyDiv, premium);
        standby_value = v.standby;
        effective_paid_value = v.effectiveIfPaid;
      }
    }
    out.push({ employee_id: r.employee_id, full_name: r.full_name, shifts: r.shifts, standby_minutes: r.standby_minutes, effective_bank: r.effective_bank, effective_paid: r.effective_paid, standby_value, effective_paid_value });
  }
  return out;
}

/** Participantes elegíveis à escala (por padrão, o setor RCPN). */
export async function eligibleParticipants(ctx: Ctx) {
  const rows = await query<{ id: string; full_name: string; sector_id: string; sector_code: string }>(
    getPool(),
    `SELECT e.id, e.full_name, e.sector_id, s.code AS sector_code FROM employees e JOIN sectors s ON s.id = e.sector_id
      WHERE e.status <> 'DESLIGADO' ORDER BY (s.code = 'RCPN') DESC, e.full_name`,
  );
  return rows.filter((r) => can(ctx.principal, 'plantoes.gerenciar', { employeeId: r.id, sectorId: r.sector_id }));
}
