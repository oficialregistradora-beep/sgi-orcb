'use server';

import { runAction, str, optStr, type ActionState } from '@/server/web/action.ts';
import { AppError } from '@/server/errors.ts';
import { requirePermission } from '@/server/authz.ts';
import {
  cancelInstitutionalEvent, createInstitutionalEvent, dispatchOutbox, postAnnouncement, retryFailed, setIntegrationFlag, syncCalendar,
} from '@/server/modules/integrations.ts';

function hhmm(fd: FormData, k: string): number | null {
  const v = str(fd, k);
  if (!v) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  if (!m) throw new AppError('Horário inválido (use HH:MM).');
  return Number(m[1]) * 60 + Number(m[2]);
}

export async function integrationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    switch (str(fd, 'op')) {
      case 'flag': await setIntegrationFlag(ctx, str(fd, 'key'), str(fd, 'value') === 'true'); return 'Parâmetro atualizado.';
      case 'sincronizar': {
        requirePermission(ctx, 'integracoes.gerenciar');
        const r = await syncCalendar();
        return r.skipped ? `Sincronização não executada: ${r.skipped}.` : `Agenda sincronizada: ${r.created} criado(s), ${r.updated} atualizado(s), ${r.deleted} removido(s), ${r.failed} falha(s).`;
      }
      case 'enviar': {
        requirePermission(ctx, 'integracoes.gerenciar');
        const r = await dispatchOutbox(200);
        return `Envio: ${r.sent} enviada(s), ${r.retried} para nova tentativa, ${r.failed} com falha, ${r.discarded} descartada(s).`;
      }
      case 'reenviar': return `${await retryFailed(ctx)} mensagem(ns) recolocada(s) na fila.`;
      default: throw new AppError('Operação desconhecida.');
    }
  }, '/configuracoes');
}

export async function agendaAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    switch (str(fd, 'op')) {
      case 'evento':
        await createInstitutionalEvent(ctx, {
          kind: str(fd, 'kind') as 'REUNIAO', title: str(fd, 'title'), description: optStr(fd, 'description'), startDate: str(fd, 'startDate'),
          endDate: optStr(fd, 'endDate'), startTime: hhmm(fd, 'startTime'), endTime: hhmm(fd, 'endTime'), sectorId: optStr(fd, 'sectorId') ?? null,
          announce: fd.get('announce') === 'on',
        });
        return 'Evento cadastrado.';
      case 'cancelar': await cancelInstitutionalEvent(ctx, str(fd, 'id')); return 'Evento cancelado.';
      case 'aviso': await postAnnouncement(ctx, str(fd, 'text')); return 'Aviso enfileirado para o Google Chat.';
      default: throw new AppError('Operação desconhecida.');
    }
  }, '/agenda');
}
