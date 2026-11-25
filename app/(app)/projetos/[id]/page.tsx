import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { getProject, listProjectDocuments, PROJECT_STATUSES } from '@/server/modules/projects.ts';
import { listCategories, listDirectory, listDocuments } from '@/server/modules/repository.ts';
import { MetaFields, ReviewFields } from '../../documentos/MetaFields.tsx';
import { ALLOWED_FILES } from '@/server/files.ts';
import { fmtDateTime } from '@/ui/format.ts';
import { listTasks } from '@/server/modules/tasks.ts';
import { directory } from '@/server/modules/directory.ts';
import { addDays, todayLocal } from '@/domain/time.ts';
import { fmtDate, fmtMoney, label, statusTone } from '@/ui/format.ts';
import { PageHead, Stat } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { Gantt, TaskBoard, TaskFields, TaskTable, type GanttItem } from '@/ui/tasks.tsx';
import { createTaskAction, projectAction } from '../../../actions/phase4a.ts';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Projeto' };

const TABS = { visao: 'Visão geral', tarefas: 'Tarefas', quadro: 'Quadro', gantt: 'Cronograma (Gantt)', documentos: 'Documentos', equipe: 'Equipe e dados' } as const;

function Op({ id, op, label: l, cls = 'btn btn-sm', children, reset }: { id: string; op: string; label: string; cls?: string; children?: React.ReactNode; reset?: boolean }) {
  return <ActionForm action={projectAction} submitLabel={l} submitClass={cls} inline resetOnSuccess={reset}><input type="hidden" name="projectId" value={id} /><input type="hidden" name="op" value={op} /><div className="row">{children}</div></ActionForm>;
}

