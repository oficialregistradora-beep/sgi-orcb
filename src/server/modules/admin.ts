import { z } from 'zod';
import { getConfig } from '../config.ts';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx } from '../context.ts';
import { can, requirePermission, requireStepUp } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors.ts';
import { revokeAllUserSessions } from '../auth/session.ts';
import { invalidateSettingsCache } from '../settings.ts';
import { parseHHMM } from '../../domain/time.ts';

const uuid = z.uuid();
const isoDate = z.iso.date();

// ---------------------------------------------------------------------------
// Usuários
// ---------------------------------------------------------------------------
export type UserListItem = {
  id: string; email: string; display_name: string; status: string; is_owner: boolean;
  mfa_enabled: boolean; last_login_at: Date | null; employee_id: string | null; employee_name: string | null;
};

export async function listUsers(ctx: Ctx, db: Db = getPool()): Promise<UserListItem[]> {
  if (!can(ctx.principal, 'usuarios.gerenciar') && !can(ctx.principal, 'permissoes.gerenciar')) throw new ForbiddenError();
  return query<UserListItem>(
    db,
    `SELECT u.id, u.email, u.display_name, u.status, u.is_owner, (u.totp_enabled_at IS NOT NULL) AS mfa_enabled,
            u.last_login_at, e.id AS employee_id, e.full_name AS employee_name
       FROM users u LEFT JOIN employees e ON e.user_id = u.id
      ORDER BY u.status, u.display_name`,
  );
}

const createUserSchema = z.object({
  email: z.email().transform((v) => v.trim().toLowerCase()),
  displayName: z.string().trim().min(2).max(120),
});

export async function createUser(ctx: Ctx, input: z.input<typeof createUserSchema>): Promise<string> {
  requirePermission(ctx, 'usuarios.gerenciar');
  const data = createUserSchema.parse(input);
  const domain = getConfig().workspaceDomain;
  if (!data.email.endsWith(`@${domain}`)) throw new AppError(`O e-mail deve pertencer ao domínio institucional (@${domain}).`);
  await requireStepUp(getPool(), ctx);
  return tx(async (c) => {
    const exists = await queryOne(c, 'SELECT 1 FROM users WHERE email = $1', [data.email]);
    if (exists) throw new ConflictError('Já existe usuário com este e-mail.');
    const u = await queryOne<{ id: string }>(c, 'INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id', [
      data.email,
      data.displayName,
    ]);
    await audit(c, ctx, { action: 'USUARIO_CRIADO', entityType: 'user', entityId: u!.id, summary: `Usuário ${data.email} criado`, data });
    return u!.id;
  });
}

const statusSchema = z.object({
  userId: uuid,
  status: z.enum(['ATIVO', 'SUSPENSO', 'REVOGADO']),
  reason: z.string().trim().min(5).max(500),
});

/** Suspensão/revogação têm efeito imediato: todas as sessões do usuário são encerradas. */
export async function setUserStatus(ctx: Ctx, input: z.input<typeof statusSchema>): Promise<void> {
  requirePermission(ctx, 'usuarios.gerenciar');
  const data = statusSchema.parse(input);
  if (data.userId === ctx.principal.userId) throw new AppError('Não é permitido alterar a situação do próprio usuário.');
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    const u = await queryOne<{ is_owner: boolean; status: string; email: string }>(
      c, 'SELECT is_owner, status, email FROM users WHERE id = $1 FOR UPDATE', [data.userId]);
    if (!u) throw new NotFoundError();
    if (u.is_owner) throw new ForbiddenError('A conta da Oficial Registradora não pode ser suspensa por outro usuário.');
    await query(c, 'UPDATE users SET status = $2 WHERE id = $1', [data.userId, data.status]);
    let revoked = 0;
    if (data.status !== 'ATIVO') revoked = await revokeAllUserSessions(c, data.userId, `ACESSO_${data.status}`);
    await audit(c, ctx, {
      action: 'USUARIO_SITUACAO', entityType: 'user', entityId: data.userId,
      summary: `Situação de ${u.email}: ${u.status} → ${data.status}${revoked ? ` (${revoked} sessão(ões) encerrada(s))` : ''}`,
      data: { reason: data.reason },
    });
  });
}

