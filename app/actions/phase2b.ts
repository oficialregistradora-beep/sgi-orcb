'use server';

import { runAction, str, optStr, int, type ActionState } from '@/server/web/action.ts';
import { assignShift, cancelShift, closeShift, generateSchedule, registerCall, voidCall } from '@/server/modules/oncall.ts';
import { cancelApprovedVacation, requestVacation } from '@/server/modules/vacation.ts';
import { deliverItem, returnItem, setChecklistItem } from '@/server/modules/checklists.ts';
import { updateBooleanSetting } from '@/server/modules/admin.ts';

export async function generateScheduleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const r = await generateSchedule(ctx, { period: str(fd, 'period'), participants: fd.getAll('participants').map(String) });
    return `${r.created} plantão(ões) criado(s).${r.uncovered.length ? ` Sem cobertura (todos indisponíveis): ${r.uncovered.join(', ')}.` : ''}`;
  }, '/plantoes');
}

export async function assignShiftAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await assignShift(ctx, {
      shiftId: optStr(fd, 'shiftId'), date: optStr(fd, 'date'), employeeId: str(fd, 'employeeId'),
      substituteId: optStr(fd, 'substituteId') ?? null, reason: str(fd, 'reason'),
    });
    return 'Plantão salvo e responsável notificado.';
  }, '/plantoes');
}

export async function cancelShiftAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await cancelShift(ctx, str(fd, 'shiftId'), str(fd, 'reason'));
    return 'Plantão cancelado.';
  }, '/plantoes');
}

export async function registerCallAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const attended = fd.get('attended') === 'on';
    await registerCall(ctx, {
      shiftId: str(fd, 'shiftId'), calledAt: str(fd, 'calledAt'), respondedAt: optStr(fd, 'respondedAt'), attended,
      arrivalAt: attended ? optStr(fd, 'arrivalAt') : undefined, departureAt: attended ? optStr(fd, 'departureAt') : undefined,
      description: str(fd, 'description'),
    });
    return 'Chamado registrado.';
  }, '/plantoes');
}

export async function voidCallAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await voidCall(ctx, str(fd, 'callId'), str(fd, 'reason'));
    return 'Registro anulado (mantido no histórico).';
  }, '/plantoes');
}

export async function closeShiftAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const dest = optStr(fd, 'destination');
    const r = await closeShift(ctx, { shiftId: str(fd, 'shiftId'), destination: dest as 'BANCO' | undefined, notes: optStr(fd, 'notes') });
    return `Plantão fechado: sobreaviso ${Math.floor(r.standby / 60)}h${String(r.standby % 60).padStart(2, '0')}, efetivo ${Math.floor(r.effective / 60)}h${String(r.effective % 60).padStart(2, '0')}.`;
  }, '/plantoes');
}

export async function requestVacationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const r = await requestVacation(ctx, {
      employeeId: optStr(fd, 'employeeId'), start: str(fd, 'start'), end: str(fd, 'end'), soldDays: int(fd, 'soldDays') || 0, notes: optStr(fd, 'notes'),
    });
    return `Solicitação enviada para aprovação. ${r.warnings.join(' ')}`;
  }, ['/ferias', '/solicitacoes']);
}

export async function cancelVacationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await cancelApprovedVacation(ctx, str(fd, 'requestId'), str(fd, 'reason'));
    return 'Férias canceladas; saldo restituído.';
  }, '/ferias');
}

export async function checklistItemAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'employeeId');
  return runAction(async (ctx) => {
    await setChecklistItem(ctx, { itemId: str(fd, 'itemId'), status: str(fd, 'status') as 'CONCLUIDO', notes: optStr(fd, 'notes') });
    return 'Item atualizado.';
  }, `/equipe/${id}`);
}

export async function deliverItemAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'employeeId');
  return runAction(async (ctx) => {
    await deliverItem(ctx, id, { kind: str(fd, 'kind') as 'UNIFORME', description: str(fd, 'description'), quantity: int(fd, 'quantity') || 1, deliveredAt: str(fd, 'deliveredAt'), notes: optStr(fd, 'notes') });
    return 'Entrega registrada; termo enviado ao funcionário para ciência.';
  }, `/equipe/${id}`);
}

export async function returnItemAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'employeeId');
  return runAction(async (ctx) => {
    await returnItem(ctx, str(fd, 'itemId'), str(fd, 'returnedAt'), optStr(fd, 'notes'));
    return 'Devolução registrada.';
  }, `/equipe/${id}`);
}

export async function booleanSettingAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await updateBooleanSetting(ctx, str(fd, 'key'), fd.get('value') === 'true');
    return 'Parâmetro atualizado.';
  }, '/configuracoes');
}
