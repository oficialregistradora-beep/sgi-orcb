import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { listProjects, PROJECT_SUGGESTIONS } from '@/server/modules/projects.ts';
import { directory } from '@/server/modules/directory.ts';
import { fmtDate, fmtMoney, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { createProjectAction } from '../../actions/phase4a.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Projetos' };

export default async function ProjetosPage({ searchParams }: { searchParams: Promise<{ encerrados?: string }> }) {
  const ctx = await requirePageCtx();
  const sp = await searchParams;
  const projects = await listProjects(ctx, { includeClosed: sp.encerrados === '1' });
  const canCreate = ctx.principal.isOwner || can(ctx.principal, 'projetos.gerenciar');
  const dir = canCreate ? await directory(ctx) : null;
  return (
    <div className="stack">
      <PageHead title="Projetos" subtitle="Fases, marcos, custos, responsáveis e indicadores." actions={<Link className="btn" href="/tarefas">Tarefas</Link>} />
      <div className="card">
        <div className="card-head"><h2>{sp.encerrados === '1' ? 'Todos os projetos' : 'Projetos em curso'}</h2>
          <a className="small" href={sp.encerrados === '1' ? '/projetos' : '/projetos?encerrados=1'}>{sp.encerrados === '1' ? 'Ocultar encerrados' : 'Incluir encerrados'}</a></div>
        <div className="card-body flush table-wrap">
          {projects.length ? (
            <table className="table">
              <thead><tr><th>Projeto</th><th>Situação</th><th>Progresso</th><th>Prazo</th><th>Custo (previsto / realizado)</th><th>Gestor(a)</th></tr></thead>
              <tbody>{projects.map((p) => {
                const pct = p.tasks_total ? Math.round((p.tasks_done / p.tasks_total) * 100) : 0;
                return (
                  <tr key={p.id}>
                    <td><Link href={`/projetos/${p.id}`}>{p.name}</Link><div className="small muted">{p.code ? <span className="mono">{p.code} · </span> : null}{p.sector_name}</div></td>
                    <td><span className={statusTone(p.status)}>{label(p.status)}</span></td>
                    <td style={{ minWidth: 140 }}><div className="bar"><span style={{ width: `${pct}%` }} /></div><div className="small muted">{p.tasks_done}/{p.tasks_total} tarefas{p.tasks_overdue ? <span className="neg"> · {p.tasks_overdue} vencida(s)</span> : null}</div></td>
                    <td className="small nowrap">{p.due_date ? fmtDate(p.due_date) : '—'}</td>
                    <td className="small nowrap">{p.estimated_cost ? fmtMoney(p.estimated_cost) : '—'} / {fmtMoney(p.actual_cost)}</td>
                    <td className="small">{p.owner_name}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          ) : <Empty>Nenhum projeto visível para você.</Empty>}
        </div>
      </div>
      {canCreate && dir ? (
        <div className="card">
          <div className="card-head"><h2>Novo projeto</h2><p>Sugestões do planejamento: digite ou escolha.</p></div>
          <div className="card-body">
            <ActionForm action={createProjectAction} submitLabel="Criar projeto">
              <div className="form-grid">
                <div className="field"><label htmlFor="np-name">Nome</label><input id="np-name" name="name" className="input" list="np-sug" required minLength={3} maxLength={160} />
                  <datalist id="np-sug">{PROJECT_SUGGESTIONS.map((s) => <option key={s} value={s} />)}</datalist></div>
                <div className="field"><label htmlFor="np-code">Código (opcional)</label><input id="np-code" name="code" className="input mono" placeholder="PQTA-2027" /></div>
                <div className="field"><label htmlFor="np-sec">Setor</label><select id="np-sec" name="sectorId" className="input" required defaultValue={ctx.principal.employeeSectorId ?? ''}>
                  <option value="" disabled>Selecione…</option>{dir.sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
                <div className="field"><label htmlFor="np-own">Gestor(a)</label><select id="np-own" name="ownerUserId" className="input" defaultValue={ctx.principal.userId}>{dir.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></div>
                <div className="field"><label htmlFor="np-sd">Início</label><input id="np-sd" name="startDate" type="date" className="input" /></div>
                <div className="field"><label htmlFor="np-dd">Término previsto</label><input id="np-dd" name="dueDate" type="date" className="input" /></div>
                <div className="field"><label htmlFor="np-cost">Custo estimado (R$)</label><input id="np-cost" name="estimatedCost" className="input" inputMode="decimal" placeholder="0,00" /></div>
              </div>
              <div className="field" style={{ marginTop: 12 }}><label htmlFor="np-desc">Descrição</label><textarea id="np-desc" name="description" className="input" rows={3} /></div>
            </ActionForm>
          </div>
        </div>
      ) : null}
    </div>
  );
}
