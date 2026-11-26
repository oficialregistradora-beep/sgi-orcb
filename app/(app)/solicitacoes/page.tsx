import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { describePayload, listMyRequests, listRequestsToDecide, REQUEST_TYPES, type RequestRow } from '@/server/modules/requests.ts';
import { fmtDate, fmtDateTime, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { cancelRequestAction, decideAction } from '../../actions/journey.ts';
import { withGuard } from '@/server/web/guard.ts';
import {
  ADMIN_REQUEST_CATEGORIES, canHandleAdminRequests, listAdminInbox, listMyAdminRequests, type AdminRequestRow,
} from '@/server/modules/adminRequests.ts';
import { adminRequestCreateAction } from '../../actions/adminRequests.ts';

function AdminTable({ rows, inbox }: { rows: AdminRequestRow[]; inbox: boolean }) {
  if (!rows.length) return <Empty>{inbox ? 'Nenhuma solicitação nesta lista.' : 'Você ainda não fez solicitações à administração.'}</Empty>;
  return (
    <table className="table">
      <thead><tr><th>Aberta em</th>{inbox ? <th>Quem pediu</th> : null}<th>Assunto</th><th>Tipo</th><th>Situação</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id}>
          <td className="small nowrap">{fmtDateTime(r.created_at)}</td>
          {inbox ? <td>{r.requester_name}</td> : null}
          <td><Link href={`/solicitacoes/administracao/${r.id}`}>{r.subject}</Link>
            {r.only_owner ? <span className="tag" style={{ marginLeft: 6 }}>somente Oficial</span> : null}
            {r.messages ? <div className="small muted">{r.messages} mensagem(ns)</div> : null}</td>
          <td className="small">{ADMIN_REQUEST_CATEGORIES[r.category]}</td>
          <td><span className={statusTone(r.status)}>{label(r.status)}</span>{r.closed_at ? <div className="small muted">{r.closed_by_name} · {fmtDate(r.closed_at.toISOString().slice(0, 10))}</div> : null}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

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

async function SolicitacoesPage({ searchParams }: { searchParams: Promise<{ aba?: string; situacao?: string }> }) {
  const ctx = await requirePageCtx();
  const { aba = 'minhas', situacao } = await searchParams;
  const approver = Object.values(REQUEST_TYPES).some((t) => can(ctx.principal, t.approve));
  const handler = canHandleAdminRequests(ctx);
  const tab = approver && (aba === 'aprovar' || aba === 'decididas') ? aba
    : aba === 'administracao' ? 'administracao'
      : handler && aba === 'recebidas' ? 'recebidas' : 'minhas';
  const adminTabs = (
    <nav className="tabs" aria-label="Abas">
      <Link href="/solicitacoes" aria-current={tab === 'minhas' ? 'page' : undefined}>Minhas</Link>
      {approver ? <Link href="/solicitacoes?aba=aprovar" aria-current={tab === 'aprovar' ? 'page' : undefined}>Para decidir</Link> : null}
      {approver ? <Link href="/solicitacoes?aba=decididas" aria-current={tab === 'decididas' ? 'page' : undefined}>Decididas</Link> : null}
      <Link href="/solicitacoes?aba=administracao" aria-current={tab === 'administracao' ? 'page' : undefined}>À administração</Link>
      {handler ? <Link href="/solicitacoes?aba=recebidas" aria-current={tab === 'recebidas' ? 'page' : undefined}>Recebidas pela administração</Link> : null}
    </nav>
  );
  if (tab === 'administracao') {
    const mine = await listMyAdminRequests(ctx);
    return (
      <div className="stack">
        <PageHead title="Solicitações" subtitle="Pedidos à administração: declarações, material, ajustes de cadastro, assuntos pessoais, sugestões." />
        {adminTabs}
        <div className="card">
          <div className="card-head"><h2>Nova solicitação à administração</h2><p>A Oficial e quem atende a administração recebem um aviso; a resposta chega no sino e nesta tela.</p></div>
          <div className="card-body">
            <ActionForm action={adminRequestCreateAction} submitLabel="Enviar solicitação" resetOnSuccess>
              <div className="form-grid">
                <div className="field"><label htmlFor="ar-c">Tipo</label>
                  <select id="ar-c" name="category" className="input" required>{Object.entries(ADMIN_REQUEST_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
                <div className="field"><label htmlFor="ar-s">Assunto</label><input id="ar-s" name="subject" className="input" required minLength={3} maxLength={200} /></div>
              </div>
              <div className="field" style={{ marginTop: 8 }}><label htmlFor="ar-b">Descreva o pedido</label><textarea id="ar-b" name="body" className="input" rows={5} required minLength={5} maxLength={5000} /></div>
              <div className="field" style={{ marginTop: 8 }}><label htmlFor="ar-f">Anexar arquivo(s) — opcional; obrigatório para atestado</label>
                <input id="ar-f" name="files" type="file" className="input" multiple accept=".pdf,.jpg,.jpeg,.png,.docx,.xlsx,.odt,.ods,.txt" />
                <span className="small muted">Até 5 arquivos (foto ou PDF do atestado, declaração, comprovante). Passam pelo antivírus.</span></div>
              <fieldset className="form-grid" style={{ marginTop: 8 }}>
                <legend className="small muted">Para &quot;Atestado / ausência&quot;: período da ausência</legend>
                <div className="field"><label htmlFor="ar-i">Primeiro dia</label><input id="ar-i" name="absenceStart" type="date" className="input" /></div>
                <div className="field"><label htmlFor="ar-e">Último dia</label><input id="ar-e" name="absenceEnd" type="date" className="input" /></div>
              </fieldset>
              <label className="check" style={{ marginTop: 8 }}><input type="checkbox" name="onlyOwner" /> Somente para a Oficial (ninguém mais da administração vê)</label>
            </ActionForm>
          </div>
        </div>
        <div className="card"><div className="card-head"><h2>Minhas solicitações à administração</h2></div>
          <div className="card-body flush table-wrap" tabIndex={0}><AdminTable rows={mine} inbox={false} /></div></div>
      </div>
    );
  }
  if (tab === 'recebidas') {
    const closed = situacao === 'encerradas';
    const rows = await listAdminInbox(ctx, closed ? 'ENCERRADAS' : 'ABERTAS');
    return (
      <div className="stack">
        <PageHead title="Solicitações" subtitle="Pedidos recebidos pela administração. Encerrar exige resposta escrita a quem pediu." />
        {adminTabs}
        <nav className="tabs" aria-label="Situação">
          <Link href="/solicitacoes?aba=recebidas" aria-current={!closed ? 'page' : undefined}>Em aberto</Link>
          <Link href="/solicitacoes?aba=recebidas&situacao=encerradas" aria-current={closed ? 'page' : undefined}>Encerradas</Link>
        </nav>
        <div className="card"><div className="card-body flush table-wrap" tabIndex={0}><AdminTable rows={rows} inbox /></div></div>
      </div>
    );
  }
  const rows = tab === 'minhas' ? await listMyRequests(ctx) : await listRequestsToDecide(ctx, tab === 'aprovar' ? 'PENDENTE' : 'DECIDIDAS');
  return (
    <div className="stack">
      <PageHead title="Solicitações" subtitle="Correções de marcação, compensações e autorizações de hora extra. Ninguém decide o próprio pedido." />
      {adminTabs}
      <div className="card"><div className="card-body flush table-wrap" tabIndex={0}><Table rows={rows} mode={tab as 'minhas'} /></div></div>
      {tab === 'minhas' ? <p className="small muted">Para abrir correções, use <Link href="/jornada">Minha jornada</Link>; para compensações, <Link href="/banco-de-horas">Banco de horas</Link>; para outros pedidos, <Link href="/solicitacoes?aba=administracao">À administração</Link>.</p> : null}
    </div>
  );
}

export default withGuard(SolicitacoesPage);
