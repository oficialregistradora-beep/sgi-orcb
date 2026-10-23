import { writeFileSync, mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne, tx } from '../../src/server/db.ts';
import type { Ctx } from '../../src/server/context.ts';
import { resetConfigCache } from '../../src/server/config.ts';
import { resetGoogleTokens } from '../../src/server/google.ts';
import { notifyUsers } from '../../src/server/modules/notifications.ts';
import { collectAgenda, dispatchOutbox, setIntegrationFlag, syncCalendar, toGoogleEvent } from '../../src/server/modules/integrations.ts';
import { verifyAuditChain } from '../../src/server/audit.ts';
import { addDays, localToInstant, todayLocal } from '../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../helpers.ts';
import { startFakeGoogle } from '../fakeGoogle.ts';

// RODADA 3 (Fase 4c) — 90 "dias" de operação com o Google instável: ~25% das execuções de envio e ~20% das
// sincronizações encontram o serviço fora do ar. Ao final, com o serviço estável, tudo deve convergir:
// cada notificação elegível gera exatamente um e-mail e a agenda Google espelha exatamente o banco.

const CAL = 'sim@group.calendar.google.com';
const SENDER = 'sgi@cartorio-teste.example';
const KEYS = ['GOOGLE_SERVICE_ACCOUNT_KEY', 'GOOGLE_CALENDAR_ID', 'GMAIL_SENDER', 'GOOGLE_CHAT_WEBHOOK_URL', 'GOOGLE_CALENDAR_API_URL', 'GOOGLE_GMAIL_API_URL', 'GOOGLE_OAUTH_TOKEN_URL'];
const metrics: Record<string, number> = {};
let seed = 71;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
let fake: Awaited<ReturnType<typeof startFakeGoogle>>;
let cOwner: Ctx;
const people: { userId: string; employeeId: string }[] = [];

