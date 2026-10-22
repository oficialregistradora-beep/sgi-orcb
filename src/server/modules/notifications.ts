import { type Db, getPool, query, queryOne } from '../db.ts';
import type { Ctx } from '../context.ts';

// Notificações internas. Envio por Google Chat/Gmail: Fase 4 (dependente de configuração e autorização de escopos).

export type NotificationInput = { kind: string; title: string; body?: string; link?: string; priority?: 'BAIXA' | 'NORMAL' | 'ALTA' };

export async function notifyUsers(db: Db, userIds: string[], n: NotificationInput): Promise<void> {
  const unique = [...new Set(userIds)];
  if (!unique.length) return;
  await query(
    db,
    `INSERT INTO notifications (user_id, kind, title, body, link, priority)
     SELECT u, $2, $3, $4, $5, $6 FROM unnest($1::uuid[]) AS u`,
    [unique, n.kind, n.title, n.body ?? null, n.link ?? null, n.priority ?? 'NORMAL'],
  );
}

export async function notifyEmployee(db: Db, employeeId: string, n: NotificationInput): Promise<void> {
  const r = await queryOne<{ user_id: string | null }>(db, 'SELECT user_id FROM employees WHERE id = $1', [employeeId]);
  if (r?.user_id) await notifyUsers(db, [r.user_id], n);
}

/** Usuários ativos que possuem `permission` alcançando o setor informado (para avisos de aprovação). */
export async function usersWithPermission(db: Db, permission: string, sectorId: string, excludeUserId?: string | null): Promise<string[]> {
  const rows = await query<{ id: string }>(
    db,
    `SELECT DISTINCT u.id FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL AND ur.valid_from <= current_date
                              AND (ur.valid_until IS NULL OR ur.valid_until >= current_date)
       LEFT JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.permission_code = $1
       LEFT JOIN employees e ON e.user_id = u.id
      WHERE u.status = 'ATIVO'
        AND (u.is_owner OR rp.scope = 'TODOS' OR (rp.scope = 'SETOR' AND coalesce(ur.sector_id, e.sector_id) = $2))`,
    [permission, sectorId],
  );
  return rows.map((r) => r.id).filter((id) => id !== excludeUserId);
}

export async function listMyNotifications(ctx: Ctx, limit = 30) {
  return query<{ id: string; kind: string; title: string; body: string | null; link: string | null; priority: string; read_at: Date | null; created_at: Date }>(
    getPool(), 'SELECT id, kind, title, body, link, priority, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [ctx.principal.userId, limit]);
}

export async function unreadCount(ctx: Ctx): Promise<number> {
  return (await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [ctx.principal.userId]))!.n;
}

export async function markAllRead(ctx: Ctx): Promise<void> {
  await query(getPool(), 'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [ctx.principal.userId]);
}
