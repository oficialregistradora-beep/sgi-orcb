import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import {
  acknowledge, createDocument, decideVersion, fileForDownload, getDocument, listCategories, listDocuments, purgeFiles, saveDraft, submitForApproval,
} from '../../../src/server/modules/repository.ts';
import { getVersion } from '../../../src/server/modules/documents.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';

let I: Awaited<ReturnType<typeof ids>>;
let cOwner: Ctx, cSubst: Ctx, cCoord: Ctx, cRi: Ctx, cAtd: Ctx;
let catPop: string;
const PDF = new TextEncoder().encode('%PDF-1.4\n%fictício\n%%EOF\n');

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  const owner = await makePerson({ name: 'Oficial Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
  const subst = await makePerson({ name: 'Substituta Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] });
  const coord = await makePerson({ name: 'Coord RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }, { roleId: I.roles.COORDENACAO_SETOR }] });
  const ri = await makePerson({ name: 'Escrevente RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
  const atd = await makePerson({ name: 'Atendente', sectorId: I.sectors.ATD, jobId: I.jobs.atendente, roles: [{ roleId: I.roles.COLABORADOR }] });
  cOwner = await ctxFor(owner.userId);
  cSubst = await ctxFor(subst.userId);
  cCoord = await ctxFor(coord.userId);
  cRi = await ctxFor(ri.userId);
  cAtd = await ctxFor(atd.userId);
  catPop = (await listCategories()).find((c) => c.code === 'POP')!.id;
});
afterAll(closePool);

async function pendingDoc(title: string, withFile = false) {
  const id = await createDocument(cCoord, { categoryId: catPop, title, sectorId: I.sectors.RI, audienceType: 'SETORES', audienceSectorIds: [I.sectors.RI], requiresAcknowledgement: true });
  await saveDraft(cCoord, id, { texto: `Conteúdo fictício de ${title}`, notaVersao: '' }, withFile ? { name: 'a.pdf', bytes: PDF } : null);
  return { id, v: await submitForApproval(cCoord, id) };
}

describe('Rodada 2 — integridade no banco', () => {
  it('arquivos: não se excluem, não se alteram e o descarte é irreversível', async () => {
    const { id } = await pendingDoc('Doc arquivo', true);
    const f = (await queryOne<{ id: string }>(getPool(), 'SELECT file_id AS id FROM document_version_reviews r JOIN document_versions v ON v.id = r.version_id WHERE v.document_id = $1', [id]))!;
    await expect(query(getPool(), 'DELETE FROM document_files WHERE id = $1', [f.id])).rejects.toThrow(/não podem ser excluídos/);
    await expect(query(getPool(), "UPDATE document_files SET sha256 = repeat('0',64) WHERE id = $1", [f.id])).rejects.toThrow(/imutável/);
    await expect(query(getPool(), "UPDATE document_files SET data = 'x'::bytea WHERE id = $1", [f.id])).rejects.toThrow(/imutável/);
    await expect(query(getPool(), "UPDATE document_files SET data = NULL, purged_at = now() WHERE id = $1", [f.id])).rejects.toThrow(/violates check/);
  });

  it('decisões, eventos e versões são imutáveis; quem submete não decide (CHECK no banco)', async () => {
    const { id, v } = await pendingDoc('Doc decisão');
    await expect(query(getPool(), "UPDATE document_version_reviews SET decision = 'REJEITADA', decided_by = submitted_by, decided_at = now(), decision_notes = 'motivo válido' WHERE version_id = $1", [v]))
      .rejects.toThrow(/document_version_reviews_check3/);
    await expect(query(getPool(), "UPDATE document_version_reviews SET decision = 'APROVADA', decided_by = $2, decided_at = now() WHERE version_id = $1", [v, cSubst.principal.userId]))
      .rejects.toThrow(/violates check/); // aprovação sem assinatura vinculada
    await decideVersion(cSubst, id, { versionId: v, decision: 'REJEITADA', notes: 'Motivo fictício' });
    await expect(query(getPool(), "UPDATE document_version_reviews SET decision_notes = 'outro' WHERE version_id = $1", [v])).rejects.toThrow(/imutável/);
    await expect(query(getPool(), 'DELETE FROM document_version_reviews WHERE version_id = $1', [v])).rejects.toThrow(/não podem ser excluídas/);
    const evs = (await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM document_events WHERE document_id = $1', [id]))!.n;
    expect(evs).toBeGreaterThan(2);
    await expect(query(getPool(), 'DELETE FROM document_events WHERE document_id = $1', [id])).rejects.toThrow();
    await expect(query(getPool(), "UPDATE document_versions SET content_sha256 = repeat('0',64) WHERE id = $1", [v])).rejects.toThrow();
  });

  it('estado inconsistente de documento é recusado pelo banco (vigente sem versão)', async () => {
    const { id } = await pendingDoc('Doc estado');
    await expect(query(getPool(), "UPDATE documents SET status = 'VIGENTE', pending_version_id = NULL WHERE id = $1", [id])).rejects.toThrow(/ck_documents_repository/);
  });
});

describe('Rodada 2 — autorização e segregação', () => {
  it('aprovação, ciência e descarte exigem reautenticação recente', async () => {
    const { id, v } = await pendingDoc('Doc stepup');
    const noStep = await ctxFor(cSubst.principal.userId, { stepUp: false });
    await expect(decideVersion(noStep, id, { versionId: v, decision: 'APROVADA', confirmed: true })).rejects.toThrow(/reautenticação/);
    await decideVersion(cSubst, id, { versionId: v, decision: 'APROVADA', confirmed: true });
    await expect(acknowledge(await ctxFor(cRi.principal.userId, { stepUp: false }), id, true)).rejects.toThrow(/reautenticação/);
    await expect(purgeFiles(await ctxFor(cOwner.principal.userId, { stepUp: false }), id, 'Motivo de teste')).rejects.toThrow(/reautenticação/);
  });

  it('quem elaborou o rascunho não aprova, ainda que outra pessoa tenha submetido', async () => {
    const id = await createDocument(cSubst, { categoryId: catPop, title: 'Elaborado pela Substituta', sectorId: I.sectors.RI, audienceType: 'TODOS' });
    await saveDraft(cSubst, id, { texto: 'Texto elaborado pela Substituta (fictício).', notaVersao: '' });
    const v = await submitForApproval(cCoord, id);
    await expect(decideVersion(cSubst, id, { versionId: v, decision: 'APROVADA', confirmed: true })).rejects.toThrow(/Segregação/);
    await expect(decideVersion(cCoord, id, { versionId: v, decision: 'APROVADA', confirmed: true })).rejects.toThrow(/permissão/);
    await decideVersion(cOwner, id, { versionId: v, decision: 'APROVADA', confirmed: true });
  });

  it('aprovações concorrentes da mesma versão: só uma prevalece', async () => {
    const { id, v } = await pendingDoc('Doc concorrência');
    const r = await Promise.allSettled([
      decideVersion(cOwner, id, { versionId: v, decision: 'APROVADA', confirmed: true }),
      decideVersion(cSubst, id, { versionId: v, decision: 'APROVADA', confirmed: true }),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled').length).toBe(1);
    expect(String((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/não está aguardando/);
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM signatures WHERE document_version_id = $1 AND act = 'APROVACAO'", [v]))!.n).toBe(1);
  });

  it('submissões concorrentes: só uma versão fica pendente', async () => {
    const id = await createDocument(cCoord, { categoryId: catPop, title: 'Doc submissão dupla', sectorId: I.sectors.RI, audienceType: 'TODOS' });
    await saveDraft(cCoord, id, { texto: 'x (fictício)', notaVersao: '' });
    const r = await Promise.allSettled([submitForApproval(cCoord, id), submitForApproval(cCoord, id)]);
    expect(r.filter((x) => x.status === 'fulfilled').length).toBe(1);
    expect((await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM document_versions WHERE document_id = $1', [id]))!.n).toBe(1);
  });

  it('fora do público: leitura, ciência, download e exportação respondem como inexistentes', async () => {
    const { id, v } = await pendingDoc('Doc RI', true);
    await decideVersion(cSubst, id, { versionId: v, decision: 'APROVADA', confirmed: true });
    await expect(getDocument(cAtd, id)).rejects.toThrow(/não encontrado/);
    await expect(acknowledge(cAtd, id, true)).rejects.toThrow(/não encontrado/);
    await expect(fileForDownload(cAtd, id, v)).rejects.toThrow(/não encontrado/);
    expect((await fileForDownload(cRi, id, v)).data).not.toBeNull();
    await expect(fileForDownload(cRi, id, 'nao-e-uuid')).rejects.toThrow();
  });

  it('papel revogado retira o acesso imediatamente', async () => {
    const tmp = await makePerson({ name: 'Temporaria', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
    const id = (await listDocuments(cRi))[0]!.id;
    expect((await getDocument(await ctxFor(tmp.userId), id)).access.read).toBe(true);
    await query(getPool(), 'UPDATE user_roles SET revoked_at = now() WHERE user_id = $1', [tmp.userId]);
    await expect(getDocument(await ctxFor(tmp.userId), id)).rejects.toThrow(/não encontrado/);
  });

  it('documentos pessoais e do repositório não se cruzam', async () => {
    const { id, v } = await pendingDoc('Doc cruzamento');
    await expect(getVersion(cOwner, v)).rejects.toThrow(/não encontrado/);
    const personal = (await queryOne<{ id: string }>(getPool(), `INSERT INTO documents (category, title, reference_type, reference_key) VALUES ('Espelho','Espelho','ESPELHO','x:2026-01') RETURNING id`))!.id;
    await expect(getDocument(cOwner, personal)).rejects.toThrow(/não encontrado/);
    expect(id).toBeTruthy();
  });

  it('pesquisa com caracteres especiais não altera a consulta', async () => {
    for (const q of ["'); DROP TABLE documents; --", '%_\\', 'a & b | !c', '<script>']) {
      await expect(listDocuments(cOwner, { q })).resolves.toBeInstanceOf(Array);
    }
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM documents WHERE reference_type = 'REPOSITORIO'"))!.n).toBeGreaterThan(5);
  });
});

describe('Rodada 2 — adulteração detectada', () => {
  it('conteúdo de versão adulterado por fora do sistema bloqueia a aprovação', async () => {
    const { id, v } = await pendingDoc('Doc adulterado');
    await query(getPool(), 'ALTER TABLE document_versions DISABLE TRIGGER trg_docver_immutable');
    await query(getPool(), "UPDATE document_versions SET content = jsonb_set(content, '{texto}', '\"texto trocado\"') WHERE id = $1", [v]);
    await query(getPool(), 'ALTER TABLE document_versions ENABLE TRIGGER trg_docver_immutable');
    await expect(decideVersion(cSubst, id, { versionId: v, decision: 'APROVADA', confirmed: true })).rejects.toThrow(/integridade/);
  });

  it('arquivo adulterado bloqueia aprovação e download', async () => {
    const { id, v } = await pendingDoc('Doc arquivo adulterado', true);
    await query(getPool(), 'ALTER TABLE document_files DISABLE TRIGGER trg_document_files_guard');
    await query(getPool(), "UPDATE document_files SET data = '%PDF-1.4 trocado'::bytea WHERE id = (SELECT file_id FROM document_version_reviews WHERE version_id = $1)", [v]);
    await query(getPool(), 'ALTER TABLE document_files ENABLE TRIGGER trg_document_files_guard');
    await expect(decideVersion(cSubst, id, { versionId: v, decision: 'APROVADA', confirmed: true })).rejects.toThrow(/integridade do arquivo/);
    await expect(fileForDownload(cCoord, id, v)).rejects.toThrow(/integridade/);
  });

  it('trilha de auditoria íntegra após todas as operações', async () => {
    const r = await verifyAuditChain(getPool());
    expect(r.ok).toBe(true);
    expect(r.total).toBeGreaterThan(20);
  });
});
