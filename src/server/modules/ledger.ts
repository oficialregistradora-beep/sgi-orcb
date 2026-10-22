import { type Db, query, queryOne } from '../db.ts';
import { AppError } from '../errors.ts';
import {
  allocateFifo,
  buildLots,
  creditExpiry,
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

type Origin = { occurrenceId?: string | null; requestId?: string | null; notes: string; userId: string };

export async function insertCredit(
  db: Db,
  p: Origin & { employeeId: string; agreement: Agreement; date: string; minutes: number },
): Promise<string> {
  if (!Number.isInteger(p.minutes) || p.minutes <= 0) throw new AppError('Crédito inválido.');
  await lockBank(db, p.employeeId);
  const r = await queryOne<{ id: string }>(
    db,
    `INSERT INTO hour_bank_entries (employee_id, agreement_id, entry_date, kind, minutes, expires_on, occurrence_id, request_id, notes, created_by)
     VALUES ($1,$2,$3,'CREDITO',$4,$5,$6,$7,$8,$9) RETURNING id`,
    [p.employeeId, p.agreement.id, p.date, p.minutes, creditExpiry(p.date, p.agreement.compensation_months),
      p.occurrenceId ?? null, p.requestId ?? null, p.notes, p.userId],
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
