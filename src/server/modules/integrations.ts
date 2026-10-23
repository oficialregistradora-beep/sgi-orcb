import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx, Principal } from '../context.ts';
import { can, requirePermission } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ForbiddenError, NotFoundError } from '../errors.ts';
import { getConfig } from '../config.ts';
import { getSetting, invalidateSettingsCache } from '../settings.ts';
import { canonicalJson } from '../crypto.ts';
import { googleFetch, SCOPES } from '../google.ts';
import { addDays, formatHHMM, localToInstant, todayLocal } from '../../domain/time.ts';

// Integrações com Google Agenda, Gmail e Chat (Fase 4c).
// Princípios: (1) o banco é a fonte da verdade; (2) mensagens saem de uma fila gravada na mesma transação do fato;
// (3) falhas do Google nunca desfazem operações do sistema; (4) mensagens externas levam o mínimo de dados
// (título e link), nunca conteúdo sensível; (5) escopos mínimos, registrados em SCOPES e na documentação.

const flag = (db: Db, key: string) => getSetting<boolean>(db, key, false).then((v) => v === true);

// ---------------------------------------------------------------------------
// Fila de saída (Gmail e Chat)
// ---------------------------------------------------------------------------

export type GmailPayload = { to: string; name: string; subject: string; link: string | null };
export type ChatPayload = { text: string };

/** Enfileira na transação corrente. Idempotente pela chave do evento. */
export async function enqueue(c: Db, channel: 'GMAIL' | 'CHAT', eventKey: string, payload: GmailPayload | ChatPayload): Promise<void> {
  await query(c, 'INSERT INTO integration_outbox (channel, event_key, payload) VALUES ($1,$2,$3) ON CONFLICT (event_key) DO NOTHING',
    [channel, eventKey, JSON.stringify(payload)]);
}

/**
 * Chamado por notifyUsers: enfileira e-mail para cada notificação, se o Gmail estiver ativo e a prioridade couber.
 * O e-mail traz só o título e o link (o conteúdo fica no sistema, atrás da autenticação).
 */
export async function enqueueNotificationEmails(c: Db, rows: { id: string; user_id: string; title: string; link: string | null; priority: string }[]): Promise<void> {
  if (!rows.length || !(await flag(c, 'integracoes.gmail.ativo'))) return;
  const onlyHigh = await getSetting<boolean>(c, 'integracoes.gmail.somente_alta', true);
  const eligible = rows.filter((r) => !onlyHigh || r.priority === 'ALTA');
  if (!eligible.length) return;
  const users = await query<{ id: string; email: string; display_name: string }>(c,
    "SELECT id, email, display_name FROM users WHERE id = ANY($1::uuid[]) AND status = 'ATIVO'", [eligible.map((r) => r.user_id)]);
  const byId = new Map(users.map((u) => [u.id, u]));
  for (const r of eligible) {
    const u = byId.get(r.user_id);
    if (u) await enqueue(c, 'GMAIL', `gmail:notificacao:${r.id}`, { to: u.email, name: u.display_name, subject: r.title, link: r.link });
  }
}

/** Aviso institucional no espaço do Chat (sem dados pessoais). */
export async function enqueueChat(c: Db, eventKey: string, text: string): Promise<void> {
  if (!(await flag(c, 'integracoes.chat.ativo'))) return;
  await enqueue(c, 'CHAT', `chat:${eventKey}`, { text: text.slice(0, 3500) });
}

