import { type Db, query, queryOne } from './db.ts';
import type { Ctx, Grant, Principal, Scope } from './context.ts';
import { ForbiddenError, StepUpRequiredError } from './errors.ts';
import { getNumberSetting } from './settings.ts';

const RANK: Record<Scope, number> = { PROPRIO: 1, SETOR: 2, TODOS: 3 };

/** Carrega o usuário com as permissões efetivas (papéis vigentes hoje, não revogados). */
export async function loadPrincipal(db: Db, userId: string): Promise<Principal | null> {
  const user = await queryOne<{
    id: string; email: string; display_name: string; is_owner: boolean; status: string;
    employee_id: string | null; sector_id: string | null;
  }>(
    db,
    `SELECT u.id, u.email, u.display_name, u.is_owner, u.status, e.id AS employee_id, e.sector_id
       FROM users u LEFT JOIN employees e ON e.user_id = u.id AND e.status <> 'DESLIGADO'
      WHERE u.id = $1`,
    [userId],
  );
  if (!user || user.status !== 'ATIVO') return null;

  const rows = await query<{ permission_code: string; scope: Scope; sector_id: string | null }>(
    db,
    `SELECT rp.permission_code, rp.scope, ur.sector_id
       FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = $1 AND ur.revoked_at IS NULL
        AND ur.valid_from <= current_date AND (ur.valid_until IS NULL OR ur.valid_until >= current_date)`,
    [userId],
  );

  const grants = new Map<string, Grant>();
  for (const r of rows) {
    const g = grants.get(r.permission_code) ?? { scope: r.scope, sectorIds: new Set<string>() };
    if (RANK[r.scope] > RANK[g.scope]) g.scope = r.scope;
    if (r.scope === 'SETOR') {
      const sector = r.sector_id ?? user.sector_id;
      if (sector) g.sectorIds.add(sector);
    }
    grants.set(r.permission_code, g);
  }

  return {
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    isOwner: user.is_owner,
    employeeId: user.employee_id,
    employeeSectorId: user.sector_id,
    grants,
  };
}

export type Resource = { employeeId?: string | null; sectorId?: string | null };

/**
 * Verifica a permissão sobre um recurso. Sem recurso, responde se o usuário possui a permissão em algum escopo.
 * A Oficial (is_owner) é a autoridade máxima e possui todas as permissões.
 */
export function can(p: Principal, permission: string, res?: Resource): boolean {
  if (p.isOwner) return true;
  const g = p.grants.get(permission);
  if (!g) return false;
  if (!res) return true;
  if (g.scope === 'TODOS') return true;
  const own = !!res.employeeId && res.employeeId === p.employeeId;
  if (g.scope === 'PROPRIO') return own;
  return own || (!!res.sectorId && g.sectorIds.has(res.sectorId));
}

export function requirePermission(ctx: Ctx, permission: string, res?: Resource): void {
  if (!can(ctx.principal, permission, res)) throw new ForbiddenError();
}

/** Filtro para listagens: todos, um conjunto de setores e/ou o próprio funcionário. */
export type ScopeFilter = { all: true } | { all: false; sectorIds: string[]; employeeId: string | null };

export function scopeFilter(p: Principal, permission: string): ScopeFilter | null {
  if (p.isOwner) return { all: true };
  const g = p.grants.get(permission);
  if (!g) return null;
  if (g.scope === 'TODOS') return { all: true };
  return { all: false, sectorIds: g.scope === 'SETOR' ? [...g.sectorIds] : [], employeeId: p.employeeId };
}

/**
 * Cláusula SQL para restringir listagens de funcionários conforme o escopo.
 * `alias` é o alias da tabela employees na consulta; os parâmetros são acrescentados a `params`.
 */
export function scopeSql(f: ScopeFilter, alias: string, params: unknown[]): string {
  if (f.all) return 'TRUE';
  params.push(f.sectorIds, f.employeeId);
  return `(${alias}.sector_id = ANY($${params.length - 1}::uuid[]) OR ${alias}.id = $${params.length}::uuid)`;
}

/** Operações críticas exigem reautenticação recente (código TOTP), conforme parâmetro institucional. */
export async function requireStepUp(db: Db, ctx: Ctx): Promise<void> {
  const minutes = await getNumberSetting(db, 'sessao.reautenticacao_minutos', 10);
  if (!ctx.stepUpAt || Date.now() - ctx.stepUpAt.getTime() > minutes * 60_000) throw new StepUpRequiredError();
}
