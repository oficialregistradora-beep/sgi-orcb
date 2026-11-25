import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import {
  accessFor, changeLifecycle, confirmResponsible, createDocument, decideVersion, deleteDocument, getDocument, listCategories, listDocuments,
  listInConstruction, listPendingDocApprovals, listResponsiblesToCheck, returnReview, revokeDelegation, saveDelegation, saveDraft, sendToReview,
  submitForApproval, withdrawSubmission,
} from '../../../src/server/modules/repository.ts';
import {
  approveProject, attachProjectFile, createProject, listProjectDocuments, sendAttachmentToRepository, updateProject,
} from '../../../src/server/modules/projects.ts';
import { createTask } from '../../../src/server/modules/tasks.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';

// Especificação da Oficial (25/11/2026): aprovação exclusiva da Oficial (com autoaprovação), revisão opcional por revisoras,
// retirar submissão, exclusão pela Oficial, documentos em projetos e autorização temporária da Substituta Legal.
let I: Awaited<ReturnType<typeof ids>>;
let cOwner: Ctx, cSubst: Ctx, cCoord: Ctx, cBeatriz: Ctx, cOutra: Ctx;
let catPop: string, catPsi: string;
const PDF = new TextEncoder().encode('%PDF-1.4\n% arquivo ficticio de teste\n%%EOF\n');

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  const mk = async (name: string, role: keyof typeof I.roles, sector = I.sectors.DIR, owner = false) =>
    ctxFor((await makePerson({ name, sectorId: sector, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles[role] }], owner })).userId);
  cOwner = await mk('Oficial Ficticia', 'OFICIAL', I.sectors.DIR, true);
  cSubst = await mk('Substituta Ficticia', 'SUBSTITUTA_LEGAL');
  cCoord = await mk('Coord Ficticia', 'COORDENACAO_SETOR', I.sectors.RI);
  cBeatriz = await mk('Beatriz Ficticia', 'COLABORADOR', I.sectors.ATD);
  cOutra = await mk('Outra Ficticia', 'COLABORADOR', I.sectors.ATD);
  const cats = await listCategories();
  catPop = cats.find((c) => c.code === 'POP')!.id;
  catPsi = cats.find((c) => c.code === 'PSI')!.id;
});
afterAll(closePool);

const meta = (title: string, extra: Record<string, unknown> = {}) => ({ categoryId: catPop, title, sectorId: I.sectors.DIR, audienceType: 'TODOS' as const, ...extra });

