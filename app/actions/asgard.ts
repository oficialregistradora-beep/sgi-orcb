'use server';

import { runAction, str, optStr, type ActionState } from '@/server/web/action.ts';
import { AppError } from '@/server/errors.ts';
import { setDefaultType, setExpenseData, uploadTemplate } from '@/server/modules/asgard.ts';

const PATH = '/financeiro';

/** Relatório XLS do Asgard: envio do modelo, correspondência padrão e ajustes por despesa. */
export async function asgardAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    switch (str(fd, 'op')) {
      case 'modelo': {
        const f = fd.get('file');
        if (!(f instanceof File) || !f.size) throw new AppError('Escolha o arquivo do modelo exportado do Asgard.');
        const r = await uploadTemplate(ctx, { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
        return `Modelo recebido: ${r.types} tipos disponíveis.`;
      }
      case 'padrao':
        await setDefaultType(ctx, { target: str(fd, 'target') as 'categoria' | 'fornecedor', id: str(fd, 'id'), asgardType: optStr(fd, 'asgardType') });
        return 'Correspondência salva.';
      case 'despesa':
        await setExpenseData(ctx, { expenseId: str(fd, 'expenseId'), asgardType: optStr(fd, 'asgardType'), fiscalDoc: optStr(fd, 'fiscalDoc'), priorAuth: optStr(fd, 'priorAuth') });
        return 'Despesa atualizada.';
      default:
        throw new AppError('Operação inválida.');
    }
  }, PATH);
}