export async function postAnnouncement(ctx: Ctx, text: string): Promise<void> {
  requirePermission(ctx, 'chat.avisos');
  const t = z.string().trim().min(5).max(2000).parse(text);
  await tx(async (c) => {
    if (!(await flag(c, 'integracoes.chat.ativo'))) throw new AppError('A integração com o Google Chat está desativada.');
    await enqueue(c, 'CHAT', `chat:aviso:${randomUUID()}`, { text: `📢 Aviso administrativo: ${t}` });
    await audit(c, ctx, { action: 'CHAT_AVISO', entityType: 'integration', entityId: null, summary: `Aviso administrativo enfileirado para o Google Chat (${t.length} caracteres)` });
  });
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** Mensagem MIME mínima (texto simples), sem cabeçalhos controláveis pelo usuário além de assunto e destinatário saneados. */
export function buildEmail(sender: string, p: GmailPayload, appUrl: string): string {
  const to = oneLine(p.to);
  if (!/^[^\s@<>"]+@[^\s@<>"]+$/.test(to)) throw new Error('destinatário inválido');
  const body = [
    `Olá, ${oneLine(p.name)}.`, '', oneLine(p.subject), '',
    `Acesse o SGI para ver os detalhes: ${appUrl}${p.link && p.link.startsWith('/') ? p.link : '/notificacoes'}`, '',
    'Mensagem automática do sistema interno da serventia. Não responda.',
  ].join('\r\n');
  const raw = [
    `From: SGI <${sender}>`, `To: <${to}>`, `Subject: =?UTF-8?B?${b64(`[SGI] ${oneLine(p.subject)}`)}?=`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(body),
  ].join('\r\n');
  return Buffer.from(raw, 'utf8').toString('base64url');
}

async function sendOne(row: { channel: string; payload: GmailPayload & ChatPayload }): Promise<{ ok: true } | { ok: false; permanent: boolean; error: string }> {
  const cfg = getConfig();
  try {
    if (row.channel === 'GMAIL') {
      if (!cfg.google.gmailSender) return { ok: false, permanent: false, error: 'GMAIL_SENDER não configurado' };
      const res = await googleFetch(`${cfg.google.gmailApiUrl}/gmail/v1/users/me/messages/send`, SCOPES.gmailSend, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw: buildEmail(cfg.google.gmailSender, row.payload, cfg.appUrl) }),
      }, cfg.google.gmailSender);
      if (!res.ok) return { ok: false, permanent: res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 401, error: `Gmail HTTP ${res.status}` };
    } else {
      if (!cfg.google.chatWebhook) return { ok: false, permanent: false, error: 'GOOGLE_CHAT_WEBHOOK_URL não configurado' };
      const res = await fetch(cfg.google.chatWebhook, { method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ text: row.payload.text }) });
      if (!res.ok) return { ok: false, permanent: res.status >= 400 && res.status < 500 && res.status !== 429, error: `Chat HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, permanent: false, error: String(err).slice(0, 200) };
  }
}

export const MAX_ATTEMPTS = 8;
/** Espera antes da próxima tentativa: 2^n minutos, no máximo 24 h. */
export function backoffMinutes(attempts: number): number {
  return Math.min(2 ** attempts, 24 * 60);
}

/**
 * Envia as mensagens pendentes. Cada lote é "reservado" (lease de 5 min) com SKIP LOCKED, para que despachos
 * simultâneos nunca enviem a mesma mensagem duas vezes. Mensagens com mais de 7 dias são descartadas.
 */
export async function dispatchOutbox(limit = 50): Promise<{ sent: number; failed: number; retried: number; discarded: number }> {
  const db = getPool();
  const discarded = (await query(db, "UPDATE integration_outbox SET status='DESCARTADO', last_error=coalesce(last_error,'')||' (expirada)' WHERE status='PENDENTE' AND created_at < now() - interval '7 days' RETURNING id")).length;
  const batch = await query<{ id: string; channel: string; payload: GmailPayload & ChatPayload; attempts: number }>(db,
    `UPDATE integration_outbox SET next_attempt_at = now() + interval '5 minutes'
      WHERE id IN (SELECT id FROM integration_outbox WHERE status = 'PENDENTE' AND next_attempt_at <= now() ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, channel, payload, attempts`, [limit]);
  let sent = 0, failed = 0, retried = 0;
  for (const row of batch) {
    const r = await sendOne(row);
    if (r.ok) {
      await query(db, "UPDATE integration_outbox SET status='ENVIADO', sent_at=now(), attempts=attempts+1, last_error=NULL WHERE id=$1", [row.id]);
      sent++;
    } else if (r.permanent || row.attempts + 1 >= MAX_ATTEMPTS) {
      await query(db, "UPDATE integration_outbox SET status='FALHA', attempts=attempts+1, last_error=$2 WHERE id=$1", [row.id, r.error]);
      failed++;
    } else {
      await query(db, "UPDATE integration_outbox SET attempts=attempts+1, last_error=$2, next_attempt_at=now() + make_interval(mins => $3) WHERE id=$1",
        [row.id, r.error, backoffMinutes(row.attempts + 1)]);
      retried++;
    }
  }
  return { sent, failed, retried, discarded };
}

export async function retryFailed(ctx: Ctx): Promise<number> {
  requirePermission(ctx, 'integracoes.gerenciar');
  return tx(async (c) => {
    const n = (await query(c, "UPDATE integration_outbox SET status='PENDENTE', attempts=0, next_attempt_at=now() WHERE status='FALHA' AND created_at > now() - interval '7 days' RETURNING id")).length;
    await audit(c, ctx, { action: 'INTEGRACAO_REENVIO', entityType: 'integration', entityId: null, summary: `${n} mensagem(ns) com falha recolocada(s) na fila` });
    return n;
  });
}

// ---------------------------------------------------------------------------
// Agenda: fontes de eventos (usadas pela sincronização com o Google e pela agenda interna)
// ---------------------------------------------------------------------------

export type AgendaSource = 'FERIAS' | 'PLANTAO' | 'MARCO' | 'COMPENSACAO' | 'EVENTO';
export type AgendaItem = {
  type: AgendaSource; id: string; title: string; description: string; startDate: string; endDate: string; // endDate inclusiva
  startTime: number | null; endTime: number | null; employeeIds: string[]; sectorId: string | null; projectId: string | null; link: string | null;
};

/** Fatos do sistema que viram eventos de agenda, no intervalo [from, to]. */
export async function collectAgenda(db: Db, from: string, to: string, types: AgendaSource[]): Promise<AgendaItem[]> {
  const out: AgendaItem[] = [];
  const name = (social: string | null, full: string) => social || full;
  if (types.includes('FERIAS')) {
    for (const r of await query<{ id: string; employee_id: string; sector_id: string; social_name: string | null; full_name: string; start_date: string; end_date: string }>(db,
      `SELECT a.id, a.employee_id, e.sector_id, e.social_name, e.full_name, a.start_date, a.end_date FROM absences a JOIN employees e ON e.id = a.employee_id
        WHERE a.type = 'FERIAS' AND a.status = 'ATIVA' AND a.end_date >= $1 AND a.start_date <= $2`, [from, to])) {
      out.push({ type: 'FERIAS', id: r.id, title: `Férias — ${name(r.social_name, r.full_name)}`, description: 'Período de férias.', startDate: r.start_date, endDate: r.end_date,
        startTime: null, endTime: null, employeeIds: [r.employee_id], sectorId: r.sector_id, projectId: null, link: '/ferias' });
    }
  }
  if (types.includes('PLANTAO')) {
    for (const r of await query<{ id: string; shift_date: string; starts_at: Date; ends_at: Date; employee_id: string; substitute_employee_id: string | null; resp: string; sub: string | null; sector_id: string }>(db,
      `SELECT s.id, s.shift_date, s.starts_at, s.ends_at, s.employee_id, s.substitute_employee_id, coalesce(e.social_name, e.full_name) AS resp,
              coalesce(x.social_name, x.full_name) AS sub, e.sector_id
         FROM oncall_shifts s JOIN employees e ON e.id = s.employee_id LEFT JOIN employees x ON x.id = s.substitute_employee_id
        WHERE s.status <> 'CANCELADO' AND s.shift_date BETWEEN $1 AND $2`, [from, to])) {
      const hm = (d: Date) => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).format(d).split(':'); return Number(p[0]) * 60 + Number(p[1]); };
      out.push({ type: 'PLANTAO', id: r.id, title: `Plantão RCPN — ${r.resp}`, description: r.sub ? `Substituto de prontidão: ${r.sub}.` : 'Sem substituto designado.',
        startDate: r.shift_date, endDate: r.shift_date, startTime: hm(r.starts_at), endTime: hm(r.ends_at), employeeIds: [r.employee_id, r.substitute_employee_id].filter((x): x is string => !!x),
        sectorId: r.sector_id, projectId: null, link: `/plantoes?mes=${r.shift_date.slice(0, 7)}` });
    }
  }
  if (types.includes('MARCO')) {
    for (const r of await query<{ id: string; title: string; due_date: string; project_id: string; project: string; sector_id: string; done: boolean }>(db,
      `SELECT m.id, m.title, m.due_date, m.project_id, p.name AS project, p.sector_id, m.done_at IS NOT NULL AS done FROM project_milestones m JOIN projects p ON p.id = m.project_id
        WHERE p.status <> 'CANCELADO' AND m.due_date BETWEEN $1 AND $2`, [from, to])) {
      out.push({ type: 'MARCO', id: r.id, title: `${r.done ? '✓ ' : ''}Marco: ${r.title}`, description: `Projeto: ${r.project}.`, startDate: r.due_date, endDate: r.due_date,
        startTime: null, endTime: null, employeeIds: [], sectorId: r.sector_id, projectId: r.project_id, link: `/projetos/${r.project_id}` });
    }
  }
  if (types.includes('COMPENSACAO')) {
    for (const r of await query<{ id: string; employee_id: string; sector_id: string; nm: string; reference_date: string; payload: { mode?: string; minutes?: number } }>(db,
      `SELECT r.id, r.employee_id, e.sector_id, coalesce(e.social_name, e.full_name) AS nm, r.reference_date, r.payload FROM requests r JOIN employees e ON e.id = r.employee_id
        WHERE r.type = 'COMPENSACAO' AND r.status = 'APROVADA' AND r.reference_date BETWEEN $1 AND $2`, [from, to])) {
      const mode = r.payload.mode === 'FOLGA_INTEGRAL' ? 'folga integral' : `${String(r.payload.mode ?? '').replace(/_/g, ' ').toLowerCase()} (${formatHHMM(Number(r.payload.minutes ?? 0))})`;
      out.push({ type: 'COMPENSACAO', id: r.id, title: `Compensação — ${r.nm}`, description: `Compensação aprovada: ${mode}.`, startDate: r.reference_date, endDate: r.reference_date,
        startTime: null, endTime: null, employeeIds: [r.employee_id], sectorId: r.sector_id, projectId: null, link: '/solicitacoes' });
    }
  }
  if (types.includes('EVENTO')) {
    for (const r of await query<{ id: string; kind: string; title: string; description: string | null; start_date: string; end_date: string; start_time: number | null; end_time: number | null; sector_id: string | null }>(db,
      'SELECT id, kind, title, description, start_date, end_date, start_time, end_time, sector_id FROM institutional_events WHERE cancelled_at IS NULL AND end_date >= $1 AND start_date <= $2', [from, to])) {
      const prefix = r.kind === 'REUNIAO' ? 'Reunião: ' : r.kind === 'PRAZO' ? 'Prazo: ' : r.kind === 'TREINAMENTO' ? 'Treinamento: ' : '';
      out.push({ type: 'EVENTO', id: r.id, title: `${prefix}${r.title}`, description: r.description ?? '', startDate: r.start_date, endDate: r.end_date,
        startTime: r.start_time, endTime: r.end_time, employeeIds: [], sectorId: r.sector_id, projectId: null, link: '/agenda' });
    }
  }
  return out.sort((a, b) => a.startDate.localeCompare(b.startDate) || (a.startTime ?? -1) - (b.startTime ?? -1));
}

/** Itens da agenda interna visíveis ao usuário (mesmas regras de acesso dos módulos de origem). */
export async function agendaFor(ctx: Ctx, from: string, to: string) {
  const db = getPool();
  const p: Principal = ctx.principal;
  const items = await collectAgenda(db, from, to, ['FERIAS', 'PLANTAO', 'MARCO', 'COMPENSACAO', 'EVENTO']);
  const projects = new Set((await query<{ id: string }>(db,
    `SELECT p.id FROM projects p LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = $1 WHERE p.owner_user_id = $1 OR m.user_id IS NOT NULL`, [p.userId])).map((r) => r.id));
  const sees = (perm: string, it: AgendaItem) => it.employeeIds.some((e) => can(p, perm, { employeeId: e, sectorId: it.sectorId }));
  return items.filter((it) => {
    switch (it.type) {
      case 'FERIAS': return sees('ferias.ver', it);
      case 'PLANTAO': return sees('plantoes.ver', it);
      case 'COMPENSACAO': return sees('banco.ver', it);
      case 'MARCO': return p.isOwner || projects.has(it.projectId!) || can(p, 'tarefas.ver', { sectorId: it.sectorId });
      case 'EVENTO': return true;
    }
  });
}

const eventSchema = z.object({
  kind: z.enum(['REUNIAO', 'PRAZO', 'TREINAMENTO', 'INSTITUCIONAL']),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(3000).optional(),
  startDate: z.iso.date(),
  endDate: z.iso.date().optional(),
  startTime: z.number().int().min(0).max(1439).nullable().optional(),
  endTime: z.number().int().min(1).max(1440).nullable().optional(),
  sectorId: z.uuid().nullable().optional(),
  announce: z.boolean().default(false),
});

export async function createInstitutionalEvent(ctx: Ctx, input: z.input<typeof eventSchema>): Promise<string> {
  requirePermission(ctx, 'agenda.eventos');
  const d = eventSchema.parse(input);
  const end = d.endDate ?? d.startDate;
  if (end < d.startDate) throw new AppError('O término não pode ser anterior ao início.');
  if ((d.startTime == null) !== (d.endTime == null)) throw new AppError('Informe início e fim do horário, ou nenhum.');
  if (d.startTime != null && end === d.startDate && d.endTime! <= d.startTime) throw new AppError('O horário final deve ser posterior ao inicial.');
  return tx(async (c) => {
    const r = await queryOne<{ id: string }>(c, `INSERT INTO institutional_events (kind, title, description, start_date, end_date, start_time, end_time, sector_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [d.kind, d.title, d.description ?? null, d.startDate, end, d.startTime ?? null, d.endTime ?? null, d.sectorId ?? null, ctx.principal.userId]);
    await audit(c, ctx, { action: 'AGENDA_EVENTO', entityType: 'institutional_event', entityId: r!.id, summary: `Evento "${d.title}" em ${d.startDate}` });
    if (d.announce) {
      const when = `${d.startDate.split('-').reverse().join('/')}${d.startTime != null ? ` às ${formatHHMM(d.startTime)}` : ''}`;
      await enqueueChat(c, `evento:${r!.id}`, `📅 ${d.kind === 'REUNIAO' ? 'Reunião' : d.kind === 'PRAZO' ? 'Prazo' : d.kind === 'TREINAMENTO' ? 'Treinamento' : 'Evento'}: ${d.title} — ${when}. Detalhes no SGI.`);
    }
    return r!.id;
  });
}

