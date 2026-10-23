import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne, tx } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import { getConfig, resetConfigCache } from '../../../src/server/config.ts';
import { resetGoogleTokens } from '../../../src/server/google.ts';
import { notifyUsers } from '../../../src/server/modules/notifications.ts';
import {
  backoffMinutes, buildEmail, dispatchOutbox, enqueue, MAX_ATTEMPTS, retryFailed, setIntegrationFlag, syncCalendar, createInstitutionalEvent,
} from '../../../src/server/modules/integrations.ts';
import { addDays, todayLocal } from '../../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';
import { startFakeGoogle } from '../../fakeGoogle.ts';

const CAL = 'agenda@group.calendar.google.com';
const SENDER = 'sgi@cartorio-teste.example';
let fake: Awaited<ReturnType<typeof startFakeGoogle>>;
let cOwner: Ctx, cColab: Ctx;
let colabId: string;
const KEYS = ['GOOGLE_SERVICE_ACCOUNT_KEY', 'GOOGLE_CALENDAR_ID', 'GMAIL_SENDER', 'GOOGLE_CHAT_WEBHOOK_URL', 'GOOGLE_CALENDAR_API_URL', 'GOOGLE_GMAIL_API_URL', 'GOOGLE_OAUTH_TOKEN_URL', 'APP_ENV'];

function env(extra: Record<string, string> = {}) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, {
    GOOGLE_SERVICE_ACCOUNT_KEY: fake.saKey, GOOGLE_CALENDAR_ID: CAL, GMAIL_SENDER: SENDER, GOOGLE_CHAT_WEBHOOK_URL: `${fake.base}/chat/webhook`,
    GOOGLE_CALENDAR_API_URL: fake.base, GOOGLE_GMAIL_API_URL: fake.base, GOOGLE_OAUTH_TOKEN_URL: `${fake.base}/token`, ...extra,
  });
  resetConfigCache();
  resetGoogleTokens();
}
const outbox = () => query<{ status: string; attempts: number; next_attempt_at: Date; last_error: string | null }>(getPool(), 'SELECT status, attempts, next_attempt_at, last_error FROM integration_outbox ORDER BY created_at');
const mailTo = (title: string) => tx((c) => notifyUsers(c, [colabId], { kind: 'TESTE', title, priority: 'ALTA' }));

