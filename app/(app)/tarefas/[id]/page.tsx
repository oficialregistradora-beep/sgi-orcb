import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { getTask, listTasks } from '@/server/modules/tasks.ts';
import { directory } from '@/server/modules/directory.ts';
import { query } from '@/server/db.ts';
import { getPool } from '@/server/db.ts';
import { fmtDate, fmtDateTime, label, statusTone } from '@/ui/format.ts';
import { PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { hm, TaskFields } from '@/ui/tasks.tsx';
import { createTaskAction, taskAction } from '../../../actions/phase4a.ts';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Tarefa' };

const EVENTS: Record<string, string> = {
  CRIADA: 'Criada', ALTERADA: 'Alterada', SITUACAO: 'Situação alterada', CONCLUIDA: 'Concluída', APROVADA_CONCLUIDA: 'Aprovada e concluída', ENVIADA_REVISAO: 'Enviada para aprovação',
  DEVOLVIDA: 'Devolvida para ajuste', CANCELADA: 'Cancelada', REABERTA: 'Reaberta', ENCAMINHADA: 'Encaminhada', ENCAMINHAMENTO_DECIDIDO: 'Encaminhamento decidido',
  DEPENDENCIA: 'Dependência incluída', DEPENDENCIA_REMOVIDA: 'Dependência removida', ITEM_CONCLUIDO: 'Item do checklist concluído', ITEM_REABERTO: 'Item reaberto',
  ANEXO: 'Anexo incluído', AVISO_PRAZO: 'Aviso de prazo enviado',
};

function Op({ id, op, children, label: l, cls = 'btn btn-sm', confirm }: { id: string; op: string; children?: React.ReactNode; label: string; cls?: string; confirm?: string }) {
  return (
    <ActionForm action={taskAction} submitLabel={l} submitClass={cls} inline confirm={confirm}>
      <input type="hidden" name="taskId" value={id} /><input type="hidden" name="op" value={op} />{children ? <div className="row">{children}</div> : null}
    </ActionForm>
  );
}

async function TarefaPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageCtx();
  const { id } = await params;
  const { task: t, access: a, checklist, comments, attachments, deps, dependents, subtasks, events, canReview } = await getTask(ctx, id);
  const open = t.status !== 'CONCLUIDA' && t.status !== 'CANCELADA';
  const dir = a.edit ? await directory(ctx) : { users: [], sectors: [], roles: [] };
  const canAssign = ctx.principal.isOwner || can(ctx.principal, 'tarefas.gerenciar', { sectorId: t.sector_id }) || t.member_role === 'GESTOR';
  const phases = t.project_id && a.edit
    ? await query<{ id: string; name: string }>(getPool(), 'SELECT id, name FROM project_phases WHERE project_id = $1 ORDER BY position', [t.project_id]) : [];
  const candidates = a.edit && open ? (await listTasks(ctx, t.project_id ? { projectId: t.project_id } : { scope: 'minhas' })).filter((x) => x.id !== t.id && !deps.some((d) => d.id === x.id)) : [];
  const me = ctx.principal.userId;

  return (
    <div className="stack">
      <PageHead title={t.title}
        subtitle={<>{t.sector_name}{t.project_name ? <> · Projeto <Link href={`/projetos/${t.project_id}`}>{t.project_name}</Link></> : null}{t.routine_id ? ' · Rotina' : ''}{t.process_instance_id ? ` · Processo, etapa ${t.process_step}` : ''} · criada por {t.created_by_name} em {fmtDateTime(t.created_at)}</>}
        actions={<Link href="/tarefas" className="btn btn-ghost">Voltar</Link>} />
      <div className="row">
        <span className={statusTone(t.status)}>{label(t.status)}</span>
        <span className={statusTone(t.priority)}>Prioridade {label(t.priority).toLowerCase()}</span>
        <span className="small">Responsável: <strong>{t.assignee_name ?? 'setor (a assumir)'}</strong></span>
        {t.due_date ? <span className="small">Prazo: {fmtDate(t.due_date)}{t.due_time != null ? ` às ${hm(t.due_time)}` : ''}</span> : null}
        {t.block_start != null ? <span className="tag tag-info">Bloco {hm(t.block_start)}–{hm(t.block_end)}</span> : null}
        {t.requires_approval ? <span className="small muted">Aprovação: {t.approver_name}</span> : null}
      </div>
      {t.blocked_reason ? <div className="alert alert-danger small">Bloqueada: {t.blocked_reason}</div> : null}
      {t.escalation_level !== 'NENHUM' ? <div className="alert alert-warn small">Encaminhada à {label(t.escalation_level)} ({t.escalated_to_name}): {t.escalation_reason}</div> : null}
      {t.description ? <div className="card"><div className="card-body doc" style={{ whiteSpace: 'pre-wrap' }}>{t.description}</div></div> : null}

      {canReview ? (
        <div className="card"><div className="card-head"><h2>Aprovação da conclusão</h2><p>Você é o(a) aprovador(a) indicado(a).</p></div>
          <div className="card-body grid grid-2">
            <Op id={id} op="aprovar" label="Aprovar conclusão" cls="btn btn-primary"><input name="notes" className="input" placeholder="Observação (opcional)" aria-label="Observação" /></Op>
            <Op id={id} op="devolver" label="Devolver para ajuste" cls="btn btn-danger"><input name="notes" className="input" placeholder="O que ajustar" aria-label="O que ajustar" required minLength={3} /></Op>
          </div>
        </div>
      ) : null}

      {t.escalated_to_user_id === me ? (
        <div className="card"><div className="card-head"><h2>Decidir encaminhamento</h2></div>
          <div className="card-body"><Op id={id} op="decidir" label="Registrar decisão" cls="btn btn-primary"><input name="decision" className="input" placeholder="Orientação / decisão" aria-label="Decisão" required minLength={3} style={{ minWidth: 320 }} /></Op></div>
        </div>
      ) : null}

      {a.work && open ? (
        <div className="card"><div className="card-head"><h2>Andamento</h2></div>
          <div className="card-body row">
            {t.status !== 'EM_ANDAMENTO' && t.status !== 'EM_REVISAO' ? <Op id={id} op="situacao" label={t.status === 'BLOQUEADA' ? 'Retomar' : 'Iniciar'}><input type="hidden" name="status" value="EM_ANDAMENTO" /></Op> : null}
            {t.status !== 'EM_REVISAO' ? <Op id={id} op="situacao" label={t.requires_approval ? 'Concluir (enviar para aprovação)' : 'Concluir'} cls="btn btn-sm btn-primary"><input type="hidden" name="status" value="CONCLUIDA" /></Op> : null}
            {t.status !== 'BLOQUEADA' ? <details className="disclosure small"><summary><a>Registrar impedimento</a></summary><Op id={id} op="situacao" label="Bloquear"><input type="hidden" name="status" value="BLOQUEADA" /><input name="reason" className="input" placeholder="Impedimento (exceção)" aria-label="Impedimento" required minLength={3} /></Op></details> : null}
            <details className="disclosure small"><summary><a>Encaminhar para decisão</a></summary>
              <Op id={id} op="encaminhar" label="Encaminhar">
                <select name="level" className="input" aria-label="Destino"><option value="SUBSTITUTA">Questão ordinária → Substituta Legal</option><option value="OFICIAL">Questão complexa → Oficial</option></select>
                <input name="reason" className="input" placeholder="Questão a decidir" aria-label="Questão" required minLength={5} />
              </Op>
            </details>
            {a.edit ? <details className="disclosure small"><summary><a>Cancelar tarefa</a></summary><Op id={id} op="situacao" label="Cancelar" cls="btn btn-sm btn-danger"><input type="hidden" name="status" value="CANCELADA" /><input name="reason" className="input" placeholder="Motivo" aria-label="Motivo do cancelamento" required minLength={3} /></Op></details> : null}
          </div>
        </div>
      ) : null}
      {!open && a.manage ? (
        <div className="card"><div className="card-body"><Op id={id} op="situacao" label="Reabrir"><input type="hidden" name="status" value="A_FAZER" /><input name="reason" className="input" placeholder="Motivo da reabertura" aria-label="Motivo da reabertura" required minLength={3} /></Op></div></div>
      ) : null}

      <div className="grid grid-2">
        <div className="card"><div className="card-head"><h2>Checklist</h2><p>{checklist.filter((c) => c.done_at).length}/{checklist.length}</p></div>
          <div className="card-body stack" style={{ gap: 6 }}>
            {checklist.map((c) => (
              <div key={c.id} className="row-between small">
                <span className={c.done_at ? 'muted' : undefined} style={c.done_at ? { textDecoration: 'line-through' } : undefined}>{c.title}{c.done_by_name ? ` — ${c.done_by_name}` : ''}</span>
                {a.work && open ? <ActionForm action={taskAction} submitLabel={c.done_at ? 'Desmarcar' : 'Feito'} submitClass="btn btn-sm" inline><input type="hidden" name="taskId" value={id} /><input type="hidden" name="op" value="marcar" /><input type="hidden" name="itemId" value={c.id} /><input type="hidden" name="done" value={c.done_at ? '0' : '1'} /></ActionForm> : null}
              </div>
            ))}
            {a.work && open ? <Op id={id} op="item" label="Incluir"><input name="title" className="input" placeholder="Novo item" aria-label="Novo item" required /></Op> : null}
          </div>
        </div>
        <div className="card"><div className="card-head"><h2>Dependências e subtarefas</h2></div>
          <div className="card-body stack" style={{ gap: 6 }}>
            {deps.map((d) => <div key={d.id} className="row-between small"><span>Depende de <Link href={`/tarefas/${d.id}`}>{d.title}</Link> <span className={statusTone(d.status)}>{label(d.status)}</span></span>
              {a.edit && !t.process_instance_id ? <Op id={id} op="remover_dependencia" label="Remover"><input type="hidden" name="dependsOnId" value={d.id} /></Op> : null}</div>)}
            {dependents.map((d) => <div key={d.id} className="small">Bloqueia <Link href={`/tarefas/${d.id}`}>{d.title}</Link></div>)}
            {candidates.length ? <Op id={id} op="dependencia" label="Incluir dependência"><select name="dependsOnId" className="input" aria-label="Tarefa predecessora">{candidates.slice(0, 200).map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select></Op> : null}
            {subtasks.map((s) => <div key={s.id} className="small">Subtarefa: <Link href={`/tarefas/${s.id}`}>{s.title}</Link> <span className={statusTone(s.status)}>{label(s.status)}</span> {s.assignee_name ?? ''}</div>)}
            {a.work && open ? (
              <details className="disclosure small"><summary><a>Nova subtarefa</a></summary>
                <ActionForm action={createTaskAction} submitLabel="Criar subtarefa" resetOnSuccess>
                  <input type="hidden" name="parentTaskId" value={id} />
                  <input name="title" className="input" placeholder="Título" aria-label="Título da subtarefa" required minLength={2} />
                  <input name="dueDate" type="date" className="input" aria-label="Prazo" style={{ marginTop: 6 }} />
                </ActionForm>
              </details>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card"><div className="card-head"><h2>Comentários internos</h2></div>
          <div className="card-body stack" style={{ gap: 8 }}>
            {comments.map((c) => <div key={c.id} className="small"><strong>{c.user_name}</strong> <span className="muted">{fmtDateTime(c.created_at)}</span><div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div></div>)}
            {a.comment ? <ActionForm action={taskAction} submitLabel="Comentar" resetOnSuccess><input type="hidden" name="taskId" value={id} /><input type="hidden" name="op" value="comentar" /><textarea name="body" className="input" rows={2} aria-label="Comentário" required maxLength={5000} /></ActionForm> : null}
          </div>
        </div>
        <div className="card"><div className="card-head"><h2>Anexos</h2></div>
          <div className="card-body stack" style={{ gap: 6 }}>
            {attachments.map((f) => <div key={f.file_id} className="small"><a href={`/api/v1/tarefas/${id}/anexos/${f.file_id}`}>{f.filename}</a> <span className="muted">{f.added_by_name} · {fmtDateTime(f.added_at)}</span> {f.scan_status === 'LIMPO' ? <span className="tag tag-ok">Verificado</span> : <span className="tag tag-warn">Não verificado</span>}</div>)}
            {a.work && open ? <Op id={id} op="anexo" label="Anexar"><input name="file" type="file" className="input" aria-label="Arquivo" required /></Op> : null}
          </div>
        </div>
      </div>

      {a.edit && open ? (
        <div className="card"><div className="card-head"><h2>Editar</h2></div>
          <div className="card-body"><details className="disclosure"><summary><a>Editar dados da tarefa</a></summary>
            <ActionForm action={taskAction} submitLabel="Salvar"><input type="hidden" name="taskId" value={id} /><input type="hidden" name="op" value="editar" />
              <TaskFields dir={dir} t={t} canAssign={canAssign} phases={phases} prefix="ed" />
            </ActionForm>
          </details></div>
        </div>
      ) : null}

      <div className="card"><div className="card-head"><h2>Histórico</h2></div>
        <div className="card-body flush table-wrap" tabIndex={0}><table className="table"><tbody>{events.map((e) => (
          <tr key={e.id}><td className="small nowrap">{fmtDateTime(e.created_at)}</td><td className="small">{EVENTS[e.event] ?? e.event}<div className="muted">{e.user_name ?? 'Rotina automática'}</div></td>
            <td className="small muted" style={{ wordBreak: 'break-word' }}>{Object.keys(e.details).length ? JSON.stringify(e.details) : ''}</td></tr>
        ))}</tbody></table></div>
      </div>
    </div>
  );
}

export default withGuard(TarefaPage);
