import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { AuditActor, Ctx } from '../context.ts';
import { actorOf } from '../context.ts';
import { requirePermission } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors.ts';
import { getNumberSetting } from '../settings.ts';
import {
  computeDay,
  deriveOccurrences,
  nextPunchKind,
  type DayResult,
  type ScheduleDay,
  type Tolerance,
} from '../../domain/journey.ts';
import { addDays, parseHHMM, todayLocal, toLocalParts, weekdayOf } from '../../domain/time.ts';
import { activeAgreement, insertCredit, reverseEntry } from './ledger.ts';

// Controle ADMINISTRATIVO INTERNO de frequência (J-01): não constitui REP-P nos termos da Portaria MTP 671/2021.

export type PunchRow = {
  id: string;
  punched_at: Date;
  local_date: string;
  kind: string;
  source: 'WEB' | 'CORRECAO' | 'IMPORTACAO';
  correction_request_id: string | null;
  created_at: Date;
  annulled: boolean;
  annul_reason: string | null;
};

export async function listPunches(db: Db, employeeId: string, from: string, to: string): Promise<PunchRow[]> {
  return query<PunchRow>(
    db,
    `SELECT p.id, p.punched_at, p.local_date, p.kind, p.source, p.correction_request_id, p.created_at,
            (a.id IS NOT NULL) AS annulled, a.reason AS annul_reason
       FROM time_punches p LEFT JOIN punch_annulments a ON a.punch_id = p.id
      WHERE p.employee_id = $1 AND p.local_date BETWEEN $2 AND $3
      ORDER BY p.punched_at`,
    [employeeId, from, to],
  );
}

type EmployeeBasics = { id: string; user_id: string | null; sector_id: string; admission_date: string; termination_date: string | null; status: string; full_name: string };

async function employeeBasics(db: Db, employeeId: string): Promise<EmployeeBasics> {
  const e = await queryOne<EmployeeBasics>(
    db, 'SELECT id, user_id, sector_id, admission_date, termination_date, status, full_name FROM employees WHERE id = $1', [employeeId]);
  if (!e) throw new NotFoundError('Funcionário não encontrado.');
  return e;
}

/** Registro de marcação pelo próprio funcionário. Horário = relógio do servidor (definido no banco). */
export async function punch(ctx: Ctx): Promise<{ id: string; punchedAt: Date; kind: string }> {
  const employeeId = ctx.principal.employeeId;
  if (!employeeId) throw new ForbiddenError('Seu usuário não está vinculado a um cadastro funcional.');
  const e = await employeeBasics(getPool(), employeeId);
  requirePermission(ctx, 'jornada.registrar', { employeeId, sectorId: e.sector_id });
  if (e.status === 'DESLIGADO') throw new ForbiddenError('Cadastro funcional desligado.');
  const minInterval = await getNumberSetting(getPool(), 'jornada.intervalo_minimo_entre_marcacoes_segundos', 60);
  return tx(async (c) => {
    await query(c, "SELECT pg_advisory_xact_lock(hashtext('punch:' || $1))", [employeeId]);
    const recent = await queryOne(
      c, "SELECT 1 FROM time_punches WHERE employee_id = $1 AND source = 'WEB' AND punched_at > now() - make_interval(secs => $2)",
      [employeeId, minInterval]);
    if (recent) throw new ConflictError('Marcação já registrada há instantes. Aguarde antes de registrar novamente.');
    const today = (await queryOne<{ d: string }>(c, "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS d"))!.d;
    const count = (await queryOne<{ n: number }>(
      c,
      `SELECT count(*)::int AS n FROM time_punches p WHERE p.employee_id = $1 AND p.local_date = $2
          AND NOT EXISTS (SELECT 1 FROM punch_annulments a WHERE a.punch_id = p.id)`,
      [employeeId, today],
    ))!.n;
    const kind = nextPunchKind(count);
    const p = await queryOne<{ id: string; punched_at: Date }>(
      c,
      `INSERT INTO time_punches (employee_id, punched_at, local_date, kind, source, ip, user_agent, created_by)
       VALUES ($1, now(), current_date, $2, 'WEB', $3, $4, $5) RETURNING id, punched_at`,
      [employeeId, kind, ctx.ip, ctx.userAgent?.slice(0, 400) ?? null, ctx.principal.userId],
    );
    await audit(c, ctx, { action: 'PONTO_MARCACAO', entityType: 'time_punch', entityId: p!.id, summary: `Marcação ${kind} de ${e.full_name}` });
    return { id: p!.id, punchedAt: p!.punched_at, kind };
  });
}

