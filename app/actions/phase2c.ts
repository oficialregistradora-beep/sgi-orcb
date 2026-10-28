'use server';

import { runAction, str, optStr, int, type ActionState } from '@/server/web/action.ts';
import { cancelPriorVacation, registerPriorVacation, reviewVacationPeriod } from '@/server/modules/vacation.ts';
import { closeRule, createRule, RULE_SCHEMAS, setInstrumentStatus, validateRule, type RuleCode } from '@/server/modules/legalRules.ts';
import {
  createTemplate, discardDraft, duplicateTemplate, inactivateTemplate, moveItem, newVersion, publishTemplate, removeItem, renameDraft, saveItem,
} from '@/server/modules/checklistTemplates.ts';
import { AppError } from '@/server/errors.ts';

export async function reviewPeriodAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const r = await reviewVacationPeriod(ctx, {
      employeeId: str(fd, 'employeeId'), periodStart: str(fd, 'periodStart'), art133Loss: fd.get('art133Loss') === 'on',
      art133Reason: optStr(fd, 'art133Reason'), notes: optStr(fd, 'notes'), priorUnjustifiedDays: optStr(fd, 'priorUnjustifiedDays') ? int(fd, 'priorUnjustifiedDays') : 0,
    });
    return `Conferência registrada: direito de ${r.entitlement} dias neste período.`;
  }, '/ferias');
}

/** Implantação: férias gozadas antes do início do controle no sistema (lançar ou cancelar). */
export async function priorVacationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    if (str(fd, 'op') === 'cancelar') {
      await cancelPriorVacation(ctx, str(fd, 'id'), str(fd, 'reason'));
      return 'Lançamento cancelado.';
    }
    await registerPriorVacation(ctx, {
      employeeId: str(fd, 'employeeId'), periodStart: str(fd, 'periodStart'), startDate: str(fd, 'startDate'),
      enjoyedDays: int(fd, 'enjoyedDays'), soldDays: optStr(fd, 'soldDays') ? int(fd, 'soldDays') : 0, note: str(fd, 'note'),
    });
    return 'Férias anteriores à implantação registradas.';
  }, '/ferias');
}

/** Monta o valor da regra a partir dos campos do formulário, conforme o esquema do código escolhido. */
function ruleValue(code: RuleCode, fd: FormData): Record<string, unknown> {
  switch (code) {
    case 'SOBREAVISO_FRACAO': return { numerador: int(fd, 'numerador'), denominador: int(fd, 'denominador') };
    case 'EFETIVO_DSR_FERIADO_ADICIONAL':
    case 'ADICIONAL_HORA_EXTRA': return { percentual: int(fd, 'percentual') };
    case 'DIVISOR_SALARIO_HORAS': return { horas: int(fd, 'horas') };
    case 'BANCO_FATOR_CONVERSAO': return { minutosFolgaPorHora: int(fd, 'minutosFolgaPorHora') };
    case 'BANCO_PRAZO': return { modo: str(fd, 'modo'), quantidade: int(fd, 'quantidade') };
    case 'BANCO_COMUNICACAO_MINIMA': return { horas: int(fd, 'horas') };
    case 'FERIAS_VEDAR_INICIO_FDS_FERIADO': return { ativo: fd.get('ativo') === 'on' };
  }
}

export async function createRuleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const code = str(fd, 'code') as RuleCode;
    if (!(code in RULE_SCHEMAS)) throw new AppError('Selecione o tipo de regra.');
    const validatedBy = optStr(fd, 'validatedBy');
    await createRule(ctx, {
      code, value: ruleValue(code, fd), validFrom: str(fd, 'validFrom'), validUntil: optStr(fd, 'validUntil') ?? null,
      instrumentId: optStr(fd, 'instrumentId') ?? null, legalBasis: str(fd, 'legalBasis'), source: str(fd, 'source'),
      validatedBy, validatedAt: validatedBy ? optStr(fd, 'validatedAt') : undefined, notes: optStr(fd, 'notes'),
    });
    return validatedBy ? 'Regra cadastrada como VALIDADA: passa a produzir efeitos na vigência.' : 'Regra cadastrada como PENDENTE de validação (não altera cálculos com efeito).';
  }, '/configuracoes');
}

export async function validateRuleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await validateRule(ctx, { ruleId: str(fd, 'ruleId'), validatedBy: str(fd, 'validatedBy'), validatedAt: str(fd, 'validatedAt'), notes: optStr(fd, 'notes') });
    return 'Regra validada.';
  }, '/configuracoes');
}

export async function closeRuleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await closeRule(ctx, str(fd, 'ruleId'), str(fd, 'validUntil'), str(fd, 'reason'));
    return 'Vigência encerrada.';
  }, '/configuracoes');
}

export async function instrumentStatusAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await setInstrumentStatus(ctx, { instrumentId: str(fd, 'instrumentId'), status: str(fd, 'status') as 'HISTORICO', notes: str(fd, 'notes') });
    return 'Situação do instrumento atualizada.';
  }, '/configuracoes');
}

const MODELS = '/configuracoes';

export async function templateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const op = str(fd, 'op');
    const id = str(fd, 'templateId');
    switch (op) {
      case 'criar': await createTemplate(ctx, { kind: str(fd, 'kind') as 'OUTRO', name: str(fd, 'name') }); return 'Modelo criado em rascunho.';
      case 'nova_versao': await newVersion(ctx, id); return 'Rascunho da nova versão criado.';
      case 'duplicar': await duplicateTemplate(ctx, id, str(fd, 'name')); return 'Modelo duplicado em rascunho.';
      case 'renomear': await renameDraft(ctx, id, str(fd, 'name')); return 'Nome atualizado.';
      case 'publicar': await publishTemplate(ctx, id); return 'Versão publicada. Novos checklists usarão esta versão.';
      case 'descartar': await discardDraft(ctx, id); return 'Rascunho descartado.';
      case 'inativar': await inactivateTemplate(ctx, id); return 'Modelo inativado.';
      default: throw new AppError('Operação inválida.');
    }
  }, MODELS);
}

export async function templateItemAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const op = str(fd, 'op');
    const templateId = str(fd, 'templateId');
    if (op === 'subir' || op === 'descer') { await moveItem(ctx, templateId, str(fd, 'itemId'), op === 'subir' ? 'UP' : 'DOWN'); return 'Ordem atualizada.'; }
    if (op === 'remover') { await removeItem(ctx, templateId, str(fd, 'itemId')); return 'Item removido.'; }
    await saveItem(ctx, {
      templateId, itemId: optStr(fd, 'itemId'), title: str(fd, 'title'), description: optStr(fd, 'description'),
      dueOffsetDays: int(fd, 'dueOffsetDays') || 0, required: fd.get('required') === 'on', evidenceRequired: fd.get('evidenceRequired') === 'on',
      responsibleRoleId: optStr(fd, 'responsibleRoleId') ?? null, autoCode: (optStr(fd, 'autoCode') ?? null) as 'JORNADA' | null,
    });
    return 'Item salvo.';
  }, MODELS);
}
