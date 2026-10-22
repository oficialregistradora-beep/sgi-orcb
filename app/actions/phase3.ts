'use server';

import { redirect } from 'next/navigation';
import { runAction, str, optStr, int, type ActionState } from '@/server/web/action.ts';
import {
  acknowledge, changeLifecycle, createDocument, decideVersion, purgeFiles, saveCategory, saveDraft, submitForApproval, updateMetadata,
  type MetaInput,
} from '@/server/modules/repository.ts';

function metaFrom(fd: FormData): MetaInput {
  const review = str(fd, 'reviewMonths');
  return {
    categoryId: str(fd, 'categoryId'), title: str(fd, 'title'), code: optStr(fd, 'code'), summary: optStr(fd, 'summary'),
    sectorId: str(fd, 'sectorId'), responsibleUserId: optStr(fd, 'responsibleUserId'),
    confidentiality: (optStr(fd, 'confidentiality') as MetaInput['confidentiality']) ?? undefined,
    audienceType: str(fd, 'audienceType') as MetaInput['audienceType'],
    audienceSectorIds: fd.getAll('audienceSectorIds').map(String), audienceUserIds: fd.getAll('audienceUserIds').map(String),
    requiresAcknowledgement: fd.get('requiresAcknowledgement') === 'on',
    reviewMonths: review === '' ? null : int(fd, 'reviewMonths'),
  };
}

export async function createDocumentAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  let id = '';
  const r = await runAction(async (ctx) => {
    id = await createDocument(ctx, metaFrom(fd));
    return 'Documento criado em rascunho.';
  }, '/documentos');
  if (r.ok && id) redirect(`/documentos/${id}`);
  return r;
}

export async function updateMetadataAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'documentId');
  return runAction(async (ctx) => {
    await updateMetadata(ctx, id, metaFrom(fd));
    return 'Dados do documento atualizados.';
  }, [`/documentos/${id}`, '/documentos']);
}

export async function saveDraftAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'documentId');
  return runAction(async (ctx) => {
    const f = fd.get('file');
    const file = f instanceof File && f.size > 0 ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null;
    const texto = fd.get('texto');
    await saveDraft(ctx, id, { texto: typeof texto === 'string' ? texto : '', notaVersao: str(fd, 'notaVersao'), removeFile: fd.get('removeFile') === 'on' }, file);
    return 'Rascunho salvo.';
  }, `/documentos/${id}`);
}

export async function submitAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'documentId');
  return runAction(async (ctx) => {
    await submitForApproval(ctx, id);
    return 'Versão submetida à aprovação.';
  }, [`/documentos/${id}`, '/documentos']);
}

export async function decideAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'documentId');
  return runAction(async (ctx) => {
    const decision = str(fd, 'decision') as 'APROVADA' | 'REJEITADA';
    await decideVersion(ctx, id, { versionId: str(fd, 'versionId'), decision, notes: optStr(fd, 'notes'), confirmed: fd.get('confirmed') === 'on' });
    return decision === 'APROVADA' ? 'Versão aprovada e vigente.' : 'Versão rejeitada; o rascunho retornou para correção.';
  }, [`/documentos/${id}`, '/documentos']);
}

export async function acknowledgeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'documentId');
  return runAction(async (ctx) => {
    await acknowledge(ctx, id, fd.get('confirmed') === 'on');
    return 'Ciência registrada.';
  }, [`/documentos/${id}`, '/documentos', '/painel']);
}

export async function lifecycleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'documentId');
  return runAction(async (ctx) => {
    const op = str(fd, 'op');
    if (op === 'DESCARTE') {
      const n = await purgeFiles(ctx, id, str(fd, 'reason'));
      return `Conteúdo de ${n} arquivo(s) descartado. Metadados, hashes e assinaturas preservados.`;
    }
    await changeLifecycle(ctx, id, op === 'OBSOLETO' ? 'OBSOLETO' : 'ARQUIVADO', str(fd, 'reason'));
    return op === 'OBSOLETO' ? 'Documento declarado obsoleto.' : 'Documento arquivado.';
  }, [`/documentos/${id}`, '/documentos']);
}

export async function categoryAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const review = str(fd, 'reviewMonths');
    const retention = str(fd, 'retentionMonths');
    await saveCategory(ctx, {
      id: optStr(fd, 'id'), code: str(fd, 'code'), name: str(fd, 'name'), description: optStr(fd, 'description'),
      reviewMonths: review === '' ? null : int(fd, 'reviewMonths'), retentionMonths: retention === '' ? null : int(fd, 'retentionMonths'),
      retentionBasis: optStr(fd, 'retentionBasis'), defaultConfidentiality: str(fd, 'defaultConfidentiality') as 'INTERNO',
      active: fd.get('active') === 'on',
    });
    return 'Categoria salva.';
  }, '/documentos');
}
