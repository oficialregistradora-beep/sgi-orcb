import { type Db, query, queryOne } from '../db.ts';
import { AppError } from '../errors.ts';
import { getRule } from './legalRules.ts';
import { weekdayOf } from '../../domain/time.ts';
import {
  allocateFifo,
  buildLots,
  convertCreditMinutes,
  creditExpiry,
  expiryByRule,
  type Allocation,
  type EntryKind,
  type LedgerEntry,
} from '../../domain/hourBank.ts';

// Primitivas do razão do banco de horas. Lançamentos são imutáveis; correções são feitas por estorno.
// Todas as operações de escrita serializam por funcionário (advisory lock) para evitar consumo duplo de créditos.

export type Agreement = {
  id: string;
  kind: string;
  compensation_months: number;
  allows_negative_balance: boolean;
  max_daily_extra_minutes: number;
  valid_from: string;
  valid_until: string | null;
};

export async function activeAgreement(db: Db, employeeId: string, date: string): Promise<Agreement | null> {
  return queryOne<Agreement>(
    db,
    `SELECT id, kind, compensation_months, allows_negative_balance, max_daily_extra_minutes, valid_from, valid_until
       FROM hour_bank_agreements
      WHERE employee_id = $1 AND revoked_at IS NULL AND valid_from <= $2 AND (valid_until IS NULL OR valid_until >= $2)
      ORDER BY valid_from DESC LIMIT 1`,
    [employeeId, date],
  );
}

export async function lockBank(db: Db, employeeId: string): Promise<void> {
  await query(db, "SELECT pg_advisory_xact_lock(hashtext('bank:' || $1))", [employeeId]);
}

export async function loadLedger(db: Db, employeeId: string): Promise<{ entries: LedgerEntry[]; allocations: Allocation[] }> {
  const entries = await query<{
    id: string; kind: EntryKind; minutes: number; entry_date: string; expires_on: string | null; reverses_entry_id: string | null;
  }>(
    db,
    'SELECT id, kind, minutes, entry_date, expires_on, reverses_entry_id FROM hour_bank_entries WHERE employee_id = $1 ORDER BY entry_date, created_at',
    [employeeId],
  );
  const allocations = await query<{ debit_entry_id: string; credit_entry_id: string; minutes: number }>(
    db,
    `SELECT a.debit_entry_id, a.credit_entry_id, a.minutes FROM hour_bank_allocations a
       JOIN hour_bank_entries e ON e.id = a.credit_entry_id WHERE e.employee_id = $1`,
    [employeeId],
  );
  return {
    entries: entries.map((e) => ({
      id: e.id, kind: e.kind, minutes: e.minutes, entryDate: e.entry_date, expiresOn: e.expires_on, reversesEntryId: e.reverses_entry_id,
    })),
    allocations: allocations.map((a) => ({ debitEntryId: a.debit_entry_id, creditEntryId: a.credit_entry_id, minutes: a.minutes })),
  };
}

type Origin = { occurrenceId?: string | null; requestId?: string | null; oncallShiftId?: string | null; notes: string; userId: string };

export type NonWorkingException = 'CASAMENTO' | 'CURSO';
export const NON_WORKING_EXCEPTION_LABELS: Record<NonWorkingException, string> = { CASAMENTO: 'Atendimento de casamento', CURSO: 'Curso ou palestra de interesse da serventia' };

/** Sábado, domingo ou feriado com folga (cadastro de feriados). */
export async function isNonWorkingDay(db: Db, date: string): Promise<{ saturday: boolean; nonWorking: boolean }> {
  const wd = weekdayOf(date);
  const holiday = await queryOne(db, 'SELECT 1 FROM holidays WHERE is_day_off AND date = $1', [date]);
  return { saturday: wd === 6 && !holiday, nonWorking: wd === 0 || wd === 6 || !!holiday };
}

/**
 * Regra coletiva (validada) que tira do banco o trabalho em sábado, domingo e feriado — pago como extra —,
 * salvo plantão, casamento e curso/palestra em sábado (limite anual). Retorna a exceção aplicável ou lança o motivo.
 */
