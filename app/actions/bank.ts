'use server';

import { runAction, str, optStr, durationToMinutes, type ActionState } from '@/server/web/action.ts';
import { closePeriod, registerPayment, reopenPeriod, resolveOccurrence } from '@/server/modules/hourbank.ts';
import { prepareMonthlyDocument, signVersion, type Act, type DocKind } from '@/server/modules/documents.ts';

export async function resolveOccurrenceAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await resolveOccurrence(ctx, {
      occurrenceId: str(fd, 'occurrenceId'),
      resolution: str(fd, 'resolution') as 'BANCO_CREDITO',
      notes: optStr(fd, 'notes'),
    });
    return 'Decisão registrada.';
  }, ['/ocorrencias', '/painel']);
}

export async function paymentAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await registerPayment(ctx, {
      employeeId: str(fd, 'employeeId'), minutes: durationToMinutes(str(fd, 'duration')),
      onlyExpired: fd.get('onlyExpired') === 'on', reference: str(fd, 'reference'),
    });
    return 'Pagamento registrado no banco de horas.';
  }, ['/banco-de-horas']);
}

export async function closePeriodAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await closePeriod(ctx, str(fd, 'period'));
    return 'Competência fechada.';
  }, ['/configuracoes']);
}

export async function reopenPeriodAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await reopenPeriod(ctx, str(fd, 'period'), str(fd, 'reason'));
    return 'Competência reaberta.';
  }, ['/configuracoes']);
}

export async function prepareDocumentAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const employeeId = optStr(fd, 'employeeId') ?? ctx.principal.employeeId;
    if (!employeeId) return 'Sem cadastro funcional.';
    await prepareMonthlyDocument(ctx, str(fd, 'kind') as DocKind, employeeId, str(fd, 'period'));
    return 'Documento gerado. Confira o conteúdo antes de registrar sua manifestação.';
  }, ['/documentos-pessoais']);
}

export async function signAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await signVersion(ctx, {
      versionId: str(fd, 'versionId'), act: str(fd, 'act') as Act, comment: optStr(fd, 'comment'),
      confirmed: (fd.get('confirmed') === 'on') as true,
    });
    return 'Manifestação registrada e vinculada ao hash desta versão.';
  }, ['/documentos-pessoais', '/painel']);
}


