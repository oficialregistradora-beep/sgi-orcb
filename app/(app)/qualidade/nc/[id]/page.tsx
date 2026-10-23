import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { getNc } from '@/server/modules/quality.ts';
import { directory } from '@/server/modules/directory.ts';
import { addDays, todayLocal } from '@/domain/time.ts';
import { fmtDate, fmtDateTime, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { qualityAction } from '../../../../actions/phase5a.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Não conformidade' };

export default async function NcPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageCtx();
  const { id } = await params;
  const p = ctx.principal;
  const { nc: n, actions } = await getNc(ctx, id);
  const manage = can(p, 'qualidade.gerenciar');
  const responsible = n.responsible_user_id === p.userId;
  const open = n.status === 'ABERTA' || n.status === 'EM_TRATAMENTO';
  const treat = open && (responsible || manage);
  const dir = treat ? await directory(ctx) : null;
  const today = todayLocal();

  return (
    <div className="stack">
      <PageHead title={`Não conformidade ${n.code}`} subtitle={<>{label(n.origin)}{n.audit_code ? <> — <Link href={`/qualidade/auditorias/${n.audit_id}`}>{n.audit_code}</Link></> : null}{n.incident_id ? <> — <Link href={`/qualidade/incidentes/${n.incident_id}`}>incidente</Link></> : null} · Gravidade {label(n.severity).toLowerCase()} · Responsável {n.responsible_name}{n.sector_name ? ` · ${n.sector_name}` : ''} · aberta em {fmtDateTime(n.created_at)}</>}
        actions={<><span className={statusTone(n.status)}>{label(n.status)}</span><Link className="btn" href="/qualidade?aba=nc">Voltar</Link></>} />
      <div className="card"><div className="card-body stack">
        <div><strong>Descrição:</strong> {n.description}</div>
        <div><strong>Causa raiz:</strong> {n.root_cause ?? <span className="muted">não registrada</span>}</div>
        {n.effectiveness_notes ? <div><strong>Verificação de eficácia:</strong> {n.effectiveness_notes}{n.verified_by_name ? ` — ${n.verified_by_name}` : ''}</div> : null}
        {n.cancel_reason ? <div><strong>Cancelamento:</strong> {n.cancel_reason}</div> : null}
      </div></div>

      <div className="card"><div className="card-head"><h2>Ações</h2><p>Cada ação é uma tarefa do responsável — prazos, evidências e conclusão ficam na tarefa.</p></div><div className="card-body flush table-wrap">
        {actions.length ? <table className="table"><thead><tr><th>Ação</th><th>Tipo</th><th>Responsável</th><th>Prazo</th><th>Situação</th></tr></thead>
          <tbody>{actions.map((a) => (
            <tr key={a.id}><td><Link href={`/tarefas/${a.task_id}`}>{a.title}</Link></td><td className="small">{label(a.kind)}</td><td className="small">{a.assignee_name ?? '—'}</td>
              <td className={`small ${a.due_date && a.due_date < today && a.status !== 'CONCLUIDA' && a.status !== 'CANCELADA' ? 'neg' : ''}`}>{fmtDate(a.due_date)}</td><td><span className={statusTone(a.status)}>{label(a.status)}</span></td></tr>
          ))}</tbody></table> : <Empty>Nenhuma ação.</Empty>}
      </div></div>

      {treat && dir ? (
        <div className="grid grid-2">
          <div className="card"><div className="card-head"><h2>Nova ação</h2></div><div className="card-body">
            <ActionForm action={qualityAction} submitLabel="Criar ação" resetOnSuccess>
              <input type="hidden" name="op" value="acao" /><input type="hidden" name="id" value={id} /><input type="hidden" name="ncId" value={id} />
              <div className="form-grid">
                <div className="field"><label>Tipo<select name="kind" className="input">{['CORRECAO_IMEDIATA', 'CORRETIVA', 'PREVENTIVA', 'MELHORIA'].map((k) => <option key={k} value={k}>{label(k)}</option>)}</select></label></div>
                <div className="field"><label>Ação<input name="title" className="input" required minLength={3} /></label></div>
                <div className="field"><label>Responsável<select name="responsibleUserId" className="input" defaultValue={n.responsible_user_id}>{dir.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label></div>
                <div className="field"><label>Prazo<input name="dueDate" type="date" className="input" defaultValue={addDays(today, 15)} required /></label></div>
              </div>
              <label className="check" style={{ marginTop: 10 }}><input type="checkbox" name="requiresApproval" /> Conclusão da tarefa sujeita à aprovação do responsável pela NC</label>
            </ActionForm>
          </div></div>
          <div className="card"><div className="card-head"><h2>Análise de causa raiz</h2><p>Ex.: 5 porquês ou diagrama de causa e efeito, em texto.</p></div><div className="card-body">
            <ActionForm action={qualityAction} submitLabel="Registrar causa raiz"><input type="hidden" name="op" value="causa_raiz" /><input type="hidden" name="id" value={id} /><textarea name="rootCause" className="input" rows={4} aria-label="Causa raiz" defaultValue={n.root_cause ?? ''} required minLength={3} /></ActionForm>
          </div></div>
        </div>
      ) : null}

      <div className="row">
        {treat ? <ActionForm action={qualityAction} submitLabel="Encaminhar para verificação de eficácia" inline><input type="hidden" name="op" value="encaminhar_nc" /><input type="hidden" name="id" value={id} /></ActionForm> : null}
      </div>

      {n.status === 'AGUARDANDO_VERIFICACAO' && manage ? (
        responsible ? <div className="alert alert-info small">Segregação: a verificação de eficácia deve ser feita por outra pessoa com permissão de gestão da qualidade.</div> : (
          <div className="card"><div className="card-head"><h2>Verificação de eficácia</h2><p>O problema deixou de ocorrer? Registre a evidência da verificação.</p></div><div className="card-body">
            <ActionForm action={qualityAction} submitLabel="Registrar verificação">
              <input type="hidden" name="op" value="verificar_nc" /><input type="hidden" name="id" value={id} />
              <div className="field"><label>Resultado<select name="effective" className="input"><option value="sim">Eficaz — encerrar</option><option value="nao">Ineficaz — devolver ao tratamento</option></select></label></div>
              <div className="field"><label>Evidência da verificação<textarea name="notes" className="input" rows={3} required minLength={5} /></label></div>
            </ActionForm>
          </div></div>
        )
      ) : null}

      {manage && n.status !== 'ENCERRADA' && n.status !== 'CANCELADA' ? (
        <details className="disclosure small"><summary><a>Cancelar não conformidade (registro indevido)</a></summary>
          <ActionForm action={qualityAction} submitLabel="Cancelar" submitClass="btn btn-sm btn-danger"><input type="hidden" name="op" value="cancelar_nc" /><input type="hidden" name="id" value={id} /><input name="reason" className="input" placeholder="Motivo" aria-label="Motivo" required minLength={5} /></ActionForm>
        </details>
      ) : null}
    </div>
  );
}