/** Redefine o autenticador (perda de celular). O usuário cadastrará um novo no próximo acesso. */
export async function resetUserMfa(ctx: Ctx, userId: string, reason: string): Promise<void> {
  requirePermission(ctx, 'usuarios.gerenciar');
  uuid.parse(userId);
  if (reason.trim().length < 5) throw new AppError('Informe o motivo.');
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    const u = await queryOne<{ email: string }>(c, 'SELECT email FROM users WHERE id = $1', [userId]);
    if (!u) throw new NotFoundError();
    await query(c, `UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL,
                    mfa_failed_count = 0, mfa_locked_until = NULL WHERE id = $1`, [userId]);
    await revokeAllUserSessions(c, userId, 'MFA_REDEFINIDO');
    await audit(c, ctx, { action: 'USUARIO_MFA_REDEFINIDO', entityType: 'user', entityId: userId, summary: `Autenticador de ${u.email} redefinido`, data: { reason } });
  });
}

// ---------------------------------------------------------------------------
// Papéis e permissões
// ---------------------------------------------------------------------------
export type PermissionRow = { code: string; module: string; description: string; sensitive: boolean; scopable: boolean };
export type RoleRow = { id: string; code: string; name: string; description: string | null; is_system: boolean; permissions: Record<string, string> };

export async function listPermissionsAndRoles(ctx: Ctx, db: Db = getPool()) {
  if (!can(ctx.principal, 'permissoes.gerenciar') && !can(ctx.principal, 'usuarios.gerenciar')) throw new ForbiddenError();
  const permissions = await query<PermissionRow>(db, 'SELECT * FROM permissions ORDER BY module, code');
  const roles = await query<RoleRow>(
    db,
    `SELECT r.id, r.code, r.name, r.description, r.is_system,
            coalesce(jsonb_object_agg(rp.permission_code, rp.scope) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
      GROUP BY r.id ORDER BY r.is_system DESC, r.name`,
  );
  return { permissions, roles };
}

const roleSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z_]{2,40}$/, 'Use letras maiúsculas e _'),
  name: z.string().trim().min(3).max(80),
  description: z.string().trim().max(300).optional(),
});

export async function createRole(ctx: Ctx, input: z.input<typeof roleSchema>): Promise<string> {
  requirePermission(ctx, 'permissoes.gerenciar');
  const data = roleSchema.parse(input);
  await requireStepUp(getPool(), ctx);
  return tx(async (c) => {
    const r = await queryOne<{ id: string }>(c, 'INSERT INTO roles (code, name, description) VALUES ($1,$2,$3) RETURNING id', [
      data.code, data.name, data.description ?? null,
    ]).catch((e: { code?: string }) => {
      if (e.code === '23505') throw new ConflictError('Já existe papel com este código ou nome.');
      throw e;
    });
    await audit(c, ctx, { action: 'PAPEL_CRIADO', entityType: 'role', entityId: r!.id, summary: `Papel ${data.name} criado`, data });
    return r!.id;
  });
}

const rolePermSchema = z.object({
  roleId: uuid,
  permissionCode: z.string().min(3),
  scope: z.enum(['PROPRIO', 'SETOR', 'TODOS']).nullable(),
});

/** Concede, altera ou remove (scope = null) uma permissão de um papel. */
export async function setRolePermission(ctx: Ctx, input: z.input<typeof rolePermSchema>): Promise<void> {
  requirePermission(ctx, 'permissoes.gerenciar');
  const data = rolePermSchema.parse(input);
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    const role = await queryOne<{ code: string; name: string }>(c, 'SELECT code, name FROM roles WHERE id = $1', [data.roleId]);
    if (!role) throw new NotFoundError('Papel não encontrado.');
    if (role.code === 'OFICIAL') throw new ForbiddenError('O papel da Oficial Registradora não pode ser alterado.');
    const perm = await queryOne<{ scopable: boolean }>(c, 'SELECT scopable FROM permissions WHERE code = $1', [data.permissionCode]);
    if (!perm) throw new NotFoundError('Permissão inexistente.');
    if (data.scope && !perm.scopable && data.scope !== 'TODOS') throw new AppError('Esta permissão é global: use o escopo TODOS.');
    const before = await queryOne<{ scope: string }>(c, 'SELECT scope FROM role_permissions WHERE role_id = $1 AND permission_code = $2', [
      data.roleId, data.permissionCode,
    ]);
    if (data.scope === null) {
      await query(c, 'DELETE FROM role_permissions WHERE role_id = $1 AND permission_code = $2', [data.roleId, data.permissionCode]);
    } else {
      await query(
        c,
        `INSERT INTO role_permissions (role_id, permission_code, scope) VALUES ($1,$2,$3)
         ON CONFLICT (role_id, permission_code) DO UPDATE SET scope = EXCLUDED.scope`,
        [data.roleId, data.permissionCode, data.scope],
      );
    }
    await audit(c, ctx, {
      action: 'PAPEL_PERMISSAO', entityType: 'role', entityId: data.roleId,
      summary: `${role.name}: ${data.permissionCode} ${before?.scope ?? '—'} → ${data.scope ?? '—'}`,
      data: { permission: data.permissionCode, before: before?.scope ?? null, after: data.scope },
    });
  });
}

