import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne, tx } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import { resetConfigCache } from '../../../src/server/config.ts';
import { resetGoogleTokens } from '../../../src/server/google.ts';
import { notifyUsers } from '../../../src/server/modules/notifications.ts';
import {
  agendaFor, cancelInstitutionalEvent, createInstitutionalEvent, dispatchOutbox, integrationOverview, postAnnouncement, setIntegrationFlag, syncCalendar,
} from '../../../src/server/modules/integrations.ts';
import { createDocument, decideVersion, listCategories, saveDraft, submitForApproval } from '../../../src/server/modules/repository.ts';
import { addMilestone, createProject } from '../../../src/server/modules/projects.ts';
import { addDays, localToInstant, todayLocal } from '../../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';
import { startFakeGoogle } from '../../fakeGoogle.ts';

const CAL = 'agenda-institucional@group.calendar.google.com';
const SENDER = 'sgi@cartorio-teste.example';
let fake: Awaited<ReturnType<typeof startFakeGoogle>>;
let I: Awaited<ReturnType<typeof ids>>;
let cOwner: Ctx, cSubst: Ctx, cAna: Ctx, cBia: Ctx;
let ana: { userId: string; employeeId: string }, bia: { userId: string; employeeId: string };
const today = todayLocal();

function googleEnv(on: boolean) {
  for (const k of ['GOOGLE_SERVICE_ACCOUNT_KEY', 'GOOGLE_CALENDAR_ID', 'GMAIL_SENDER', 'GOOGLE_CHAT_WEBHOOK_URL', 'GOOGLE_CALENDAR_API_URL', 'GOOGLE_GMAIL_API_URL', 'GOOGLE_OAUTH_TOKEN_URL']) delete process.env[k];
  if (on) Object.assign(process.env, {
    GOOGLE_SERVICE_ACCOUNT_KEY: fake.saKey, GOOGLE_CALENDAR_ID: CAL, GMAIL_SENDER: SENDER, GOOGLE_CHAT_WEBHOOK_URL: `${fake.base}/chat/webhook`,
    GOOGLE_CALENDAR_API_URL: fake.base, GOOGLE_GMAIL_API_URL: fake.base, GOOGLE_OAUTH_TOKEN_URL: `${fake.base}/token`,
  });
  resetConfigCache();
  resetGoogleTokens();
}

