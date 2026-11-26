import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import {
  adminRequestFileForDownload, createAdminRequest, getAdminRequest, handleAdminRequest, listAdminInbox,
} from '../../../src/server/modules/adminRequests.ts';
import { listAbsences } from '../../../src/server/modules/people.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { addDays, todayLocal } from '../../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';
import { resetConfigCache } from '../../../src/server/config.ts';

// Anexo abaixo da descrição do pedido e pedido de "Atestado / ausência": anexo com antivírus e hash; atestado (dado de saúde)
// só para quem pediu, a Oficial e quem atende E lança ausências; ao atender, a ausência é lançada e os dias abonados.
let I: Awaited<ReturnType<typeof ids>>;
let cOwner: Ctx, cSubst: Ctx, cAna: Ctx, cBia: Ctx, cAtende: Ctx;
let anaEmployee: string;
const PDF = new TextEncoder().encode('%PDF-1.4\n% atestado ficticio de teste\n%%EOF\n');
const EICAR = new TextEncoder().encode('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
const start = addDays(todayLocal(), -3);
const end = addDays(todayLocal(), -2);

beforeAll(async () => {
  // Antivírus real (clamd local), como no teste da Fase 3b.
  process.env.CLAMAV_HOST = process.env.TEST_CLAMAV_HOST ?? '127.0.0.1';
  process.env.CLAMAV_PORT = process.env.TEST_CLAMAV_PORT ?? '3310';
  resetConfigCache();
  await resetDatabase();
  I = await ids();
  const colab = (name: string) => makePerson({ name, sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
  cOwner = await ctxFor((await makePerson({ name: 'Oficial', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true })).userId);
  cSubst = await ctxFor((await makePerson({ name: 'Substituta', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] })).userId);
  const ana = await colab('Ana Fictícia');
  anaEmployee = ana.employeeId;
  cAna = await ctxFor(ana.userId);
  cBia = await ctxFor((await colab('Bia Fictícia')).userId);
  // Atende a administração, mas não lança ausências: não deve ver atestados.
  const atende = await colab('Atendente Adm Fictícia');
  await query(getPool(), `INSERT INTO roles (code, name) VALUES ('ATENDE_ADM', 'Atende administração (teste)')`);
  await query(getPool(), `INSERT INTO role_permissions (role_id, permission_code, scope) SELECT id, 'solicitacoes.administracao.atender', 'TODOS' FROM roles WHERE code = 'ATENDE_ADM'`);
  await query(getPool(), `INSERT INTO user_roles (user_id, role_id, valid_from) SELECT $1, id, current_date - 1 FROM roles WHERE code = 'ATENDE_ADM'`, [atende.userId]);
  cAtende = await ctxFor(atende.userId);
});
afterAll(async () => {
  delete process.env.CLAMAV_HOST; delete process.env.CLAMAV_PORT; resetConfigCache();
  await closePool();
});

describe('Anexos nas solicitações à administração', () => {
  it('pedido comum com anexo: antivírus, hash e download só para quem pode ver', async () => {
    const id = await createAdminRequest(cAna, { category: 'DOCUMENTO', subject: 'Comprovante de residência', body: 'Segue o comprovante para atualizar o cadastro.' },
      [{ name: 'comprovante.pdf', bytes: PDF }]);
    const r = await getAdminRequest(cSubst, id);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    const dl = await adminRequestFileForDownload(cOwner, id, r.files[0]!.id);
    expect(dl.filename).toBe('comprovante.pdf');
    await expect(adminRequestFileForDownload(cBia, id, r.files[0]!.id)).rejects.toThrow(/não encontrada/);
    await expect(query(getPool(), 'DELETE FROM admin_request_files WHERE request_id = $1', [id])).rejects.toThrow();
  });

  it('arquivo infectado é recusado e nada é gravado; mais de 5 arquivos, recusado', async () => {
    await expect(createAdminRequest(cAna, { category: 'OUTRO', subject: 'Arquivo', body: 'Arquivo de teste antivírus.' }, [{ name: 'x.txt', bytes: EICAR }]))
      .rejects.toThrow(/antivírus/);
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `a${i}.pdf`, bytes: PDF }));
    await expect(createAdminRequest(cAna, { category: 'OUTRO', subject: 'Muitos', body: 'Muitos arquivos de teste.' }, six)).rejects.toThrow(/no máximo 5/);
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM admin_requests WHERE subject IN ('Arquivo','Muitos')"))!.n).toBe(0);
  });
});

describe('Atestado / ausência', () => {
  let id: string;
  it('exige período e anexo; dado de saúde fica fora do alcance de quem só atende a administração', async () => {
    await expect(createAdminRequest(cAna, { category: 'ATESTADO', subject: 'Atestado', body: 'Consulta médica.' }, [{ name: 'atestado.pdf', bytes: PDF }])).rejects.toThrow(/período/);
    await expect(createAdminRequest(cAna, { category: 'ATESTADO', subject: 'Atestado', body: 'Consulta médica.', absenceStart: start, absenceEnd: end })).rejects.toThrow(/Anexe o atestado/);
    id = await createAdminRequest(cAna, { category: 'ATESTADO', subject: 'Atestado médico', body: 'Peço o abono dos dias do atestado.', absenceStart: start, absenceEnd: end },
      [{ name: 'atestado.pdf', bytes: PDF }]);
    await expect(getAdminRequest(cAtende, id)).rejects.toThrow(/não encontrada/);
    expect((await listAdminInbox(cAtende, 'ABERTAS')).some((r) => r.id === id)).toBe(false);
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'ADM_SOLICITACAO' AND link LIKE $2", [cAtende.principal.userId, `%${id}`]))!.n).toBe(0);
    expect((await getAdminRequest(cSubst, id)).can.launchAbsence).toBe(true);
  });

  it('ao atender, a ausência é lançada e ligada ao pedido; dias abonados; não lança duas vezes', async () => {
    await handleAdminRequest(cSubst, id, { status: 'ATENDIDA', response: 'Atestado recebido e abonado.', absence: { type: 'ATESTADO_MEDICO', startDate: start, endDate: end } });
    const r = await getAdminRequest(cAna, id);
    expect(r.status).toBe('ATENDIDA');
    expect(r.absence_id).not.toBeNull();
    const abs = (await listAbsences(getPool(), anaEmployee)).find((a) => a.id === r.absence_id)!;
    expect(abs).toMatchObject({ type: 'ATESTADO_MEDICO', start_date: start, end_date: end, counts_as_worked: true, request_id: id });
    await expect(handleAdminRequest(cSubst, id, { status: 'ATENDIDA', response: 'De novo', absence: { type: 'ATESTADO_MEDICO', startDate: start, endDate: end } })).rejects.toThrow();
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
