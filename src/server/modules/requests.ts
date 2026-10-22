import { z } from 'zod';
import { getPool, query, queryOne, tx } from '../db.ts';
import type { Ctx } from '../context.ts';
import { can, requirePermission, scopeFilter, scopeSql } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ForbiddenError, NotFoundError } from '../errors.ts';
import { localToInstant, todayLocal } from '../../domain/time.ts';
import { nextPunchKind, scheduleMinutes } from '../../domain/journey.ts';
import { summarize } from '../../domain/hourBank.ts';
import { activeAgreement, assertPeriodOpen, insertDebit, loadLedger } from './ledger.ts';
import { computeRange, recomputeDays } from './timeclock.ts';
import { findEmployee } from './people.ts';
import { notifyEmployee, notifyUsers, usersWithPermission } from './notifications.ts';
import { applyVacationApproval } from './vacation.ts';

export const REQUEST_TYPES = {
  CORRECAO_PONTO: { label: 'Correção de marcação', approve: 'solicitacoes.correcao.aprovar' },
  COMPENSACAO: { label: 'Compensação de banco de horas', approve: 'solicitacoes.compensacao.aprovar' },
  AUTORIZACAO_EXTRA: { label: 'Autorização prévia de hora extra', approve: 'solicitacoes.extra.aprovar' },
  FERIAS: { label: 'Férias', approve: 'ferias.aprovar' },
} as const;
export type RequestType = keyof typeof REQUEST_TYPES;

const correctionPayload = z.discriminatedUnion('action', [
  z.object({ action: z.literal('INCLUIR'), time: z.string().regex(/^\d{2}:\d{2}$/) }),
  z.object({ action: z.literal('DESCONSIDERAR'), punchId: z.uuid() }),
]);
const compensationPayload = z.object({
  mode: z.enum(['FOLGA_INTEGRAL', 'COMPENSACAO_PARCIAL', 'ENTRADA_POSTERIOR', 'SAIDA_ANTECIPADA']),
  minutes: z.number().int().positive().max(720).optional(),
});
const extraPayload = z.object({ minutes: z.number().int().positive().max(240), destination: z.enum(['BANCO', 'PAGAMENTO']) });

const createSchema = z.object({
  type: z.enum(['CORRECAO_PONTO', 'COMPENSACAO', 'AUTORIZACAO_EXTRA']),
  employeeId: z.uuid().optional(), // ausente = o próprio solicitante
  referenceDate: z.iso.date(),
  payload: z.record(z.string(), z.unknown()),
  justification: z.string().trim().min(5).max(1000),
});

async function expectedMinutesOn(employeeId: string, date: string): Promise<number> {
  const [day] = await computeRange(getPool(), employeeId, date, date);
  return day?.result.kind === 'UTIL' && day.schedule ? scheduleMinutes(day.schedule) : 0;
}