export type UserRoleRow = {
  id: string; user_id: string; role_id: string; role_name: string; sector_id: string | null; sector_name: string | null;
  valid_from: string; valid_until: string | null; reason: string | null; granted_at: Date; revoked_at: Date | null;
};

export async function listUserRoles(ctx: Ctx, userId: string, db: Db = getPool()): Promise<UserRoleRow[]> {
  if (!can(ctx.principal, 'permissoes.gerenciar') && !can(ctx.principal, 'usuarios.gerenciar')) throw new ForbiddenError();
  return query<UserRoleRow>(
    db,
    `SELECT ur.id, ur.user_id, ur.role_id, r.name AS role_name, ur.sector_id, s.name AS sector_name, ur.valid_from,
            ur.valid_until, ur.reason, ur.granted_at, ur.revoked_at
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id LEFT JOIN sectors s ON s.id = ur.sector_id
      WHERE ur.user_id = $1 ORDER BY ur.revoked_at NULLS FIRST, ur.granted_at DESC`,
    [userId],
  );
}

const assignSchema = z.object({
  userId: uuid,
  roleId: uuid,
  sectorId: uuid.nullable().optional(),
  validFrom: isoDate,
  validUntil: isoDate.nullable().optional(),
  reason: z.string().trim().min(5).max(500),
});