beforeAll(async () => {
  fake = await startFakeGoogle({ calendarId: CAL, sender: SENDER });
  googleEnv(true);
  await resetDatabase();
  I = await ids();
  const o = await makePerson({ name: 'Oficial Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
  const s = await makePerson({ name: 'Substituta Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] });
  ana = await makePerson({ name: 'Ana RCPN', sectorId: I.sectors.RCPN, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
  bia = await makePerson({ name: 'Bia RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
  cOwner = await ctxFor(o.userId); cSubst = await ctxFor(s.userId); cAna = await ctxFor(ana.userId); cBia = await ctxFor(bia.userId);
});
afterEach(() => googleEnv(true));
afterAll(async () => { googleEnv(false); await fake.close(); await closePool(); });

describe('Fase 4c — Gmail', () => {
  it('desligado por padrão: notificações não geram e-mail', async () => {
    await tx((c) => notifyUsers(c, [ana.userId], { kind: 'TESTE', title: 'Aviso sem e-mail', priority: 'ALTA' }));
    expect((await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM integration_outbox'))!.n).toBe(0);
  });

  it('ativado: só prioridade alta (padrão); e-mail com título e link, sem o conteúdo da notificação', async () => {
    await setIntegrationFlag(cOwner, 'integracoes.gmail.ativo', true);
    await tx((c) => notifyUsers(c, [ana.userId], { kind: 'TESTE', title: 'Prioridade normal', body: 'nada', priority: 'NORMAL' }));
    await tx((c) => notifyUsers(c, [ana.userId], { kind: 'TESTE', title: 'Tarefa com prazo vencido', body: 'CONTEUDO-SENSIVEL-123', link: '/tarefas/x', priority: 'ALTA' }));
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM integration_outbox WHERE channel = 'GMAIL'"))!.n).toBe(1);
    const r = await dispatchOutbox();
    expect(r.sent).toBe(1);
    const mail = fake.mails.at(-1)!;
    expect(mail.sub).toBe(SENDER); // delegação: envia como a caixa institucional
    expect(mail.decoded).toMatch(/^From: SGI <sgi@cartorio-teste\.example>/);
    expect(mail.decoded).toContain(`To: <${(await queryOne<{ email: string }>(getPool(), 'SELECT email FROM users WHERE id = $1', [ana.userId]))!.email}>`);
    const body = Buffer.from(mail.decoded.split('\r\n\r\n').at(-1)!, 'base64').toString('utf8');
    expect(body).toContain('Tarefa com prazo vencido');
    expect(body).toContain('http://localhost:3000/tarefas/x');
    expect(mail.decoded + body).not.toContain('CONTEUDO-SENSIVEL-123');
    expect((await queryOne<{ status: string }>(getPool(), "SELECT status FROM integration_outbox WHERE channel = 'GMAIL'"))!.status).toBe('ENVIADO');
  });

  it('operação desfeita não envia nada (fila na mesma transação)', async () => {
    const before = (await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM integration_outbox'))!.n;
    await expect(tx(async (c) => {
      await notifyUsers(c, [ana.userId], { kind: 'TESTE', title: 'Nunca enviado', priority: 'ALTA' });
      throw new Error('falha na operação');
    })).rejects.toThrow(/falha/);
    expect((await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM integration_outbox'))!.n).toBe(before);
  });
});

describe('Fase 4c — Google Chat', () => {
  it('aviso administrativo: permissão própria; enviado ao espaço', async () => {
    await expect(postAnnouncement(cSubst, 'Expediente reduzido na sexta (fictício)')).rejects.toThrow(/desativada/);
    await setIntegrationFlag(cOwner, 'integracoes.chat.ativo', true);
    await expect(postAnnouncement(cAna, 'Tentativa do colaborador')).rejects.toThrow(/permissão/);
    await postAnnouncement(cSubst, 'Expediente reduzido na sexta (fictício)');
    await dispatchOutbox();
    expect(fake.chats.at(-1)).toContain('Expediente reduzido');
  });

  it('documento vigente para ciência: anuncia só se interno e para todos; confidencial nunca', async () => {
    const cat = (await listCategories()).find((c) => c.code === 'POLITICA')!.id;
    const publish = async (title: string, extra: Record<string, unknown>) => {
      const id = await createDocument(cOwner, { categoryId: cat, title, sectorId: I.sectors.DIR, requiresAcknowledgement: true, audienceType: 'TODOS', ...extra } as never);
      await saveDraft(cOwner, id, { texto: 'Texto fictício.', notaVersao: '' });
      const v = await submitForApproval(cOwner, id);
      await decideVersion(cSubst, id, { versionId: v, decision: 'APROVADA', confirmed: true });
    };
    await publish('Política de uso de e-mail (fictícia)', {});
    await publish('Plano sigiloso (fictício)', { confidentiality: 'CONFIDENCIAL', audienceType: 'USUARIOS', audienceUserIds: [cSubst.principal.userId] });
    await dispatchOutbox();
    expect(fake.chats.some((t) => t.includes('Política de uso de e-mail'))).toBe(true);
    expect(fake.chats.some((t) => t.includes('Plano sigiloso'))).toBe(false);
  });
});

describe('Fase 4c — Agenda', () => {
  let absenceId: string, shiftId: string;
  it('fontes: férias, plantão, marco, compensação e evento institucional', async () => {
    absenceId = (await queryOne<{ id: string }>(getPool(), "INSERT INTO absences (employee_id, type, start_date, end_date) VALUES ($1,'FERIAS',$2,$3) RETURNING id",
      [ana.employeeId, addDays(today, 10), addDays(today, 19)]))!.id;
    shiftId = (await queryOne<{ id: string }>(getPool(), `INSERT INTO oncall_shifts (shift_date, starts_at, ends_at, employee_id, substitute_employee_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [addDays(today, 3), localToInstant(addDays(today, 3), '08:00'), localToInstant(addDays(today, 3), '18:00'), ana.employeeId, bia.employeeId, cOwner.principal.userId]))!.id;
    const pid = await createProject(cOwner, { name: 'PQTA 2027 (fictício)', sectorId: I.sectors.DIR });
    await addMilestone(cOwner, pid, { title: 'Autoavaliação concluída', dueDate: addDays(today, 30) });
    await query(getPool(), `INSERT INTO requests (type, employee_id, requested_by, reference_date, payload, justification, status, decided_by, decided_at)
      VALUES ('COMPENSACAO',$1,$2,$3,'{"mode":"FOLGA_INTEGRAL","minutes":480}','Compensação fictícia','APROVADA',$4,now())`, [bia.employeeId, bia.userId, addDays(today, 5), cOwner.principal.userId]);
    await expect(createInstitutionalEvent(cAna, { kind: 'REUNIAO', title: 'Reunião', startDate: today })).rejects.toThrow(/permissão/);
    await createInstitutionalEvent(cSubst, { kind: 'REUNIAO', title: 'Reunião mensal da equipe', startDate: addDays(today, 7), startTime: 900, endTime: 960, announce: true });
    await dispatchOutbox();
    expect(fake.chats.at(-1)).toContain('Reunião: Reunião mensal da equipe');
  });

  it('desativada: não sincroniza; ativada: cria um evento por fonte habilitada (compensações desligadas por padrão)', async () => {
    expect((await syncCalendar()).skipped).toBe('desativada');
    await setIntegrationFlag(cOwner, 'integracoes.calendar.ativo', true);
    const r = await syncCalendar();
    expect(r).toEqual({ created: 4, updated: 0, deleted: 0, failed: 0 });
    const titles = [...fake.events.values()].map((e) => e.body.summary);
    expect(titles).toEqual(expect.arrayContaining(['Férias — Ana RCPN', 'Plantão RCPN — Ana RCPN', 'Marco: Autoavaliação concluída', 'Reunião: Reunião mensal da equipe']));
    const shift = [...fake.events.values()].find((e) => e.body.summary === 'Plantão RCPN — Ana RCPN')!.body as { start: { dateTime: string; timeZone: string } };
    expect(shift.start).toMatchObject({ timeZone: 'America/Sao_Paulo' });
    const ferias = [...fake.events.values()].find((e) => e.body.summary === 'Férias — Ana RCPN')!.body as { end: { date: string } };
    expect(ferias.end.date).toBe(addDays(today, 20)); // fim exclusivo
    expect(await syncCalendar()).toEqual({ created: 0, updated: 0, deleted: 0, failed: 0 }); // idempotente
  });

  it('ligar compensações, alterar, cancelar e apagar no Google: a agenda acompanha o banco', async () => {
    await setIntegrationFlag(cOwner, 'integracoes.calendar.compensacoes', true);
    expect((await syncCalendar()).created).toBe(1);
    await query(getPool(), 'UPDATE absences SET end_date = $2 WHERE id = $1', [absenceId, addDays(today, 24)]);
    expect((await syncCalendar()).updated).toBe(1);
    await query(getPool(), "UPDATE oncall_shifts SET status = 'CANCELADO' WHERE id = $1", [shiftId]);
    expect((await syncCalendar()).deleted).toBe(1);
    const link = (await queryOne<{ google_event_id: string }>(getPool(), "SELECT google_event_id FROM calendar_links WHERE source_type = 'FERIAS'"))!;
    fake.events.delete(link.google_event_id); // apagado diretamente no Google
    await query(getPool(), 'UPDATE absences SET end_date = $2 WHERE id = $1', [absenceId, addDays(today, 25)]);
    expect((await syncCalendar()).created).toBe(1); // recriado
    await setIntegrationFlag(cOwner, 'integracoes.calendar.ferias', false);
    expect((await syncCalendar()).deleted).toBe(1); // tipo desligado: eventos removidos
    expect([...fake.events.values()].some((e) => String(e.body.summary).startsWith('Férias'))).toBe(false);
  });

  it('evento institucional cancelado sai da agenda', async () => {
    const id = (await queryOne<{ id: string }>(getPool(), 'SELECT id FROM institutional_events LIMIT 1'))!.id;
    await cancelInstitutionalEvent(cSubst, id);
    expect((await syncCalendar()).deleted).toBe(1);
  });

  it('agenda interna respeita o acesso de origem: colaborador vê suas férias e plantões, não os de outros', async () => {
    const from = today, to = addDays(today, 60);
    await query(getPool(), "UPDATE oncall_shifts SET status = 'PLANEJADO' WHERE id = $1", [shiftId]);
    await createInstitutionalEvent(cSubst, { kind: 'PRAZO', title: 'Entrega do relatório anual', startDate: addDays(today, 9) });
    const asAna = (await agendaFor(cAna, from, to)).map((i) => i.type);
    expect(asAna).toEqual(expect.arrayContaining(['FERIAS', 'PLANTAO', 'EVENTO']));
    expect(asAna).not.toContain('COMPENSACAO'); // compensação é da Bia
    const asBia = await agendaFor(cBia, from, to);
    expect(asBia.some((i) => i.type === 'FERIAS')).toBe(false); // férias da Ana
    expect(asBia.some((i) => i.type === 'PLANTAO')).toBe(true); // Bia é substituta
    expect(asBia.some((i) => i.type === 'COMPENSACAO')).toBe(true);
    expect((await agendaFor(cOwner, from, to)).length).toBeGreaterThan(asBia.length);
  });

  it('painel de integrações registra os escopos e a situação', async () => {
    const o = await integrationOverview();
    expect(o.scopes.map((s) => s.scope)).toEqual(expect.arrayContaining(['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/gmail.send']));
    expect(o.configured).toMatchObject({ calendar: true, gmail: true, chat: true });
    expect(o.lastSync).not.toBeNull();
  });
});
