'use server';

import { runAction, str, type ActionState } from '@/server/web/action.ts';
import {
  addAdminRequestMessage, cancelAdminRequest, createAdminRequest, handleAdminRequest, type AdminRequestCategory,
} from '@/server/modules/adminRequests.ts';

const PATHS = ['/solicitacoes', '/painel'];

export async function adminRequestCreateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await createAdminRequest(ctx, {
      category: str(fd, 'category') as AdminRequestCategory, subject: str(fd, 'subject'), body: str(fd, 'body'), onlyOwner: fd.get('onlyOwner') === 'on',
    });
    return 'Solicitação enviada à administração. Você será avisada quando houver resposta.';
  }, PATHS);
}

export async function adminRequestMessageAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'id');
  return runAction(async (ctx) => {
    await addAdminRequestMessage(ctx, id, str(fd, 'body'));
    return 'Mensagem enviada.';
  }, [...PATHS, `/solicitacoes/administracao/${id}`]);
}

export async function adminRequestHandleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'id');
  return runAction(async (ctx) => {
    await handleAdminRequest(ctx, id, { status: str(fd, 'status') as 'ATENDIDA', response: str(fd, 'response') || undefined });
    return 'Situação registrada; quem pediu foi avisada.';
  }, [...PATHS, `/solicitacoes/administracao/${id}`]);
}

export async function adminRequestCancelAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'id');
  return runAction(async (ctx) => {
    await cancelAdminRequest(ctx, id);
    return 'Solicitação cancelada.';
  }, [...PATHS, `/solicitacoes/administracao/${id}`]);
}