describe('Aprovação exclusiva da Oficial', () => {
  it('matriz: ninguém além da Oficial tem "aprovar"; a Substituta só com autorização vigente', async () => {
    const rows = await query<{ code: string }>(getPool(),
      "SELECT r.code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission_code IN ('documentos.aprovar','projetos.aprovar')");
    expect([...new Set(rows.map((r) => r.code))]).toEqual(['OFICIAL']);
    const d = { status: 'EM_APROVACAO' as const, confidentiality: 'INTERNO' as const, sector_id: I.sectors.DIR, responsible_user_id: 'x', created_by: 'x',
      audience_type: 'TODOS' as const, aud_sectors: [], aud_users: [], category_id: catPop };
    expect(accessFor(cSubst.principal, d).approve).toBe(false);
    expect(accessFor(cCoord.principal, d).approve).toBe(false);
    expect(accessFor(cOwner.principal, d).approve).toBe(true);
  });

  it('a Oficial aprova a versão que ela mesma elaborou: autoaprovação na Auditoria, com hash', async () => {
    const id = await createDocument(cOwner, { ...meta('padronização caixa CRC (fictício)'), responsibleUserId: cOwner.principal.userId });
    await saveDraft(cOwner, id, { texto: 'Procedimento fictício.', notaVersao: '' });
    const v = await submitForApproval(cOwner, id);
    expect((await listPendingDocApprovals(cOwner)).find((x) => x.id === id)).toMatchObject({ own: true });
    const view = await getDocument(cOwner, id);
    expect(view).toMatchObject({ canDecide: true, selfAuthored: true });
    await decideVersion(cOwner, id, { versionId: v, decision: 'APROVADA', confirmed: true });
    const a = await queryOne<{ summary: string }>(getPool(), "SELECT summary FROM audit_log WHERE action = 'DOC_AUTOAPROVADO' AND entity_id = $1", [v]);
    expect(a!.summary).toMatch(/Versão autoaprovada pela Oficial Registradora/);
    expect(a!.summary).toMatch(/sha256 [0-9a-f]{64}/);
  });

  it('autorização da Substituta: aprova no prazo, não aprova o que elaborou; revogada volta a "—"', async () => {
    const id = await createDocument(cCoord, { ...meta('POP do RI (fictício)', { sectorId: I.sectors.RI }), responsibleUserId: cCoord.principal.userId });
    await saveDraft(cCoord, id, { texto: 'Texto.', notaVersao: '' });
    const v = await submitForApproval(cCoord, id);
    await expect(decideVersion(cSubst, id, { versionId: v, decision: 'APROVADA', confirmed: true })).rejects.toThrow();
    await expect(saveDelegation(cSubst, { documents: true, projects: true, startsOn: '2026-01-01', endsOn: null, reason: 'Férias da Oficial' })).rejects.toThrow(/Somente a Oficial/);
    // Só categoria PSI: o POP continua fora do alcance.
    const onlyPsi = await saveDelegation(cOwner, { documents: true, projects: false, categoryIds: [catPsi], startsOn: '2026-01-01', endsOn: null, reason: 'Férias da Oficial (PSI)' });
    expect(accessFor((await ctxFor(cSubst.principal.userId)).principal, (await getDocument(cOwner, id)).doc).approve).toBe(false);
    await revokeDelegation(cOwner, onlyPsi);
    const del = await saveDelegation(cOwner, { documents: true, projects: true, startsOn: '2026-01-01', endsOn: '2099-12-31', reason: 'Férias da Oficial' });
    const subst = await ctxFor(cSubst.principal.userId);
    await decideVersion(subst, id, { versionId: v, decision: 'APROVADA', confirmed: true });
    const own = await createDocument(subst, { ...meta('Próprio da Substituta'), responsibleUserId: subst.principal.userId });
    await saveDraft(subst, own, { texto: 'Texto.', notaVersao: '' });
    const v2 = await submitForApproval(subst, own);
    await expect(decideVersion(subst, own, { versionId: v2, decision: 'APROVADA', confirmed: true })).rejects.toThrow(/Segregação/);
    await revokeDelegation(cOwner, del);
    expect((await ctxFor(cSubst.principal.userId)).principal.grants.has('documentos.aprovar')).toBe(false);
    // Prazo vencido também desliga sozinho.
    await saveDelegation(cOwner, { documents: true, projects: true, startsOn: '2026-01-01', endsOn: '2026-01-31', reason: 'Férias de janeiro' });
    expect((await ctxFor(cSubst.principal.userId)).principal.grants.has('documentos.aprovar')).toBe(false);
    await decideVersion(cOwner, own, { versionId: v2, decision: 'REJEITADA', notes: 'Ajustar o texto (fictício)' });
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM audit_log WHERE action IN ('APROVACAO_AUTORIZADA','APROVACAO_AUTORIZACAO_REVOGADA')"))!.n).toBe(5);
  });
});