async function ProjetoPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ aba?: string }> }) {
  const ctx = await requirePageCtx();
  const { id } = await params;
  const sp = await searchParams;
  const tab = (sp.aba && sp.aba in TABS ? sp.aba : 'visao') as keyof typeof TABS;
  const { project: p, access: a, members, phases, milestones, costs, indicators } = await getProject(ctx, id);
  const tasks = await listTasks(ctx, { projectId: id, status: 'TODAS' });
  const dir = a.contribute ? await directory(ctx) : { users: [], sectors: [], roles: [] };
  const pct = p.tasks_total ? Math.round((p.tasks_done / p.tasks_total) * 100) : 0;
  const open = !p.closed_at;

  return (
    <div className="stack">
      <PageHead title={p.name} subtitle={<>{p.code ? <span className="mono">{p.code} · </span> : null}{p.sector_name} · Gestor(a): {p.owner_name}{p.start_date ? ` · ${fmtDate(p.start_date)}` : ''}{p.due_date ? ` a ${fmtDate(p.due_date)}` : ''}</>}
        actions={<Link href="/projetos" className="btn btn-ghost">Voltar</Link>} />
      <div className="row"><span className={statusTone(p.status)}>{label(p.status)}</span>{p.member_role ? <span className="tag">Você: {label(p.member_role)}</span> : null}</div>
      <nav className="tabs">{Object.entries(TABS).filter(([k]) => k !== 'documentos' || a.docs).map(([k, v]) => <Link key={k} href={`/projetos/${id}?aba=${k}`} aria-current={tab === k ? 'page' : undefined}>{v}</Link>)}</nav>

      {tab === 'visao' ? (
        <div className="stack">
          <div className="grid grid-4">
            <Stat label="Progresso" value={`${pct}%`} hint={`${p.tasks_done} de ${p.tasks_total} tarefas`} />
            <Stat label="Tarefas vencidas" value={p.tasks_overdue} tone={p.tasks_overdue ? 'neg' : undefined} />
            <Stat label="Custo realizado" value={fmtMoney(p.actual_cost)} hint={p.estimated_cost ? `Previsto ${fmtMoney(p.estimated_cost)}` : 'Sem previsão'}
              tone={p.estimated_cost && Number(p.actual_cost) > Number(p.estimated_cost) ? 'neg' : undefined} />
            <Stat label="Marcos atingidos" value={`${milestones.filter((m) => m.done_at).length}/${milestones.length}`} />
          </div>
          {p.description ? <div className="card"><div className="card-body" style={{ whiteSpace: 'pre-wrap' }}>{p.description}</div></div> : null}
          <div className="card"><div className="card-head"><div><h2>Aprovação</h2><p>Projeto e fases são aprovados pela Oficial (a Substituta Legal, só com autorização).</p></div></div>
            <div className="card-body stack" style={{ gap: 8 }}>
              <div className="row-between small"><span>Projeto: {p.approved_at ? <span className="tag tag-ok">Aprovado por {p.approved_by_name} em {fmtDateTime(p.approved_at)}</span> : <span className="tag tag-warn">Aguardando aprovação</span>}{p.approval_notes ? ` — ${p.approval_notes}` : ''}</span>
                {a.approve && !p.approved_at ? <Op id={id} op="aprovar" label="Aprovar projeto" cls="btn btn-sm btn-primary"><input name="notes" className="input" placeholder="Observação (opcional)" aria-label="Observação da aprovação" /></Op> : null}</div>
              {phases.map((f) => (
                <div key={f.id} className="row-between small"><span>Fase {f.name}: {f.approved_at ? <span className="tag tag-ok">Aprovada por {f.approved_by_name}</span> : <span className="tag">Não aprovada</span>}</span>
                  {a.approve && !f.approved_at ? <Op id={id} op="aprovar_fase" label="Aprovar fase"><input type="hidden" name="phaseId" value={f.id} /></Op> : null}</div>
              ))}
              {a.approve && (p.owner_user_id === ctx.principal.userId || p.created_by === ctx.principal.userId) && ctx.principal.isOwner
                ? <p className="small muted">A senhora gere ou criou este projeto: a aprovação ficará registrada como autoaprovação da Oficial Registradora.</p> : null}
            </div>
          </div>
          <div className="grid grid-2">
            <div className="card"><div className="card-head"><h2>Marcos</h2></div>
              <div className="card-body stack" style={{ gap: 6 }}>
                {milestones.map((m) => (
                  <div key={m.id} className="row-between small"><span>{m.done_at ? '◆' : '◇'} {m.title} — {fmtDate(m.due_date)}{!m.done_at && m.due_date < todayLocal() ? <span className="neg"> (atrasado)</span> : null}</span>
                    {a.manage ? <ActionForm action={projectAction} submitLabel={m.done_at ? 'Reabrir' : 'Atingido'} submitClass="btn btn-sm" inline><input type="hidden" name="projectId" value={id} /><input type="hidden" name="op" value="marco_feito" /><input type="hidden" name="milestoneId" value={m.id} /><input type="hidden" name="done" value={m.done_at ? '0' : '1'} /></ActionForm> : null}</div>
                ))}
                {a.manage && open ? <Op id={id} op="marco" label="Incluir marco" reset><input name="title" className="input" placeholder="Marco" aria-label="Marco" required minLength={2} /><input name="dueDate" type="date" className="input" aria-label="Data do marco" required /></Op> : null}
              </div>
            </div>
            <div className="card"><div className="card-head"><h2>Indicadores</h2></div>
              <div className="card-body stack" style={{ gap: 8 }}>
                {indicators.map((i) => {
                  const ratio = Number(i.target) ? Math.min(100, (Number(i.current) / Number(i.target)) * 100) : 0;
                  return (
                    <div key={i.id}>
                      <div className="row-between small"><span>{i.name}</span><span>{Number(i.current).toLocaleString('pt-BR')} / {Number(i.target).toLocaleString('pt-BR')} {i.unit ?? ''}</span></div>
                      <div className="bar"><span style={{ width: `${ratio}%` }} /></div>
                      {a.contribute && open ? <Op id={id} op="indicador" label="Atualizar"><input type="hidden" name="indicatorId" value={i.id} /><input type="hidden" name="name" value={i.name} /><input type="hidden" name="unit" value={i.unit ?? ''} /><input type="hidden" name="target" value={i.target} /><input name="current" className="input" aria-label={`Valor atual de ${i.name}`} defaultValue={i.current} style={{ width: 100 }} /></Op> : null}
                    </div>
                  );
                })}
                {a.manage && open ? <Op id={id} op="indicador" label="Incluir indicador" reset><input name="name" className="input" placeholder="Indicador" aria-label="Indicador" required minLength={2} /><input name="target" className="input" placeholder="Meta" aria-label="Meta" required style={{ width: 80 }} /><input name="current" className="input" placeholder="Atual" aria-label="Atual" defaultValue="0" style={{ width: 80 }} /><input name="unit" className="input" placeholder="Unidade" aria-label="Unidade" style={{ width: 80 }} /></Op> : null}
              </div>
            </div>
          </div>
          <div className="card"><div className="card-head"><h2>Custos realizados</h2><p>Lançamentos gerenciais (o módulo financeiro, Fase 4b, terá contas a pagar e aprovação de despesas).</p></div>
            <div className="card-body flush table-wrap" tabIndex={0}><table className="table"><thead><tr><th>Data</th><th>Descrição</th><th className="num">Valor</th><th>Lançado por</th></tr></thead>
              <tbody>{costs.map((c) => <tr key={c.id}><td className="small">{fmtDate(c.spent_on)}</td><td className="small">{c.description}</td><td className="num">{fmtMoney(c.amount)}</td><td className="small">{c.created_by_name}</td></tr>)}</tbody></table></div>
            {a.manage && open ? <div className="card-body"><Op id={id} op="custo" label="Lançar custo" reset><input name="description" className="input" placeholder="Descrição" aria-label="Descrição do custo" required minLength={3} /><input name="amount" className="input" placeholder="Valor (R$)" aria-label="Valor" inputMode="decimal" required style={{ width: 120 }} /><input name="spentOn" type="date" className="input" aria-label="Data" defaultValue={todayLocal()} required /></Op></div> : null}
          </div>
        </div>
      ) : null}

      {tab === 'tarefas' ? (
        <div className="stack">
          <div className="card"><div className="card-body flush table-wrap" tabIndex={0}><TaskTable tasks={tasks.filter((t) => t.status !== 'CANCELADA')} showProject={false} /></div></div>
          {a.contribute && open ? (
            <div className="card"><div className="card-head"><h2>Nova tarefa do projeto</h2></div>
              <div className="card-body"><ActionForm action={createTaskAction} submitLabel="Criar tarefa" resetOnSuccess>
                <input type="hidden" name="projectId" value={id} />
                <TaskFields dir={dir} canAssign={a.manage} phases={phases} prefix="pt" />
              </ActionForm></div>
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === 'quadro' ? <TaskBoard tasks={tasks.filter((t) => t.status !== 'CANCELADA')} userId={ctx.principal.userId} /> : null}

      {tab === 'gantt' ? (() => {
        const dates = [p.start_date, p.due_date, ...tasks.flatMap((t) => [t.start_date, t.due_date]), ...phases.flatMap((f) => [f.start_date, f.due_date]), ...milestones.map((m) => m.due_date)]
          .filter((d): d is string => !!d).sort();
        const from = dates[0] ?? todayLocal();
        const to = dates.at(-1) && dates.at(-1)! > from ? dates.at(-1)! : addDays(from, 30);
        const items: GanttItem[] = [
          ...phases.flatMap((f) => [
            { id: `f-${f.id}`, label: `Fase: ${f.name}`, start: f.start_date, end: f.due_date, kind: 'phase' as const },
            ...tasks.filter((t) => t.phase_id === f.id && t.status !== 'CANCELADA').map((t) => ({ id: t.id, label: t.title, start: t.start_date, end: t.due_date, kind: 'task' as const, done: t.status === 'CONCLUIDA', href: `/tarefas/${t.id}` })),
          ]),
          ...tasks.filter((t) => !t.phase_id && t.status !== 'CANCELADA').map((t) => ({ id: t.id, label: t.title, start: t.start_date, end: t.due_date, kind: 'task' as const, done: t.status === 'CONCLUIDA', href: `/tarefas/${t.id}` })),
          ...milestones.map((m) => ({ id: `m-${m.id}`, label: `◆ ${m.title}`, start: m.due_date, end: m.due_date, kind: 'milestone' as const, done: !!m.done_at })),
        ];
        return (
          <div className="card">
            <div className="card-head"><h2>Cronograma</h2><p>Barras: verde concluída, vermelha vencida, cinza fase; losango: marco; linha vermelha: hoje.</p></div>
            <div className="card-body table-wrap" tabIndex={0}><Gantt items={items} from={from} to={to} /></div>
            {a.manage && open ? <div className="card-body"><Op id={id} op="fase" label="Incluir fase" reset><input name="name" className="input" placeholder="Fase" aria-label="Nome da fase" required minLength={2} /><input name="startDate" type="date" className="input" aria-label="Início da fase" /><input name="dueDate" type="date" className="input" aria-label="Fim da fase" /></Op></div> : null}
          </div>
        );
      })() : null}

      {tab === 'documentos' && a.docs ? await (async () => {
        const docs = await listProjectDocuments(ctx, id);
        const [categories, docDir, linkable] = a.attach
          ? await Promise.all([listCategories(), listDirectory(ctx), listDocuments(ctx, {}).catch(() => [])]) : [[], { users: [], sectors: [] }, []];
        const accept = Object.keys(ALLOWED_FILES).map((e) => `.${e}`).join(',');
        return (
          <div className="stack">
            <div className="card"><div className="card-head"><h2>Documentos do projeto</h2><p>Veem esta aba: gestor(a), pessoas com tarefa no projeto e a Oficial. Arquivos com antivírus e hash SHA-256, como na Gestão documental.</p></div>
              <div className="card-body flush table-wrap" tabIndex={0}>
                <table className="table"><thead><tr><th>Documento</th><th>Enviado por</th><th>Situação</th><th></th></tr></thead>
                  <tbody>{docs.map((d) => (
                    <tr key={d.id}>
                      <td>{d.file_id && !d.document_id ? <a href={`/api/v1/projetos/${id}/anexo/${d.id}`}>{d.title}</a> : d.document_id && d.doc_status !== 'EXCLUIDO' ? <Link href={`/documentos/${d.document_id}`}>{d.title}</Link> : d.title}
                        {d.sha256 ? <div className="small muted mono hash">SHA-256 {d.sha256.slice(0, 16)}…</div> : null}</td>
                      <td className="small">{d.added_by_name}<div className="muted">{fmtDateTime(d.added_at)}</div></td>
                      <td><span className={d.doc_status === 'VIGENTE' ? 'tag tag-ok' : d.doc_status === 'EXCLUIDO' ? 'tag tag-danger' : 'tag'}>{d.stage}{d.doc_version && d.doc_status === 'VIGENTE' ? ` — v${d.doc_version}` : ''}</span>
                        {d.doc_status === 'EXCLUIDO' && d.doc_delete_reason ? <div className="small">Motivo: {d.doc_delete_reason}</div> : null}</td>
                      <td style={{ minWidth: 260 }}>
                        {a.attach && open && d.file_id && !d.document_id ? (
                          <details className="disclosure small"><summary><a>Enviar à Gestão documental</a></summary>
                            <ActionForm action={projectAction} submitLabel="Criar documento e enviar" submitClass="btn btn-sm btn-primary">
                              <input type="hidden" name="projectId" value={id} /><input type="hidden" name="op" value="enviar_doc" /><input type="hidden" name="attachmentId" value={d.id} />
                              <MetaFields categories={categories} dir={docDir} prefix={`pd-${d.id.slice(0, 8)}`} title={d.title.replace(/\.[a-z0-9]+$/i, '')} fromProject={{ ownerName: p.owner_name, sectorName: p.sector_name }} />
                              <ReviewFields dir={docDir} prefix={`pr-${d.id.slice(0, 8)}`} />
                            </ActionForm>
                          </details>
                        ) : null}
                        {a.manage ? (
                          <details className="disclosure small"><summary><a>Retirar do projeto</a></summary>
                            <Op id={id} op="retirar_doc" label="Retirar"><input type="hidden" name="attachmentId" value={d.id} /><input name="reason" className="input" placeholder="Motivo" aria-label="Motivo da retirada" required minLength={3} /></Op>
                          </details>
                        ) : null}
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
                {docs.length ? null : <p className="small muted" style={{ padding: 12 }}>Nenhum documento no projeto.</p>}
              </div>
            </div>
            {a.attach && open ? (
              <div className="grid grid-2">
                <div className="card"><div className="card-head"><h2>Anexar arquivo</h2><p>.docx, .pdf, .xlsx, imagens e os demais formatos aceitos.</p></div>
                  <div className="card-body"><ActionForm action={projectAction} submitLabel="Anexar" resetOnSuccess>
                    <input type="hidden" name="projectId" value={id} /><input type="hidden" name="op" value="anexar" />
                    <div className="field"><label htmlFor="pa-f">Arquivo</label><input id="pa-f" name="file" type="file" className="input" accept={accept} required /></div>
                    <div className="field"><label htmlFor="pa-t">Título (opcional)</label><input id="pa-t" name="title" className="input" maxLength={200} /></div>
                  </ActionForm></div></div>
                <div className="card"><div className="card-head"><h2>Vincular documento existente</h2><p>Da Gestão documental.</p></div>
                  <div className="card-body"><ActionForm action={projectAction} submitLabel="Vincular" resetOnSuccess>
                    <input type="hidden" name="projectId" value={id} /><input type="hidden" name="op" value="vincular" />
                    <select name="documentId" className="input" aria-label="Documento" required defaultValue=""><option value="" disabled>Selecione…</option>
                      {linkable.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select>
                  </ActionForm></div></div>
              </div>
            ) : null}
          </div>
        );
      })() : null}

      {tab === 'equipe' ? (
        <div className="stack">
          <div className="card"><div className="card-head"><h2>Equipe</h2><p>Gestor(a): gere o projeto · Membro: cria e executa tarefas · Leitor(a): consulta</p></div>
            <div className="card-body flush table-wrap" tabIndex={0}><table className="table"><tbody>{members.map((m) => (
              <tr key={m.user_id}><td>{m.display_name}</td><td><span className="tag">{label(m.role)}</span></td>
                <td>{a.manage && m.user_id !== p.owner_user_id ? <Op id={id} op="membro" label="Remover" cls="btn btn-sm btn-ghost"><input type="hidden" name="userId" value={m.user_id} /></Op> : null}</td></tr>
            ))}</tbody></table></div>
            {a.manage ? <div className="card-body"><Op id={id} op="membro" label="Incluir / alterar">
              <select name="userId" className="input" aria-label="Pessoa">{dir.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select>
              <select name="role" className="input" aria-label="Papel no projeto"><option value="MEMBRO">Membro</option><option value="LEITOR">Leitor(a)</option><option value="GESTOR">Gestor(a)</option></select>
            </Op></div> : null}
          </div>
          {a.manage ? (
            <div className="card"><div className="card-head"><h2>Dados do projeto</h2></div>
              <div className="card-body"><ActionForm action={projectAction} submitLabel="Salvar">
                <input type="hidden" name="projectId" value={id} /><input type="hidden" name="op" value="editar" />
                <div className="form-grid">
                  <div className="field"><label htmlFor="pe-n">Nome</label><input id="pe-n" name="name" className="input" defaultValue={p.name} required /></div>
                  <div className="field"><label htmlFor="pe-c">Código</label><input id="pe-c" name="code" className="input mono" defaultValue={p.code ?? ''} /></div>
                  <div className="field"><label htmlFor="pe-s">Setor</label><select id="pe-s" name="sectorId" className="input" defaultValue={p.sector_id}>{dir.sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
                  <div className="field"><label htmlFor="pe-o">Gestor(a)</label><select id="pe-o" name="ownerUserId" className="input" required defaultValue={p.owner_user_id}><option value="" disabled>Selecione…</option>{dir.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></div>
                  <div className="field"><label htmlFor="pe-sd">Início</label><input id="pe-sd" name="startDate" type="date" className="input" defaultValue={p.start_date ?? ''} /></div>
                  <div className="field"><label htmlFor="pe-dd">Término previsto</label><input id="pe-dd" name="dueDate" type="date" className="input" defaultValue={p.due_date ?? ''} /></div>
                  <div className="field"><label htmlFor="pe-e">Custo estimado (R$)</label><input id="pe-e" name="estimatedCost" className="input" defaultValue={p.estimated_cost ? Number(p.estimated_cost).toFixed(2).replace('.', ',') : ''} /></div>
                  <div className="field"><label htmlFor="pe-st">Situação</label><select id="pe-st" name="status" className="input" defaultValue={p.status}>{PROJECT_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></div>
                  <div className="field"><label htmlFor="pe-r">Motivo (cancelamento/reabertura)</label><input id="pe-r" name="reason" className="input" /></div>
                </div>
                <div className="field" style={{ marginTop: 12 }}><label htmlFor="pe-d">Descrição</label><textarea id="pe-d" name="description" className="input" rows={3} defaultValue={p.description ?? ''} /></div>
              </ActionForm></div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default withGuard(ProjetoPage);
