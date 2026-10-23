import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx, Principal } from '../context.ts';
import { can, requirePermission, requireStepUp } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ForbiddenError, NotFoundError } from '../errors.ts';
import { invalidateSettingsCache } from '../settings.ts';
import { ipAllowed, parseAllowList, parseCidr, type Cidr } from '../../domain/network.ts';

// Restrição de acesso à rede da serventia. Fora dos endereços cadastrados, o uso depende de: ser a Oficial,
// ter a permissão "acesso.externo", ter liberação temporária vigente ou estar no horário do próprio plantão.

export type NetworkReason = 'DESATIVADA' | 'REDE_INTERNA' | 'OFICIAL' | 'PERMISSAO' | 'LIBERACAO' | 'PLANTAO' | 'BLOQUEADO';

type NetSettings = { active: boolean; list: Cidr[]; punchInternal: boolean; slack: number };

/**
 * Parâmetros de rede lidos direto do banco a cada verificação (sem o cache de 30 s dos demais parâmetros):
 * ligar ou desligar a restrição vale na hora, em todas as instâncias.
 */
async function netSettings(db: Db): Promise<NetSettings> {
  const rows = await query<{ key: string; value: unknown }>(db, "SELECT key, value FROM settings WHERE key LIKE 'rede.%'");
  const v = (k: string) => rows.find((r) => r.key === k)?.value;
  const raw = v('rede.ips_permitidos');
  const items = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  return {
    active: v('rede.restricao_ativa') === true,
    // Entradas inválidas são ignoradas aqui (a gravação já as recusa); nunca derrubam a verificação.
    list: items.flatMap((t) => { try { return [parseCidr(t)]; } catch { return []; } }),
    punchInternal: v('rede.ponto_somente_interno') !== false,
    slack: typeof v('rede.plantao_folga_minutos') === 'number' ? (v('rede.plantao_folga_minutos') as number) : 60,
  };
}

/** Decide se a pessoa pode usar o sistema a partir deste endereço. */
export async function networkDecision(db: Db, p: Principal, ip: string | null): Promise<{ allowed: boolean; reason: NetworkReason }> {
  const net = await netSettings(db);
  if (!net.active) return { allowed: true, reason: 'DESATIVADA' };
  const list = net.list;
  // Restrição ativa sem endereços cadastrados não tranca ninguém (a gravação também impede essa combinação).
  if (!list.length) return { allowed: true, reason: 'DESATIVADA' };
  if (ipAllowed(ip, list)) return { allowed: true, reason: 'REDE_INTERNA' };
  if (p.isOwner) return { allowed: true, reason: 'OFICIAL' };
  if (can(p, 'acesso.externo')) return { allowed: true, reason: 'PERMISSAO' };
  if (await queryOne(db, 'SELECT 1 FROM network_exceptions WHERE user_id = $1 AND revoked_at IS NULL AND valid_until > now() AND created_at <= now()', [p.userId])) {
    return { allowed: true, reason: 'LIBERACAO' };
  }
  if (p.employeeId) {
    const slack = net.slack;
    if (await queryOne(db, `SELECT 1 FROM oncall_shifts WHERE status <> 'CANCELADO' AND $1 IN (employee_id, substitute_employee_id)
        AND now() BETWEEN starts_at - make_interval(mins => $2) AND ends_at + make_interval(mins => $2)`, [p.employeeId, slack])) {
      return { allowed: true, reason: 'PLANTAO' };
    }
  }
  return { allowed: false, reason: 'BLOQUEADO' };
}

// Registro dos bloqueios na auditoria, no máximo um por pessoa e endereço a cada hora (evita inundar a trilha).
const lastLogged = new Map<string, number>();
export async function logBlocked(db: Db, p: Principal, sessionId: string, ip: string | null): Promise<void> {
  const key = `${p.userId}|${ip}`;
  const now = Date.now();
  if ((lastLogged.get(key) ?? 0) > now - 3600_000) return;
  lastLogged.set(key, now);
  await audit(db, { userId: p.userId, sessionId, ip }, { action: 'REDE_BLOQUEIO', entityType: 'user', entityId: p.userId, summary: `Acesso fora da rede da serventia recusado (${ip ?? 'endereço desconhecido'})` })
    .catch(() => undefined);
}

/** Marcação de ponto: só da rede da serventia, quando há endereços cadastrados e a regra está ligada (vale para todos). */
export async function assertPunchNetwork(db: Db, ip: string | null): Promise<void> {
  const net = await netSettings(db);
  if (!net.punchInternal) return;
  if (net.list.length && !ipAllowed(ip, net.list)) throw new ForbiddenError('A marcação de ponto só pode ser feita na rede da serventia.');
}

// ---------------------------------------------------------------------------
// Administração (Configurações → Rede)
// ---------------------------------------------------------------------------

