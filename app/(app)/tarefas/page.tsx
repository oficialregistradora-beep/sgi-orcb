import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { listTasks, taskDashboard, STATUSES, type TaskStatus } from '@/server/modules/tasks.ts';
import { ensureRoutineTasks } from '@/server/modules/routines.ts';
import { directory } from '@/server/modules/directory.ts';
import { monthRange, todayLocal } from '@/domain/time.ts';
import { label } from '@/ui/format.ts';
import { PageHead, Stat } from '@/ui/Stat.tsx';
import { MonthPicker } from '@/ui/MonthPicker.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { TaskBoard, TaskCalendar, TaskFields, TaskTable } from '@/ui/tasks.tsx';
import { createTaskAction } from '../../actions/phase4a.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Tarefas' };

const VIEWS = { minhas: 'Minhas tarefas', lista: 'Lista', quadro: 'Quadro', calendario: 'Calendário', painel: 'Painel', nova: 'Nova tarefa' } as const;

export default async function TarefasPage({ searchParams }: { searchParams: Promise<{ visao?: string; q?: string; situacao?: string; setor?: string; responsavel?: string; mes?: string }> }) {
  const ctx = await requirePageCtx();
  const sp = await searchParams;
  const view = (sp.visao && sp.visao in VIEWS ? sp.visao : 'minhas') as keyof typeof VIEWS;
  await ensureRoutineTasks();
  const p = ctx.principal;
  const canAssign = p.isOwner || can(p, 'tarefas.gerenciar');
  const dir = await directory(ctx);
  const status = (sp.situacao && (STATUSES as readonly string[]).concat(['TODAS', 'ABERTAS']).includes(sp.situacao) ? sp.situacao : undefined) as TaskStatus | 'TODAS' | 'ABERTAS' | undefined;
  const period = /^\d{4}-\d{2}$/.test(sp.mes ?? '') ? sp.mes! : todayLocal().slice(0, 7);

  const filters = (
    <form className="row" method="get" action="/tarefas" role="search">
      <input type="hidden" name="visao" value={view} />
      <input name="q" className="input" placeholder="Pesquisar" aria-label="Pesquisar" defaultValue={sp.q ?? ''} />
      <select name="situacao" className="input" aria-label="Situação" defaultValue={sp.situacao ?? ''}>
        <option value="">Em aberto</option><option value="TODAS">Todas</option>
        {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
      </select>
      <select name="setor" className="input" aria-label="Setor" defaultValue={sp.setor ?? ''}><option value="">Todos os setores</option>{dir.sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      <select name="responsavel" className="input" aria-label="Responsável" defaultValue={sp.responsavel ?? ''}><option value="">Todos os responsáveis</option>{dir.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select>
      <button type="submit" className="btn">Filtrar</button>
    </form>
  );

  return (
    <div className="stack">
      <PageHead title="Tarefas" subtitle="Gestão interna de atividades. Não substitui livros, protocolos, centrais nem sistemas oficiais, e não pratica atos registrais."
        actions={<><Link className="btn" href="/projetos">Projetos</Link><Link className="btn" href="/rotinas">Rotinas e processos</Link></>} />
      <nav className="tabs">{Object.entries(VIEWS).map(([k, v]) => <Link key={k} href={`/tarefas?visao=${k}`} aria-current={view === k ? 'page' : undefined}>{v}</Link>)}</nav>

      {view === 'minhas' ? await (async () => {
        const mine = await listTasks(ctx, { scope: 'minhas' });
        const today = todayLocal();
        const groups = [
          { title: 'Imediatas e urgentes', items: mine.filter((t) => t.priority === 'IMEDIATA' || t.priority === 'URGENTE') },
          { title: 'Vencidas', items: mine.filter((t) => t.priority !== 'IMEDIATA' && t.priority !== 'URGENTE' && t.due_date && t.due_date < today) },
          { title: 'Hoje', items: mine.filter((t) => t.priority !== 'IMEDIATA' && t.priority !== 'URGENTE' && t.due_date === today) },
          { title: 'Próximas e sem prazo', items: mine.filter((t) => t.priority !== 'IMEDIATA' && t.priority !== 'URGENTE' && (!t.due_date || t.due_date > today)) },
        ];
        return groups.map((g) => (
          <div className="card" key={g.title}>
            <div className="card-head"><h2>{g.title}</h2><p>{g.items.length}</p></div>
            <div className="card-body flush table-wrap"><TaskTable tasks={g.items} /></div>
          </div>
        ));
      })() : null}

      {view === 'lista' ? await (async () => {
        const rows = await listTasks(ctx, { q: sp.q, status, sectorId: sp.setor, assigneeUserId: sp.responsavel });
        return (
          <div className="card">
            <div className="card-head">{filters}</div>
            <div className="card-body flush table-wrap"><TaskTable tasks={rows} /></div>
          </div>
        );
      })() : null}

      {view === 'quadro' ? await (async () => {
        const rows = await listTasks(ctx, { q: sp.q, status: 'TODAS', sectorId: sp.setor, assigneeUserId: sp.responsavel });
        const recentDone = rows.filter((t) => t.status !== 'CONCLUIDA' || (t.completed_at && t.completed_at.getTime() > Date.now() - 7 * 86400000));
        return <div className="stack">{filters}<TaskBoard tasks={recentDone.filter((t) => t.status !== 'CANCELADA')} userId={p.userId} /><p className="small muted">Concluídas: últimos 7 dias. Bloqueio e cancelamento exigem motivo, na página da tarefa.</p></div>;
      })() : null}

      {view === 'calendario' ? await (async () => {
        const { from, to } = monthRange(period);
        const rows = await listTasks(ctx, { status: 'TODAS', dueFrom: from, dueTo: to, sectorId: sp.setor, assigneeUserId: sp.responsavel });
        return (
          <div className="card">
            <div className="card-head"><MonthPicker period={period} base="/tarefas" extra={{ visao: 'calendario', setor: sp.setor, responsavel: sp.responsavel }} /></div>
            <div className="card-body flush table-wrap"><TaskCalendar tasks={rows.filter((t) => t.status !== 'CANCELADA')} period={period} /></div>
          </div>
        );
      })() : null}

      {view === 'painel' ? await (async () => {
        const d = await taskDashboard(ctx, { sectorId: sp.setor });
        return (
          <div className="stack">
            <div className="grid grid-4">
              <Stat label="Em aberto" value={d.open} hint={`${d.dueToday} com prazo hoje`} />
              <Stat label="Vencidas" value={d.overdue} tone={d.overdue ? 'neg' : undefined} />
              <Stat label="Imediatas / encaminhadas" value={`${d.immediate} / ${d.escalated}`} />
              <Stat label="Concluídas em 30 dias" value={d.completed30} hint={d.onTimePct === null ? '—' : `${d.onTimePct}% no prazo`} />
            </div>
            <div className="grid grid-2">
              <div className="card"><div className="card-head"><h2>Por situação</h2></div>
                <div className="card-body stack" style={{ gap: 8 }}>{STATUSES.map((s) => {
                  const total = Object.values(d.byStatus).reduce((a, b) => a + b, 0) || 1;
                  return <div key={s}><div className="row-between small"><span>{label(s)}</span><span>{d.byStatus[s]}</span></div><div className="bar"><span style={{ width: `${(d.byStatus[s] / total) * 100}%` }} /></div></div>;
                })}</div>
              </div>
              <div className="card"><div className="card-head"><h2>Carga por responsável</h2><p>Tarefas em aberto</p></div>
                <div className="card-body flush table-wrap"><table className="table"><thead><tr><th>Responsável</th><th className="num">Abertas</th><th className="num">Vencidas</th></tr></thead>
                  <tbody>{d.byAssignee.map((a) => <tr key={a.name}><td>{a.name}</td><td className="num">{a.open}</td><td className={`num ${a.overdue ? 'neg' : ''}`}>{a.overdue}</td></tr>)}</tbody></table></div>
              </div>
            </div>
          </div>
        );
      })() : null}

      {view === 'nova' ? (
        <div className="card">
          <div className="card-head"><h2>Nova tarefa</h2><p>{canAssign ? 'Você pode atribuir a pessoas do seu escopo.' : 'A tarefa será atribuída a você. Atribuições a terceiros cabem à coordenação.'}</p></div>
          <div className="card-body">
            <ActionForm action={createTaskAction} submitLabel="Criar tarefa">
              <input type="hidden" name="open" value="1" />
              <TaskFields dir={dir} canAssign={canAssign} prefix="nova" />
            </ActionForm>
          </div>
        </div>
      ) : null}
    </div>
  );
}
