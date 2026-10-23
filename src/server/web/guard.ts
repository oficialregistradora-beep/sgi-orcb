import { forbidden, notFound } from 'next/navigation';
import { ForbiddenError, NotFoundError } from '../errors.ts';

/**
 * Envolve uma página: recusa de permissão vira resposta 403 e registro inexistente vira 404, com página
 * própria — em vez de erro 500. Demais erros seguem para a página de erro (e para o registro do servidor).
 */
export function withGuard<P>(page: (props: P) => Promise<React.ReactNode>) {
  return async function Guarded(props: P): Promise<React.ReactNode> {
    try {
      return await page(props);
    } catch (e) {
      if (e instanceof ForbiddenError) forbidden();
      if (e instanceof NotFoundError || (e && typeof e === 'object' && 'issues' in e)) notFound(); // identificador malformado
      throw e;
    }
  };
}
