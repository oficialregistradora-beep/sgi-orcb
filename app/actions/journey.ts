'use server';

import { runAction, str, optStr, durationToMinutes, type ActionState } from '@/server/web/action.ts';
import { punch } from '@/server/modules/timeclock.ts';
import { createRequest, decideRequest, cancelRequest } from '@/server/modules/requests.ts';
import { justifyOccurrence } from '@/server/modules/hourbank.ts';
import { label, fmtTime } from '@/ui/format.ts';

export async function punchAction(_p: ActionState, _fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const r = await punch(ctx);
    return `${label(r.kind)} registrada às ${fmtTime(r.punchedAt)} (horário do servidor).`;
  }, ['/jornada', '/painel']);
}

export async function correctionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const action = str(fd, 'action');
    // DESCONSIDERAR: a opção carrega "id|data"; o serviço confere se a marcação pertence ao funcionário nessa data.
    const [punchId = '', punchDate = ''] = str(fd, 'punchId').split('|');
    const payload = action === 'DESCONSIDERAR' ? { action, punchId } : { action: 'INCLUIR', time: str(fd, 'time') };
    await createRequest(ctx, {
      type: 'CORRECAO_PONTO', employeeId: optStr(fd, 'employeeId'), referenceDate: action === 'DESCONSIDERAR' ? punchDate : str(fd, 'date'),
      payload, justification: str(fd, 'justification'),
    });
    return 'Solicitação de correção enviada para aprovação. A marcação original será preservada.';
  }, ['/jornada', '/solicitacoes']);
}

export async function compensationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const mode = str(fd, 'mode');
    const dur = optStr(fd, 'duration');
    await createRequest(ctx, {
      type: 'COMPENSACAO', employeeId: optStr(fd, 'employeeId'), referenceDate: str(fd, 'date'),
      payload: { mode, ...(mode === 'FOLGA_INTEGRAL' ? {} : { minutes: dur ? durationToMinutes(dur) : NaN }) },
      justification: str(fd, 'justification'),
    });
    return 'Solicitação de compensação enviada para aprovação.';
  }, ['/banco-de-horas', '/solicitacoes']);
}

export async function extraAuthorizationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await createRequest(ctx, {
      type: 'AUTORIZACAO_EXTRA', employeeId: optStr(fd, 'employeeId'), referenceDate: str(fd, 'date'),
      payload: { minutes: durationToMinutes(str(fd, 'duration')), destination: str(fd, 'destination') },
      justification: str(fd, 'justification'),
    });
    return 'Pedido de autorização prévia de hora extra enviado.';
  }, ['/solicitacoes']);
}

export async function decideAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const approve = str(fd, 'decision') === 'aprovar';
    await decideRequest(ctx, { requestId: str(fd, 'requestId'), approve, notes: optStr(fd, 'notes') });
    return approve ? 'Solicitação aprovada.' : 'Solicitação rejeitada.';
  }, ['/solicitacoes', '/painel']);
}

export async function cancelRequestAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await cancelRequest(ctx, str(fd, 'requestId'));
    return 'Solicitação cancelada.';
  }, ['/solicitacoes']);
}

export async function justifyAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await justifyOccurrence(ctx, str(fd, 'occurrenceId'), str(fd, 'text'));
    return 'Justificativa registrada. A análise será feita pela administração.';
  }, ['/banco-de-horas', '/painel']);
}