// ---------------------------------------------------------------------------
// Apuração por período
// ---------------------------------------------------------------------------
export type ComputedDay = {
  date: string;
  result: DayResult;
  punches: PunchRow[];
  schedule: ScheduleDay | null;
  scheduleName: string | null;
  holidayName: string | null;
  absenceType: string | null;
  inEmployment: boolean;
};

type ScheduleAssign = { valid_from: string; valid_until: string | null; name: string; tolerance: Tolerance; days: Map<number, ScheduleDay> };

async function loadSchedules(db: Db, employeeId: string): Promise<ScheduleAssign[]> {
  const rows = await query<{
    valid_from: string; valid_until: string | null; name: string; tolerance_enabled: boolean; tolerance_per_mark_minutes: number;
    tolerance_daily_minutes: number; weekday: number | null; start_time: string | null; break_start: string | null; break_end: string | null; end_time: string | null;
  }>(
    db,
    `SELECT es.valid_from, es.valid_until, ws.name, ws.tolerance_enabled, ws.tolerance_per_mark_minutes, ws.tolerance_daily_minutes,
            d.weekday, to_char(d.start_time,'HH24:MI') AS start_time, to_char(d.break_start,'HH24:MI') AS break_start,
            to_char(d.break_end,'HH24:MI') AS break_end, to_char(d.end_time,'HH24:MI') AS end_time
       FROM employee_schedules es JOIN work_schedules ws ON ws.id = es.schedule_id
       LEFT JOIN work_schedule_days d ON d.schedule_id = ws.id
      WHERE es.employee_id = $1`,
    [employeeId],
  );
  const map = new Map<string, ScheduleAssign>();
  for (const r of rows) {
    let a = map.get(r.valid_from);
    if (!a) {
      a = {
        valid_from: r.valid_from, valid_until: r.valid_until, name: r.name,
        tolerance: { enabled: r.tolerance_enabled, perMark: r.tolerance_per_mark_minutes, daily: r.tolerance_daily_minutes },
        days: new Map(),
      };
      map.set(r.valid_from, a);
    }
    if (r.weekday !== null && r.start_time && r.end_time) {
      a.days.set(r.weekday, {
        start: parseHHMM(r.start_time),
        breakStart: r.break_start ? parseHHMM(r.break_start) : null,
        breakEnd: r.break_end ? parseHHMM(r.break_end) : null,
        end: parseHHMM(r.end_time),
      });
    }
  }
  return [...map.values()];
}

