import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { getIncident } from '@/server/modules/security.ts';
import { directory } from '@/server/modules/directory.ts';
import { addDays, todayLocal } from '@/domain/time.ts';
import { fmtDate, fmtDateTime, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { qualityAction, securityAction } from '../../../../actions/phase5a.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Incidente' };

export default async function IncidentePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageCtx();
  const { id } = await params;
  const { incident: i, events, ncs, actions, canManage } = await getIncident(ctx, id);
  const dir = canManage ? await directory(ctx) : null;
  const ncAllowed = can(ctx.principal, 'qualidade.gerenciar');
  const today = todayLocal();
  const hidden = <><input type="hidden" name="id" value={id} /></>;

  return (
    <div className="stack">
      <PageHead title={`Incidente ${i.code} — ${i.title}`} subtitle={<>{label(i.category)} · comunicado por {i.reporter_name} em {fmtDateTime(i.reported_at)} · detectado {fmtDateTime(i.detected_at)}{i.occurred_at ? ` · ocorrido ${fmtDateTime(i.occurred_at)}` : ''}</>}
        actions={<><span className={statusTone(i.severity)}>{label(i.severity)}</span><span className={statusTone(i.status)}>{label(i.status)}</span><Link className="btn" href="/qualidade/incidentes">Voltar</Link></>} />
      {i.personal_data_involved ? <div className="alert alert-warn small"><strong>Envolve dados pessoais.</strong> A necessidade de comunicação à ANPD e aos titulares deve ser avaliada pelo controlador com o encarregado de dados (LGPD, art. 48, e regulamentação da ANPD); o sistema registra a avaliação, mas não decide. {i.lgpd_assessment ? `Avaliação registrada por ${i.lgpd_assessed_by_name}.` : 'Avaliação pendente.'}</div> : null}
      <div className="card"><div className="card-body stack">
        <div><strong>Descrição:</strong> {i.description}</div>
        <div><strong>Contenção:</strong> {i.containment ?? <span className="muted">não registrada</span>}</div>
        <div><strong>Causa raiz:</strong> {i.root_cause ?? <span className="muted">não registrada</span>}</div>
        {i.lgpd_assessment ? <div><strong>Avaliação LGPD:</strong> {i.lgpd_assessment}</div> : null}
      </div></div>

      {canManage && dir ? (
        <div className="grid grid-2">
          <div className="card"><div className="card-head"><h2>Tratamento</h2><p>Registrar a contenção muda a situação para “contido”.</p></div><div className="card-body">
            <ActionForm action={securityAction} submitLabel="Registrar" resetOnSuccess>
              <input type="hidden" name="op" value="tratar_incidente" />{hidden}
              <div className="field"><label>Gravidade<select name="severity" className="input" defaultValue="">{['', 'BAIXA', 'MEDIA', 'ALTA', 'CRITICA'].map((c) => <option key={c} value={c}>{c ? label(c) : 'manter'}</option>)}</select></label></div>
              <div className="field"><label>Contenção<textarea name="containment" className="input" rows={2} /></label></div>
              <div className="field"><label>Causa raiz<textarea name="rootCause" className="input" rows={2} /></label></div>
              <div className="field"><label>Anotação<input name="notes" className="input" /></label></div>
              {!i.personal_data_involved ? <label className="check"><input type="checkbox" name="personalData" /> Constatado envolvimento de dados pessoais</label> : null}
            </ActionForm>
          </div></div>
          <div className="stack">
            {i.personal_data_involved ? (
              <div className="card"><div className="card-head"><h2>Avaliação LGPD</h2><p>Riscos aos titulares, dados afetados, decisão sobre comunicação e respectivas datas.</p></div><div className="card-body">
                <ActionForm action={securityAction} submitLabel="Registrar avaliação"><input type="hidden" name="op" value="lgpd" />{hidden}<textarea name="assessment" className="input" rows={4} aria-label="Avaliação" defaultValue={i.lgpd_assessment ?? ''} required minLength={5} /></ActionForm>
              </div></div>
            ) : null}
            <div className="card"><div className="card-head"><h2>Ação</h2></div><div className="card-body">
              <ActionForm action={qualityAction} submitLabel="Criar ação" resetOnSuccess>
                <input type="hidden" name="op" value="acao" /><input type="hidden" name="incidentId" value={id} />
                <div className="form-grid">
                  <div className="field"><label>Tipo<select name="kind" className="input">{['CORRECAO_IMEDIATA', 'PREVENTIVA', 'MELHORIA'].map((k) => <option key={k} value={k}>{label(k)}</option>)}</select></label></div>
                  <div className="field"><label>Ação<input name="title" className="input" required minLength={3} /></label></div>
                  <div className="field"><label>Responsável<select name="responsibleUserId" className="input">{dir.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label></div>
                  <div className="field"><label>Prazo<input name="dueDate" type="date" className="input" defaultValue={addDays(today, 7)} required /></label></div>
                </div>
              </ActionForm>
            </div></div>
            {ncAllowed ? (
              <div className="card"><div className="card-head"><h2>Abrir não conformidade</h2><p>Quando o incidente revela falha de processo que requer ação corretiva.</p></div><div className="card-body">
                <ActionForm action={qualityAction} submitLabel="Abrir NC">
                  <input type="hidden" name="op" value="nc" /><input type="hidden" name="origin" value="INCIDENTE" /><input type="hidden" name="incidentId" value={id} />
                  <div className="form-grid">
                    <div className="field"><label>Gravidade<select name="severity" className="input">{['MENOR', 'MAIOR', 'CRITICA'].map((k) => <option key={k} value={k}>{label(k)}</option>)}</select></label></div>
                    <div className="field"><label>Responsável<select name="responsibleUserId" className="input">{dir.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label></div>
                  </div>
                  <div className="field"><label>Descrição<textarea name="description" className="input" rows={2} defaultValue={`${i.code}: `} required minLength={5} /></label></div>
                </ActionForm>
              </div></div>
            ) : null}
          </div>
        </div>
      ) : null}

      {ncs.length || actions.length ? (
        <div className="card"><div className="card-head"><h2>Não conformidades e ações</h2></div><div className="card-body flush table-wrap"><table className="table"><tbody>
          {ncs.map((n) => <tr key={n.id}><td><Link href={`/qualidade/nc/${n.id}`}>{n.code}</Link></td><td>Não conformidade</td><td></td><td><span className={statusTone(n.status)}>{label(n.status)}</span></td></tr>)}
          {actions.map((a) => <tr key={a.id}><td><Link href={`/tarefas/${a.task_id}`}>{a.title}</Link></td><td className="small">{label(a.kind)} · {a.assignee_name ?? '—'}</td><td className="small">{fmtDate(a.due_date)}</td><td><span className={statusTone(a.status)}>{label(a.status)}</span></td></tr>)}
        </tbody></table></div></div>
      ) : null}

      <div className="card"><div className="card-head"><h2>Linha do tempo</h2></div><div className="card-body flush table-wrap">
        {events.length ? <table className="table"><tbody>{events.map((e, k) => <tr key={k}><td className="small nowrap">{fmtDateTime(e.created_at)}</td><td className="small">{label(e.event)}</td><td className="small">{e.notes ?? ''}</td><td className="small">{e.user_name ?? 'Sistema'}</td></tr>)}</tbody></table> : <Empty>Sem eventos.</Empty>}
      </div></div>

      {canManage ? (
        <div className="card"><div className="card-head"><h2>Encerrar</h2><p>Exige contenção, causa raiz, avaliação LGPD (se houver dados pessoais) e nenhuma ação em aberto.</p></div><div className="card-body">
          <ActionForm action={securityAction} submitLabel="Encerrar incidente" confirm="Encerrar o incidente?"><input type="hidden" name="op" value="encerrar_incidente" />{hidden}<input name="notes" className="input" placeholder="Lições aprendidas (opcional)" aria-label="Lições aprendidas" /></ActionForm>
        </div></div>
      ) : null}
    </div>
  );
}