/** Atribui papel (inclusive substituições temporárias, com vigência). */
export async function assignRole(ctx: Ctx, input: z.input<typeof assignSchema>): Promise<string> {
  requirePermission(ctx, 'permissoes.gerenciar');
  const data = assignSchema.parse(input);
  if (data.validUntil && data.validUntil < data.validFrom) throw new AppError('A vigência final é anterior à inicial.');
  if (data.userId === ctx.principal.userId && !ctx.principal.isOwner) {
    throw new ForbiddenError('Não é permitido atribuir papéis a si mesmo (segregação de funções).');
  }
  await requireStepUp(getPool(), ctx);
  return tx(async (c) => {
    const role = await queryOne<{ name: string; code: string }>(c, 'SELECT name, code FROM roles WHERE id = $1', [data.roleId]);
    if (!role) throw new NotFoundError('Papel não encontrado.');
    if (role.code === 'OFICIAL') throw new ForbiddenError('O papel da Oficial Registradora não é atribuível.');
    const r = await queryOne<{ id: string }>(
      c,
      `INSERT INTO user_roles (user_id, role_id, sector_id, valid_from, valid_until, reason, granted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [data.userId, data.roleId, data.sectorId ?? null, data.validFrom, data.validUntil ?? null, data.reason, ctx.principal.userId],
    );
    await audit(c, ctx, {
      action: 'PAPEL_ATRIBUIDO', entityType: 'user', entityId: data.userId,
      summary: `Papel ${role.name} atribuído (${data.validFrom}${data.validUntil ? ` a ${data.validUntil}` : ', sem termo final'})`,
      data: { ...data },
    });
    return r!.id;
  });
}

export async function revokeUserRole(ctx: Ctx, userRoleId: string, reason: string): Promise<void> {
  requirePermission(ctx, 'permissoes.gerenciar');
  uuid.parse(userRoleId);
  if (reason.trim().length < 5) throw new AppError('Informe o motivo.');
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    const ur = await queryOne<{ user_id: string; role_name: string }>(
      c,
      `UPDATE user_roles ur SET revoked_at = now(), revoked_by = $2 FROM roles r
        WHERE ur.id = $1 AND r.id = ur.role_id AND ur.revoked_at IS NULL RETURNING ur.user_id, r.name AS role_name`,
      [userRoleId, ctx.principal.userId],
    );
    if (!ur) throw new NotFoundError('Atribuição não encontrada ou já revogada.');
    await audit(c, ctx, { action: 'PAPEL_REVOGADO', entityType: 'user', entityId: ur.user_id, summary: `Papel ${ur.role_name} revogado`, data: { reason } });
  });
}

// ---------------------------------------------------------------------------
// Setores e cargos
// ---------------------------------------------------------------------------
export type SectorRow = { id: string; code: string; name: string; parent_id: string | null; active: boolean; employees: number };

export async function listSectors(db: Db = getPool()): Promise<SectorRow[]> {
  return query<SectorRow>(
    db,
    `SELECT s.id, s.code, s.name, s.parent_id, s.active,
            (SELECT count(*)::int FROM employees e WHERE e.sector_id = s.id AND e.status <> 'DESLIGADO') AS employees
       FROM sectors s ORDER BY s.active DESC, s.name`,
  );
}

const sectorSchema = z.object({
  id: uuid.optional(),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,20}$/, 'Código: 2 a 20 letras maiúsculas, números ou _'),
  name: z.string().trim().min(2).max(120),
  parentId: uuid.nullable().optional(),
  active: z.boolean().default(true),
});

export async function saveSector(ctx: Ctx, input: z.input<typeof sectorSchema>): Promise<string> {
  requirePermission(ctx, 'configuracoes.gerenciar');
  const d = sectorSchema.parse(input);
  if (d.id && d.parentId === d.id) throw new AppError('Um setor não pode ser subordinado a si mesmo.');
  return tx(async (c) => {
    try {
      const row = d.id
        ? await queryOne<{ id: string }>(c, 'UPDATE sectors SET code=$2, name=$3, parent_id=$4, active=$5 WHERE id=$1 RETURNING id', [
            d.id, d.code, d.name, d.parentId ?? null, d.active,
          ])
        : await queryOne<{ id: string }>(c, 'INSERT INTO sectors (code, name, parent_id, active) VALUES ($1,$2,$3,$4) RETURNING id', [
            d.code, d.name, d.parentId ?? null, d.active,
          ]);
      if (!row) throw new NotFoundError();
      await audit(c, ctx, { action: d.id ? 'SETOR_ALTERADO' : 'SETOR_CRIADO', entityType: 'sector', entityId: row.id, summary: `Setor ${d.name}`, data: d });
      return row.id;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictError('Já existe setor com este código ou nome.');
      throw e;
    }
  });
}

export async function listJobTitles(db: Db = getPool()) {
  return query<{ id: string; name: string; description: string | null; active: boolean }>(
    db, 'SELECT id, name, description, active FROM job_titles ORDER BY active DESC, name');
}

const jobSchema = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional(),
  active: z.boolean().default(true),
});

export async function saveJobTitle(ctx: Ctx, input: z.input<typeof jobSchema>): Promise<string> {
  requirePermission(ctx, 'configuracoes.gerenciar');
  const d = jobSchema.parse(input);
  return tx(async (c) => {
    try {
      const row = d.id
        ? await queryOne<{ id: string }>(c, 'UPDATE job_titles SET name=$2, description=$3, active=$4 WHERE id=$1 RETURNING id', [
            d.id, d.name, d.description ?? null, d.active])
        : await queryOne<{ id: string }>(c, 'INSERT INTO job_titles (name, description, active) VALUES ($1,$2,$3) RETURNING id', [
            d.name, d.description ?? null, d.active]);
      if (!row) throw new NotFoundError();
      await audit(c, ctx, { action: d.id ? 'CARGO_ALTERADO' : 'CARGO_CRIADO', entityType: 'job_title', entityId: row.id, summary: `Cargo ${d.name}`, data: d });
      return row.id;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictError('Já existe cargo com este nome.');
      throw e;
    }
  });
}

// ---------------------------------------------------------------------------
// Jornadas contratuais e feriados
// ---------------------------------------------------------------------------
export type ScheduleWithDays = {
  id: string; name: string; description: string | null; tolerance_enabled: boolean; tolerance_per_mark_minutes: number;
  tolerance_daily_minutes: number; active: boolean;
  days: { weekday: number; start_time: string; break_start: string | null; break_end: string | null; end_time: string }[];
};

export async function listSchedules(db: Db = getPool()): Promise<ScheduleWithDays[]> {
  return query<ScheduleWithDays>(
    db,
    `SELECT ws.*, coalesce(jsonb_agg(jsonb_build_object('weekday', d.weekday, 'start_time', to_char(d.start_time,'HH24:MI'),
              'break_start', to_char(d.break_start,'HH24:MI'), 'break_end', to_char(d.break_end,'HH24:MI'),
              'end_time', to_char(d.end_time,'HH24:MI')) ORDER BY d.weekday) FILTER (WHERE d.weekday IS NOT NULL), '[]') AS days
       FROM work_schedules ws LEFT JOIN work_schedule_days d ON d.schedule_id = ws.id
      GROUP BY ws.id ORDER BY ws.active DESC, ws.name`,
  );
}

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const scheduleSchema = z.object({
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(500).optional(),
  toleranceEnabled: z.boolean(),
  tolerancePerMark: z.number().int().min(0).max(15),
  toleranceDaily: z.number().int().min(0).max(30),
  days: z
    .array(z.object({ weekday: z.number().int().min(0).max(6), start: hhmm, breakStart: hhmm.nullable(), breakEnd: hhmm.nullable(), end: hhmm }))
    .min(1),
});

export async function createSchedule(ctx: Ctx, input: z.input<typeof scheduleSchema>): Promise<string> {
  requirePermission(ctx, 'configuracoes.gerenciar');
  const d = scheduleSchema.parse(input);
  const weekdays = new Set<number>();
  let weekly = 0;
  for (const day of d.days) {
    if (weekdays.has(day.weekday)) throw new AppError('Dia da semana repetido.');
    weekdays.add(day.weekday);
    const [s, e] = [parseHHMM(day.start), parseHHMM(day.end)];
    const brk = day.breakStart && day.breakEnd ? parseHHMM(day.breakEnd) - parseHHMM(day.breakStart) : 0;
    if (e <= s || brk < 0) throw new AppError('Horários inconsistentes.');
    weekly += e - s - brk;
  }
  if (weekly > 44 * 60) throw new AppError('A jornada semanal excede 44 horas (CF, art. 7º, XIII).');
  return tx(async (c) => {
    const s = await queryOne<{ id: string }>(
      c,
      `INSERT INTO work_schedules (name, description, tolerance_enabled, tolerance_per_mark_minutes, tolerance_daily_minutes)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [d.name, d.description ?? null, d.toleranceEnabled, d.tolerancePerMark, d.toleranceDaily],
    ).catch((e: { code?: string }) => {
      if (e.code === '23505') throw new ConflictError('Já existe jornada com este nome.');
      throw e;
    });
    for (const day of d.days) {
      await query(c, 'INSERT INTO work_schedule_days (schedule_id, weekday, start_time, break_start, break_end, end_time) VALUES ($1,$2,$3,$4,$5,$6)', [
        s!.id, day.weekday, day.start, day.breakStart, day.breakEnd, day.end,
      ]);
    }
    await audit(c, ctx, { action: 'JORNADA_CRIADA', entityType: 'work_schedule', entityId: s!.id, summary: `Jornada ${d.name} (${weekly / 60}h semanais)`, data: d });
    return s!.id;
  });
}

