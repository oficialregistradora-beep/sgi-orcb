'use server';

import { runAction, str, optStr, int, type ActionState } from '@/server/web/action.ts';
import { AppError } from '@/server/errors.ts';
import { parseBRL } from '@/domain/money.ts';
import { importRecurring, removeRecurring, saveRecurring } from '@/server/modules/recurring.ts';

const PATH = '/financeiro';

/** Despesas fixas mensais: incluir, alterar, excluir/desativar e importar de planilha no formato do Asgard. */
export async function recurringAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    switch (str(fd, 'op')) {
      case 'salvar': {
        const raw = optStr(fd, 'amount');
        let amountCents: number | null = null;
        try { amountCents = raw ? parseBRL(raw) : null; } catch (e) { throw new AppError((e as Error).message); }
        await saveRecurring(ctx, {
          id: optStr(fd, 'id'), description: str(fd, 'description'), costCenterId: str(fd, 'costCenterId'), categoryId: str(fd, 'categoryId'),
          supplierId: optStr(fd, 'supplierId') ?? null, amountCents, dueDay: int(fd, 'dueDay'), asgardType: optStr(fd, 'asgardType') ?? null,
          notes: optStr(fd, 'notes'), active: optStr(fd, 'id') ? fd.get('active') === 'on' : true,
        });
        return optStr(fd, 'id') ? 'Despesa fixa atualizada.' : 'Despesa fixa incluída.';
      }
      case 'remover':
        return (await removeRecurring(ctx, str(fd, 'id'))) === 'EXCLUIDA' ? 'Despesa fixa excluída.' : 'Despesa fixa desativada (já tinha lançamentos; o histórico foi mantido).';
      case 'importar': {
        const f = fd.get('file');
        if (!(f instanceof File) || !f.size) throw new AppError('Escolha a planilha.');
        const r = await importRecurring(ctx, { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }, { costCenterId: str(fd, 'costCenterId'), defaultCategoryId: str(fd, 'categoryId') });
        return `${r.created} despesa(s) fixa(s) importada(s)${r.skipped ? `; ${r.skipped} já existia(m)` : ''}${r.withoutAmount ? `; ${r.withoutAmount} sem valor (informe para lançar)` : ''}. Confira categorias e valores abaixo.`;
      }
      default:
        throw new AppError('Operação inválida.');
    }
  }, PATH);
}