export async function cancelInstitutionalEvent(ctx: Ctx, id: string): Promise<void> {
  requirePermission(ctx, 'agenda.eventos');
  z.uuid().parse(id);
  await tx(async (c) => {
    const r = await query(c, 'UPDATE institutional_events SET cancelled_at = now(), cancelled_by = $2 WHERE id = $1 AND cancelled_at IS NULL RETURNING id', [id, ctx.principal.userId]);
    if (!r.length) throw new NotFoundError('Evento não encontrado ou já cancelado.');
    await audit(c, ctx, { action: 'AGENDA_EVENTO_CANCELADO', entityType: 'institutional_event', entityId: id, summary: 'Evento institucional cancelado' });
  });
}

// ---------------------------------------------------------------------------
// Sincronização com a Agenda Google
// ---------------------------------------------------------------------------

export function toGoogleEvent(it: AgendaItem, appUrl: string) {
  const base = {
    summary: it.title,
    description: `${it.description}\n\nGerado pelo SGI — alterações feitas aqui são sobrescritas.${it.link ? `\n${appUrl}${it.link}` : ''}`,
    extendedProperties: { private: { sgiSource: `${it.type}:${it.id}` } },
  };
  if (it.startTime != null) {
    return { ...base,
      start: { dateTime: localToInstant(it.startDate, formatHHMM(it.startTime)).toISOString(), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: localToInstant(it.endDate, formatHHMM(Math.min(it.endTime!, 1439))).toISOString(), timeZone: 'America/Sao_Paulo' } };
  }
  return { ...base, start: { date: it.startDate }, end: { date: addDays(it.endDate, 1) } }; // fim exclusivo no Google
}