export async function listHolidays(year: number, db: Db = getPool()) {
  return query<{ id: string; date: string; name: string; scope: string; is_day_off: boolean }>(
    db, "SELECT id, date, name, scope, is_day_off FROM holidays WHERE date BETWEEN make_date($1,1,1) AND make_date($1,12,31) ORDER BY date", [year]);
}

const holidaySchema = z.object({
  date: isoDate,
  name: z.string().trim().min(3).max(120),
  scope: z.enum(['NACIONAL', 'ESTADUAL', 'MUNICIPAL', 'PONTO_FACULTATIVO', 'INTERNO']),
  isDayOff: z.boolean().default(true),
});

export async function addHoliday(ctx: Ctx, input: z.input<typeof holidaySchema>): Promise<void> {
  requirePermission(ctx, 'configuracoes.gerenciar');
  const d = holidaySchema.parse(input);
  await tx(async (c) => {
    await query(c, 'INSERT INTO holidays (date, name, scope, is_day_off) VALUES ($1,$2,$3,$4)', [d.date, d.name, d.scope, d.isDayOff]).catch(
      (e: { code?: string }) => {
        if (e.code === '23505') throw new ConflictError('Já existe feriado nesta data.');
        throw e;
      },
    );
    await audit(c, ctx, { action: 'FERIADO_INCLUIDO', entityType: 'holiday', entityId: d.date, summary: `Feriado ${d.name} em ${d.date}`, data: d });
  });
}

