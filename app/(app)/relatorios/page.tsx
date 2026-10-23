import { requirePageCtx } from '@/server/web/session.ts';
import { requirePermission } from '@/server/authz.ts';
import { payrollReport } from '@/server/modules/hourbank.ts';
import { ensureProcessedAll } from '@/server/modules/timeclock.ts';
import { addMonths, todayLocal } from '@/domain/time.ts';
import { fmtMin } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { MonthPicker } from '@/ui/MonthPicker.tsx';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Relatórios' };

async function RelatoriosPage({ searchParams }: { searchParams: Promise<{ mes?: string }> }) {
  const ctx = await requirePageCtx();
  requirePermission(ctx, 'banco.ocorrencias.tratar');
  const sp = await searchParams;
  const period = sp.mes && /^\d{4}-\d{2}$/.test(sp.mes) ? sp.mes : addMonths(`${todayLocal().slice(0, 7)}-01`, -1).slice(0, 7);
  await ensureProcessedAll();
  const rows = await payrollReport(ctx, period);
  return (
    <div className="stack">
      <PageHead
        title="Relatório para a folha de pagamento"
        subtitle="Consolidação gerencial por competência. Valores informativos: verbas e eventuais descontos dependem de validação contábil e jurídica."
        actions={<><MonthPicker period={period} base="/relatorios" /><a className="btn btn-primary btn-sm" href={`/api/v1/relatorios/folha?periodo=${period}`}>Exportar CSV</a></>}
      />
      <div className="card">
        <div className="card-body flush table-wrap" tabIndex={0}>
          {rows.length ? (
            <table className="table">
              <thead><tr><th>Matrícula</th><th>Funcionário</th><th className="num">Extras para pagamento</th><th className="num">Faltas não justificadas</th><th className="num">Créditos no banco</th><th className="num">Diferenças compensadas</th><th className="num">Pagamentos do banco</th><th className="num">Pendências</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.employee_id}>
                  <td className="mono">{r.registration_code}</td><td>{r.full_name}</td>
                  <td className="num">{fmtMin(r.extra_paid_minutes)}</td><td className="num">{fmtMin(r.unjustified_minutes)}</td>
                  <td className="num">{fmtMin(r.bank_credit_minutes)}</td><td className="num">{fmtMin(r.bank_debit_minutes)}</td>
                  <td className="num">{fmtMin(r.payments_minutes)}</td>
                  <td className="num">{r.pending_occurrences ? <span className="tag tag-warn">{r.pending_occurrences}</span> : '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <Empty>Sem dados na competência.</Empty>}
        </div>
      </div>
    </div>
  );
}

export default withGuard(RelatoriosPage);
