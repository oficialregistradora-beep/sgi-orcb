import { z } from 'zod';
import { type Db, getPool, query, queryOne, tx } from '../db.ts';
import type { Ctx } from '../context.ts';
import type { Principal } from '../context.ts';
import { requirePermission, requireStepUp } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ForbiddenError, NotFoundError } from '../errors.ts';

// Alcance do financeiro (decisão da Oficial, 02/11/2026): o papel diz O QUE a pessoa faz; ONDE, só o que a Oficial habilitar —
// todo o financeiro ("administração") ou centros de custo escolhidos. A Oficial vê sempre tudo.

/** null = todo o financeiro; lista (possivelmente vazia) = centros de custo habilitados. */
export async function financeScope(db: Db, p: Principal): Promise<string[] | null> {
  if (p.isOwner) return null;
  const u = await queryOne<{ finance_all: boolean }>(db, 'SELECT finance_all FROM users WHERE id = $1', [p.userId]);
  if (u?.finance_all) return null;
  return (await query<{ cost_center_id: string }>(db, 'SELECT cost_center_id FROM finance_access WHERE user_id = $1', [p.userId])).map((r) => r.cost_center_id);
}

export async function hasFinanceAccess(db: Db, p: Principal): Promise<boolean> {
  const s = await financeScope(db, p);
  return s === null || s.length > 0;
}

export async function assertCostCenterInScope(db: Db, p: Principal, costCenterId: string): Promise<void> {
  const s = await financeScope(db, p);
  if (s !== null && !s.includes(costCenterId)) throw new ForbiddenError('Este centro de custo não está habilitado para você no financeiro. Fale com a Oficial.');
}

/** Operações que envolvem todo o financeiro (receitas, lançamento mensal, planilha do Asgard, importação). */
export async function requireFullFinance(db: Db, p: Principal): Promise<void> {
  if ((await financeScope(db, p)) !== null) throw new ForbiddenError('Somente quem vê todo o financeiro (administração) pode fazer isto.');
}

/** Quem tem a permissão (em qualquer escopo do papel) e alcança o centro de custo — para avisos e para "quem paga". */
export async function financeUsers(db: Db, permission: string, costCenterId: string | null): Promise<string[]> {
  return (await query<{ id: string }>(
    db,
    `SELECT DISTINCT u.id FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL AND ur.valid_from <= current_date
                              AND (ur.valid_until IS NULL OR ur.valid_until >= current_date)
       LEFT JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.permission_code = $1
      WHERE u.status = 'ATIVO'
        AND (u.is_owner OR (rp.permission_code IS NOT NULL AND (u.finance_all
             OR ($2::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM finance_access fa WHERE fa.user_id = u.id AND fa.cost_center_id = $2)))))`,
    [permission, costCenterId],
  )).map((r) => r.id);
}

export type FinanceAccessView = { all: boolean; costCenterIds: string[] };

export async function getFinanceAccess(ctx: Ctx, userId: string): Promise<FinanceAccessView> {
  requirePermission(ctx, 'usuarios.gerenciar');
  const db = getPool();
  const u = await queryOne<{ finance_all: boolean }>(db, 'SELECT finance_all FROM users WHERE id = $1', [userId]);
  if (!u) throw new NotFoundError();
  const ccs = await query<{ cost_center_id: string }>(db, 'SELECT cost_center_id FROM finance_access WHERE user_id = $1', [userId]);
  return { all: u.finance_all, costCenterIds: ccs.map((r) => r.cost_center_id) };
}

const accessSchema = z.object({
  userId: z.uuid(),
  all: z.boolean(),
  costCenterIds: z.array(z.uuid()).max(500),
  reason: z.string().trim().min(5).max(500),
});

/** A Oficial define o alcance de cada pessoa no financeiro (todo ou centros de custo). Reautenticação e auditoria. */
export async function setFinanceAccess(ctx: Ctx, input: z.input<typeof accessSchema>): Promise<void> {
  requirePermission(ctx, 'usuarios.gerenciar');
  const d = accessSchema.parse(input);
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    const u = await queryOne<{ email: string; is_owner: boolean }>(c, 'SELECT email, is_owner FROM users WHERE id = $1 FOR UPDATE', [d.userId]);
    if (!u) throw new NotFoundError();
    if (u.is_owner) throw new AppError('A Oficial vê sempre todo o financeiro.');
    const ids = [...new Set(d.costCenterIds)];
    const codes = ids.length
      ? (await query<{ code: string }>(c, 'SELECT code FROM cost_centers WHERE id = ANY($1::uuid[]) ORDER BY code', [ids])).map((r) => r.code)
      : [];
    if (codes.length !== ids.length) throw new AppError('Centro de custo inexistente.');
    await query(c, 'UPDATE users SET finance_all = $2 WHERE id = $1', [d.userId, d.all]);
    await query(c, 'DELETE FROM finance_access WHERE user_id = $1', [d.userId]);
    for (const id of ids) await query(c, 'INSERT INTO finance_access (user_id, cost_center_id, granted_by) VALUES ($1,$2,$3)', [d.userId, id, ctx.principal.userId]);
    await audit(c, ctx, {
      action: 'FIN_ACESSO_DEFINIDO', entityType: 'user', entityId: d.userId,
      summary: `Financeiro de ${u.email}: ${d.all ? 'todo o financeiro (administração)' : codes.length ? `centros de custo ${codes.join(', ')}` : 'sem acesso'}`,
      data: { reason: d.reason },
    });
  });
}