beforeAll(async () => {
  fake = await startFakeGoogle({ calendarId: CAL, sender: SENDER });
  env();
  await resetDatabase();
  const I = await ids();
  const o = await makePerson({ name: 'Oficial Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
  const c = await makePerson({ name: 'Colab', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
  cOwner = await ctxFor(o.userId); cColab = await ctxFor(c.userId); colabId = c.userId;
  await setIntegrationFlag(cOwner, 'integracoes.gmail.ativo', true);
  await setIntegrationFlag(cOwner, 'integracoes.chat.ativo', true);
  await setIntegrationFlag(cOwner, 'integracoes.calendar.ativo', true);
});
afterEach(async () => {
  fake.state.down = false; fake.state.gmailStatus = 200; fake.state.calendarStatus = 200; fake.state.chatStatus = 200;
  env();
});
afterAll(async () => { for (const k of KEYS) delete process.env[k]; resetConfigCache(); await fake.close(); await closePool(); });

describe('Rodada 2 (4c) — falhas do Google não afetam o sistema', () => {
  it('Google fora do ar: mensagem fica pendente com espera crescente; volta e é enviada uma única vez', async () => {
    await query(getPool(), 'DELETE FROM integration_outbox');
    await mailTo('Aviso durante indisponibilidade');
    fake.state.down = true;
    expect(await dispatchOutbox()).toMatchObject({ sent: 0, retried: 1 });
    let [row] = await outbox();
    expect(row).toMatchObject({ status: 'PENDENTE', attempts: 1 });
    expect(row!.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 60_000); // 2 min
    expect(await dispatchOutbox()).toMatchObject({ sent: 0, retried: 0 }); // ainda não é hora
    fake.state.down = false;
    await query(getPool(), 'UPDATE integration_outbox SET next_attempt_at = now()');
    const sentBefore = fake.mails.length;
    expect((await dispatchOutbox()).sent).toBe(1);
    expect(fake.mails.length).toBe(sentBefore + 1);
    [row] = await outbox();
    expect(row!.status).toBe('ENVIADO');
    expect(backoffMinutes(1)).toBe(2);
    expect(backoffMinutes(20)).toBe(1440);
  });

  it('após o máximo de tentativas, FALHA; reenvio manual pela administração', async () => {
    await query(getPool(), 'DELETE FROM integration_outbox');
    await mailTo('Sempre falha');
    fake.state.gmailStatus = 500;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await query(getPool(), 'UPDATE integration_outbox SET next_attempt_at = now()');
      await dispatchOutbox();
    }
    expect((await outbox())[0]).toMatchObject({ status: 'FALHA', attempts: MAX_ATTEMPTS, last_error: 'Gmail HTTP 500' });
    await expect(retryFailed(cColab)).rejects.toThrow(/permissão/);
    fake.state.gmailStatus = 200;
    expect(await retryFailed(cOwner)).toBe(1);
    expect((await dispatchOutbox()).sent).toBe(1);
  });

  it('erro permanente (delegação/escopo recusado) vai direto a FALHA, sem insistir', async () => {
    await query(getPool(), 'DELETE FROM integration_outbox');
    await mailTo('Delegação errada');
    env({ GMAIL_SENDER: 'outra.caixa@cartorio-teste.example' }); // o Google recusa a delegação para esta caixa (simulado: 403)
    expect((await dispatchOutbox()).failed).toBe(1);
    expect((await outbox())[0]).toMatchObject({ status: 'FALHA', attempts: 1, last_error: 'Gmail HTTP 403' });
  });

  it('agenda com o Google falhando: nada é vinculado; na próxima execução tudo é criado', async () => {
    await createInstitutionalEvent(cOwner, { kind: 'INSTITUCIONAL', title: 'Evento de teste', startDate: addDays(todayLocal(), 2) });
    fake.state.calendarStatus = 500;
    const r = await syncCalendar();
    expect(r.failed).toBeGreaterThan(0);
    expect((await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM calendar_links'))!.n).toBe(0);
    fake.state.calendarStatus = 200;
    expect((await syncCalendar()).created).toBe(r.failed);
  });
});

describe('Rodada 2 (4c) — concorrência e idempotência', () => {
  it('despachos simultâneos não enviam a mesma mensagem duas vezes', async () => {
    await query(getPool(), 'DELETE FROM integration_outbox');
    for (let i = 0; i < 20; i++) await mailTo(`Mensagem ${i}`);
    const before = fake.mails.length;
    const r = await Promise.all([dispatchOutbox(), dispatchOutbox(), dispatchOutbox()]);
    expect(r.reduce((a, x) => a + x.sent, 0)).toBe(20);
    expect(fake.mails.length - before).toBe(20);
  });

  it('a mesma chave de evento nunca enfileira duas vezes', async () => {
    await tx(async (c) => { await enqueue(c, 'CHAT', 'chat:unico', { text: 'a' }); await enqueue(c, 'CHAT', 'chat:unico', { text: 'b' }); });
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM integration_outbox WHERE event_key = 'chat:unico'"))!.n).toBe(1);
  });

  it('sincronizações simultâneas da agenda: uma executa, a outra é recusada; nenhum evento duplicado', async () => {
    await createInstitutionalEvent(cOwner, { kind: 'REUNIAO', title: 'Concorrência', startDate: addDays(todayLocal(), 4) });
    const r = await Promise.all([syncCalendar(), syncCalendar()]);
    expect(r.filter((x) => !x.skipped).length).toBeGreaterThanOrEqual(1);
    expect(r.every((x) => !x.skipped || x.skipped === 'sincronização já em andamento')).toBe(true);
    const dup = await query(getPool(), 'SELECT google_event_id FROM calendar_links GROUP BY 1 HAVING count(*) > 1');
    expect(dup).toEqual([]);
    expect(fake.events.size).toBe((await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM calendar_links'))!.n);
  });

  it('mensagens antigas não enviadas são descartadas (sem disparos tardios em massa)', async () => {
    await query(getPool(), 'DELETE FROM integration_outbox');
    await mailTo('Antiga');
    await query(getPool(), "UPDATE integration_outbox SET created_at = now() - interval '8 days'");
    expect((await dispatchOutbox()).discarded).toBe(1);
    expect((await outbox())[0]!.status).toBe('DESCARTADO');
  });
});

describe('Rodada 2 (4c) — configuração e conteúdo seguros', () => {
  it('em produção: endereços de API substitutos, webhook fora do Google e remetente externo são recusados', () => {
    process.env.APP_URL = 'https://sgi.example';
    env({ APP_ENV: 'producao' });
    expect(() => getConfig()).toThrow(/não podem ser substituídos/);
    for (const k of ['GOOGLE_CALENDAR_API_URL', 'GOOGLE_GMAIL_API_URL', 'GOOGLE_OAUTH_TOKEN_URL']) delete process.env[k];
    resetConfigCache();
    expect(() => getConfig()).toThrow(/chat\.googleapis\.com/);
    process.env.GOOGLE_CHAT_WEBHOOK_URL = 'https://chat.googleapis.com/v1/spaces/x/messages?key=k&token=t';
    process.env.GMAIL_SENDER = 'sgi@gmail.com';
    resetConfigCache();
    expect(() => getConfig()).toThrow(/domínio institucional/);
    process.env.APP_URL = 'http://localhost:3000';
  });

  it('e-mail: quebra de linha no assunto não injeta cabeçalhos; destinatário inválido é recusado', () => {
    const raw = Buffer.from(buildEmail(SENDER, { to: 'pessoa@cartorio-teste.example', name: 'Pessoa\r\nBcc: x@y.z', subject: 'Título\r\nBcc: atacante@exemplo.com', link: '/x' }, 'https://sgi'), 'base64url').toString();
    const headers = raw.split('\r\n\r\n')[0]!;
    expect(headers).not.toMatch(/^Bcc:/m);
    expect(headers.split('\r\n').length).toBe(6);
    expect(() => buildEmail(SENDER, { to: 'a@b.c>\r\nBcc: d@e.f', name: 'x', subject: 'y', link: null }, 'https://sgi')).toThrow(/destinatário/);
  });

  it('colaborador não altera parâmetros de integração', async () => {
    await expect(setIntegrationFlag(cColab, 'integracoes.gmail.ativo', false)).rejects.toThrow(/permissão/);
    await expect(setIntegrationFlag(cOwner, 'sessao.reautenticacao_minutos', true)).rejects.toThrow();
  });
});
