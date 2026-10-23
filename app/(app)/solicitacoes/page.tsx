import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { describePayload, listMyRequests, listRequestsToDecide, REQUEST_TYPES, type RequestRow } from '@/server/modules/requests.ts';
import { fmtDate, fmtDateTime, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { cancelRequestAction, decideAction } from '../../actions/journey.ts';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Solicitações' };

function Table({ rows, mode }: { rows: RequestRow[]; mode: 'minhas' | 'aprovar' | 'decididas' }) {
  if (!rows.length) return <Empty>Nenhuma solicitação.</Empty>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Aberta em</th>{mode !== 'minhas' ? <th>Funcionário</th> : null}<th>Tipo</th><th>Referência</th><th>Pedido</th><th>Justificativa</th><th>Situação</th>
          {mode !== 'decididas' ? <th className="no-print">Ação</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="small nowrap">{fmtDateTime(r.created_at)}</td>
            {mode !== 'minhas' ? <td>{r.full_name}<div className="small muted">{r.sector_name}</div></td> : null}
            <td>{REQUEST_TYPES[r.type].label}</td>
            <td className="nowrap">{fmtDate(r.reference_date)}</td>
            <td className="small">{describePayload(r.type, r.payload)}</td>
            <td className="small">{r.justification}</td>
            <td>
              <span className={statusTone(r.status)}>{label(r.status)}</span>
              {r.decided_by_name ? <div className="small muted">{r.decided_by_name} · {fmtDateTime(r.decided_at)}</div> : null}
              {r.decision_notes ? <div className="small">{r.decision_notes}</div> : null}
            </td>
            {mode === 'aprovar' ? (
              <td style={{ minWidth: 220 }}>
                <ActionForm action={decideAction} submitLabel="Registrar decisão" submitClass="btn btn-sm btn-primary">
                  <input type="hidden" name="requestId" value={r.id} />
                  <select name="decision" className="input" aria-label="Decisão" defaultValue="aprovar">
                    <option value="aprovar">Aprovar</option>
                    <option value="rejeitar">Rejeitar</option>
                  </select>
                  <input name="notes" className="input" placeholder="Observação (obrigatória para rejeição)" aria-label="Observação" style={{ marginTop: 6 }} />
                </ActionForm>
              </td>
            ) : mode === 'minhas' ? (
              <td>
                {r.status === 'PENDENTE' ? (
                  <ActionForm action={cancelRequestAction} submitLabel="Cancelar" submitClass="btn btn-sm btn-danger" inline>
                    <input type="hidden" name="requestId" value={r.id} />
                  </ActionForm>
                ) : null}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

async function SolicitacoesPage({ searchParams }: { searchParams: Promise<{ aba?: string }> }) {
  const ctx = await requirePageCtx();
  const { aba = 'minhas' } = await searchParams;
  const approver = Object.values(REQUEST_TYPES).some((t) => can(ctx.principal, t.approve));
  const tab = approver && (aba === 'aprovar' || aba === 'decididas') ? aba : 'minhas';
  const rows = tab === 'minhas' ? await listMyRequests(ctx) : await listRequestsToDecide(ctx, tab === 'aprovar' ? 'PENDENTE' : 'DECIDIDAS');
  return (
    <div className="stack">
      <PageHead title="Solicitações" subtitle="Correções de marcação, compensações e autorizações de hora extra. Ninguém decide o próprio pedido." />
      <nav className="tabs" aria-label="Abas">
        <Link href="/solicitacoes" aria-current={tab === 'minhas' ? 'page' : undefined}>Minhas</Link>
        {approver ? <Link href="/solicitacoes?aba=aprovar" aria-current={tab === 'aprovar' ? 'page' : undefined}>Para decidir</Link> : null}
        {approver ? <Link href="/solicitacoes?aba=decididas" aria-current={tab === 'decididas' ? 'page' : undefined}>Decididas</Link> : null}
      </nav>
      <div className="card"><div className="card-body flush table-wrap" tabIndex={0}><Table rows={rows} mode={tab as 'minhas'} /></div></div>
      {tab === 'minhas' ? <p className="small muted">Para abrir correções, use <Link href="/jornada">Minha jornada</Link>; para compensações, <Link href="/banco-de-horas">Banco de horas</Link>.</p> : null}
    </div>
  );
}

export default withGuard(SolicitacoesPage);