export async function createRequest(ctx: Ctx, input: z.input<typeof createSchema>): Promise<string> {
  const d = createSchema.parse(input);
  const employeeId = d.employeeId ?? ctx.principal.employeeId;
  if (!employeeId) throw new ForbiddenError('Seu usuário não está vinculado a um cadastro funcional.');
  const e = await findEmployee(getPool(), employeeId);
  requirePermission(ctx, 'solicitacoes.criar', { employeeId, sectorId: e.sector_id });
  if (e.status === 'DESLIGADO') throw new AppError('Funcionário desligado.');
  const today = todayLocal();
  let payload: Record<string, unknown>;

  if (d.type === 'CORRECAO_PONTO') {
    const p = correctionPayload.parse(d.payload);
    if (d.referenceDate > today) throw new AppError('Não é possível corrigir marcação de data futura.');
    if (d.referenceDate < e.admission_date) throw new AppError('Data anterior à admissão.');
    await assertPeriodOpen(getPool(), d.referenceDate);
    if (p.action === 'INCLUIR' && localToInstant(d.referenceDate, p.time).getTime() > Date.now()) {
      throw new AppError('O horário informado ainda não ocorreu.');
    }
    if (p.action === 'DESCONSIDERAR') {
      const punch = await queryOne(getPool(), 'SELECT 1 FROM time_punches WHERE id = $1 AND employee_id = $2 AND local_date = $3', [p.punchId, employeeId, d.referenceDate]);
      if (!punch) throw new AppError('Marcação não encontrada para a data informada.');
    }
    payload = p;
  } else if (d.type === 'COMPENSACAO') {
    const p = compensationPayload.parse(d.payload);
    if (d.referenceDate < today) throw new AppError('Compensações são solicitadas para hoje ou datas futuras. Para dias passados, apresente justificativa na ocorrência.');
    const expected = await expectedMinutesOn(employeeId, d.referenceDate);
    if (expected === 0) throw new AppError('Não há jornada prevista nesta data.');
    const minutes = p.mode === 'FOLGA_INTEGRAL' ? expected : p.minutes;
    if (!minutes || minutes > expected) throw new AppError(`Informe a quantidade de minutos (máximo ${expected}).`);
    const agreement = await activeAgreement(getPool(), employeeId, d.referenceDate);
    if (!agreement) throw new AppError('Não há acordo de banco de horas vigente na data.');
    payload = { mode: p.mode, minutes };
  } else {
    const p = extraPayload.parse(d.payload);
    if (d.referenceDate < today) throw new AppError('A autorização deve ser prévia (hoje ou data futura).');
    payload = p;
  }

  return tx(async (c) => {
    const r = await queryOne<{ id: string }>(
      c,
      `INSERT INTO requests (type, employee_id, requested_by, reference_date, payload, justification)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [d.type, employeeId, ctx.principal.userId, d.referenceDate, JSON.stringify(payload), d.justification],
    );
    await audit(c, ctx, {
      action: 'SOLICITACAO_CRIADA', entityType: 'request', entityId: r!.id,
      summary: `${REQUEST_TYPES[d.type].label} — ${e.full_name}, ${d.referenceDate}`, data: { payload },
    });
    const approvers = await usersWithPermission(c, REQUEST_TYPES[d.type].approve, e.sector_id, e.user_id);
    await notifyUsers(c, approvers, {
      kind: 'SOLICITACAO_PENDENTE', title: `Nova solicitação: ${REQUEST_TYPES[d.type].label}`,
      body: `${e.full_name} — ${d.referenceDate}`, link: '/solicitacoes?aba=aprovar',
    });
    return r!.id;
  });
}

export type RequestRow = {
  id: string; type: RequestType; employee_id: string; full_name: string; sector_id: string; sector_name: string;
  requested_by_name: string; reference_date: string; payload: Record<string, unknown>; justification: string; status: string;
  decided_by_name: string | null; decided_at: Date | null; decision_notes: string | null; created_at: Date;
};

const LIST_SQL = `
  SELECT r.id, r.type, r.employee_id, e.full_name, e.sector_id, s.name AS sector_name, ru.display_name AS requested_by_name,
         r.reference_date, r.payload, r.justification, r.status, du.display_name AS decided_by_name, r.decided_at, r.decision_notes, r.created_at
    FROM requests r JOIN employees e ON e.id = r.employee_id JOIN sectors s ON s.id = e.sector_id
    JOIN users ru ON ru.id = r.requested_by LEFT JOIN users du ON du.id = r.decided_by`;

export async function listMyRequests(ctx: Ctx): Promise<RequestRow[]> {
  if (!ctx.principal.employeeId) return [];
  return query<RequestRow>(getPool(), `${LIST_SQL} WHERE r.employee_id = $1 ORDER BY r.created_at DESC LIMIT 200`, [ctx.principal.employeeId]);
}

/** Solicitações que o usuário pode decidir (exclui as próprias — ninguém aprova o próprio pedido). */
export async function listRequestsToDecide(ctx: Ctx, status: 'PENDENTE' | 'DECIDIDAS' = 'PENDENTE'): Promise<RequestRow[]> {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [type, meta] of Object.entries(REQUEST_TYPES)) {
    const f = scopeFilter(ctx.principal, meta.approve);
    if (!f) continue;
    params.push(type);
    parts.push(`(r.type = $${params.length} AND ${scopeSql(f, 'e', params)})`);
  }
  if (!parts.length) return [];
  params.push(ctx.principal.employeeId);
  const statusSql = status === 'PENDENTE' ? "r.status = 'PENDENTE'" : "r.status IN ('APROVADA','REJEITADA')";
  return query<RequestRow>(
    getPool(),
    `${LIST_SQL} WHERE (${parts.join(' OR ')}) AND ${statusSql}
       AND (r.employee_id IS DISTINCT FROM $${params.length}::uuid ${ctx.principal.isOwner ? 'OR TRUE' : ''})
     ORDER BY r.created_at ${status === 'PENDENTE' ? 'ASC' : 'DESC'} LIMIT 300`,
    params,
  );
}

const decideSchema = z.object({ requestId: z.uuid(), approve: z.boolean(), notes: z.string().trim().max(1000).optional() });

export async function decideRequest(ctx: Ctx, input: z.input<typeof decideSchema>): Promise<void> {
  const d = decideSchema.parse(input);
  const today = todayLocal();
  await tx(async (c) => {
    const r = await queryOne<RequestRow & { requested_by: string; user_id: string | null }>(
      c,
      `SELECT r.*, e.full_name, e.sector_id, e.user_id FROM requests r JOIN employees e ON e.id = r.employee_id WHERE r.id = $1 FOR UPDATE OF r`,
      [d.requestId],
    );
    if (!r) throw new NotFoundError('Solicitação não encontrada.');
    const meta = REQUEST_TYPES[r.type];
    requirePermission(ctx, meta.approve, { employeeId: r.employee_id, sectorId: r.sector_id });
    const ownRequest = r.employee_id === ctx.principal.employeeId || r.requested_by === ctx.principal.userId;
    if (ownRequest && !ctx.principal.isOwner) throw new ForbiddenError('Não é permitido decidir a própria solicitação (segregação de funções).');
    if (r.status !== 'PENDENTE') throw new AppError('A solicitação já foi decidida ou cancelada.');
    if (!d.approve && !d.notes) throw new AppError('Informe o motivo da rejeição.');

    if (d.approve) {
      if (r.type === 'CORRECAO_PONTO') {
        await assertPeriodOpen(c, r.reference_date);
        const p = correctionPayload.parse(r.payload);
        if (p.action === 'INCLUIR') {
          const count = (await queryOne<{ n: number }>(
            c,
            `SELECT count(*)::int AS n FROM time_punches t WHERE t.employee_id = $1 AND t.local_date = $2
               AND NOT EXISTS (SELECT 1 FROM punch_annulments a WHERE a.punch_id = t.id)`,
            [r.employee_id, r.reference_date],
          ))!.n;
          await query(
            c,
            `INSERT INTO time_punches (employee_id, punched_at, local_date, kind, source, correction_request_id, created_by)
             VALUES ($1,$2,$3,$4,'CORRECAO',$5,$6)`,
            [r.employee_id, localToInstant(r.reference_date, p.time), r.reference_date, nextPunchKind(count), r.id, ctx.principal.userId],
          );
        } else {
          await query(c, 'INSERT INTO punch_annulments (punch_id, request_id, reason, approved_by) VALUES ($1,$2,$3,$4)', [
            p.punchId, r.id, r.justification, ctx.principal.userId,
          ]).catch((e: { code?: string }) => {
            if (e.code === '23505') throw new AppError('Esta marcação já foi desconsiderada.');
            throw e;
          });
        }
      } else if (r.type === 'FERIAS') {
        await applyVacationApproval(c, ctx, r);
      } else if (r.type === 'COMPENSACAO') {
        await assertPeriodOpen(c, r.reference_date);
        const agreement = await activeAgreement(c, r.employee_id, r.reference_date);
        if (!agreement) throw new AppError('Não há acordo de banco de horas vigente na data.');
        const minutes = Number(r.payload.minutes);
        await insertDebit(c, {
          employeeId: r.employee_id, agreement, date: r.reference_date, minutes, kind: 'DEBITO_COMPENSACAO', asOf: r.reference_date, today,
          requestId: r.id, userId: ctx.principal.userId, notes: `Compensação aprovada (${String(r.payload.mode).replace(/_/g, ' ').toLowerCase()})`,
        });
      }
    }
    await query(c, 'UPDATE requests SET status = $2, decided_by = $3, decided_at = now(), decision_notes = $4 WHERE id = $1', [
      r.id, d.approve ? 'APROVADA' : 'REJEITADA', ctx.principal.userId, d.notes ?? null,
    ]);
    await audit(c, ctx, {
      action: d.approve ? 'SOLICITACAO_APROVADA' : 'SOLICITACAO_REJEITADA', entityType: 'request', entityId: r.id,
      summary: `${meta.label} de ${r.full_name} (${r.reference_date}) ${d.approve ? 'aprovada' : 'rejeitada'}${ownRequest ? ' — decisão pela Oficial sobre pedido próprio' : ''}`,
      data: { notes: d.notes ?? null },
    });
    if (d.approve && (r.type === 'CORRECAO_PONTO' || r.type === 'COMPENSACAO')) await recomputeDays(c, ctx, r.employee_id, r.reference_date, r.reference_date);
    await notifyEmployee(c, r.employee_id, {
      kind: 'SOLICITACAO_DECIDIDA', title: `${meta.label} ${d.approve ? 'aprovada' : 'rejeitada'}`,
      body: `Referência ${r.reference_date}${d.notes ? ` — ${d.notes}` : ''}`, link: '/solicitacoes',
    });
  });
}

export async function cancelRequest(ctx: Ctx, requestId: string): Promise<void> {
  z.uuid().parse(requestId);
  await tx(async (c) => {
    const r = await queryOne<{ requested_by: string; status: string; employee_id: string }>(
      c, 'SELECT requested_by, status, employee_id FROM requests WHERE id = $1 FOR UPDATE', [requestId]);
    if (!r) throw new NotFoundError();
    if (r.requested_by !== ctx.principal.userId) throw new ForbiddenError('Somente quem abriu a solicitação pode cancelá-la.');
    if (r.status !== 'PENDENTE') throw new AppError('Somente solicitações pendentes podem ser canceladas.');
    await query(c, "UPDATE requests SET status = 'CANCELADA' WHERE id = $1", [requestId]);
    await audit(c, ctx, { action: 'SOLICITACAO_CANCELADA', entityType: 'request', entityId: requestId, summary: 'Solicitação cancelada pelo solicitante' });
  });
}

/** Saldo disponível para orientar o funcionário ao pedir compensação. */
export async function availableCredits(ctx: Ctx, employeeId: string): Promise<number> {
  const e = await findEmployee(getPool(), employeeId);
  if (!can(ctx.principal, 'banco.ver', { employeeId, sectorId: e.sector_id })) throw new ForbiddenError();
  const { entries, allocations } = await loadLedger(getPool(), employeeId);
  return summarize(entries, allocations, todayLocal(), 0).available;
}

export function describePayload(type: RequestType, payload: Record<string, unknown>): string {
  if (type === 'CORRECAO_PONTO') {
    return payload.action === 'INCLUIR' ? `Incluir marcação às ${String(payload.time)}` : 'Desconsiderar marcação registrada';
  }
  if (type === 'COMPENSACAO') {
    return `${String(payload.mode).replace(/_/g, ' ').toLowerCase()} — ${Math.floor(Number(payload.minutes) / 60)}h${String(Number(payload.minutes) % 60).padStart(2, '0')}`;
  }
  if (type === 'FERIAS') {
    const [ys, ms, ds] = String(payload.start).split('-');
    const [ye, me, de] = String(payload.end).split('-');
    return `${ds}/${ms}/${ys} a ${de}/${me}/${ye} — ${payload.days} dias${Number(payload.soldDays) ? ` + ${payload.soldDays} de abono pecuniário` : ''} (período aquisitivo ${payload.periodIndex})`;
  }
  return `Até ${payload.minutes} min — destino: ${payload.destination === 'BANCO' ? 'banco de horas' : 'pagamento'}`;
}

