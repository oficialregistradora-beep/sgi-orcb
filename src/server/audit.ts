import { type Db, query, queryOne } from './db.ts';
import { type AuditActor, type Ctx, actorOf } from './context.ts';

export type AuditEvent = {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  data?: Record<string, unknown>;
};

const SENSITIVE_KEYS = new Set(
  [
    'cpf', 'rg', 'birthDate', 'address', 'phone', 'personalEmail', 'bankAccount', 'emergencyContact', 'healthNotes',
    'totpSecret', 'secret', 'token', 'password', 'monthlyAmount', 'salary',
  ].map((k) => k.toLowerCase()),
);

/** Remove valores sensíveis antes de gravar na trilha (registra apenas que o campo foi alterado). */
export function redact(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase().replace(/_/g, ''))) out[k] = v === null || v === undefined || v === '' ? null : '[protegido]';
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = redact(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}

/** Grava um evento na trilha encadeada. Deve ser chamado na MESMA transação da operação auditada. */
export async function audit(db: Db, who: Ctx | AuditActor | null, ev: AuditEvent): Promise<void> {
  const actor: AuditActor = who && 'principal' in who ? actorOf(who) : (who ?? actorOf(null));
  await query(
    db,
    `INSERT INTO audit_log (actor_user_id, actor_session_id, action, entity_type, entity_id, summary, data, ip, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '', '')`,
    [actor.userId, actor.sessionId, ev.action, ev.entityType, ev.entityId ?? null, ev.summary, JSON.stringify(redact(ev.data ?? {})), actor.ip],
  );
}

export async function verifyAuditChain(db: Db): Promise<{ ok: boolean; total: number; brokenId: number | null; reason: string | null }> {
  const total = (await queryOne<{ n: number }>(db, 'SELECT count(*)::int AS n FROM audit_log'))!.n;
  const broken = await queryOne<{ broken_id: number; reason: string }>(db, 'SELECT * FROM fn_audit_verify()');
  return { ok: !broken, total, brokenId: broken?.broken_id ?? null, reason: broken?.reason ?? null };
}
