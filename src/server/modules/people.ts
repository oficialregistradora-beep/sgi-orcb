import { z } from 'zod';
import { getConfig } from '../config.ts';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx } from '../context.ts';
import { can, requirePermission, requireStepUp, scopeFilter, scopeSql } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors.ts';
import { decryptField, encryptField, hmacLookup, normalizeCpf } from '../crypto.ts';
import { revokeAllUserSessions } from '../auth/session.ts';
import { addDays, todayLocal } from '../../domain/time.ts';
import { recomputeDays } from './timeclock.ts';
import { createChecklistFromTemplate } from './checklists.ts';

const uuid = z.uuid();
const isoDate = z.iso.date();

export type EmployeeRow = {
  id: string; user_id: string | null; registration_code: string; full_name: string; social_name: string | null;
  job_title_id: string; job_title: string; function_description: string | null; sector_id: string; sector_name: string;
  admission_date: string; termination_date: string | null; contract_type: string; weekly_hours: string; status: string;
  email: string | null; user_status: string | null;
};

const EMPLOYEE_SELECT = `
  SELECT e.id, e.user_id, e.registration_code, e.full_name, e.social_name, e.job_title_id, j.name AS job_title,
         e.function_description, e.sector_id, s.name AS sector_name, e.admission_date, e.termination_date,
         e.contract_type, e.weekly_hours, e.status, u.email, u.status AS user_status
    FROM employees e
    JOIN job_titles j ON j.id = e.job_title_id
    JOIN sectors s ON s.id = e.sector_id
    LEFT JOIN users u ON u.id = e.user_id`;

export async function listEmployees(ctx: Ctx, opts: { includeTerminated?: boolean } = {}, db: Db = getPool()): Promise<EmployeeRow[]> {
  const f = scopeFilter(ctx.principal, 'pessoas.ver');
  if (!f) throw new ForbiddenError();
  const params: unknown[] = [];
  const where = [scopeSql(f, 'e', params)];
  if (!opts.includeTerminated) where.push("e.status <> 'DESLIGADO'");
  return query<EmployeeRow>(db, `${EMPLOYEE_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.full_name`, params);
}

export async function findEmployee(db: Db, id: string): Promise<EmployeeRow> {
  uuid.parse(id);
  const e = await queryOne<EmployeeRow>(db, `${EMPLOYEE_SELECT} WHERE e.id = $1`, [id]);
  if (!e) throw new NotFoundError('Funcionário não encontrado.');
  return e;
}

/** Busca o funcionário e exige a permissão sobre ele (evita acesso indevido por identificador — IDOR). */
export async function getEmployeeFor(ctx: Ctx, permission: string, id: string, db: Db = getPool()): Promise<EmployeeRow> {
  const e = await findEmployee(db, id);
  requirePermission(ctx, permission, { employeeId: e.id, sectorId: e.sector_id });
  return e;
}

const createSchema = z.object({
  registrationCode: z.string().trim().min(1).max(20),
  fullName: z.string().trim().min(3).max(160),
  socialName: z.string().trim().max(160).optional(),
  jobTitleId: uuid,
  functionDescription: z.string().trim().max(300).optional(),
  sectorId: uuid,
  admissionDate: isoDate,
  contractType: z.enum(['CLT', 'ESTAGIO', 'APRENDIZ', 'TEMPORARIO', 'OUTRO']),
  weeklyHours: z.number().positive().max(44),
  email: z.email().transform((v) => v.trim().toLowerCase()).optional(),
  scheduleId: uuid.optional(),
});

/**
 * Admissão: cria o cadastro funcional, o histórico inicial de cargo, a jornada contratual e,
 * se informado o e-mail institucional, o usuário com o papel COLABORADOR — tudo numa única transação.
 */
