import { apiHandler } from '@/server/web/api.ts';
import { getBankOverview } from '@/server/modules/hourbank.ts';
import { AppError } from '@/server/errors.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return apiHandler(req, async (ctx) => {
    const id = new URL(req.url).searchParams.get('funcionario') ?? ctx.principal.employeeId;
    if (!id) throw new AppError('Informe o funcionário.');
    const o = await getBankOverview(ctx, id);
    return { resumo: o.summary, lotes: o.lots, lancamentos: o.lines, acordo: o.agreement, ocorrenciasPendentes: o.pendingOccurrences };
  });
}
