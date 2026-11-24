'use server';

import { runAction, str, optStr, type ActionState } from '@/server/web/action.ts';
import { AppError } from '@/server/errors.ts';
import { parseBRL, formatCents } from '@/domain/money.ts';
import {
  addEntry, approveMonth, closeSession, confirmSession, markDivergence, openSession, reopenSession, reverseEntry, saveRegister,
} from '@/server/modules/cash.ts';
import { deleteStatement, importStatement, matchLine, rematchStatement, type Source } from '@/server/modules/cashReconcile.ts';
import type { CashMethod } from '@/domain/cash.ts';

const PATH = '/caixa';

function money(fd: FormData, k: string, required = true): number | null {
  try {
    const v = parseBRL(str(fd, k));
    if (v === null && required) throw new AppError('Informe o valor.');
    return v;
  } catch (e) {
    throw e instanceof AppError ? e : new AppError((e as Error).message);
  }
}

/** Frente de caixa: abertura, lançamentos, estorno e fechamento (operadora). */
export async function cashOperateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    switch (str(fd, 'op')) {
      case 'abrir':
        await openSession(ctx, str(fd, 'registerId'), money(fd, 'float', false));
        return 'Caixa aberto.';
      case 'lancar': {
        const kind = str(fd, 'kind') as 'ENTRADA' | 'SAIDA_REPASSE' | 'SAIDA_DESPESA' | 'SAIDA_DEVOLUCAO' | 'SUPRIMENTO' | 'SANGRIA';
        const method = (kind === 'SUPRIMENTO' || kind === 'SANGRIA' ? 'DINHEIRO' : str(fd, 'method')) as CashMethod;
        await addEntry(ctx, str(fd, 'sessionId'), {
          kind, method, protocol: optStr(fd, 'protocol'), payee: optStr(fd, 'payee'), amountCents: money(fd, 'amount')!,
          receivedCents: method === 'DINHEIRO' && kind === 'ENTRADA' ? money(fd, 'received', false) : null,
          description: optStr(fd, 'description'), reference: optStr(fd, 'reference'),
        });
        return 'Lançamento registrado.';
      }
      case 'estornar':
        await reverseEntry(ctx, str(fd, 'entryId'), str(fd, 'reason'));
        return 'Estorno lançado no caixa de hoje.';
      case 'fechar': {
        const r = await closeSession(ctx, str(fd, 'sessionId'), { countedCents: money(fd, 'counted')!, sentToDepositCents: money(fd, 'deposit', false) ?? 0, notes: optStr(fd, 'notes') });
        return r.difference ? `Caixa fechado com diferença de ${formatCents(r.difference)} (esperado ${formatCents(r.expected)}).` : 'Caixa fechado sem diferença.';
      }
      default:
        throw new AppError('Operação inválida.');
    }
  }, PATH);
}

/** Conferência (Bárbara): divergência por linha, confirmar o dia num clique, reabrir e OK final do mês. */
export async function cashConferAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    switch (str(fd, 'op')) {
      case 'divergencia':
        await markDivergence(ctx, str(fd, 'entryId'), optStr(fd, 'note') ?? null);
        return optStr(fd, 'note') ? 'Divergência anotada.' : 'Divergência retirada.';
      case 'confirmar':
        await confirmSession(ctx, str(fd, 'sessionId'), optStr(fd, 'notes'));
        return 'Dia conferido e travado.';
      case 'reabrir':
        await reopenSession(ctx, str(fd, 'sessionId'), str(fd, 'reason'));
        return 'Dia reaberto para a operadora corrigir.';
      case 'aprovar-mes':
        await approveMonth(ctx, str(fd, 'registerId'), str(fd, 'month'), optStr(fd, 'notes'));
        return 'Aprovação final do mês registrada.';
      default:
        throw new AppError('Operação inválida.');
    }
  }, PATH);
}

export async function cashRegisterAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await saveRegister(ctx, {
      id: optStr(fd, 'id'), code: str(fd, 'code'), name: str(fd, 'name'), sectorId: str(fd, 'sectorId'), shared: fd.get('shared') === 'on',
      defaultFloatCents: money(fd, 'float', false) ?? 0, active: fd.get('active') !== 'off', operatorIds: fd.getAll('operators').map(String),
    });
    return 'Caixa salvo.';
  }, PATH);
}

export async function cashReconcileAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    switch (str(fd, 'op')) {
      case 'importar': {
        const f = fd.get('file');
        if (!(f instanceof File) || !f.size) throw new AppError('Escolha o arquivo do extrato.');
        const r = await importStatement(ctx, { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) },
          { source: str(fd, 'source') as Source, month: str(fd, 'month'), label: optStr(fd, 'label') });
        return `${r.lines} linha(s) lida(s); ${r.matched} conciliada(s) automaticamente.`;
      }
      case 'conciliar':
        await matchLine(ctx, str(fd, 'lineId'), optStr(fd, 'entryId') ?? null);
        return optStr(fd, 'entryId') ? 'Linha conciliada.' : 'Conciliação desfeita.';
      case 'reprocessar':
        return `${await rematchStatement(ctx, str(fd, 'statementId'))} nova(s) conciliação(ões).`;
      case 'excluir':
        await deleteStatement(ctx, str(fd, 'statementId'));
        return 'Extrato excluído.';
      default:
        throw new AppError('Operação inválida.');
    }
  }, PATH);
}