export async function createEmployee(ctx: Ctx, input: z.input<typeof createSchema>): Promise<string> {
  const d = createSchema.parse(input);
  requirePermission(ctx, 'pessoas.editar', { sectorId: d.sectorId });
  const domain = getConfig().workspaceDomain;
  if (d.email && !d.email.endsWith(`@${domain}`)) throw new AppError(`O e-mail deve pertencer ao domínio @${domain}.`);
  return tx(async (c) => {
    let userId: string | null = null;
    if (d.email) {
      const existing = await queryOne<{ id: string }>(c, 'SELECT id FROM users WHERE email = $1', [d.email]);
      if (existing) {
        const linked = await queryOne(c, 'SELECT 1 FROM employees WHERE user_id = $1', [existing.id]);
        if (linked) throw new ConflictError('Este usuário já está vinculado a outro cadastro funcional.');
        userId = existing.id;
      } else {
        userId = (await queryOne<{ id: string }>(c, 'INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id', [
          d.email, d.socialName || d.fullName,
        ]))!.id;
      }
      await query(
        c,
        `INSERT INTO user_roles (user_id, role_id, valid_from, reason, granted_by)
         SELECT $1, id, $2, 'Admissão — acesso básico de colaborador', $3 FROM roles WHERE code = 'COLABORADOR'`,
        [userId, d.admissionDate, ctx.principal.userId],
      );
    }
    let emp: { id: string } | null;
    try {
      emp = await queryOne<{ id: string }>(
        c,
        `INSERT INTO employees (user_id, registration_code, full_name, social_name, job_title_id, function_description,
                                sector_id, admission_date, contract_type, weekly_hours, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [userId, d.registrationCode, d.fullName, d.socialName || null, d.jobTitleId, d.functionDescription || null,
          d.sectorId, d.admissionDate, d.contractType, d.weeklyHours, ctx.principal.userId],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictError('Matrícula já utilizada.');
      throw e;
    }
    await query(
      c,
      `INSERT INTO job_history (employee_id, job_title_id, sector_id, function_description, start_date, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,'Admissão',$6)`,
      [emp!.id, d.jobTitleId, d.sectorId, d.functionDescription || null, d.admissionDate, ctx.principal.userId],
    );
    if (d.scheduleId) {
      await query(c, 'INSERT INTO employee_schedules (employee_id, schedule_id, valid_from, created_by) VALUES ($1,$2,$3,$4)', [
        emp!.id, d.scheduleId, d.admissionDate, ctx.principal.userId,
      ]);
    }
    await createChecklistFromTemplate(c, ctx.principal.userId, emp!.id, 'ADMISSAO', d.admissionDate);
    await audit(c, ctx, {
      action: 'FUNCIONARIO_ADMITIDO', entityType: 'employee', entityId: emp!.id,
      summary: `Admissão de ${d.fullName} (matrícula ${d.registrationCode})`, data: { ...d },
    });
    return emp!.id;
  });
}

const updateSchema = z.object({
  fullName: z.string().trim().min(3).max(160),
  socialName: z.string().trim().max(160).optional(),
  jobTitleId: uuid,
  functionDescription: z.string().trim().max(300).optional(),
  sectorId: uuid,
  contractType: z.enum(['CLT', 'ESTAGIO', 'APRENDIZ', 'TEMPORARIO', 'OUTRO']),
  weeklyHours: z.number().positive().max(44),
  changeDate: isoDate.optional(),
  changeReason: z.string().trim().max(300).optional(),
});

export async function updateEmployee(ctx: Ctx, id: string, input: z.input<typeof updateSchema>): Promise<void> {
  const d = updateSchema.parse(input);
  const before = await getEmployeeFor(ctx, 'pessoas.editar', id);
  requirePermission(ctx, 'pessoas.editar', { sectorId: d.sectorId });
  if (before.status === 'DESLIGADO') throw new AppError('Cadastro de funcionário desligado não pode ser alterado.');
  await tx(async (c) => {
    await query(
      c,
      `UPDATE employees SET full_name=$2, social_name=$3, job_title_id=$4, function_description=$5, sector_id=$6,
              contract_type=$7, weekly_hours=$8 WHERE id=$1`,
      [id, d.fullName, d.socialName || null, d.jobTitleId, d.functionDescription || null, d.sectorId, d.contractType, d.weeklyHours],
    );
    const careerChanged =
      before.job_title_id !== d.jobTitleId || before.sector_id !== d.sectorId || (before.function_description ?? '') !== (d.functionDescription ?? '');
    if (careerChanged) {
      await query(
        c,
        `INSERT INTO job_history (employee_id, job_title_id, sector_id, function_description, start_date, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, d.jobTitleId, d.sectorId, d.functionDescription || null, d.changeDate ?? todayLocal(), d.changeReason || 'Alteração cadastral', ctx.principal.userId],
      );
    }
    await audit(c, ctx, {
      action: 'FUNCIONARIO_ALTERADO', entityType: 'employee', entityId: id, summary: `Cadastro de ${d.fullName} alterado`,
      data: { before: { jobTitleId: before.job_title_id, sectorId: before.sector_id, weeklyHours: before.weekly_hours }, after: d },
    });
  });
}

