import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import {
  acknowledge, acknowledgementReport, changeLifecycle, createDocument, decideVersion, exportVersion, fileForDownload, getDocument,
  listCategories, listDocuments, listPendingAcknowledgements, listPendingDocApprovals, listReviewsDue, processReviewReminders, purgeFiles,
  saveCategory, saveDraft, submitForApproval, updateMetadata,
} from '../../../src/server/modules/repository.ts';
import { addMonths, todayLocal } from '../../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';

let I: Awaited<ReturnType<typeof ids>>;
type P = { userId: string; employeeId: string };
let owner: P, subst: P, coordRi: P, workerRi: P, workerAtd: P;
let cOwner: Ctx, cSubst: Ctx, cCoord: Ctx, cRi: Ctx, cAtd: Ctx;
let catPop: string, catPsi: string;
const today = todayLocal();
const PDF = new TextEncoder().encode('%PDF-1.4\n% documento ficticio de teste\n%%EOF\n');

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  owner = await makePerson({ name: 'Oficial Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
  subst = await makePerson({ name: 'Substituta Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] });
  coordRi = await makePerson({ name: 'Coord RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }, { roleId: I.roles.COORDENACAO_SETOR }] });
  workerRi = await makePerson({ name: 'Escrevente RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
  workerAtd = await makePerson({ name: 'Atendente ATD', sectorId: I.sectors.ATD, jobId: I.jobs.atendente, roles: [{ roleId: I.roles.COLABORADOR }] });
  cOwner = await ctxFor(owner.userId);
  cSubst = await ctxFor(subst.userId);
  cCoord = await ctxFor(coordRi.userId);
  cRi = await ctxFor(workerRi.userId);
  cAtd = await ctxFor(workerAtd.userId);
  const cats = await listCategories();
  expect(cats.length).toBe(21);
  catPop = cats.find((c) => c.code === 'POP')!.id;
  catPsi = cats.find((c) => c.code === 'PSI')!.id;
});
afterAll(closePool);

describe('Fase 3 — ciclo de vida do documento', () => {
  let popId: string;
  let v1: string;

  it('categorias iniciais: nenhuma com prazo de retenção presumido', async () => {
    const cats = await listCategories();
    expect(cats.every((c) => c.retention_months === null)).toBe(true);
    expect(cats.map((c) => c.name)).toContain('Plano de Recuperação de Desastres');
  });

  it('coordenação cria POP do próprio setor; não cria em outro setor', async () => {
    popId = await createDocument(cCoord, {
      categoryId: catPop, title: 'POP — Prenotação de títulos', code: 'pop-ri-001', sectorId: I.sectors.RI,
      audienceType: 'SETORES', audienceSectorIds: [I.sectors.RI], requiresAcknowledgement: true,
    });
    const { doc } = await getDocument(cCoord, popId);
    expect(doc.status).toBe('RASCUNHO');
    expect(doc.code).toBe('POP-RI-001');
    expect(doc.review_months).toBe(12); // padrão da categoria
    await expect(createDocument(cCoord, { categoryId: catPop, title: 'POP do atendimento', sectorId: I.sectors.ATD, audienceType: 'TODOS' }))
      .rejects.toThrow(/permissão/);
    await expect(createDocument(cCoord, { categoryId: catPop, title: 'Duplicado', code: 'POP-RI-001', sectorId: I.sectors.RI, audienceType: 'TODOS' }))
      .rejects.toThrow(/código/);
  });

  it('rascunho não é visível ao público; submissão vazia é recusada', async () => {
    expect((await listDocuments(cRi)).find((d) => d.id === popId)).toBeUndefined();
    await expect(getDocument(cRi, popId)).rejects.toThrow(/não encontrado/);
    await expect(submitForApproval(cCoord, popId)).rejects.toThrow(/vazio/);
  });

  it('rascunho com texto e PDF; arquivo com extensão falsa é recusado', async () => {
    await expect(saveDraft(cCoord, popId, { texto: 'x', notaVersao: '' }, { name: 'pop.pdf', bytes: new TextEncoder().encode('<html>não é pdf</html>') }))
      .rejects.toThrow(/não corresponde/);
    await expect(saveDraft(cCoord, popId, { texto: 'x', notaVersao: '' }, { name: 'script.exe', bytes: new Uint8Array([0x4d, 0x5a, 1]) }))
      .rejects.toThrow(/Formato não aceito/);
    await saveDraft(cCoord, popId, { texto: '1. Receber o título.\n2. Conferir a prenotação no livro protocolo.', notaVersao: 'Versão inicial' }, { name: 'pop-ri-001.pdf', bytes: PDF });
    const { draftFile } = await getDocument(cCoord, popId);
    expect(draftFile?.filename).toBe('pop-ri-001.pdf');
  });

  it('submete: versão imutável com hash; status em aprovação; rascunho bloqueado', async () => {
    v1 = await submitForApproval(cCoord, popId);
    const { doc, versions } = await getDocument(cCoord, popId);
    expect(doc.status).toBe('EM_APROVACAO');
    expect(versions[0]!.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(versions[0]!.content.arquivo?.nome).toBe('pop-ri-001.pdf');
    await expect(saveDraft(cCoord, popId, { texto: 'y', notaVersao: '' })).rejects.toThrow(/aguardando aprovação/);
    await expect(query(getPool(), "UPDATE document_versions SET content = '{}' WHERE id = $1", [v1])).rejects.toThrow();
  });

  it('aprovação: coordenação não aprova; Substituta vê a pendência e rejeita com motivo', async () => {
    expect(await listPendingDocApprovals(cCoord)).toEqual([]);
    await expect(decideVersion(cCoord, popId, { versionId: v1, decision: 'APROVADA', confirmed: true })).rejects.toThrow(/permissão/);
    expect((await listPendingDocApprovals(cSubst)).map((p) => p.id)).toContain(popId);
    await expect(decideVersion(cSubst, popId, { versionId: v1, decision: 'REJEITADA' })).rejects.toThrow(/motivo/);
    await decideVersion(cSubst, popId, { versionId: v1, decision: 'REJEITADA', notes: 'Incluir o prazo de prenotação.' });
    const { doc, versions } = await getDocument(cCoord, popId);
    expect(doc.status).toBe('RASCUNHO');
    expect(doc.draft?.texto).toContain('Receber o título'); // rascunho restaurado para correção
    expect(versions[0]!.decision).toBe('REJEITADA');
  });

  let v2: string;
  it('nova submissão aprovada pela Substituta com assinatura: vigente, revisão em 12 meses', async () => {
    await saveDraft(cCoord, popId, { texto: '1. Receber o título.\n2. Prenotar no protocolo.\n3. Observar o prazo legal de prenotação.', notaVersao: 'Ajuste solicitado' });
    v2 = await submitForApproval(cCoord, popId);
    await expect(decideVersion(cSubst, popId, { versionId: v2, decision: 'APROVADA' })).rejects.toThrow(/confirmar/);
    await decideVersion(cSubst, popId, { versionId: v2, decision: 'APROVADA', confirmed: true, notes: 'Conferido.' });
    const { doc, versions } = await getDocument(cCoord, popId);
    expect(doc.status).toBe('VIGENTE');
    expect(doc.current_version_id).toBe(v2);
    expect(doc.effective_from).toBe(today);
    expect(doc.next_review_on).toBe(addMonths(today, 12));
    const sig = await queryOne<{ act: string; content_sha256: string }>(getPool(), 'SELECT act, content_sha256 FROM signatures WHERE document_version_id = $1', [v2]);
    expect(sig?.act).toBe('APROVACAO');
    expect(sig?.content_sha256).toBe(versions.find((v) => v.id === v2)!.content_sha256);
  });

  it('público do setor lê a versão vigente; outro setor não; histórico restrito', async () => {
    const asRi = await getDocument(cRi, popId);
    expect(asRi.versions.map((v) => v.id)).toEqual([v2]);
    expect(asRi.events).toEqual([]);
    expect(asRi.doc.draft).toBeNull();
    await expect(getDocument(cAtd, popId)).rejects.toThrow(/não encontrado/);
    expect((await listDocuments(cAtd)).find((d) => d.id === popId)).toBeUndefined();
  });

  it('pesquisa textual encontra pelo conteúdo da versão vigente (com flexão)', async () => {
    const r = await listDocuments(cRi, { q: 'prazos' });
    expect(r.map((d) => d.id)).toContain(popId);
    expect((await listDocuments(cRi, { q: 'inexistente-xyz' })).length).toBe(0);
    expect((await listDocuments(cRi, { q: '%' })).length).toBe(0); // curinga tratado como literal
  });

  it('ciência: pendente para o público; registrada com assinatura; relatório de cobertura', async () => {
    expect((await listPendingAcknowledgements(cRi)).map((d) => d.id)).toContain(popId);
    expect((await listPendingAcknowledgements(cAtd)).length).toBe(0);
    await expect(acknowledge(cAtd, popId, true)).rejects.toThrow(/não encontrado/);
    await expect(acknowledge(cRi, popId, false)).rejects.toThrow(/confirmar/);
    await acknowledge(cRi, popId, true);
    await expect(acknowledge(cRi, popId, true)).rejects.toThrow(/já registrada/);
    expect((await listPendingAcknowledgements(cRi)).length).toBe(0);
    const rep = await acknowledgementReport(cSubst, popId);
    expect(rep!.total).toBe(2); // coordenação + escrevente do RI
    expect(rep!.done).toBe(1);
    await expect(acknowledgementReport(cRi, popId)).rejects.toThrow(/permissão/);
  });

  it('download: arquivo da versão vigente com hash conferido; rascunho só para quem edita', async () => {
    const f = await fileForDownload(cRi, popId, v2);
    expect(Buffer.from(f.data!).toString()).toContain('%PDF');
    await expect(fileForDownload(cRi, popId, v1)).rejects.toThrow(/não encontrado/);
    await expect(fileForDownload(cRi, popId, 'rascunho')).rejects.toThrow(/não encontrado/);
  });

  it('revisão: nova versão substitui a anterior (que fica superada) e reabre a ciência', async () => {
    await saveDraft(cCoord, popId, { texto: 'Texto revisado.', notaVersao: '' });
    await expect(submitForApproval(cCoord, popId)).rejects.toThrow(/nota da versão/);
    await saveDraft(cCoord, popId, { texto: 'Texto revisado.', notaVersao: 'Revisão anual' });
    const v3 = await submitForApproval(cCoord, popId);
    expect((await getDocument(cRi, popId)).doc.status).toBe('VIGENTE'); // continua vigente durante a revisão
    await decideVersion(cOwner, popId, { versionId: v3, decision: 'APROVADA', confirmed: true });
    const { versions } = await getDocument(cCoord, popId);
    expect(versions.find((v) => v.id === v2)!.superseded_at).not.toBeNull();
    expect((await listPendingAcknowledgements(cRi)).map((d) => d.id)).toContain(popId);
    const exp = await exportVersion(cRi, popId, v3);
    expect(exp.verificacao.conteudoIntegro).toBe(true);
    expect(exp.assinaturas[0]!.act).toBe('APROVACAO');
    await expect(exportVersion(cRi, popId, v2)).rejects.toThrow(/não encontrada/);
  });

  it('revisões próximas: aviso uma única vez ao responsável', async () => {
    await query(getPool(), "UPDATE documents SET next_review_on = current_date + 5 WHERE id = $1", [popId]);
    expect((await listReviewsDue(cCoord)).map((d) => d.id)).toContain(popId);
    expect((await listReviewsDue(cRi)).length).toBe(0);
    expect(await processReviewReminders()).toBe(1);
    expect(await processReviewReminders()).toBe(0);
  });

  it('obsolescência e arquivamento; descarte bloqueado sem prazo de retenção', async () => {
    await expect(changeLifecycle(cCoord, popId, 'OBSOLETO', 'Substituído')).rejects.toThrow(/permissão/);
    await changeLifecycle(cSubst, popId, 'OBSOLETO', 'Substituído pelo novo manual do RI');
    expect((await listDocuments(cRi)).find((d) => d.id === popId)).toBeUndefined();
    await changeLifecycle(cOwner, popId, 'ARQUIVADO', 'Arquivamento após obsolescência');
    expect((await listDocuments(cOwner)).find((d) => d.id === popId)).toBeUndefined();
    expect((await listDocuments(cOwner, { status: 'ARQUIVADO' })).map((d) => d.id)).toContain(popId);
    await expect(purgeFiles(cSubst, popId, 'Prazo cumprido')).rejects.toThrow(/permissão/);
    await expect(purgeFiles(cOwner, popId, 'Prazo cumprido')).rejects.toThrow(/não definido/);
  });

  it('retenção definida (com fundamento) e vencida: descarte preserva hash e metadados', async () => {
    await expect(saveCategory(cOwner, { id: catPop, code: 'POP', name: 'POPs por atribuição', reviewMonths: 12, retentionMonths: 60, defaultConfidentiality: 'INTERNO', active: true }))
      .rejects.toThrow(/fundamento/);
    await saveCategory(cOwner, { id: catPop, code: 'POP', name: 'POPs por atribuição', reviewMonths: 12, retentionMonths: 60, retentionBasis: 'Decisão fictícia de teste nº 1', defaultConfidentiality: 'INTERNO', active: true });
    await query(getPool(), "UPDATE documents SET retention_until = current_date - 1 WHERE id = $1", [popId]);
    expect(await purgeFiles(cOwner, popId, 'Prazo de retenção cumprido (teste)')).toBe(1);
    const f = await queryOne<{ data: Buffer | null; sha256: string }>(getPool(), 'SELECT data, sha256 FROM document_files LIMIT 1');
    expect(f!.data).toBeNull();
    expect(f!.sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(fileForDownload(cOwner, popId, v2)).rejects.toThrow(/descartado/);
  });
});

describe('Fase 3 — confidencialidade', () => {
  let psi: string;
  it('confidencial exige lista nominal; gestão (Substituta) não alcança o documento', async () => {
    await expect(createDocument(cOwner, { categoryId: catPsi, title: 'Plano de resposta a incidentes', confidentiality: 'CONFIDENCIAL', sectorId: I.sectors.DIR, audienceType: 'TODOS' }))
      .rejects.toThrow(/nominalmente/);
    psi = await createDocument(cOwner, {
      categoryId: catPsi, title: 'Plano de resposta a incidentes', confidentiality: 'CONFIDENCIAL', sectorId: I.sectors.DIR,
      audienceType: 'USUARIOS', audienceUserIds: [workerAtd.userId],
    });
    await saveDraft(cOwner, psi, { texto: 'Contatos e procedimentos de resposta (fictício).', notaVersao: '' });
    const v = await submitForApproval(cOwner, psi);
    expect(await listPendingDocApprovals(cSubst)).toEqual([]);
    await expect(getDocument(cSubst, psi)).rejects.toThrow(/não encontrado/);
    await expect(decideVersion(cSubst, psi, { versionId: v, decision: 'APROVADA', confirmed: true })).rejects.toThrow(/não encontrado/);
    // A Oficial submeteu: não pode aprovar a própria versão (segregação).
    await expect(decideVersion(cOwner, psi, { versionId: v, decision: 'APROVADA', confirmed: true })).rejects.toThrow(/Segregação/);
  });

  it('restrito não pode ser destinado a todos', async () => {
    await expect(createDocument(cSubst, { categoryId: catPsi, title: 'Restrito', confidentiality: 'RESTRITO', sectorId: I.sectors.DIR, audienceType: 'TODOS' }))
      .rejects.toThrow(/restrito/);
  });

  it('alteração de acesso de documento publicado exige gestão; alteração que remove o próprio acesso é recusada', async () => {
    const id = await createDocument(cCoord, { categoryId: catPop, title: 'POP — Certidões', sectorId: I.sectors.RI, audienceType: 'TODOS' });
    await saveDraft(cCoord, id, { texto: 'Emitir certidão (fictício).', notaVersao: '' });
    const v = await submitForApproval(cCoord, id);
    await decideVersion(cSubst, id, { versionId: v, decision: 'APROVADA', confirmed: true });
    const base = { categoryId: catPop, title: 'POP — Certidões', sectorId: I.sectors.RI };
    await expect(updateMetadata(cCoord, id, { ...base, audienceType: 'SETORES', audienceSectorIds: [I.sectors.RI] })).rejects.toThrow(/gestão documental/);
    await updateMetadata(cCoord, id, { ...base, title: 'POP — Emissão de certidões', audienceType: 'TODOS' });
    await expect(updateMetadata(cSubst, id, { ...base, confidentiality: 'CONFIDENCIAL', audienceType: 'USUARIOS', audienceUserIds: [workerAtd.userId], responsibleUserId: workerAtd.userId }))
      .rejects.toThrow(/retiraria/);
  });
});