export async function assertNonWorkingCredit(
  db: Db, p: { employeeId: string; date: string; oncallShiftId?: string | null; exception?: NonWorkingException | null },
): Promise<'PLANTAO' | NonWorkingException | null> {
  const rule = await getRule(db, 'BANCO_DIAS_NAO_UTEIS', p.date, { allowPending: false });
  if (!rule?.value.excluir) return null;
  const day = await isNonWorkingDay(db, p.date);
  if (!day.nonWorking) return null;
  if (p.oncallShiftId) return 'PLANTAO';
  if (p.exception === 'CASAMENTO') return 'CASAMENTO';
  if (p.exception === 'CURSO') {
    if (!day.saturday) throw new AppError(`Curso ou palestra só entra no banco quando realizado em sábado; domingos e feriados são pagos como extra (${rule.legalBasis}).`);
    const used = (await queryOne<{ n: number }>(
      db,
      `SELECT count(DISTINCT e.entry_date)::int AS n FROM hour_bank_entries e
        WHERE e.employee_id = $1 AND e.kind = 'CREDITO' AND e.non_working_exception = 'CURSO'
          AND date_part('year', e.entry_date) = date_part('year', $2::date) AND e.entry_date <> $2::date
          AND NOT EXISTS (SELECT 1 FROM hour_bank_entries r WHERE r.reverses_entry_id = e.id)`,
      [p.employeeId, p.date],
    ))!.n;
    if (used >= rule.value.sabadosCursoPorAno) {
      throw new AppError(`Limite de ${rule.value.sabadosCursoPorAno} sábados de curso/palestra no banco neste ano já atingido: destine para pagamento (${rule.legalBasis}).`);
    }
    return 'CURSO';
  }
  throw new AppError(`Trabalho em sábado, domingo ou feriado não entra no banco de horas: destine para pagamento como extra, salvo plantão, casamento ou curso/palestra (${rule.legalBasis}).`);
}

