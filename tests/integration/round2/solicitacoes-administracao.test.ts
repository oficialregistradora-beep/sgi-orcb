import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import {
  addAdminRequestMessage, cancelAdminRequest, createAdminRequest, getAdminRequest, handleAdminRequest, listAdminInbox, listMyAdminRequests,
} from '../../../src/server/modules/adminRequests.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';

// Solicitações à administração: qualquer pessoa pede; Oficial e Substituta (permissão) atendem; "somente para a Oficial" é reservado.
let I: Awaited<ReturnType<typeof ids>>;
let cOwner: Ctx, cSubst: Ctx, cAna: Ctx, cBia: Ctx;
const notes = async (userId: string, kind: string) =>
  (await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = $2', [userId, kind]))!.n;

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  const colab = (name: string) => makePerson({ name, sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
  cOwner = await ctxFor((await makePerson({ name: 'Oficial', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true })).userId);
  cSubst = await ctxFor((await makePerson({ name: 'Substituta', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] })).userId);
  cAna = await ctxFor((await colab('Ana Fictícia')).userId);
  cBia = await ctxFor((await colab('Bia Fictícia')).userId);
});
afterAll(closePool);

describe('Solicitações à administração', () => {
  let id: string;
  it('qualquer funcionária pede; Oficial e Substituta são avisadas; colega não vê', async () => {
    await expect(createAdminRequest(cAna, { category: 'DOCUMENTO', subject: 'x', body: 'Preciso de uma declaração' })).rejects.toThrow(/assunto/);
    id = await createAdminRequest(cAna, { category: 'DOCUMENTO', subject: 'Declaração de vínculo', body: 'Preciso de uma declaração de vínculo para o banco.' });
    expect(await notes(cOwner.principal.userId, 'ADM_SOLICITACAO')).toBe(1);
    expect(await notes(cSubst.principal.userId, 'ADM_SOLICITACAO')).toBe(1);
    expect(await notes(cBia.principal.userId, 'ADM_SOLICITACAO')).toBe(0);
    expect((await listMyAdminRequests(cAna)).map((r) => r.id)).toEqual([id]);
    await expect(getAdminRequest(cBia, id)).rejects.toThrow(/não encontrada/);
    await expect(listAdminInbox(cBia, 'ABERTAS')).rejects.toThrow();
    expect((await listAdminInbox(cSubst, 'ABERTAS')).map((r) => r.id)).toEqual([id]);
  });

  it('conversa nos dois sentidos; quem pediu não atende; encerrar exige resposta e avisa quem pediu', async () => {
    await addAdminRequestMessage(cSubst, id, 'Para qual banco? Precisa constar o salário?');
    expect(await notes(cAna.principal.userId, 'ADM_SOLICITACAO_MENSAGEM')).toBe(1);
    await addAdminRequestMessage(cAna, id, 'Banco fictício; sem salário.');
    expect((await getAdminRequest(cAna, id)).can.handle).toBe(false);
    await expect(handleAdminRequest(cAna, id, { status: 'ATENDIDA', response: 'Feito' })).rejects.toThrow(/próprio pedido/);
    await handleAdminRequest(cSubst, id, { status: 'EM_ANDAMENTO' });
    await expect(handleAdminRequest(cSubst, id, { status: 'ATENDIDA' })).rejects.toThrow(/resposta/);
    await handleAdminRequest(cSubst, id, { status: 'ATENDIDA', response: 'Declaração pronta: retire na recepção.' });
    const r = await getAdminRequest(cAna, id);
    expect(r.status).toBe('ATENDIDA');
    expect(r.response).toContain('recepção');
    expect(r.messages).toHaveLength(2);
    expect(await notes(cAna.principal.userId, 'ADM_SOLICITACAO_RESPOSTA')).toBe(2);
    await expect(addAdminRequestMessage(cAna, id, 'Mais uma')).rejects.toThrow(/encerrada/);
    await expect(getPool().query('DELETE FROM admin_request_messages WHERE request_id = $1', [id])).rejects.toThrow();
    expect((await listAdminInbox(cOwner, 'ENCERRADAS')).map((x) => x.id)).toContain(id);
  });

  it('"somente para a Oficial": a Substituta não vê nem é avisada; quem pediu pode cancelar; cadeia íntegra', async () => {
    const before = await notes(cSubst.principal.userId, 'ADM_SOLICITACAO');
    const priv = await createAdminRequest(cBia, { category: 'PESSOAL', subject: 'Assunto de saúde', body: 'Gostaria de conversar em particular.', onlyOwner: true });
    expect(await notes(cSubst.principal.userId, 'ADM_SOLICITACAO')).toBe(before);
    await expect(getAdminRequest(cSubst, priv)).rejects.toThrow(/não encontrada/);
    expect((await listAdminInbox(cSubst, 'ABERTAS')).map((r) => r.id)).not.toContain(priv);
    expect((await listAdminInbox(cOwner, 'ABERTAS')).map((r) => r.id)).toContain(priv);
    await expect(cancelAdminRequest(cOwner, priv)).rejects.toThrow(/quem pediu/);
    await cancelAdminRequest(cBia, priv);
    expect((await getAdminRequest(cBia, priv)).status).toBe('CANCELADA');
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
