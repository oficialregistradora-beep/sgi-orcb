import { closePool, getPool, query, queryOne } from '../src/server/db.ts';
import { runMigrations } from '../src/server/migrate.ts';
import { loadPrincipal } from '../src/server/authz.ts';
import { createSession, markMfaVerified } from '../src/server/auth/session.ts';
import type { Ctx } from '../src/server/context.ts';
import { invalidateSettingsCache } from '../src/server/settings.ts';
import { addDays, localToInstant, todayLocal, weekdayOf } from '../src/domain/time.ts';

// Todos os dados criados aqui são FICTÍCIOS. Domínio de teste: cartorio-teste.example

export const DOMAIN = 'cartorio-teste.example';

/** Recria o esquema do banco de testes e aplica todas as migrations. */
export async function resetDatabase(): Promise<void> {
  const pool = getPool();
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS btree_gist;');
  await runMigrations(pool);
  invalidateSettingsCache();
}

export { closePool };

export async function ids() {
  const db = getPool();
  const sector = async (code: string) => (await queryOne<{ id: string }>(db, 'SELECT id FROM sectors WHERE code = $1', [code]))!.id;
  const job = async (name: string) => (await queryOne<{ id: string }>(db, 'SELECT id FROM job_titles WHERE name = $1', [name]))!.id;
  const role = async (code: string) => (await queryOne<{ id: string }>(db, 'SELECT id FROM roles WHERE code = $1', [code]))!.id;
  const schedule = (await queryOne<{ id: string }>(db, 'SELECT id FROM work_schedules LIMIT 1'))!.id;
  return {
    sectors: { DIR: await sector('DIR'), ATD: await sector('ATD'), RI: await sector('RI'), RCPN: await sector('RCPN'), RTDPJ: await sector('RTDPJ') },
    jobs: { oficial: await job('Oficial Registradora'), substituta: await job('Substituta Legal'), escrevente: await job('Escrevente Autorizado'), atendente: await job('Atendente') },
    roles: { OFICIAL: await role('OFICIAL'), SUBSTITUTA_LEGAL: await role('SUBSTITUTA_LEGAL'), COORDENACAO_SETOR: await role('COORDENACAO_SETOR'), COLABORADOR: await role('COLABORADOR') },
    schedule,
  };
}

let seq = 0;

/** Cria usuário + funcionário fictício com papéis. */
export async function makePerson(opts: {
  name: string;
  sectorId: string;
  jobId: string;
  roles: { roleId: string; sectorId?: string; validFrom?: string; validUntil?: string }[];
  owner?: boolean;
  admission?: string;
  scheduleId?: string;
  agreementMonths?: number | null;
  allowsNegative?: boolean;
}): Promise<{ userId: string; employeeId: string }> {
  const db = getPool();
  seq += 1;
  const email = `${opts.name.toLowerCase().replace(/[^a-z]/g, '')}${seq}@${DOMAIN}`;
  const admission = opts.admission ?? addDays(todayLocal(), -200);
  const u = (await queryOne<{ id: string }>(db, 'INSERT INTO users (email, display_name, is_owner) VALUES ($1,$2,$3) RETURNING id', [
    email, opts.name, opts.owner ?? false,
  ]))!;
  const e = (await queryOne<{ id: string }>(
    db,
    `INSERT INTO employees (user_id, registration_code, full_name, job_title_id, sector_id, admission_date, contract_type, weekly_hours)
     VALUES ($1,$2,$3,$4,$5,$6,'CLT',40) RETURNING id`,
    [u.id, `M${String(seq).padStart(4, '0')}`, opts.name, opts.jobId, opts.sectorId, admission],
  ))!;
  for (const r of opts.roles) {
    await query(db, 'INSERT INTO user_roles (user_id, role_id, sector_id, valid_from, valid_until) VALUES ($1,$2,$3,$4,$5)', [
      u.id, r.roleId, r.sectorId ?? null, r.validFrom ?? admission, r.validUntil ?? null,
    ]);
  }
  if (opts.scheduleId) {
    await query(db, 'INSERT INTO employee_schedules (employee_id, schedule_id, valid_from) VALUES ($1,$2,$3)', [e.id, opts.scheduleId, admission]);
  }
  if (opts.agreementMonths) {
    await query(
      db,
      `INSERT INTO hour_bank_agreements (employee_id, kind, compensation_months, valid_from, allows_negative_balance, document_reference)
       VALUES ($1,'INDIVIDUAL_ESCRITO',$2,$3,$4,'Acordo fictício de teste')`,
      [e.id, opts.agreementMonths, admission, opts.allowsNegative ?? false],
    );
  }
  return { userId: u.id, employeeId: e.id };
}

/** Contexto autenticado (sessão real no banco), com MFA validado e, opcionalmente, reautenticação recente. */
export async function ctxFor(userId: string, opts: { stepUp?: boolean } = { stepUp: true }): Promise<Ctx> {
  const db = getPool();
  const { sessionId } = await createSession(db, userId, 'DEV', '127.0.0.1', 'vitest');
  await markMfaVerified(db, sessionId);
  if (opts.stepUp === false) await query(db, 'UPDATE sessions SET step_up_at = NULL WHERE id = $1', [sessionId]);
  const principal = await loadPrincipal(db, userId);
  if (!principal) throw new Error('principal inválido');
  return {
    principal, sessionId, authMethod: 'DEV', mfaVerifiedAt: new Date(),
    stepUpAt: opts.stepUp === false ? null : new Date(), ip: '127.0.0.1', userAgent: 'vitest',
  };
}

/** Insere marcações históricas (origem IMPORTACAO) — apenas para montar cenários de teste. */
export async function seedPunches(employeeId: string, date: string, times: string[], createdBy: string): Promise<void> {
  for (const t of times) {
    await query(
      getPool(),
      `INSERT INTO time_punches (employee_id, punched_at, local_date, kind, source, created_by) VALUES ($1,$2,$3,'ADICIONAL','IMPORTACAO',$4)`,
      [employeeId, localToInstant(date, t), date, createdBy],
    );
  }
}

/** Segunda-feira útil (sem feriado) de N semanas atrás. */
export async function pastMonday(weeksAgo: number): Promise<string> {
  let d = addDays(todayLocal(), -7 * weeksAgo);
  while (weekdayOf(d) !== 1) d = addDays(d, -1);
  const holiday = await queryOne(getPool(), 'SELECT 1 FROM holidays WHERE date BETWEEN $1 AND $2', [d, addDays(d, 4)]);
  return holiday ? pastMonday(weeksAgo + 1) : d;
}

export const FULL_DAY = ['08:00', '12:00', '13:00', '17:00'];