export async function removeHoliday(ctx: Ctx, id: string): Promise<void> {
  requirePermission(ctx, 'configuracoes.gerenciar');
  uuid.parse(id);
  await tx(async (c) => {
    const h = await queryOne<{ date: string; name: string }>(c, 'DELETE FROM holidays WHERE id = $1 RETURNING date, name', [id]);
    if (!h) throw new NotFoundError();
    await audit(c, ctx, { action: 'FERIADO_EXCLUIDO', entityType: 'holiday', entityId: h.date, summary: `Feriado ${h.name} (${h.date}) excluído` });
  });
}

// ---------------------------------------------------------------------------
// Parâmetros institucionais
// ---------------------------------------------------------------------------
export async function listSettings(ctx: Ctx, db: Db = getPool()) {
  requirePermission(ctx, 'configuracoes.gerenciar');
  return query<{ key: string; value: unknown; description: string | null; updated_at: Date }>(
    db, 'SELECT key, value, description, updated_at FROM settings ORDER BY key');
}

const NUMERIC_LIMITS: Record<string, [number, number]> = {
  'sessao.inatividade_minutos': [5, 120],
  'sessao.duracao_maxima_horas': [1, 24],
  'sessao.reautenticacao_minutos': [1, 30],
  'jornada.intervalo_minimo_entre_marcacoes_segundos': [0, 600],
  'banco.alerta_vencimento_dias': [1, 120],
  'banco.alerta_saldo_elevado_minutos': [60, 10000],
  'banco.divisor_salario_horas': [100, 240],
  'banco.adicional_extra_percentual': [50, 200],
  'plantao.horario_inicio_minutos': [0, 1380],
  'plantao.horario_fim_minutos': [60, 1440],
  'plantao.sobreaviso_divisor': [1, 10],
  'plantao.adicional_efetivo_percentual': [0, 200],
  'ferias.aviso_minimo_dias': [0, 60],
};

/** Parâmetros booleanos editáveis (ex.: exigência de aprovação por tipo de documento). */
export async function updateBooleanSetting(ctx: Ctx, key: string, value: boolean): Promise<void> {
  requirePermission(ctx, 'configuracoes.gerenciar');
  if (!/^documentos\.aprovacao\.[A-Z_]+$/.test(key)) throw new AppError('Parâmetro não editável por esta tela.');
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    const r = await query(c, 'UPDATE settings SET value = $2, updated_by = $3, updated_at = now() WHERE key = $1 RETURNING key', [key, JSON.stringify(value), ctx.principal.userId]);
    if (!r.length) throw new NotFoundError('Parâmetro inexistente.');
    await audit(c, ctx, { action: 'PARAMETRO_ALTERADO', entityType: 'setting', entityId: key, summary: `${key} → ${value}` });
  });
  invalidateSettingsCache();
}

export async function updateNumericSetting(ctx: Ctx, key: string, value: number): Promise<void> {
  requirePermission(ctx, 'configuracoes.gerenciar');
  const limits = NUMERIC_LIMITS[key];
  if (!limits) throw new AppError('Parâmetro não editável por esta tela.');
  if (!Number.isInteger(value) || value < limits[0] || value > limits[1]) {
    throw new AppError(`Valor fora do intervalo permitido (${limits[0]}–${limits[1]}).`);
  }
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    const before = await queryOne<{ value: unknown }>(c, 'SELECT value FROM settings WHERE key = $1', [key]);
    await query(c, 'UPDATE settings SET value = $2, updated_by = $3, updated_at = now() WHERE key = $1', [key, JSON.stringify(value), ctx.principal.userId]);
    await audit(c, ctx, { action: 'PARAMETRO_ALTERADO', entityType: 'setting', entityId: key, summary: `${key}: ${String(before?.value)} → ${value}` });
  });
  invalidateSettingsCache();
}