describe('Fluxo do documento: revisão opcional, devolução, retirada e exclusão', () => {
  let id: string;

  it('sem revisão vai direto para aprovação e só fica vigente com a Oficial', async () => {
    const d = await createDocument(cCoord, { ...meta('Sem revisão (fictício)', { sectorId: I.sectors.RI }), responsibleUserId: cCoord.principal.userId });
    await saveDraft(cCoord, d, { texto: 'Texto.', notaVersao: '' });
    await submitForApproval(cCoord, d);
    expect((await getDocument(cCoord, d)).doc.status).toBe('EM_APROVACAO');
    expect((await getDocument(cCoord, d)).canDecide).toBe(false);
  });

  it('com revisão: Beatriz (revisora) vê o confidencial em revisão, edita, devolve; a Oficial é notificada', async () => {
    id = await createDocument(cOwner, {
      categoryId: catPsi, title: 'Plano confidencial (fictício)', sectorId: I.sectors.DIR, confidentiality: 'CONFIDENCIAL',
      audienceType: 'USUARIOS', audienceUserIds: [cOwner.principal.userId], responsibleUserId: cOwner.principal.userId,
    });
    await saveDraft(cOwner, id, { texto: 'Versão da Oficial.', notaVersao: '' });
    await expect(getDocument(cBeatriz, id)).rejects.toThrow(/não encontrado/);
    await expect(sendToReview(cOwner, id, [])).rejects.toThrow(/revisora/);
    await sendToReview(cOwner, id, [cBeatriz.principal.userId, cOutra.principal.userId]);
    const asBeatriz = await getDocument(cBeatriz, id);
    expect(asBeatriz).toMatchObject({ canReturnReview: true, stage: 'Em revisão' });
    expect(asBeatriz.access.edit).toBe(true);
    expect((await listInConstruction(cBeatriz)).find((x) => x.id === id)).toMatchObject({ myReview: true });
    await saveDraft(cBeatriz, id, { texto: 'Versão revisada pela Beatriz.', notaVersao: 'Revisão' }, { name: 'revisado.pdf', bytes: PDF });
    expect(await returnReview(cBeatriz, id, 'Ajustei o item 2')).toEqual({ submitted: false });
    await expect(returnReview(cBeatriz, id)).rejects.toThrow(/não tem revisão pendente/);
    expect(await returnReview(cOutra, id)).toEqual({ submitted: true });
    const after = await getDocument(cOwner, id);
    expect(after.doc.status).toBe('EM_APROVACAO');
    expect(after.versions[0]!.content.texto).toBe('Versão revisada pela Beatriz.');
    expect(after.versions[0]!.content.arquivo?.nome).toBe('revisado.pdf');
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'DOCUMENTO_PARA_APROVACAO'", [cOwner.principal.userId]))!.n).toBeGreaterThan(0);
    // Ninguém além da Oficial vê Aprovar ou Excluir.
    expect((await getDocument(cBeatriz, id))).toMatchObject({ canDecide: false, canDelete: false });
  });

  it('a Oficial devolve para ajuste com motivo, e quem recebe vê o motivo', async () => {
    const v = (await getDocument(cOwner, id)).doc.pending_version_id!;
    await expect(decideVersion(cOwner, id, { versionId: v, decision: 'REJEITADA' })).rejects.toThrow(/motivo/);
    await decideVersion(cOwner, id, { versionId: v, decision: 'REJEITADA', notes: 'Incluir os contatos de contingência' });
    const n = await queryOne<{ body: string }>(getPool(), "SELECT body FROM notifications WHERE user_id = $1 AND kind = 'DOCUMENTO_REJEITADO' ORDER BY created_at DESC LIMIT 1", [cBeatriz.principal.userId])
      ?? await queryOne<{ body: string }>(getPool(), "SELECT body FROM notifications WHERE kind = 'DOCUMENTO_REJEITADO' ORDER BY created_at DESC LIMIT 1");
    expect(n!.body).toContain('Incluir os contatos de contingência');
    expect((await getDocument(cOwner, id)).versions[0]!.decision_notes).toBe('Incluir os contatos de contingência');
  });

  it('a autora retira uma submissão pendente; o documento pode então ser arquivado', async () => {
    const d = await createDocument(cCoord, { ...meta('Para retirar (fictício)', { sectorId: I.sectors.RI }), responsibleUserId: cCoord.principal.userId });
    await saveDraft(cCoord, d, { texto: 'Texto.', notaVersao: '' });
    await submitForApproval(cCoord, d);
    await expect(changeLifecycle(cOwner, d, 'ARQUIVADO', 'Arquivar teste')).rejects.toThrow(/aguardando aprovação/);
    await expect(withdrawSubmission(cBeatriz, d)).rejects.toThrow();
    await withdrawSubmission(cCoord, d, 'Vou ajustar');
    const v = await getDocument(cCoord, d);
    expect(v.doc.status).toBe('RASCUNHO');
    expect(v.doc.draft?.texto).toBe('Texto.');
    expect(v.versions[0]!.decision).toBe('RETIRADA');
    await changeLifecycle(cOwner, d, 'ARQUIVADO', 'Arquivar teste');
  });

  it('a Oficial exclui com motivo: sai do Repositório, histórico e Auditoria guardam (arquivo preservado)', async () => {
    const d = await createDocument(cCoord, { ...meta('Anexado por engano (fictício)', { sectorId: I.sectors.RI }), responsibleUserId: cCoord.principal.userId });
    await saveDraft(cCoord, d, { texto: '', notaVersao: '' }, { name: 'engano.pdf', bytes: PDF });
    await submitForApproval(cCoord, d);
    await expect(deleteDocument(cSubst, d, 'Tentativa')).rejects.toThrow(/exclusivo da Oficial/);
    await expect(deleteDocument(cOwner, d, 'x')).rejects.toThrow(/motivo/);
    await deleteDocument(cOwner, d, 'Arquivo enviado por engano');
    expect((await listDocuments(cOwner, {})).some((x) => x.id === d)).toBe(false);
    const v = await getDocument(cOwner, d);
    expect(v.doc.status).toBe('EXCLUIDO');
    expect(v.events.find((e) => e.event === 'EXCLUIDO')!.details).toMatchObject({ motivo: 'Arquivo enviado por engano' });
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM document_files WHERE filename = 'engano.pdf' AND purged_at IS NULL"))!.n).toBe(1);
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM audit_log WHERE action = 'DOC_EXCLUIDO' AND entity_id = $1", [d]))!.n).toBe(1);
    const vig = (await listDocuments(cOwner, { status: 'VIGENTE' }))[0]!;
    await expect(deleteDocument(cOwner, vig.id, 'Não pode')).rejects.toThrow(/já foi vigente/);
  });
});