export async function getJobHistory(ctx: Ctx, id: string, db: Db = getPool()) {
  await getEmployeeFor(ctx, 'pessoas.ver', id, db);
  return query<{ start_date: string; job_title: string; sector_name: string; function_description: string | null; reason: string | null }>(
    db,
    `SELECT h.start_date, j.name AS job_title, s.name AS sector_name, h.function_description, h.reason
       FROM job_history h JOIN job_titles j ON j.id = h.job_title_id JOIN sectors s ON s.id = h.sector_id
      WHERE h.employee_id = $1 ORDER BY h.start_date DESC, h.created_at DESC`,
    [id],
  );
}

// ---------------------------------------------------------------------------
// Dados sensíveis (LGPD): acesso restrito, criptografado e com registro de cada consulta
// ---------------------------------------------------------------------------
export type SensitiveData = {
  cpf: string | null; rg: string | null; birthDate: string | null; address: string | null; phone: string | null;
  personalEmail: string | null; bankAccount: string | null; emergencyContact: string | null; healthNotes: string | null;
};

const SENSITIVE_FIELDS = [
  ['cpf', 'cpf_enc'], ['rg', 'rg_enc'], ['birthDate', 'birth_date_enc'], ['address', 'address_enc'], ['phone', 'phone_enc'],
  ['personalEmail', 'personal_email_enc'], ['bankAccount', 'bank_account_enc'], ['emergencyContact', 'emergency_contact_enc'],
  ['healthNotes', 'health_notes_enc'],
] as const;

export async function getSensitiveData(ctx: Ctx, id: string): Promise<SensitiveData> {
  const e = await getEmployeeFor(ctx, 'pessoas.sensiveis.ver', id);
  return tx(async (c) => {
    const row = await queryOne<Record<string, string | null>>(c, 'SELECT * FROM employee_sensitive WHERE employee_id = $1', [id]);
    await audit(c, ctx, { action: 'DADO_SENSIVEL_CONSULTADO', entityType: 'employee', entityId: id, summary: `Consulta a dados sensíveis de ${e.full_name}` });
    const out = {} as SensitiveData;
    for (const [k, col] of SENSITIVE_FIELDS) out[k] = decryptField(row?.[col] ?? null);
    return out;
  });
}

const sensitiveSchema = z.object({
  cpf: z.string().trim().max(20).optional(),
  rg: z.string().trim().max(30).optional(),
  birthDate: isoDate.or(z.literal('')).optional(),
  address: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(30).optional(),
  personalEmail: z.email().or(z.literal('')).optional(),
  bankAccount: z.string().trim().max(120).optional(),
  emergencyContact: z.string().trim().max(200).optional(),
  healthNotes: z.string().trim().max(1000).optional(),
});

