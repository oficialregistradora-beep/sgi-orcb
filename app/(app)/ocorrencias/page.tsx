import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { requirePermission } from '@/server/authz.ts';
import { listOccurrences } from '@/server/modules/hourbank.ts';
import { ensureProcessedAll } from '@/server/modules/timeclock.ts';
import { ALERT_LABELS, type DayAlert } from '@/domain/journey.ts';
import { fmtDate, fmtDateTime, fmtMin, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { resolveOccurrenceAction } from '../../actions/bank.ts';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Ocorrências' };

const OPTIONS: Record<string, string[]> = {
  HORA_EXTRA: ['BANCO_CREDITO', 'PAGAMENTO_EXTRA'],
  DIFERENCA_NEGATIVA: ['ABONO', 'BANCO_DEBITO', 'FALTA_NAO_JUSTIFICADA'],
  MARCACAO_INCOMPLETA: ['CIENTE'],
};

async function OcorrenciasPage({ searchParams }: { searchParams: Promise<{ aba?: string }> }) {
  const ctx = await requirePageCtx();
  requirePermission(ctx, 'banco.ocorrencias.tratar');
  const { aba } = await searchParams;
  const tab = aba === 'resolvidas' ? 'RESOLVIDA' : 'PENDENTE';
  await ensureProcessedAll();
  const rows = await listOccurrences(ctx, { status: tab });
  return (
    <div className="stack">
      <PageHead
        title="Ocorrências de jornada"
        subtitle="Horas extras nunca são descartadas (banco ou pagamento). Diferenças negativas nunca são descontadas automaticamente."
      />
      <nav className="tabs">
        <Link href="/ocorrencias" aria-current={tab === 'PENDENTE' ? 'page' : undefined}>Pendentes</Link>
        <Link href="/ocorrencias?aba=resolvidas" aria-current={tab === 'RESOLVIDA' ? 'page' : undefined}>Resolvidas</Link>
      </nav>
      <div className="card">
        <div className="card-body flush table-wrap" tabIndex={0}>
          {rows.length ? (
            <table className="table">
              <thead><tr><th>Data</th><th>Funcionário</th><th>Ocorrência</th><th className="num">Minutos</th><th>Contexto</th><th>{tab === 'PENDENTE' ? 'Decisão' : 'Resultado'}</th></tr></thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id}>
                    <td className="nowrap"><Link href={`/jornada?funcionario=${o.employee_id}&mes=${o.work_date.slice(0, 7)}`}>{fmtDate(o.work_date)}</Link></td>
                    <td>{o.full_name}<div className="small muted">{o.sector_name}</div></td>
                    <td>{label(o.type)}</td>
                    <td className="num">{o.minutes ? fmtMin(o.minutes) : '—'}</td>
                    <td className="small">
                      {o.employee_justification ? <div><strong>Justificativa:</strong> {o.employee_justification}</div> : null}
                      {(o.alerts ?? []).map((a) => <div key={a} className="neg">{ALERT_LABELS[a as DayAlert] ?? a}</div>)}
                    </td>
                    <td style={{ minWidth: 240 }}>
                      {tab === 'PENDENTE' ? (
                        <ActionForm action={resolveOccurrenceAction} submitLabel="Registrar" submitClass="btn btn-sm btn-primary">
                          <input type="hidden" name="occurrenceId" value={o.id} />
                          <select name="resolution" className="input" aria-label="Decisão">
                            {OPTIONS[o.type]!.map((r) => <option key={r} value={r}>{label(r)}</option>)}
                          </select>
                          <input name="notes" className="input" placeholder="Fundamentação" aria-label="Fundamentação" style={{ marginTop: 6 }} />
                        </ActionForm>
                      ) : (
                        <div className="small">
                          <span className={statusTone(o.status)}>{label(o.resolution)}</span>
                          {o.auto_resolved ? <span className="tag" style={{ marginLeft: 4 }}>autorização prévia</span> : null}
                          <div className="muted">{o.resolver_name} · {fmtDateTime(o.resolved_at)}</div>
                          {o.resolution_notes ? <div>{o.resolution_notes}</div> : null}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>{tab === 'PENDENTE' ? 'Nenhuma ocorrência pendente de análise.' : 'Nenhuma ocorrência resolvida.'}</Empty>}
        </div>
      </div>
    </div>
  );
}

export default withGuard(OcorrenciasPage);