describe('Projetos com documentos', () => {
  let projectId: string;
  it('gestor(a) obrigatório; anexo com antivírus e hash; enviar à Gestão documental com revisão cria tarefa e "Origem: projeto"', async () => {
    await expect(createProject(cCoord, { name: 'Revisão de procedimentos', sectorId: I.sectors.RI, ownerUserId: 'nao-e-uuid' })).rejects.toThrow(/gestor/);
    projectId = await createProject(cOwner, { name: 'Revisão de procedimentos (fictício)', sectorId: I.sectors.ATD, ownerUserId: cCoord.principal.userId });
    await createTask(cOwner, { title: 'Levantar procedimentos', projectId, assigneeUserId: cBeatriz.principal.userId });
    const beatriz = await ctxFor(cBeatriz.principal.userId);
    const attId = await attachProjectFile(beatriz, projectId, { name: 'procedimento.pdf', bytes: PDF });
    await expect(attachProjectFile(cOutra, projectId, { name: 'x.pdf', bytes: PDF })).rejects.toThrow();
    const docs = await listProjectDocuments(beatriz, projectId);
    expect(docs[0]).toMatchObject({ stage: 'Anexo do projeto', filename: 'procedimento.pdf' });
    expect(docs[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(sendAttachmentToRepository(beatriz, attId, { categoryId: catPop, title: 'Procedimento', audienceType: 'TODOS' }, { mode: 'COM', reviewerIds: [] })).rejects.toThrow(/revisora/);
    const docId = await sendAttachmentToRepository(beatriz, attId, { categoryId: catPop, title: 'Procedimento de atendimento (fictício)', audienceType: 'TODOS' },
      { mode: 'COM', reviewerIds: [cOutra.principal.userId] });
    const d = await getDocument(cOwner, docId);
    expect(d.doc).toMatchObject({ origin_project_id: projectId, responsible_user_id: cCoord.principal.userId, sector_id: I.sectors.ATD, in_review: true });
    const task = await queryOne<{ title: string; status: string }>(getPool(), 'SELECT title, status FROM tasks WHERE project_id = $1 AND assignee_user_id = $2', [projectId, cOutra.principal.userId]);
    expect(task).toMatchObject({ title: 'Revisar Procedimento de atendimento (fictício)', status: 'A_FAZER' });
    expect((await listProjectDocuments(beatriz, projectId))[0]!.stage).toBe('Em revisão');
    await returnReview(cOutra, docId);
    expect((await queryOne<{ status: string }>(getPool(), 'SELECT status FROM tasks WHERE project_id = $1 AND assignee_user_id = $2', [projectId, cOutra.principal.userId]))!.status).toBe('CONCLUIDA');
    expect((await listProjectDocuments(beatriz, projectId))[0]!.stage).toBe('Em aprovação');
    // Projeto não conclui com documento enviado ainda não vigente.
    await query(getPool(), "UPDATE tasks SET status = 'CONCLUIDA', completed_at = now() WHERE project_id = $1 AND status <> 'CONCLUIDA'", [projectId]);
    await expect(updateProject(cOwner, projectId, { name: 'Revisão de procedimentos (fictício)', sectorId: I.sectors.ATD, ownerUserId: cCoord.principal.userId, status: 'CONCLUIDO' }))
      .rejects.toThrow(/não vigente/);
    await decideVersion(cOwner, docId, { versionId: (await getDocument(cOwner, docId)).doc.pending_version_id!, decision: 'APROVADA', confirmed: true });
    expect((await listProjectDocuments(beatriz, projectId))[0]).toMatchObject({ stage: 'Vigente', doc_version: 1 });
  });

  it('sem revisão: direto para a Oficial; excluído aparece no projeto com o motivo', async () => {
    const att = await attachProjectFile(cOwner, projectId, { name: 'rascunho.pdf', bytes: PDF });
    const docId = await sendAttachmentToRepository(cOwner, att, { categoryId: catPop, title: 'Rascunho do projeto (fictício)', audienceType: 'TODOS' }, { mode: 'SEM', reviewerIds: [] });
    expect((await getDocument(cOwner, docId)).doc.status).toBe('EM_APROVACAO');
    await deleteDocument(cOwner, docId, 'Duplicado de outro documento');
    const row = (await listProjectDocuments(cOwner, projectId)).find((x) => x.document_id === docId)!;
    expect(row).toMatchObject({ stage: 'Excluído pela Oficial', doc_delete_reason: 'Duplicado de outro documento' });
  });

  it('aprovação do projeto: só a Oficial (autoaprovação registrada quando ela gere ou criou)', async () => {
    await expect(approveProject(cCoord, projectId, {})).rejects.toThrow(/Oficial/);
    await approveProject(cOwner, projectId, { notes: 'Projeto aprovado (teste)' });
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM audit_log WHERE action = 'PROJETO_AUTOAPROVADO' AND entity_id = $1", [projectId]))!.n).toBe(1);
    await expect(approveProject(cOwner, projectId, {})).rejects.toThrow(/já aprovado/);
  });
});

describe('Responsáveis a conferir', () => {
  it('lista o que foi gravado com a primeira pessoa da lista e não troca nada sozinho', async () => {
    await query(getPool(), 'UPDATE documents SET responsible_checked_at = NULL WHERE id = (SELECT id FROM documents WHERE reference_type = $1 ORDER BY created_at LIMIT 1)', ['REPOSITORIO']);
    const before = await listResponsiblesToCheck(cOwner);
    expect(before.documents.length).toBe(1);
    expect((await listResponsiblesToCheck(cCoord)).documents).toEqual([]);
    await confirmResponsible(cOwner, 'documento', before.documents[0]!.id);
    expect((await listResponsiblesToCheck(cOwner)).documents).toEqual([]);
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
