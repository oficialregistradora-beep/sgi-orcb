import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { ADMIN_REQUEST_CATEGORIES, getAdminRequest } from '@/server/modules/adminRequests.ts';
import { fmtDate, fmtDateTime, label, statusTone } from '@/ui/format.ts';
import { PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { withGuard } from '@/server/web/guard.ts';
import { adminRequestCancelAction, adminRequestHandleAction, adminRequestMessageAction } from '../../../../actions/adminRequests.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Solicitação à administração' };

async function AdminRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageCtx();
  const { id } = await params;
  const r = await getAdminRequest(ctx, id);
  const back = r.requester_id === ctx.principal.userId ? '/solicitacoes?aba=administracao' : '/solicitacoes?aba=recebidas';
  return (
    <div className="stack">
      <PageHead title={r.subject} subtitle={`${ADMIN_REQUEST_CATEGORIES[r.category]} · pedido de ${r.requester_name} em ${fmtDateTime(r.created_at)}`}
        actions={<Link href={back} className="btn btn-ghost">Voltar</Link>} />
      <div className="card">
        <div className="card-head"><div><h2>Pedido</h2><p><span className={statusTone(r.status)}>{label(r.status)}</span>{r.only_owner ? <span className="tag" style={{ marginLeft: 6 }}>somente para a Oficial</span> : null}</p></div></div>
        <div className="card-body"><p style={{ whiteSpace: 'pre-wrap' }}>{r.body}</p>
          {r.absence_start ? <p className="small"><strong>Período da ausência:</strong> {fmtDate(r.absence_start)} a {fmtDate(r.absence_end!)}{r.absence_id ? <span className="tag tag-ok" style={{ marginLeft: 6 }}>ausência lançada e abonada</span> : null}</p> : null}
          {r.files.length ? (
            <div className="stack" style={{ gap: 4, marginTop: 8 }}><strong className="small">Anexos</strong>
              {r.files.map((f) => (
                <div key={f.id} className="row small"><a href={`/api/v1/solicitacoes/${r.id}/anexo/${f.id}`}>{f.filename}</a>
                  <span className="muted">{Math.max(1, Math.round(f.size_bytes / 1024))} KB · SHA-256 <span className="mono">{f.sha256.slice(0, 16)}…</span></span>
                  {f.scan_status === 'LIMPO' ? <span className="tag tag-ok">Verificado pelo antivírus</span> : <span className="tag tag-warn">Não verificado</span>}</div>
              ))}
            </div>
          ) : null}
          {r.response ? <div className="alert alert-info" style={{ marginTop: 12 }}><strong>Resposta</strong> ({r.closed_by_name}, {r.closed_at ? fmtDateTime(r.closed_at) : ''}):<div style={{ whiteSpace: 'pre-wrap' }}>{r.response}</div></div> : null}
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h2>Conversa</h2><p>{r.messages.length} mensagem(ns)</p></div>
        <div className="card-body stack">
          {r.messages.map((m) => (
            <div key={m.id} className="small"><strong>{m.author_name}</strong> <span className="muted">· {fmtDateTime(m.created_at)}</span><div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div></div>
          ))}
          {r.can.reply ? (
            <ActionForm action={adminRequestMessageAction} submitLabel="Enviar mensagem" resetOnSuccess>
              <input type="hidden" name="id" value={r.id} />
              <div className="field"><label htmlFor="am-b">Mensagem</label><textarea id="am-b" name="body" className="input" rows={3} required maxLength={3000} /></div>
            </ActionForm>
          ) : null}
        </div>
      </div>
      {r.can.handle ? (
        <div className="card">
          <div className="card-head"><h2>Atender</h2><p>Encerrar como atendida ou recusada exige a resposta; quem pediu é avisada.</p></div>
          <div className="card-body">
            <ActionForm action={adminRequestHandleAction} submitLabel="Registrar">
              <input type="hidden" name="id" value={r.id} />
              <div className="field"><label htmlFor="ah-s">Situação</label>
                <select id="ah-s" name="status" className="input" defaultValue="ATENDIDA">
                  <option value="EM_ANDAMENTO">Em andamento</option><option value="ATENDIDA">Atendida</option><option value="RECUSADA">Recusada</option>
                </select></div>
              <div className="field" style={{ marginTop: 8 }}><label htmlFor="ah-r">Resposta a quem pediu</label><textarea id="ah-r" name="response" className="input" rows={3} maxLength={3000} /></div>
              {r.can.launchAbsence ? (
                <fieldset className="stack" style={{ marginTop: 8, gap: 6 }}>
                  <label className="check"><input type="checkbox" name="launchAbsence" defaultChecked /> Ao marcar &quot;Atendida&quot;, lançar a ausência na ficha e abonar os dias no ponto</label>
                  <div className="form-grid">
                    <div className="field"><label htmlFor="ah-t">Tipo</label><select id="ah-t" name="absenceType" className="input" defaultValue="ATESTADO_MEDICO">
                      <option value="ATESTADO_MEDICO">Atestado médico</option><option value="FALTA_JUSTIFICADA">Falta justificada</option></select></div>
                    <div className="field"><label htmlFor="ah-i">Primeiro dia</label><input id="ah-i" name="absenceStart" type="date" className="input" defaultValue={r.absence_start ?? ''} /></div>
                    <div className="field"><label htmlFor="ah-e">Último dia</label><input id="ah-e" name="absenceEnd" type="date" className="input" defaultValue={r.absence_end ?? ''} /></div>
                  </div>
                </fieldset>
              ) : null}
            </ActionForm>
          </div>
        </div>
      ) : null}
      {r.can.cancel ? (
        <ActionForm action={adminRequestCancelAction} submitLabel="Cancelar minha solicitação" submitClass="btn btn-danger" confirm="Cancelar esta solicitação?">
          <input type="hidden" name="id" value={r.id} />
        </ActionForm>
      ) : null}
    </div>
  );
}

export default withGuard(AdminRequestPage);
