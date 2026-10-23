'use server';

import { redirect } from 'next/navigation';
import { runAction, str, optStr, int, type ActionState } from '@/server/web/action.ts';
import { AppError } from '@/server/errors.ts';
import { parseBRL } from '@/domain/money.ts';
import {
  addFinanceAttachment, addQuote, addRevenue, cancelExpense, chooseQuote, closeContract, decideExpense, generateContractExpenses, registerPayment, requestExpense,
  reverseRevenue, saveContract, saveCostCenter, saveFinanceCategory, saveSupplier, setBudget, updateRequest,
} from '@/server/modules/finance.ts';

function money(fd: FormData, k: string, required = true): number | null {
  try {
    const v = parseBRL(str(fd, k));
    if (v === null && required) throw new AppError('Informe o valor.');
    return v;
  } catch (e) {
    throw e instanceof AppError ? e : new AppError((e as Error).message);
  }
}

function fileOf(fd: FormData, k = 'file') {
  const f = fd.get(k);
  return f instanceof File && f.size > 0 ? f : null;
}

function expenseFields(fd: FormData) {
  return {
    kind: str(fd, 'kind') as 'VARIAVEL', description: str(fd, 'description'), supplierId: optStr(fd, 'supplierId') ?? null, projectId: optStr(fd, 'projectId') ?? null,
    costCenterId: str(fd, 'costCenterId'), categoryId: str(fd, 'categoryId'), amountCents: money(fd, 'amount')!, competence: str(fd, 'competence'),
    dueDate: str(fd, 'dueDate'), justification: optStr(fd, 'justification'),
  };
}

export async function requestExpenseAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  let id = '';
  const r = await runAction(async (ctx) => {
    id = await requestExpense(ctx, expenseFields(fd));
    const f = fileOf(fd);
    if (f) await addFinanceAttachment(ctx, { expenseId: id }, str(fd, 'fileKind') || 'NOTA_FISCAL', { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    return 'Solicitação registrada e enviada para aprovação.';
  }, '/financeiro');
  if (r.ok && id) redirect(`/financeiro/despesas/${id}`);
  return r;
}

export async function expenseAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'expenseId');
  return runAction(async (ctx) => {
    switch (str(fd, 'op')) {
      case 'editar': await updateRequest(ctx, id, expenseFields(fd)); return 'Solicitação atualizada.';
      case 'aprovar': await decideExpense(ctx, id, true, optStr(fd, 'notes')); return 'Despesa aprovada.';
      case 'rejeitar': await decideExpense(ctx, id, false, optStr(fd, 'notes')); return 'Despesa rejeitada.';
      case 'pagar':
        await registerPayment(ctx, id, { paidOn: str(fd, 'paidOn'), amountCents: money(fd, 'amount')!, method: str(fd, 'method') as 'PIX', reference: optStr(fd, 'reference') });
        return 'Pagamento registrado.';
      case 'cancelar': await cancelExpense(ctx, id, str(fd, 'reason')); return 'Despesa cancelada.';
      case 'cotacao': {
        const f = fileOf(fd);
        await addQuote(ctx, id, { supplierName: str(fd, 'supplierName'), amountCents: money(fd, 'amount')! }, f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null);
        return 'Cotação registrada.';
      }
      case 'escolher': await chooseQuote(ctx, str(fd, 'quoteId'), optStr(fd, 'reason')); return 'Cotação escolhida; valor da solicitação atualizado.';
      case 'anexo': {
        const f = fileOf(fd);
        if (!f) throw new AppError('Escolha um arquivo.');
        await addFinanceAttachment(ctx, { expenseId: id }, str(fd, 'kind'), { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
        return 'Anexo incluído.';
      }
      default: throw new AppError('Operação desconhecida.');
    }
  }, [`/financeiro/despesas/${id}`, '/financeiro']);
}

export async function financeAdminAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    switch (str(fd, 'op')) {
      case 'centro': await saveCostCenter(ctx, { id: optStr(fd, 'id'), code: str(fd, 'code'), name: str(fd, 'name'), sectorId: str(fd, 'sectorId'), active: fd.get('active') === 'on' }); return 'Centro de custo salvo.';
      case 'categoria': await saveFinanceCategory(ctx, { id: optStr(fd, 'id'), code: str(fd, 'code'), name: str(fd, 'name'), kind: str(fd, 'kind'), active: fd.get('active') === 'on' }); return 'Categoria salva.';
      case 'fornecedor':
        await saveSupplier(ctx, { id: optStr(fd, 'id'), name: str(fd, 'name'), document: str(fd, 'document'), email: optStr(fd, 'email'), phone: optStr(fd, 'phone'), notes: optStr(fd, 'notes'), active: fd.get('active') !== 'off' });
        return 'Fornecedor salvo.';
      case 'contrato': {
        const id = await saveContract(ctx, {
          id: optStr(fd, 'id'), supplierId: str(fd, 'supplierId'), object: str(fd, 'object'), costCenterId: str(fd, 'costCenterId'), categoryId: str(fd, 'categoryId'),
          startDate: str(fd, 'startDate'), endDate: optStr(fd, 'endDate') ?? null, monthlyCents: money(fd, 'monthly', false), totalCents: money(fd, 'total', false),
          dueDay: optStr(fd, 'dueDay') ? int(fd, 'dueDay') : null, readjustment: optStr(fd, 'readjustment'), noticeDays: optStr(fd, 'noticeDays') ? int(fd, 'noticeDays') : 60,
        });
        const f = fileOf(fd);
        if (f) await addFinanceAttachment(ctx, { contractId: id }, 'CONTRATO', { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
        return 'Contrato salvo.';
      }
      case 'encerrar_contrato': await closeContract(ctx, str(fd, 'id'), str(fd, 'reason')); return 'Contrato encerrado.';
      case 'gerar_fixas': { const n = await generateContractExpenses(ctx, str(fd, 'month')); return `${n} despesa(s) fixa(s) lançada(s) para aprovação.`; }
      case 'orcamento': {
        const months = str(fd, 'scope') === 'ano' ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [int(fd, 'month')];
        await setBudget(ctx, { year: int(fd, 'year'), months, costCenterId: str(fd, 'costCenterId'), categoryId: str(fd, 'categoryId'), amountCents: money(fd, 'amount')! });
        return 'Orçamento registrado.';
      }
      case 'receita':
        await addRevenue(ctx, { competence: str(fd, 'competence'), receivedOn: str(fd, 'receivedOn'), categoryId: str(fd, 'categoryId'), description: str(fd, 'description'), amountCents: money(fd, 'amount')! });
        return 'Receita lançada.';
      case 'estornar_receita': await reverseRevenue(ctx, str(fd, 'id'), str(fd, 'reason')); return 'Estorno registrado.';
      default: throw new AppError('Operação desconhecida.');
    }
  }, '/financeiro');
}
