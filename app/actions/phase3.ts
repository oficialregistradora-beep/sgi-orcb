'use server';

import { redirect } from 'next/navigation';
import { AppError } from '@/server/errors.ts';
import { runAction, str, optStr, int, type ActionState } from '@/server/web/action.ts';
import {
  acknowledge, changeLifecycle, confirmResponsible, createDocument, decideVersion, deleteDocument, purgeFiles, returnReview, revokeDelegation, saveCategory,
  saveDelegation, saveDraft, sendToReview, submitForApproval, updateMetadata, withdrawSubmission, type MetaInput,
} from '@/server/modules/repository.ts';

function metaFrom(fd: FormData): MetaInput {
  // Nenhum campo de pessoa vem pré-selecionado: a responsável é escolhida por quem cria.
  if (!optStr(fd, 'responsibleUserId')) throw new AppError('Escolha a responsável.');
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
    const mode = str(fd, 'reviewMode');
    if (mode === 'COM') {
      await sendToReview(ctx, id, fd.getAll('reviewerIds').map(String));
      return 'Documento enviado para revisão. Quando todas as revisoras devolverem, ele segue para a aprovação da Oficial.';
    }
    if (mode !== 'SEM') throw new AppError('Escolha a revisão: sem revisão (direto para aprovação) ou com revisão.');
    await submitForApproval(ctx, id);
    return 'Versão enviada para a aprovação da Oficial.';
  }, [`/documentos/${id}`, '/documentos']);
}

/** Revisão, retirada, exclusão e conferência de responsável. */
export async function workflowAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'documentId');
  return runAction(async (ctx) => {
    switch (str(fd, 'op')) {
      case 'devolver_revisao': {
        const r = await returnReview(ctx, id, optStr(fd, 'comment'));
        return r.submitted ? 'Revisão devolvida. Todas as revisoras devolveram: o documento seguiu para a aprovação da Oficial.' : 'Revisão devolvida. Aguardando as demais revisoras.';
      }
      case 'retirar': await withdrawSubmission(ctx, id, optStr(fd, 'reason')); return 'Submissão retirada. O documento voltou a rascunho.';
      case 'excluir': await deleteDocument(ctx, id, str(fd, 'reason')); return 'Documento excluído. O registro e o arquivo ficam guardados pelo prazo de retenção.';
      case 'conferir_doc': await confirmResponsible(ctx, 'documento', id); return 'Responsável conferida.';
      case 'conferir_projeto': await confirmResponsible(ctx, 'projeto', str(fd, 'projectId')); return 'Gestor(a) conferido(a).';
      default: throw new AppError('Operação desconhecida.');
    }
  }, id ? [`/documentos/${id}`, '/documentos'] : ['/documentos']);
}

export async function delegationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    if (str(fd, 'op') === 'revogar') { await revokeDelegation(ctx, str(fd, 'id')); return 'Autorização revogada.'; }
    await saveDelegation(ctx, {
      documents: fd.get('documents') === 'on', projects: fd.get('projects') === 'on', categoryIds: fd.getAll('categoryIds').map(String),
      startsOn: str(fd, 'startsOn'), endsOn: optStr(fd, 'endsOn') ?? null, reason: str(fd, 'reason'),
    });
    return 'Autorização registrada.';
  }, ['/configuracoes', '/documentos']);
}

export async function decideAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'documentId');
  return runAction(async (ctx) => {
    const decision = str(fd, 'decision') as 'APROVADA' | 'REJEITADA';
    await decideVersion(ctx, id, { versionId: str(fd, 'versionId'), decision, notes: optStr(fd, 'notes'), confirmed: fd.get('confirmed') === 'on' });
    return decision === 'APROVADA' ? 'Versão aprovada e vigente.' : 'Devolvido para ajuste; o rascunho retornou à responsável com o motivo.';
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