const SOURCE_SETTINGS: Record<AgendaSource, string> = {
  FERIAS: 'integracoes.calendar.ferias', PLANTAO: 'integracoes.calendar.plantoes', MARCO: 'integracoes.calendar.marcos',
  COMPENSACAO: 'integracoes.calendar.compensacoes', EVENTO: 'integracoes.calendar.eventos',
};

/**
 * Reconcilia a Agenda Google com o banco: cria, atualiza e remove eventos. Idempotente; uma execução por vez.
 * Falhas por item são contadas e retentadas na próxima execução; nada no banco do sistema é alterado além dos vínculos.
 */
export async function syncCalendar(db: Db = getPool()): Promise<{ skipped?: string; created: number; updated: number; deleted: number; failed: number }> {
  const cfg = getConfig();
  if (!(await flag(db, 'integracoes.calendar.ativo'))) return { skipped: 'desativada', created: 0, updated: 0, deleted: 0, failed: 0 };
  if (!cfg.google.calendarId) return { skipped: 'GOOGLE_CALENDAR_ID não configurado', created: 0, updated: 0, deleted: 0, failed: 0 };
  const client = await getPool().connect();
  try {
    const got = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext('calendar-sync')) AS ok");
    if (!got.rows[0]!.ok) return { skipped: 'sincronização já em andamento', created: 0, updated: 0, deleted: 0, failed: 0 };
    try {
      const enabled: AgendaSource[] = [];
      for (const [t, key] of Object.entries(SOURCE_SETTINGS)) if (await getSetting<boolean>(db, key, false)) enabled.push(t as AgendaSource);
      const today = todayLocal();
      const desired = await collectAgenda(db, addDays(today, -30), addDays(today, 400), enabled);
      const links = await query<{ source_type: string; source_id: string; google_event_id: string; payload_sha256: string }>(db, 'SELECT * FROM calendar_links');
      const linkMap = new Map(links.map((l) => [`${l.source_type}:${l.source_id}`, l]));
      const api = `${cfg.google.calendarApiUrl}/calendar/v3/calendars/${encodeURIComponent(cfg.google.calendarId)}/events`;
      const json = { 'content-type': 'application/json' };
      let created = 0, updated = 0, deleted = 0, failed = 0;
      const seen = new Set<string>();
      for (const it of desired) {
        const key = `${it.type}:${it.id}`;
        seen.add(key);
        const ev = toGoogleEvent(it, cfg.appUrl);
        const hash = createHash('sha256').update(canonicalJson(ev)).digest('hex');
        const link = linkMap.get(key);
        try {
          if (link && link.payload_sha256 === hash) continue;
          if (link) {
            const res = await googleFetch(`${api}/${encodeURIComponent(link.google_event_id)}`, SCOPES.calendar, { method: 'PATCH', headers: json, body: JSON.stringify(ev) });
            if (res.status === 404 || res.status === 410) {
              // Evento apagado diretamente no Google: recria.
              const re = await googleFetch(api, SCOPES.calendar, { method: 'POST', headers: json, body: JSON.stringify(ev) });
              if (!re.ok) throw new Error(`HTTP ${re.status}`);
              await query(db, 'UPDATE calendar_links SET google_event_id=$3, payload_sha256=$4, synced_at=now() WHERE source_type=$1 AND source_id=$2', [it.type, it.id, ((await re.json()) as { id: string }).id, hash]);
              created++;
              continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await query(db, 'UPDATE calendar_links SET payload_sha256=$3, synced_at=now() WHERE source_type=$1 AND source_id=$2', [it.type, it.id, hash]);
            updated++;
          } else {
            const res = await googleFetch(api, SCOPES.calendar, { method: 'POST', headers: json, body: JSON.stringify(ev) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await query(db, 'INSERT INTO calendar_links (source_type, source_id, google_event_id, payload_sha256) VALUES ($1,$2,$3,$4)', [it.type, it.id, ((await res.json()) as { id: string }).id, hash]);
            created++;
          }
        } catch (err) {
          failed++;
          console.error('[agenda] falha ao sincronizar', key, String(err).slice(0, 200));
        }
      }
      for (const l of links) {
        const key = `${l.source_type}:${l.source_id}`;
        if (seen.has(key)) continue;
        try {
          const res = await googleFetch(`${api}/${encodeURIComponent(l.google_event_id)}`, SCOPES.calendar, { method: 'DELETE' });
          if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`HTTP ${res.status}`);
          await query(db, 'DELETE FROM calendar_links WHERE source_type=$1 AND source_id=$2', [l.source_type, l.source_id]);
          deleted++;
        } catch (err) {
          failed++;
          console.error('[agenda] falha ao remover', key, String(err).slice(0, 200));
        }
      }
      await query(db, 'INSERT INTO calendar_sync_runs (created, updated, deleted, failed) VALUES ($1,$2,$3,$4)', [created, updated, deleted, failed]);
      return { created, updated, deleted, failed };
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('calendar-sync'))");
    }
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Administração
// ---------------------------------------------------------------------------

export const INTEGRATION_SETTINGS = [
  'integracoes.calendar.ativo', 'integracoes.calendar.ferias', 'integracoes.calendar.plantoes', 'integracoes.calendar.marcos',
  'integracoes.calendar.compensacoes', 'integracoes.calendar.eventos', 'integracoes.gmail.ativo', 'integracoes.gmail.somente_alta', 'integracoes.chat.ativo',
] as const;

export async function setIntegrationFlag(ctx: Ctx, key: string, value: boolean): Promise<void> {
  requirePermission(ctx, 'integracoes.gerenciar');
  if (!(INTEGRATION_SETTINGS as readonly string[]).includes(key)) throw new ForbiddenError();
  await tx(async (c) => {
    await query(c, 'UPDATE settings SET value = $2::jsonb, updated_by = $3, updated_at = now() WHERE key = $1', [key, JSON.stringify(value), ctx.principal.userId]);
    await audit(c, ctx, { action: 'INTEGRACAO_PARAMETRO', entityType: 'setting', entityId: key, summary: `${key} = ${value}` });
  });
  invalidateSettingsCache();
}

export async function integrationOverview() {
  const db = getPool();
  const cfg = getConfig();
  const flags = Object.fromEntries(await Promise.all(INTEGRATION_SETTINGS.map(async (k) => [k, (await getSetting<boolean>(db, k, false)) === true] as const)));
  const outbox = await query<{ channel: string; status: string; n: number }>(db,
    "SELECT channel, status, count(*)::int AS n FROM integration_outbox WHERE created_at > now() - interval '30 days' GROUP BY 1,2");
  const failures = await query<{ channel: string; last_error: string | null; created_at: Date; attempts: number }>(db,
    "SELECT channel, last_error, created_at, attempts FROM integration_outbox WHERE status IN ('FALHA','PENDENTE') AND last_error IS NOT NULL ORDER BY created_at DESC LIMIT 10");
  const lastSync = await queryOne<{ started_at: Date; created: number; updated: number; deleted: number; failed: number }>(db, 'SELECT * FROM calendar_sync_runs ORDER BY started_at DESC LIMIT 1');
  const links = (await queryOne<{ n: number }>(db, 'SELECT count(*)::int AS n FROM calendar_links'))!.n;
  return {
    flags, outbox, failures, lastSync, links,
    configured: { calendar: !!cfg.google.calendarId, gmail: !!cfg.google.gmailSender, chat: !!cfg.google.chatWebhook, serviceAccountKey: !!cfg.google.saKey },
    scopes: [
      { api: 'Google Drive', scope: SCOPES.drive, uso: 'Armazenamento opcional de arquivos documentais (Drive compartilhado)' },
      { api: 'Google Agenda', scope: SCOPES.calendar, uso: 'Criar, atualizar e remover eventos na agenda institucional compartilhada com a conta de serviço' },
      { api: 'Gmail', scope: SCOPES.gmailSend, uso: 'Somente envio, a partir de uma única caixa institucional (delegação em todo o domínio restrita a este escopo)' },
      { api: 'Google Chat', scope: '— (webhook de entrada do espaço)', uso: 'Avisos administrativos; sem OAuth e sem leitura de mensagens' },
    ],
  };
}
