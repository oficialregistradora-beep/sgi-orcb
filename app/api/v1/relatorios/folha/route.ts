import { NextResponse } from 'next/server';
import { getSessionState } from '@/server/web/session.ts';
import { payrollReport } from '@/server/modules/hourbank.ts';
import { publicMessage } from '@/server/errors.ts';
import { audit } from '@/server/audit.ts';
import { getPool } from '@/server/db.ts';

export const dynamic = 'force-dynamic';

function csvCell(v: unknown): string {
  if (typeof v === 'number') return String(v);
  const s = String(v ?? '');
  // Neutraliza injeção de fórmulas em planilhas (CSV injection).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Exportação CSV do relatório gerencial para a contabilidade (valores informativos). */
export async function GET(req: Request) {
  const st = await getSessionState();
  if (st.status !== 'AUTENTICADO') return new NextResponse('Não autenticado', { status: 401 });
  const period = new URL(req.url).searchParams.get('periodo') ?? '';
  try {
    const rows = await payrollReport(st.ctx, period);
    await audit(getPool(), st.ctx, { action: 'RELATORIO_EXPORTADO', entityType: 'relatorio', entityId: `folha:${period}`, summary: `Exportação do relatório para a folha ${period}` });
    const head = ['Matrícula', 'Nome', 'Extras para pagamento (min)', 'Faltas não justificadas (min)', 'Créditos no banco (min)', 'Diferenças compensadas (min)', 'Pagamentos do banco (min)', 'Pendências'];
    const lines = rows.map((r) => [r.registration_code, r.full_name, r.extra_paid_minutes, r.unjustified_minutes, r.bank_credit_minutes, r.bank_debit_minutes, r.payments_minutes, r.pending_occurrences].map(csvCell).join(';'));
    const body = '﻿' + [head.map(csvCell).join(';'), ...lines].join('\r\n');
    return new NextResponse(body, {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="relatorio-folha-${period}.csv"`, 'cache-control': 'no-store' },
    });
  } catch (err) {
    return new NextResponse(publicMessage(err), { status: 400 });
  }
}