export async function updateSensitiveData(ctx: Ctx, id: string, input: z.input<typeof sensitiveSchema>): Promise<void> {
  const d = sensitiveSchema.parse(input);
  const e = await getEmployeeFor(ctx, 'pessoas.sensiveis.editar', id);
  await requireStepUp(getPool(), ctx);
  let cpfDigits: string | null = null;
  if (d.cpf) {
    cpfDigits = normalizeCpf(d.cpf);
    if (!cpfDigits) throw new AppError('CPF inválido.');
  }
  const values: Record<string, string | null> = {};
  for (const [k, col] of SENSITIVE_FIELDS) values[col] = encryptField(k === 'cpf' ? cpfDigits : (d[k] ?? null));
  await tx(async (c) => {
    try {
      await query(
        c,
        `INSERT INTO employee_sensitive (employee_id, cpf_enc, cpf_hmac, rg_enc, birth_date_enc, address_enc, phone_enc,
           personal_email_enc, bank_account_enc, emergency_contact_enc, health_notes_enc, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         ON CONFLICT (employee_id) DO UPDATE SET cpf_enc=EXCLUDED.cpf_enc, cpf_hmac=EXCLUDED.cpf_hmac, rg_enc=EXCLUDED.rg_enc,
           birth_date_enc=EXCLUDED.birth_date_enc, address_enc=EXCLUDED.address_enc, phone_enc=EXCLUDED.phone_enc,
           personal_email_enc=EXCLUDED.personal_email_enc, bank_account_enc=EXCLUDED.bank_account_enc,
           emergency_contact_enc=EXCLUDED.emergency_contact_enc, health_notes_enc=EXCLUDED.health_notes_enc,
           updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [id, values.cpf_enc, cpfDigits ? hmacLookup(cpfDigits) : null, values.rg_enc, values.birth_date_enc, values.address_enc,
          values.phone_enc, values.personal_email_enc, values.bank_account_enc, values.emergency_contact_enc, values.health_notes_enc,
          ctx.principal.userId],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ConflictError('CPF já cadastrado para outro funcionário.');
      throw err;
    }
    await audit(c, ctx, {
      action: 'DADO_SENSIVEL_ALTERADO', entityType: 'employee', entityId: id, summary: `Dados sensíveis de ${e.full_name} atualizados`,
      data: Object.fromEntries(Object.keys(d).map((k) => [k, d[k as keyof typeof d]])),
    });
  });
}

// ---------------------------------------------------------------------------
// Histórico salarial (restrito)
// ---------------------------------------------------------------------------
export async function listSalaryHistory(ctx: Ctx, id: string) {
  const e = await getEmployeeFor(ctx, 'pessoas.salario.ver', id);
  return tx(async (c) => {
    const rows = await query<{ monthly_amount: string; effective_date: string; reason: string | null; created_at: Date }>(
      c, 'SELECT monthly_amount, effective_date, reason, created_at FROM salary_history WHERE employee_id = $1 ORDER BY effective_date DESC', [id]);
    await audit(c, ctx, { action: 'SALARIO_CONSULTADO', entityType: 'employee', entityId: id, summary: `Consulta ao histórico salarial de ${e.full_name}` });
    return rows;
  });
}

const salarySchema = z.object({
  monthlyAmount: z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Use o formato 1234.56'),
  effectiveDate: isoDate,
  reason: z.string().trim().min(3).max(300),
});

export async function addSalary(ctx: Ctx, id: string, input: z.input<typeof salarySchema>): Promise<void> {
  const d = salarySchema.parse(input);
  const e = await getEmployeeFor(ctx, 'pessoas.salario.editar', id);
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    await query(c, 'INSERT INTO salary_history (employee_id, monthly_amount, effective_date, reason, created_by) VALUES ($1,$2,$3,$4,$5)', [
      id, d.monthlyAmount, d.effectiveDate, d.reason, ctx.principal.userId,
    ]).catch((err: { code?: string }) => {
      if (err.code === '23505') throw new ConflictError('Já existe registro salarial nesta data de vigência.');
      throw err;
    });
    await audit(c, ctx, { action: 'SALARIO_REGISTRADO', entityType: 'employee', entityId: id, summary: `Alteração salarial de ${e.full_name} a partir de ${d.effectiveDate}`, data: d });
  });
}

export async function currentSalary(db: Db, employeeId: string, onDate: string): Promise<string | null> {
  const r = await queryOne<{ monthly_amount: string }>(
    db, 'SELECT monthly_amount FROM salary_history WHERE employee_id = $1 AND effective_date <= $2 ORDER BY effective_date DESC LIMIT 1', [employeeId, onDate]);
  return r?.monthly_amount ?? null;
}

// ---------------------------------------------------------------------------
// Jornada contratual, acordos de banco de horas e ausências
// ---------------------------------------------------------------------------
export async function getEmployeeSchedules(db: Db, employeeId: string) {
  return query<{ id: string; schedule_id: string; name: string; valid_from: string; valid_until: string | null }>(
    db,
    `SELECT es.id, es.schedule_id, ws.name, es.valid_from, es.valid_until FROM employee_schedules es
       JOIN work_schedules ws ON ws.id = es.schedule_id WHERE es.employee_id = $1 ORDER BY es.valid_from DESC`,
    [employeeId],
  );
}

export async function assignSchedule(ctx: Ctx, employeeId: string, scheduleId: string, validFrom: string): Promise<void> {
  uuid.parse(scheduleId);
  isoDate.parse(validFrom);
  const e = await getEmployeeFor(ctx, 'jornada.escalas.gerenciar', employeeId);
  if (validFrom < e.admission_date) throw new AppError('A vigência não pode ser anterior à admissão.');
  await tx(async (c) => {
    const later = await queryOne(c, 'SELECT 1 FROM employee_schedules WHERE employee_id = $1 AND valid_from >= $2', [employeeId, validFrom]);
    if (later) throw new ConflictError('Já existe jornada com vigência igual ou posterior a esta data.');
    await query(c, `UPDATE employee_schedules SET valid_until = $2 WHERE employee_id = $1 AND (valid_until IS NULL OR valid_until >= $3)`, [
      employeeId, addDays(validFrom, -1), validFrom,
    ]);
    await query(c, 'INSERT INTO employee_schedules (employee_id, schedule_id, valid_from, created_by) VALUES ($1,$2,$3,$4)', [
      employeeId, scheduleId, validFrom, ctx.principal.userId,
    ]);
    await audit(c, ctx, { action: 'JORNADA_ATRIBUIDA', entityType: 'employee', entityId: employeeId, summary: `Nova jornada contratual a partir de ${validFrom}`, data: { scheduleId, validFrom } });
    await recomputeDays(c, ctx, employeeId, validFrom, addDays(todayLocal(), -1));
  });
}

export async function listAgreements(db: Db, employeeId: string) {
  return query<{
    id: string; kind: string; compensation_months: number; valid_from: string; valid_until: string | null;
    allows_negative_balance: boolean; max_daily_extra_minutes: number; document_reference: string | null; revoked_at: Date | null;
  }>(db, 'SELECT * FROM hour_bank_agreements WHERE employee_id = $1 ORDER BY valid_from DESC', [employeeId]);
}

const agreementSchema = z.object({
  kind: z.enum(['INDIVIDUAL_ESCRITO', 'COLETIVO']),
  compensationMonths: z.number().int().min(1).max(12),
  validFrom: isoDate,
  validUntil: isoDate.nullable().optional(),
  allowsNegativeBalance: z.boolean().default(false),
  maxDailyExtraMinutes: z.number().int().min(0).max(240).default(120),
  documentReference: z.string().trim().min(3).max(300),
  notes: z.string().trim().max(500).optional(),
});

/** Cadastra o acordo de banco de horas. Acordo individual escrito: compensação em até 6 meses (CLT art. 59 §5º). */
export async function createAgreement(ctx: Ctx, employeeId: string, input: z.input<typeof agreementSchema>): Promise<string> {
  const d = agreementSchema.parse(input);
  if (d.kind === 'INDIVIDUAL_ESCRITO' && d.compensationMonths > 6) {
    throw new AppError('Acordo individual escrito admite compensação em no máximo 6 meses (CLT, art. 59, §5º).');
  }
  const e = await getEmployeeFor(ctx, 'banco.acordos.gerenciar', employeeId);
  await requireStepUp(getPool(), ctx);
  return tx(async (c) => {
    const overlap = await queryOne(
      c,
      `SELECT 1 FROM hour_bank_agreements WHERE employee_id = $1 AND revoked_at IS NULL
         AND daterange(valid_from, valid_until, '[]') && daterange($2::date, $3::date, '[]')`,
      [employeeId, d.validFrom, d.validUntil ?? null],
    );
    if (overlap) throw new ConflictError('Já existe acordo vigente no período. Revogue-o ou ajuste a vigência.');
    const r = await queryOne<{ id: string }>(
      c,
      `INSERT INTO hour_bank_agreements (employee_id, kind, compensation_months, valid_from, valid_until, allows_negative_balance,
                                         max_daily_extra_minutes, document_reference, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [employeeId, d.kind, d.compensationMonths, d.validFrom, d.validUntil ?? null, d.allowsNegativeBalance, d.maxDailyExtraMinutes,
        d.documentReference, d.notes ?? null, ctx.principal.userId],
    );
    await audit(c, ctx, { action: 'ACORDO_BANCO_CADASTRADO', entityType: 'employee', entityId: employeeId, summary: `Acordo de banco de horas de ${e.full_name} (${d.compensationMonths} meses)`, data: d });
    return r!.id;
  });
}

export async function revokeAgreement(ctx: Ctx, agreementId: string, endDate: string): Promise<void> {
  uuid.parse(agreementId);
  isoDate.parse(endDate);
  const a = await queryOne<{ employee_id: string; valid_from: string }>(getPool(), 'SELECT employee_id, valid_from FROM hour_bank_agreements WHERE id = $1', [agreementId]);
  if (!a) throw new NotFoundError();
  await getEmployeeFor(ctx, 'banco.acordos.gerenciar', a.employee_id);
  await requireStepUp(getPool(), ctx);
  if (endDate < a.valid_from) throw new AppError('Data final anterior ao início do acordo.');
  await tx(async (c) => {
    await query(c, 'UPDATE hour_bank_agreements SET valid_until = $2 WHERE id = $1', [agreementId, endDate]);
    await audit(c, ctx, { action: 'ACORDO_BANCO_ENCERRADO', entityType: 'employee', entityId: a.employee_id, summary: `Acordo de banco de horas encerrado em ${endDate}` });
  });
}

export async function listAbsences(db: Db, employeeId: string) {
  return query<{ id: string; type: string; start_date: string; end_date: string; counts_as_worked: boolean; notes: string | null; status: string }>(
    db, 'SELECT id, type, start_date, end_date, counts_as_worked, notes, status FROM absences WHERE employee_id = $1 ORDER BY start_date DESC', [employeeId]);
}

const absenceSchema = z.object({
  type: z.enum(['FERIAS', 'ATESTADO_MEDICO', 'LICENCA_MATERNIDADE', 'LICENCA_PATERNIDADE', 'LICENCA_OUTRA', 'FALTA_JUSTIFICADA', 'AFASTAMENTO_INSS', 'OUTRO']),
  startDate: isoDate,
  endDate: isoDate,
  countsAsWorked: z.boolean().default(true),
  notes: z.string().trim().max(500).optional(),
});

export async function addAbsence(ctx: Ctx, employeeId: string, input: z.input<typeof absenceSchema>): Promise<string> {
  const d = absenceSchema.parse(input);
  if (d.endDate < d.startDate) throw new AppError('A data final é anterior à inicial.');
  const e = await getEmployeeFor(ctx, 'jornada.ausencias.gerenciar', employeeId);
  return tx(async (c) => {
    const overlap = await queryOne(
      c,
      `SELECT 1 FROM absences WHERE employee_id = $1 AND status = 'ATIVA' AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')`,
      [employeeId, d.startDate, d.endDate],
    );
    if (overlap) throw new ConflictError('Já existe ausência lançada que se sobrepõe a este período.');
    const r = await queryOne<{ id: string }>(
      c,
      'INSERT INTO absences (employee_id, type, start_date, end_date, counts_as_worked, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [employeeId, d.type, d.startDate, d.endDate, d.countsAsWorked, d.notes ?? null, ctx.principal.userId],
    );
    await audit(c, ctx, { action: 'AUSENCIA_LANCADA', entityType: 'employee', entityId: employeeId, summary: `${d.type} de ${e.full_name}: ${d.startDate} a ${d.endDate}`, data: d });
    await recomputeDays(c, ctx, employeeId, d.startDate, d.endDate);
    return r!.id;
  });
}

export async function cancelAbsence(ctx: Ctx, absenceId: string, reason: string): Promise<void> {
  uuid.parse(absenceId);
  if (reason.trim().length < 5) throw new AppError('Informe o motivo.');
  const a = await queryOne<{ employee_id: string; start_date: string; end_date: string }>(
    getPool(), "SELECT employee_id, start_date, end_date FROM absences WHERE id = $1 AND status = 'ATIVA'", [absenceId]);
  if (!a) throw new NotFoundError();
  await getEmployeeFor(ctx, 'jornada.ausencias.gerenciar', a.employee_id);
  await tx(async (c) => {
    await query(c, "UPDATE absences SET status = 'CANCELADA', cancelled_by = $2, cancelled_at = now() WHERE id = $1", [absenceId, ctx.principal.userId]);
    await audit(c, ctx, { action: 'AUSENCIA_CANCELADA', entityType: 'employee', entityId: a.employee_id, summary: `Ausência ${a.start_date}–${a.end_date} cancelada`, data: { reason } });
    await recomputeDays(c, ctx, a.employee_id, a.start_date, a.end_date);
  });
}

// ---------------------------------------------------------------------------
// Desligamento
// ---------------------------------------------------------------------------
const terminationSchema = z.object({ terminationDate: isoDate, reason: z.string().trim().min(5).max(500) });

/**
 * Desligamento: encerra vínculo, revoga acesso e sessões imediatamente, encerra jornada e acordo.
 * Os registros são PRESERVADOS (retenção legal) e o saldo do banco de horas é sinalizado para apuração rescisória.
 */
export async function terminateEmployee(ctx: Ctx, id: string, input: z.input<typeof terminationSchema>): Promise<void> {
  const d = terminationSchema.parse(input);
  const e = await getEmployeeFor(ctx, 'pessoas.editar', id);
  if (e.status === 'DESLIGADO') throw new AppError('Funcionário já desligado.');
  if (d.terminationDate < e.admission_date) throw new AppError('Data de desligamento anterior à admissão.');
  if (e.user_id === ctx.principal.userId) throw new ForbiddenError('Não é permitido registrar o próprio desligamento.');
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    await query(c, "UPDATE employees SET status = 'DESLIGADO', termination_date = $2 WHERE id = $1", [id, d.terminationDate]);
    await query(c, 'UPDATE employee_schedules SET valid_until = $2 WHERE employee_id = $1 AND (valid_until IS NULL OR valid_until > $2) AND valid_from <= $2', [id, d.terminationDate]);
    await query(c, 'UPDATE hour_bank_agreements SET valid_until = $2 WHERE employee_id = $1 AND revoked_at IS NULL AND (valid_until IS NULL OR valid_until > $2) AND valid_from <= $2', [id, d.terminationDate]);
    if (e.user_id) {
      await query(c, "UPDATE users SET status = 'REVOGADO' WHERE id = $1", [e.user_id]);
      await query(c, 'UPDATE user_roles SET revoked_at = now(), revoked_by = $2 WHERE user_id = $1 AND revoked_at IS NULL', [e.user_id, ctx.principal.userId]);
      await revokeAllUserSessions(c, e.user_id, 'DESLIGAMENTO');
    }
    await createChecklistFromTemplate(c, ctx.principal.userId, id, 'DESLIGAMENTO', d.terminationDate);
    await audit(c, ctx, {
      action: 'FUNCIONARIO_DESLIGADO', entityType: 'employee', entityId: id,
      summary: `Desligamento de ${e.full_name} em ${d.terminationDate}; acessos revogados; saldo do banco sinalizado para apuração rescisória`,
      data: d,
    });
  });
}
