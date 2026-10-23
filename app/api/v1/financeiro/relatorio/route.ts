import { NextResponse } from 'next/server';
import { getSessionState } from '@/server/web/session.ts';
import { listExpenses } from '@/server/modules/finance.ts';
import { AppError, publicMessage } from '@/server/errors.ts';
import { audit } from '@/server/audit.ts';
import { getPool } from '@/server/db.ts';
import { monthsBetween } from '@/domain/finance.ts';

export const dynamic = 'force-dynamic';

function cell(v: unknown): string {
  const s = String(v ?? '');
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // neutraliza injeção de fórmulas
  return `"${safe.replace(/"/g, '""')}"`;
}

/** CSV das despesas do período (competências de/até), respeitando o escopo do usuário. Exportação auditada. */
export async function GET(req: Request) {
  const st = await getSessionState();
  if (st.status !== 'AUTENTICADO') return new NextResponse('Não autenticado', { status: 401 });
  const u = new URL(req.url);
  const de = u.searchParams.get('de') ?? '';
  const ate = u.searchParams.get('ate') ?? de;
  try {
    if (!/^\d{4}-\d{2}$/.test(de) || !/^\d{4}-\d{2}$/.test(ate) || ate < de) throw new AppError('Período inválido.');
    const months = monthsBetween(de, ate);
    if (months.length > 24) throw new AppError('Período máximo: 24 meses.');
    const rows = (await Promise.all(months.map((m) => listExpenses(st.ctx, { status: 'TODAS', month: m })))).flat();
    await audit(getPool(), st.ctx, { action: 'FIN_RELATORIO_EXPORTADO', entityType: 'relatorio', entityId: `financeiro:${de}:${ate}`, summary: `Exportação de despesas ${de} a ${ate} (${rows.length})` });
    const head = ['Competência', 'Vencimento', 'Descrição', 'Fornecedor', 'Centro de custo', 'Categoria', 'Tipo', 'Situação', 'Valor', 'Pago em', 'Forma', 'Solicitante', 'Aprovador', 'Projeto'];
    const lines = rows.map((e) => [e.competence.slice(0, 7), e.due_date, e.description, e.supplier_name, e.cost_center, e.category, e.kind, e.status, e.amount.replace('.', ','),
      e.paid_on, e.method, e.requested_by_name, e.decided_by_name, e.project_name].map(cell).join(';'));
    const body = '\uFEFF' + [head.map(cell).join(';'), ...lines].join('\r\n');
    return new NextResponse(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="despesas-${de}-a-${ate}.csv"`, 'cache-control': 'no-store' } });
  } catch (err) {
    return new NextResponse(publicMessage(err), { status: err instanceof AppError ? err.status : 500 });
  }
}
