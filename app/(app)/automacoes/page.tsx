import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { ACTIONS, listRules, recentRuns, TRIGGERS } from '@/server/modules/automation.ts';
import { directory } from '@/server/modules/directory.ts';
import { fmtDateTime } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { automationAction } from '../../actions/phase5b.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Automações' };

export default async function AutomacoesPage({ searchParams }: { searchParams: Promise<{ regra?: string }> }) {
  const ctx = await requirePageCtx();
  if (!can(ctx.principal, 'automacoes.gerenciar')) return <div className="stack"><PageHead title="Automações" /><div className="alert alert-warn">Você não tem acesso a esta página.</div></div>;
  const sp = await searchParams;
  const [rules, runs, dir] = await Promise.all([listRules(ctx), recentRuns(ctx), directory(ctx)]);
  const edit = rules.find((r) => r.id === sp.regra);
  return (
    <div className="stack">
      <PageHead title="Automações" subtitle="Regras “quando… então…” executadas pela rotina diária. Só enviam avisos ou criam tarefas — nunca alteram, aprovam, pagam ou excluem registros. Cada item dispara uma única vez por regra." />
      <div className="card"><div className="card-body flush table-wrap">
        {rules.length ? <table className="table"><thead><tr><th>Regra</th><th>Quando</th><th>Então</th><th>Última execução</th><th className="num">Disparos</th><th></th></tr></thead>
          <tbody>{rules.map((r) => (
            <tr key={r.id} className={r.active ? undefined : 'row-muted'}>
              <td>{r.name}{r.active ? null : <span className="tag" style={{ marginLeft: 6 }}>Inativa</span>}</td>
              <td className="small">{TRIGGERS[r.trigger]?.label ?? r.trigger} · {r.days} {TRIGGERS[r.trigger]?.daysMeaning}{r.sector_name ? ` · ${r.sector_name}` : ''}</td>
              <td className="small">{ACTIONS[r.action as keyof typeof ACTIONS]}{r.role_name ? `: ${r.role_name}` : r.user_name ? `: ${r.user_name}` : ''}</td>
              <td className="small">{r.last_run_at ? fmtDateTime(r.last_run_at) : '—'}</td><td className="num">{r.runs}</td>
              <td className="nowrap"><a className="btn btn-sm" href={`/automacoes?regra=${r.id}#form-regra`}>Editar</a>
                {r.active ? <ActionForm action={automationAction} submitLabel="Executar agora" submitClass="btn btn-sm" inline><input type="hidden" name="op" value="executar" /><input type="hidden" name="id" value={r.id} /></ActionForm> : null}</td>
            </tr>
          ))}</tbody></table> : <Empty>Nenhuma regra.</Empty>}
      </div></div>

      <div className="card" id="form-regra"><div className="card-head"><h2>{edit ? `Editar: ${edit.name}` : 'Nova regra'}</h2><p>Avisos a um papel ou a uma pessoa não trazem detalhes do item — só o link, que respeita as permissões de acesso.</p></div><div className="card-body">
        <ActionForm action={automationAction} submitLabel="Salvar regra" key={edit?.id ?? 'nova'} resetOnSuccess={!edit}>
          <input type="hidden" name="op" value="regra" />{edit ? <><input type="hidden" name="id" value={edit.id} /><input type="hidden" name="activeField" value="1" /></> : null}
          <div className="form-grid">
            <div className="field" style={{ gridColumn: 'span 2' }}><label>Nome<input name="name" className="input" required minLength={3} defaultValue={edit?.name} /></label></div>
            <div className="field"><label>Quando<select name="trigger" className="input" defaultValue={edit?.trigger}>{Object.entries(TRIGGERS).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}</select></label></div>
            <div className="field"><label>Dias (atraso, antecedência ou duração)<input name="days" type="number" min={0} max={365} className="input" defaultValue={edit?.days ?? 0} /></label></div>
            <div className="field"><label>Somente o setor<select name="sectorId" className="input" defaultValue={edit?.sector_id ?? ''}><option value="">Todos</option>{dir.sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></div>
            <div className="field"><label>Então<select name="action" className="input" defaultValue={edit?.action}>{Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label></div>
            <div className="field"><label>Papel (avisar papel)<select name="targetRoleId" className="input" defaultValue={edit?.target_role_id ?? ''}><option value="">—</option>{dir.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label></div>
            <div className="field"><label>Pessoa (avisar pessoa / criar tarefa)<select name="targetUserId" className="input" defaultValue={edit?.target_user_id ?? ''}><option value="">—</option>{dir.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label></div>
          </div>
          <div className="field"><label>Mensagem (opcional, sem dados pessoais)<input name="message" className="input" maxLength={300} defaultValue={edit?.message ?? ''} /></label></div>
          {edit ? <label className="check"><input type="checkbox" name="active" defaultChecked={edit.active} /> Ativa</label> : null}
        </ActionForm>
      </div></div>

      <div className="card"><div className="card-head"><h2>Últimos disparos</h2></div><div className="card-body flush table-wrap">
        {runs.length ? <table className="table"><tbody>{runs.map((r, i) => <tr key={i}><td className="small nowrap">{fmtDateTime(r.ran_at)}</td><td>{r.rule_name}</td><td className="small">{r.outcome}</td></tr>)}</tbody></table> : <Empty>Nenhum disparo.</Empty>}
      </div></div>
    </div>
  );
}