export async function insertCredit(
  db: Db,
  p: Origin & { employeeId: string; agreement: Agreement; date: string; minutes: number; nonWorkingException?: NonWorkingException | null },
): Promise<string> {
  if (!Number.isInteger(p.minutes) || p.minutes <= 0) throw new AppError('Crédito inválido.');
  await lockBank(db, p.employeeId);
  const exception = await assertNonWorkingCredit(db, { employeeId: p.employeeId, date: p.date, oncallShiftId: p.oncallShiftId, exception: p.nonWorkingException });
  // Regras coletivas só alteram o banco quando VALIDADAS (J-14); sem elas vale o acordo (CLT art. 59).
  const factor = await getRule(db, 'BANCO_FATOR_CONVERSAO', p.date, { allowPending: false });
  const term = await getRule(db, 'BANCO_PRAZO', p.date, { allowPending: false });
  const minutes = factor ? convertCreditMinutes(p.minutes, factor.value.minutosFolgaPorHora) : p.minutes;
  const expiresOn = term ? expiryByRule(p.date, term.value) : creditExpiry(p.date, p.agreement.compensation_months);
  const notes = [p.notes, factor ? `conversão ${p.minutes}→${minutes} min (${factor.legalBasis})` : null, term ? `prazo: ${term.legalBasis}` : null,
    exception && exception !== 'PLANTAO' ? `sábado/domingo/feriado no banco: ${NON_WORKING_EXCEPTION_LABELS[exception].toLowerCase()}` : null]
    .filter(Boolean).join(' · ');
  const r = await queryOne<{ id: string }>(
    db,
    `INSERT INTO hour_bank_entries (employee_id, agreement_id, entry_date, kind, minutes, expires_on, occurrence_id, request_id,
                                    oncall_shift_id, notes, created_by, non_working_exception)
     VALUES ($1,$2,$3,'CREDITO',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [p.employeeId, p.agreement.id, p.date, minutes, expiresOn,
      p.occurrenceId ?? null, p.requestId ?? null, p.oncallShiftId ?? null, notes, p.userId, exception],
  );
  return r!.id;
}

/**
 * Lança um débito (compensação, cobertura de diferença negativa ou pagamento) consumindo créditos PEPS.
 * Sem saldo suficiente, só prossegue se o acordo admitir saldo negativo (débitos) — pagamentos nunca.
 */
export async function insertDebit(
  db: Db,
  p: Origin & {
    employeeId: string;
    agreement: Agreement | null;
    date: string;
    minutes: number;
    kind: 'DEBITO_COMPENSACAO' | 'DEBITO_FALTA' | 'PAGAMENTO';
    asOf: string;
    onlyExpired?: boolean;
    today: string;
  },
): Promise<{ entryId: string; covered: number; shortfall: number }> {
  if (!Number.isInteger(p.minutes) || p.minutes <= 0) throw new AppError('Quantidade de minutos inválida.');
  await lockBank(db, p.employeeId);
  const { entries, allocations } = await loadLedger(db, p.employeeId);
  const lots = buildLots(entries, allocations, p.today, 0);
  const isPayment = p.kind === 'PAGAMENTO';
  const { allocations: alloc, shortfall } = allocateFifo(lots, p.minutes, p.asOf, {
    includeExpired: isPayment,
    onlyExpired: p.onlyExpired,
  });
  if (shortfall > 0 && (isPayment || !p.agreement?.allows_negative_balance)) {
    throw new AppError(
      isPayment
        ? `Créditos insuficientes para o pagamento: faltam ${shortfall} min.`
        : `Saldo de créditos insuficiente (faltam ${shortfall} min) e o acordo não admite saldo negativo.`,
      409,
      'SALDO_INSUFICIENTE',
    );
  }
  const r = await queryOne<{ id: string }>(
    db,
    `INSERT INTO hour_bank_entries (employee_id, agreement_id, entry_date, kind, minutes, occurrence_id, request_id, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [p.employeeId, p.agreement?.id ?? null, p.date, p.kind, -p.minutes, p.occurrenceId ?? null, p.requestId ?? null, p.notes, p.userId],
  );
  for (const a of alloc) {
    await query(db, 'INSERT INTO hour_bank_allocations (debit_entry_id, credit_entry_id, minutes) VALUES ($1,$2,$3)', [r!.id, a.creditEntryId, a.minutes]);
  }
  return { entryId: r!.id, covered: p.minutes - shortfall, shortfall };
}

/** Estorna um lançamento (o original permanece). Retorna o id do estorno ou null se já estornado. */
export async function reverseEntry(db: Db, entryId: string, userId: string, notes: string): Promise<string | null> {
  const e = await queryOne<{ employee_id: string; minutes: number; entry_date: string; kind: string }>(
    db, 'SELECT employee_id, minutes, entry_date, kind FROM hour_bank_entries WHERE id = $1', [entryId]);
  if (!e) return null;
  if (e.kind === 'ESTORNO') throw new AppError('Não é possível estornar um estorno.');
  await lockBank(db, e.employee_id);
  const already = await queryOne(db, 'SELECT 1 FROM hour_bank_entries WHERE reverses_entry_id = $1', [entryId]);
  if (already) return null;
  const r = await queryOne<{ id: string }>(
    db,
    `INSERT INTO hour_bank_entries (employee_id, entry_date, kind, minutes, reverses_entry_id, notes, created_by)
     VALUES ($1,$2,'ESTORNO',$3,$4,$5,$6) RETURNING id`,
    [e.employee_id, e.entry_date, -e.minutes, entryId, notes, userId],
  );
  return r!.id;
}

export async function assertPeriodOpen(db: Db, date: string): Promise<void> {
  const closed = await queryOne(db, "SELECT 1 FROM period_closings WHERE period = to_char($1::date, 'YYYY-MM') AND reopened_at IS NULL", [date]);
  if (closed) throw new AppError(`A competência ${date.slice(0, 7)} está fechada. Solicite a reabertura à administração.`, 409, 'PERIODO_FECHADO');
}
