'use server';

import { runAction, str, optStr, type ActionState } from '@/server/web/action.ts';
import { AppError } from '@/server/errors.ts';
import {
  addAdminRequestMessage, cancelAdminRequest, createAdminRequest, handleAdminRequest, type AdminRequestCategory,
} from '@/server/modules/adminRequests.ts';

const PATHS = ['/solicitacoes', '/painel'];

export async function adminRequestCreateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const files = await Promise.all(fd.getAll('files').filter((f): f is File => f instanceof File && f.size > 0)
      .map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    await createAdminRequest(ctx, {
      category: str(fd, 'category') as AdminRequestCategory, subject: str(fd, 'subject'), body: str(fd, 'body'), onlyOwner: fd.get('onlyOwner') === 'on',
      absenceStart: optStr(fd, 'absenceStart') ?? null, absenceEnd: optStr(fd, 'absenceEnd') ?? null,
    }, files);
    return `Solicitação enviada à administração${files.length ? ` com ${files.length} anexo(s)` : ''}. Você será avisada quando houver resposta.`;
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
    const launch = fd.get('launchAbsence') === 'on';
    if (launch && (!optStr(fd, 'absenceStart') || !optStr(fd, 'absenceEnd'))) throw new AppError('Informe o período da ausência.');
    await handleAdminRequest(ctx, id, {
      status: str(fd, 'status') as 'ATENDIDA', response: str(fd, 'response') || undefined,
      absence: launch ? { type: str(fd, 'absenceType') as 'ATESTADO_MEDICO', startDate: str(fd, 'absenceStart'), endDate: str(fd, 'absenceEnd') } : null,
    });
    return launch ? 'Atendida: ausência lançada e dias abonados no ponto; quem pediu foi avisada.' : 'Situação registrada; quem pediu foi avisada.';
  }, [...PATHS, `/solicitacoes/administracao/${id}`]);
}

export async function adminRequestCancelAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'id');
  return runAction(async (ctx) => {
    await cancelAdminRequest(ctx, id);
    return 'Solicitação cancelada.';
  }, [...PATHS, `/solicitacoes/administracao/${id}`]);
}