export async function getNetworkConfig(ctx: Ctx) {
  requirePermission(ctx, 'configuracoes.gerenciar');
  const db = getPool();
  const exceptions = await query<{ id: string; user_name: string; valid_until: Date; reason: string; created_by_name: string; created_at: Date }>(db,
    `SELECT x.id, u.display_name AS user_name, x.valid_until, x.reason, c.display_name AS created_by_name, x.created_at FROM network_exceptions x
       JOIN users u ON u.id = x.user_id JOIN users c ON c.id = x.created_by WHERE x.revoked_at IS NULL AND x.valid_until > now() ORDER BY x.valid_until`);
  const blocks = await query<{ created_at: Date; summary: string; user_name: string | null }>(db,
    `SELECT a.occurred_at AS created_at, a.summary, u.display_name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.action = 'REDE_BLOQUEIO' ORDER BY a.occurred_at DESC LIMIT 30`);
  const external = await query<{ display_name: string }>(db,
    `SELECT DISTINCT u.display_name FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL AND ur.valid_from <= current_date AND (ur.valid_until IS NULL OR ur.valid_until >= current_date)
       JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.permission_code = 'acesso.externo' WHERE u.status = 'ATIVO' ORDER BY 1`);
  const net = await netSettings(db);
  return {
    active: net.active,
    ips: net.list.map((x) => x.text),
    punchInternal: net.punchInternal,
    oncallSlack: net.slack,
    currentIp: ctx.ip,
    exceptions, blocks, external,
  };
}

const configSchema = z.object({ active: z.boolean(), ipsText: z.string().max(4000), punchInternal: z.boolean(), oncallSlack: z.number().int().min(0).max(240) });

/** Grava a configuração. Ativar exige endereços cadastrados; o aviso de que o próprio endereço está fora fica no retorno. */
export async function saveNetworkConfig(ctx: Ctx, input: z.input<typeof configSchema>): Promise<{ currentIpInside: boolean }> {
  requirePermission(ctx, 'configuracoes.gerenciar');
  const d = configSchema.parse(input);
  await requireStepUp(getPool(), ctx);
  let list: Cidr[];
  try { list = parseAllowList(d.ipsText); } catch (e) { throw new AppError((e as Error).message); }
  if (d.active && !list.length) throw new AppError('Cadastre ao menos um endereço da serventia antes de ativar a restrição.');
  if (list.length > 20) throw new AppError('No máximo 20 endereços ou faixas.');
  const currentIpInside = ipAllowed(ctx.ip, list);
  // Quem não é a Oficial e não tem acesso externo não pode ativar a restrição de fora da rede (trancaria a si mesmo).
  if (d.active && !currentIpInside && !ctx.principal.isOwner && !can(ctx.principal, 'acesso.externo')) {
    throw new AppError(`Seu endereço atual (${ctx.ip ?? 'desconhecido'}) não está na lista: ative a restrição de dentro da rede da serventia.`);
  }
  await tx(async (c) => {
    const set = (k: string, v: unknown) => query(c, 'UPDATE settings SET value = $2, updated_by = $3, updated_at = now() WHERE key = $1', [k, JSON.stringify(v), ctx.principal.userId]);
    await set('rede.restricao_ativa', d.active);
    await set('rede.ips_permitidos', list.map((x) => x.text));
    await set('rede.ponto_somente_interno', d.punchInternal);
    await set('rede.plantao_folga_minutos', d.oncallSlack);
    await audit(c, ctx, { action: 'REDE_CONFIGURACAO', entityType: 'settings', entityId: null,
      summary: `Restrição de rede ${d.active ? 'ATIVADA' : 'desativada'}; ${list.length} endereço(s): ${list.map((x) => x.text).join(', ') || '—'}; ponto só na rede: ${d.punchInternal ? 'sim' : 'não'}` });
  });
  invalidateSettingsCache();
  return { currentIpInside };
}

const exceptionSchema = z.object({ userId: z.uuid(), validUntil: z.coerce.date(), reason: z.string().trim().min(5).max(500) });

export async function addNetworkException(ctx: Ctx, input: z.input<typeof exceptionSchema>): Promise<string> {
  requirePermission(ctx, 'configuracoes.gerenciar');
  const d = exceptionSchema.parse(input);
  if (d.validUntil.getTime() <= Date.now()) throw new AppError('A liberação deve terminar no futuro.');
  if (d.validUntil.getTime() > Date.now() + 31 * 86400_000) throw new AppError('Liberação de no máximo 31 dias; renove se preciso.');
  if (d.userId === ctx.principal.userId) throw new ForbiddenError('Ninguém libera o próprio acesso.');
  return tx(async (c) => {
    const u = await queryOne<{ display_name: string }>(c, "SELECT display_name FROM users WHERE id = $1 AND status = 'ATIVO'", [d.userId]);
    if (!u) throw new NotFoundError('Usuário inexistente ou inativo.');
    const r = await queryOne<{ id: string }>(c, 'INSERT INTO network_exceptions (user_id, valid_until, reason, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
      [d.userId, d.validUntil, d.reason, ctx.principal.userId]);
    await audit(c, ctx, { action: 'REDE_LIBERACAO', entityType: 'user', entityId: d.userId, summary: `${u.display_name}: acesso externo liberado até ${d.validUntil.toISOString()} — ${d.reason}` });
    return r!.id;
  });
}

export async function revokeNetworkException(ctx: Ctx, id: string): Promise<void> {
  requirePermission(ctx, 'configuracoes.gerenciar');
  await tx(async (c) => {
    const r = await queryOne<{ user_id: string }>(c, 'UPDATE network_exceptions SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING user_id', [z.uuid().parse(id), ctx.principal.userId]);
    if (!r) throw new NotFoundError('Liberação não encontrada.');
    await audit(c, ctx, { action: 'REDE_LIBERACAO_REVOGADA', entityType: 'user', entityId: r.user_id, summary: 'Liberação de acesso externo revogada' });
  });
}