export async function computeRange(db: Db, employeeId: string, from: string, to: string): Promise<ComputedDay[]> {
  const e = await employeeBasics(db, employeeId);
  const schedules = await loadSchedules(db, employeeId);
  const holidays = new Map(
    (await query<{ date: string; name: string }>(db, 'SELECT date, name FROM holidays WHERE is_day_off AND date BETWEEN $1 AND $2', [from, to])).map(
      (h) => [h.date, h.name],
    ),
  );
  const absences = await query<{ type: string; start_date: string; end_date: string; counts_as_worked: boolean }>(
    db,
    "SELECT type, start_date, end_date, counts_as_worked FROM absences WHERE employee_id = $1 AND status = 'ATIVA' AND end_date >= $2 AND start_date <= $3",
    [employeeId, from, to],
  );
  const compensations = new Map<string, number>();
  for (const r of await query<{ reference_date: string; minutes: number }>(
    db,
    `SELECT reference_date, (payload->>'minutes')::int AS minutes FROM requests
      WHERE employee_id = $1 AND type = 'COMPENSACAO' AND status = 'APROVADA' AND reference_date BETWEEN $2 AND $3`,
    [employeeId, from, to],
  )) {
    compensations.set(r.reference_date, (compensations.get(r.reference_date) ?? 0) + r.minutes);
  }
  const agreements = await query<{ valid_from: string; valid_until: string | null; max_daily_extra_minutes: number }>(
    db,
    'SELECT valid_from, valid_until, max_daily_extra_minutes FROM hour_bank_agreements WHERE employee_id = $1 AND revoked_at IS NULL',
    [employeeId],
  );
  const punches = await listPunches(db, employeeId, addDays(from, -1), to);
  const byDate = new Map<string, PunchRow[]>();
  for (const p of punches) byDate.set(p.local_date, [...(byDate.get(p.local_date) ?? []), p]);

  const out: ComputedDay[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const inEmployment = date >= e.admission_date && (!e.termination_date || date <= e.termination_date);
    const assign = schedules.find((s) => s.valid_from <= date && (!s.valid_until || s.valid_until >= date)) ?? null;
    const schedule = assign?.days.get(weekdayOf(date)) ?? null;
    const absence = absences.find((a) => a.start_date <= date && a.end_date >= date) ?? null;
    const dayPunches = byDate.get(date) ?? [];
    const valid = dayPunches.filter((p) => !p.annulled);
    const prevValid = (byDate.get(addDays(date, -1)) ?? []).filter((p) => !p.annulled);
    const lastPrev = prevValid.at(-1);
    const firstToday = valid[0];
    const agreement = inEmployment
      ? agreements.find((a) => a.valid_from <= date && (!a.valid_until || a.valid_until >= date)) ?? null
      : null;
    const result = computeDay({
      punches: valid.map((p) => toLocalParts(p.punched_at).minutes),
      schedule: inEmployment ? schedule : null,
      holiday: holidays.has(date),
      absence: absence ? { countsAsWorked: absence.counts_as_worked } : null,
      compensatedMinutes: compensations.get(date) ?? 0,
      tolerance: assign?.tolerance ?? { enabled: false, perMark: 0, daily: 0 },
      maxDailyExtraMinutes: agreement?.max_daily_extra_minutes ?? 120,
      restSincePreviousMinutes:
        lastPrev && firstToday ? Math.round((firstToday.punched_at.getTime() - lastPrev.punched_at.getTime()) / 60000) : null,
    });
    out.push({
      date, result, punches: dayPunches, schedule, scheduleName: assign?.name ?? null,
      holidayName: holidays.get(date) ?? null, absenceType: absence?.type ?? null, inEmployment,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reprocessamento: grava a apuração diária e sincroniza as ocorrências pendentes de análise
// ---------------------------------------------------------------------------
type OccurrenceRow = { id: string; type: string; minutes: number; status: string; resolution: string | null };

async function supersede(db: Db, occ: OccurrenceRow, actor: AuditActor, userIdForLedger: string): Promise<void> {
  await query(db, "UPDATE daily_occurrences SET status = 'SUPERADA', superseded_at = now() WHERE id = $1", [occ.id]);
  const entry = await queryOne<{ id: string }>(db, 'SELECT id FROM hour_bank_entries WHERE occurrence_id = $1', [occ.id]);
  if (entry) {
    await reverseEntry(db, entry.id, userIdForLedger, 'Estorno automático: apuração do dia alterada (ocorrência superada)');
    await audit(db, actor, {
      action: 'BANCO_ESTORNO_AUTOMATICO', entityType: 'daily_occurrence', entityId: occ.id,
      summary: `Lançamento estornado porque a apuração do dia mudou (${occ.type}, ${occ.minutes} min)`,
    });
  }
}

/** Reprocessa [from, to] (limitado a ontem). Dias em curso não geram ocorrências. */
export async function recomputeDays(db: Db, who: Ctx | AuditActor | null, employeeId: string, from: string, to: string): Promise<number> {
  const actor: AuditActor = who && 'principal' in who ? actorOf(who) : (who ?? actorOf(null));
  const yesterday = addDays(todayLocal(), -1);
  const end = to > yesterday ? yesterday : to;
  if (from > end) return 0;
  await query(db, "SELECT pg_advisory_xact_lock(hashtext('recompute:' || $1))", [employeeId]);
  const e = await employeeBasics(db, employeeId);
  const start = from < e.admission_date ? e.admission_date : from;
  const stop = e.termination_date && e.termination_date < end ? e.termination_date : end;
  if (start > stop) return 0;
  const days = await computeRange(db, employeeId, start, stop);
  const ledgerUser = actor.userId ?? (await systemUserId(db));
  for (const d of days) {
    const r = d.result;
    await query(
      db,
      `INSERT INTO daily_records (employee_id, work_date, expected_minutes, worked_minutes, compensated_minutes, raw_diff_minutes,
                                  diff_minutes, tolerance_applied, incomplete, day_kind, alerts, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (employee_id, work_date) DO UPDATE SET expected_minutes=EXCLUDED.expected_minutes, worked_minutes=EXCLUDED.worked_minutes,
         compensated_minutes=EXCLUDED.compensated_minutes, raw_diff_minutes=EXCLUDED.raw_diff_minutes, diff_minutes=EXCLUDED.diff_minutes,
         tolerance_applied=EXCLUDED.tolerance_applied, incomplete=EXCLUDED.incomplete, day_kind=EXCLUDED.day_kind, alerts=EXCLUDED.alerts, computed_at=now()`,
      [employeeId, d.date, r.expected, r.worked, r.compensated, r.rawDiff, r.diff, r.toleranceApplied, r.incomplete, r.kind, r.alerts],
    );
    const desired = deriveOccurrences(r);
    const alive = await query<OccurrenceRow>(
      db, "SELECT id, type, minutes, status, resolution FROM daily_occurrences WHERE employee_id = $1 AND work_date = $2 AND status <> 'SUPERADA'",
      [employeeId, d.date]);
    const handled = new Set<string>();
    for (const occ of alive) {
      const want = desired.find((x) => x.type === occ.type);
      if (want && want.minutes === occ.minutes) {
        handled.add(want.type);
      } else if (occ.status === 'PENDENTE' && want) {
        await query(db, 'UPDATE daily_occurrences SET minutes = $2 WHERE id = $1', [occ.id, want.minutes]);
        handled.add(want.type);
      } else {
        await supersede(db, occ, actor, ledgerUser);
      }
    }
    for (const want of desired) {
      if (handled.has(want.type)) continue;
      const occ = await queryOne<{ id: string }>(
        db, 'INSERT INTO daily_occurrences (employee_id, work_date, type, minutes) VALUES ($1,$2,$3,$4) RETURNING id',
        [employeeId, d.date, want.type, want.minutes]);
      if (want.type === 'HORA_EXTRA') await tryAutoResolveAuthorizedExtra(db, actor, employeeId, d.date, occ!.id, want.minutes);
    }
  }
  return days.length;
}

/**
 * Extra previamente autorizada: resolvida automaticamente conforme o destino autorizado, desde que a hora realizada
 * não exceda o total autorizado. Caso exceda, toda a ocorrência permanece pendente para análise.
 */
async function tryAutoResolveAuthorizedExtra(db: Db, actor: AuditActor, employeeId: string, date: string, occurrenceId: string, minutes: number) {
  const auth = await queryOne<{ total: number; destination: string; decided_by: string; request_id: string }>(
    db,
    `SELECT sum((payload->>'minutes')::int)::int AS total, (array_agg(payload->>'destination' ORDER BY decided_at DESC))[1] AS destination,
            (array_agg(decided_by ORDER BY decided_at DESC))[1] AS decided_by, (array_agg(id ORDER BY decided_at DESC))[1] AS request_id
       FROM requests WHERE employee_id = $1 AND type = 'AUTORIZACAO_EXTRA' AND status = 'APROVADA' AND reference_date = $2`,
    [employeeId, date],
  );
  if (!auth?.total || minutes > auth.total) return;
  if (auth.destination === 'BANCO') {
    const agreement = await activeAgreement(db, employeeId, date);
    if (!agreement || minutes > agreement.max_daily_extra_minutes) return;
    await insertCredit(db, {
      employeeId, agreement, date, minutes, occurrenceId, userId: auth.decided_by,
      notes: 'Crédito de hora extra previamente autorizada',
    });
  }
  const resolution = auth.destination === 'BANCO' ? 'BANCO_CREDITO' : 'PAGAMENTO_EXTRA';
  await query(
    db,
    `UPDATE daily_occurrences SET status = 'RESOLVIDA', resolution = $2, resolved_by = $3, resolved_at = now(), auto_resolved = true,
            resolution_notes = 'Resolução automática: hora extra previamente autorizada'
      WHERE id = $1`,
    [occurrenceId, resolution, auth.decided_by],
  );
  await audit(db, actor, {
    action: 'OCORRENCIA_AUTO_RESOLVIDA', entityType: 'daily_occurrence', entityId: occurrenceId,
    summary: `Hora extra de ${minutes} min em ${date} resolvida como ${resolution} (autorização prévia ${auth.request_id})`,
  });
}

let systemUserCache: string | null = null;
/** Lançamentos gerados sem usuário humano são atribuídos à conta da Oficial (autoridade do sistema), com registro em auditoria. */
async function systemUserId(db: Db): Promise<string> {
  if (systemUserCache) return systemUserCache;
  const r = await queryOne<{ id: string }>(db, 'SELECT id FROM users WHERE is_owner LIMIT 1');
  if (!r) throw new AppError('Conta da Oficial Registradora não configurada.', 500);
  systemUserCache = r.id;
  return r.id;
}

/** Processa os dias ainda não apurados até ontem (apuração preguiçosa, sem depender de agendador externo). */
export async function ensureProcessed(employeeId: string): Promise<void> {
  const yesterday = addDays(todayLocal(), -1);
  const last = await queryOne<{ d: string | null }>(getPool(), 'SELECT max(work_date) AS d FROM daily_records WHERE employee_id = $1', [employeeId]);
  if (last?.d && last.d >= yesterday) return;
  await tx(async (c) => {
    const again = await queryOne<{ d: string | null }>(c, 'SELECT max(work_date) AS d FROM daily_records WHERE employee_id = $1', [employeeId]);
    const e = await employeeBasics(c, employeeId);
    const from = again?.d ? addDays(again.d, 1) : e.admission_date;
    await recomputeDays(c, null, employeeId, from, yesterday);
  });
}

export async function ensureProcessedAll(): Promise<number> {
  const rows = await query<{ id: string }>(getPool(), "SELECT id FROM employees WHERE status <> 'DESLIGADO' OR termination_date >= current_date - 60");
  for (const r of rows) await ensureProcessed(r.id);
  return rows.length;
}

export async function getTodayStatus(ctx: Ctx) {
  const employeeId = ctx.principal.employeeId;
  if (!employeeId) return null;
  const today = todayLocal();
  const [day] = await computeRange(getPool(), employeeId, today, today);
  const valid = day!.punches.filter((p) => !p.annulled);
  return { today, day: day!, nextKind: nextPunchKind(valid.length) };
}