beforeAll(async () => {
  fake = await startFakeGoogle({ calendarId: CAL, sender: SENDER });
  Object.assign(process.env, {
    GOOGLE_SERVICE_ACCOUNT_KEY: fake.saKey, GOOGLE_CALENDAR_ID: CAL, GMAIL_SENDER: SENDER, GOOGLE_CHAT_WEBHOOK_URL: `${fake.base}/chat/webhook`,
    GOOGLE_CALENDAR_API_URL: fake.base, GOOGLE_GMAIL_API_URL: fake.base, GOOGLE_OAUTH_TOKEN_URL: `${fake.base}/token`,
  });
  resetConfigCache(); resetGoogleTokens();
  await resetDatabase();
  const I = await ids();
  const o = await makePerson({ name: 'Oficial Sim', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
  cOwner = await ctxFor(o.userId);
  for (let i = 0; i < 8; i++) people.push(await makePerson({ name: `Pessoa ${i}`, sectorId: [I.sectors.RI, I.sectors.RCPN, I.sectors.ATD][i % 3]!, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] }));
  for (const k of ['integracoes.gmail.ativo', 'integracoes.calendar.ativo', 'integracoes.calendar.compensacoes']) await setIntegrationFlag(cOwner, k, true);
});
afterAll(async () => {
  mkdirSync('docs/test-reports', { recursive: true });
  writeFileSync('docs/test-reports/rodada3-fase4c-metricas.json', JSON.stringify({ executadoEm: new Date().toISOString(), metricas: metrics }, null, 2));
  for (const k of KEYS) delete process.env[k];
  resetConfigCache();
  await fake.close();
  await closePool();
});

describe('Rodada 3 (4c) — 90 dias com o Google instável', () => {
  it('opera e converge: e-mails exatamente uma vez; agenda espelha o banco', async () => {
    const today = todayLocal();
    let eligible = 0, notifications = 0, dispatchOutages = 0, syncOutages = 0, changes = 0;
    const shifts: string[] = [];
    const absences: string[] = [];
    for (let day = 0; day < 90; day++) {
      // Notificações do dia (prioridade alta ~30%); títulos únicos para auditar duplicidade.
      for (let k = 0; k < 6; k++) {
        const p = people[Math.floor(rnd() * people.length)]!;
        const high = rnd() < 0.3;
        await tx((c) => notifyUsers(c, [p.userId], { kind: 'SIM', title: `Aviso d${day}-${k}`, priority: high ? 'ALTA' : 'NORMAL' }));
        notifications++;
        if (high) eligible++;
      }
      // Mudanças na agenda: novas férias e plantões; cancelamentos e alterações ocasionais.
      const d = addDays(today, day);
      if (day % 7 === 5) {
        const p = people[day % people.length]!;
        shifts.push((await queryOne<{ id: string }>(getPool(), `INSERT INTO oncall_shifts (shift_date, starts_at, ends_at, employee_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [d, localToInstant(d, '08:00'), localToInstant(d, '18:00'), p.employeeId, cOwner.principal.userId]))!.id);
        changes++;
      }
      if (day % 15 === 3) {
        absences.push((await queryOne<{ id: string }>(getPool(), "INSERT INTO absences (employee_id, type, start_date, end_date) VALUES ($1,'FERIAS',$2,$3) RETURNING id",
          [people[day % people.length]!.employeeId, addDays(d, 20), addDays(d, 29)]))!.id);
        changes++;
      }
      if (day % 20 === 10 && shifts.length) { await query(getPool(), "UPDATE oncall_shifts SET status = 'CANCELADO' WHERE id = $1", [shifts.shift()]); changes++; }
      if (day % 25 === 12 && absences.length) { await query(getPool(), 'UPDATE absences SET end_date = end_date + 2 WHERE id = $1', [absences[0]]); changes++; }
      // Rotinas do "dia": envio e sincronização, com o Google fora do ar em parte das vezes.
      fake.state.down = rnd() < 0.25;
      if (fake.state.down) dispatchOutages++;
      await dispatchOutbox(100);
      await query(getPool(), "UPDATE integration_outbox SET next_attempt_at = now() WHERE status = 'PENDENTE'"); // o tempo passa
      fake.state.down = rnd() < 0.2;
      if (fake.state.down) syncOutages++;
      await syncCalendar();
    }
    // Serviço estável: algumas rodadas finais.
    fake.state.down = false;
    for (let i = 0; i < 3; i++) { await dispatchOutbox(500); await query(getPool(), "UPDATE integration_outbox SET next_attempt_at = now() WHERE status = 'PENDENTE'"); await syncCalendar(); }
    Object.assign(metrics, { notificacoes: notifications, emails_elegiveis: eligible, emails_enviados: fake.mails.length, quedas_no_envio: dispatchOutages, quedas_na_sincronizacao: syncOutages, mudancas_na_agenda: changes });

    // Exatamente um e-mail por notificação elegível; nenhum para as demais.
    expect(fake.mails.length).toBe(eligible);
    const subjects = fake.mails.map((m) => /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(m.decoded)![1]!).map((b) => Buffer.from(b, 'base64').toString());
    expect(new Set(subjects).size).toBe(subjects.length);
    const stuck = await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM integration_outbox WHERE status <> 'ENVIADO'");
    expect(stuck!.n).toBe(0);

    // Agenda Google = desejado a partir do banco (mesmos eventos, mesmo conteúdo, sem sobras).
    const desired = await collectAgenda(getPool(), addDays(today, -30), addDays(today, 400), ['FERIAS', 'PLANTAO', 'MARCO', 'COMPENSACAO', 'EVENTO']);
    const want = desired.map((it) => JSON.stringify({ s: it.title, st: toGoogleEvent(it, 'http://localhost:3000').start, en: toGoogleEvent(it, 'http://localhost:3000').end })).sort();
    const have = [...fake.events.values()].map((e) => JSON.stringify({ s: e.body.summary, st: e.body.start, en: e.body.end })).sort();
    expect(have).toEqual(want);
    expect((await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM calendar_links'))!.n).toBe(desired.length);
    metrics.eventos_na_agenda = desired.length;
    metrics.chamadas_a_api = fake.state.calls;
  });

  it('trilha de auditoria íntegra', async () => {
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
