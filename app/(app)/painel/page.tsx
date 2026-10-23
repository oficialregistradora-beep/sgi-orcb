import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { executiveIndicators, managementDashboard, personalDashboard } from '@/server/modules/dashboard.ts';
import { ALERT_LABELS, type DayAlert } from '@/domain/journey.ts';
import { fmtDate, fmtMin, fmtTime, label } from '@/ui/format.ts';
import { Empty, PageHead, Stat } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { punchAction } from '../../actions/journey.ts';
import { listPendingAcknowledgements, listPendingDocApprovals } from '@/server/modules/repository.ts';
import { listTasks } from '@/server/modules/tasks.ts';
import { ensureRoutineTasks } from '@/server/modules/routines.ts';
import { todayLocal } from '@/domain/time.ts';
import { availableWidgets, myWidgets, WIDGETS } from '@/server/modules/automation.ts';
import { complianceMatrix, myTrainings } from '@/server/modules/training.ts';
import { listEvaluations } from '@/server/modules/evaluations.ts';
import { qualityOverview } from '@/server/modules/security.ts';
import { financeOverview } from '@/server/modules/finance.ts';
import { panelAction } from '../../actions/phase5b.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Painel' };

export default async function Painel() {
  const ctx = await requirePageCtx();
  await ensureRoutineTasks();
  const widgets = await myWidgets(ctx);
  const on = (w: string) => widgets.includes(w);
  const [me, team, exec, docAcks, docApprovals, myTasks] = await Promise.all([
    on('jornada') ? personalDashboard(ctx) : null, on('coordenacao') ? managementDashboard(ctx) : null, on('administracao') ? executiveIndicators(ctx) : null,
    on('pendencias') ? listPendingAcknowledgements(ctx) : [], on('pendencias') ? listPendingDocApprovals(ctx) : [], on('tarefas') ? listTasks(ctx, { scope: 'minhas' }) : [],
  ]);
  const today = todayLocal();
  const urgentTasks = myTasks.filter((t) => t.priority === 'IMEDIATA' || t.priority === 'URGENTE' || (t.due_date && t.due_date <= today));
  const firstName = ctx.principal.displayName.split(' ')[0];
  const avail = availableWidgets(ctx.principal);
  const blocks: Record<string, React.ReactNode> = {};
  blocks.tarefas = myTasks.length ? (
        <div className="card">
          <div className="card-head"><h2>Minhas tarefas</h2><p>{myTasks.length} em aberto · {urgentTasks.length} para hoje, vencidas ou urgentes — <Link href="/tarefas">abrir</Link></p></div>
          {urgentTasks.length ? <div className="card-body stack" style={{ gap: 4 }}>{urgentTasks.slice(0, 8).map((t) => (
            <div key={t.id} className="row-between small"><Link href={`/tarefas/${t.id}`}>{t.title}</Link><span className={t.due_date && t.due_date < today ? 'neg' : 'muted'}>{label(t.priority)}{t.due_date ? ` · ${fmtDate(t.due_date)}` : ''}{t.due_time != null ? ` ${String(Math.floor(t.due_time / 60)).padStart(2, '0')}:${String(t.due_time % 60).padStart(2, '0')}` : ''}</span></div>
          ))}</div> : null}
        </div>
      ) : null;
  blocks.pendencias = docAcks.length || docApprovals.length ? (
        <div className="alert alert-warn small"><div>
          {docAcks.length ? <><strong>{docAcks.length}</strong> documento(s) institucional(is) aguardando sua ciência — <Link href="/documentos?aba=ciencia">ver</Link>. </> : null}
          {docApprovals.length ? <><strong>{docApprovals.length}</strong> versão(ões) aguardando sua aprovação — <Link href="/documentos?aba=aprovacoes">ver</Link>.</> : null}
        </div></div>
      ) : null;
  blocks.jornada = me ? (
        <section className="stack" aria-labelledby="pessoal">
          <h2 id="pessoal" className="sr-only">Minha situação</h2>
          <div className="grid grid-4">
            <div className="card stat">
              <div className="stat-label">Jornada de hoje</div>
              <div className="stat-value">{fmtMin(me.today?.day.result.worked ?? 0)}</div>
              <div className="stat-hint">
                {me.today?.day.punches.filter((p) => !p.annulled).map((p) => fmtTime(p.punched_at)).join(' · ') || 'Nenhuma marcação hoje'}
              </div>
              <div style={{ marginTop: 10 }}>
                <ActionForm action={punchAction} submitLabel={`Registrar ${label(me.today?.nextKind).toLowerCase()}`} inline>{null}</ActionForm>
              </div>
            </div>
            <Stat label="Saldo do banco de horas" value={fmtMin(me.bank.balance, true)} tone={me.bank.balance < 0 ? 'neg' : undefined}
              hint={`Disponível ${fmtMin(me.bank.available)}${me.bank.expiringSoon ? ` · ${fmtMin(me.bank.expiringSoon)} a vencer` : ''}`} />
            <Stat label="Ocorrências em análise" value={me.pendingOccurrences.length} hint={<Link href="/banco-de-horas">Ver e justificar</Link>} />
            <Stat label="Documentos para ciência" value={me.docsToSign} hint={<Link href="/documentos-pessoais">Meus documentos</Link>} tone={me.docsToSign ? 'warn' : undefined} />
          </div>
          {me.bank.expired > 0 ? (
            <div className="alert alert-warn">Há {fmtMin(me.bank.expired)} de créditos vencidos sem compensação. A administração foi sinalizada para pagamento ou análise.</div>
          ) : null}
          {me.upcomingAbsences.length ? (
            <div className="card">
              <div className="card-head"><h2>Próximas ausências</h2></div>
              <div className="card-body small">
                {me.upcomingAbsences.map((a) => (
                  <div key={`${a.start_date}${a.type}`}>{label(a.type)}: {fmtDate(a.start_date)} a {fmtDate(a.end_date)}</div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : (
        <div className="alert alert-info">Seu usuário não está vinculado a um cadastro funcional; as áreas pessoais de jornada não se aplicam.</div>
      );
  blocks.coordenacao = team ? (
        <section className="stack" aria-labelledby="equipe-h">
          <h2 id="equipe-h">Coordenação</h2>
          <div className="grid grid-3">
            <Stat label="Solicitações aguardando decisão" value={team.requestsToDecide} hint={<Link href="/solicitacoes?aba=aprovar">Analisar</Link>} tone={team.requestsToDecide ? 'warn' : undefined} />
            <Stat label="Ocorrências pendentes de análise" value={team.pendingOccurrences} hint={<Link href="/ocorrencias">Analisar</Link>} tone={team.pendingOccurrences ? 'warn' : undefined} />
            <Stat label="Espelhos aguardando aprovação" value={team.documentsToApprove} hint={<Link href="/documentos-pessoais?aba=aprovar">Conferir</Link>} />
          </div>
          <div className="grid grid-2">
            <div className="card">
              <div className="card-head"><h2>Frequência de hoje</h2><p>Equipe sob sua visão</p></div>
              <div className="card-body flush table-wrap">
                <table className="table">
                  <thead><tr><th>Funcionário</th><th>Setor</th><th>Situação</th></tr></thead>
                  <tbody>
                    {team.team.map((m) => (
                      <tr key={m.id}>
                        <td>{m.full_name}</td>
                        <td className="muted">{m.sector_name}</td>
                        <td>{m.absence ? <span className="tag tag-info">{label(m.absence)}</span> : m.punches_today > 0 ? <span className="tag tag-ok">{m.punches_today} marcação(ões)</span> : <span className="tag">Sem marcação</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <div className="card-head"><h2>Alertas de jornada</h2><p>Últimos 14 dias</p></div>
              <div className="card-body flush table-wrap">
                {team.alerts.length ? (
                  <table className="table">
                    <thead><tr><th>Data</th><th>Funcionário</th><th>Alerta</th></tr></thead>
                    <tbody>
                      {team.alerts.map((a) => (
                        <tr key={`${a.full_name}${a.work_date}`}>
                          <td className="nowrap">{fmtDate(a.work_date)}</td>
                          <td>{a.full_name}</td>
                          <td className="small">{a.alerts.map((x) => ALERT_LABELS[x as DayAlert] ?? x).join('; ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <Empty>Nenhum alerta no período.</Empty>}
              </div>
            </div>
          </div>
        </section>
      ) : null;
  blocks.administracao = exec ? (
        <section className="stack" aria-labelledby="exec-h">
          <h2 id="exec-h">Visão da administração</h2>
          <div className="grid grid-4">
            <Stat label="Colaboradores ativos" value={exec.headcount} hint={exec.bySector.map((s) => `${s.name.split(' ')[0]} ${s.n}`).join(' · ')} />
            <Stat label="Créditos disponíveis (todos)" value={fmtMin(exec.totals.available)} hint={`${fmtMin(exec.totals.expiringSoon)} vencem em breve`} />
            <Stat label="Créditos vencidos" value={fmtMin(exec.totals.expired)} hint="Requerem pagamento ou análise" tone={exec.totals.expired ? 'neg' : undefined} />
            <Stat label="Saldos elevados" value={exec.totals.highBalances} hint="Acima do limite configurado" tone={exec.totals.highBalances ? 'warn' : undefined} />
          </div>
          <div className="grid grid-2">
            <div className="card">
              <div className="card-head"><h2>Banco de horas por funcionário</h2></div>
              <div className="card-body flush table-wrap">
                <table className="table">
                  <thead><tr><th>Funcionário</th><th className="num">Saldo</th><th className="num">A vencer</th><th className="num">Vencido</th></tr></thead>
                  <tbody>
                    {exec.balances.map((b) => (
                      <tr key={b.id}>
                        <td><Link href={`/banco-de-horas?funcionario=${b.id}`}>{b.full_name}</Link></td>
                        <td className={`num ${b.balance < 0 ? 'neg' : ''}`}>{fmtMin(b.balance, true)}</td>
                        <td className="num">{b.expiringSoon ? fmtMin(b.expiringSoon) : '—'}</td>
                        <td className={`num ${b.expired ? 'neg' : ''}`}>{b.expired ? fmtMin(b.expired) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <div className="card-head"><h2>Ausências nos próximos 30 dias</h2></div>
              <div className="card-body flush table-wrap">
                {exec.absencesNext30.length ? (
                  <table className="table">
                    <thead><tr><th>Funcionário</th><th>Tipo</th><th>Período</th></tr></thead>
                    <tbody>
                      {exec.absencesNext30.map((a) => (
                        <tr key={`${a.full_name}${a.start_date}`}><td>{a.full_name}</td><td>{label(a.type)}</td><td className="nowrap">{fmtDate(a.start_date)} – {fmtDate(a.end_date)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                ) : <Empty>Nenhuma ausência programada.</Empty>}
              </div>
            </div>
          </div>
        </section>
      ) : null;
  if (on('treinamentos') && ctx.principal.employeeId) {
    const tr = (await myTrainings(ctx)).filter((r) => r.required);
    const bad = tr.filter((r) => ['PENDENTE', 'VENCIDO', 'NOVA_VERSAO'].includes(r.situation));
    const soon = tr.filter((r) => r.situation === 'A_VENCER');
    blocks.treinamentos = tr.length ? (
      <div className="card"><div className="card-head"><h2>Meus treinamentos</h2><p>{tr.length - bad.length} de {tr.length} obrigatórios em dia — <Link href="/treinamentos">abrir</Link></p></div>
        {bad.length || soon.length ? <div className="card-body stack small" style={{ gap: 4 }}>{[...bad, ...soon].slice(0, 6).map((r) => (
          <div key={r.training.id} className="row-between"><Link href={`/treinamentos/${r.training.id}`}>{r.training.title}</Link><span className={bad.includes(r) ? 'neg' : 'muted'}>{bad.includes(r) ? (r.situation === 'NOVA_VERSAO' ? 'nova versão' : r.situation === 'VENCIDO' ? 'vencido' : 'pendente') : `vence ${r.expiresOn?.split('-').reverse().join('/')}`}</span></div>
        ))}</div> : null}</div>
    ) : null;
  }
  if (on('avaliacoes')) {
    const all = await listEvaluations(ctx);
    const mine = all.filter((v) => v.employee_user_id === ctx.principal.userId && (v.status === 'AGUARDANDO_CIENCIA' || (v.status === 'PENDENTE' && v.self_assessment && !v.self_submitted_at)));
    const todo = all.filter((v) => v.evaluator_user_id === ctx.principal.userId && v.status === 'PENDENTE');
    blocks.avaliacoes = mine.length || todo.length ? (
      <div className="grid grid-2">
        <Stat label="Minhas avaliações aguardando ação" value={mine.length} tone={mine.length ? 'warn' : undefined} hint={<Link href="/avaliacoes">Ciência ou autoavaliação</Link>} />
        <Stat label="Avaliações a fazer" value={todo.length} tone={todo.some((v) => v.due_date < today) ? 'neg' : undefined} hint={<Link href="/avaliacoes?aba=avaliar">{todo.filter((v) => v.due_date < today).length} em atraso</Link>} />
      </div>
    ) : null;
  }
  if (on('capacitacao')) {
    const m = await complianceMatrix(ctx).catch(() => null);
    blocks.capacitacao = m && m.summary.required ? (
      <Stat label="Capacitação obrigatória da equipe em dia" value={`${m.summary.pct?.toLocaleString('pt-BR')}%`} tone={m.summary.expired ? 'neg' : undefined} hint={<Link href="/treinamentos?aba=equipe">{m.summary.expired} vencido(s) · ver matriz</Link>} />
    ) : null;
  }
  if (on('qualidade')) {
    const q = await qualityOverview(ctx).catch(() => null);
    blocks.qualidade = q ? (
      <div className="grid grid-4">
        {q.compliance ? <Stat label="Índice de atendimento (registrado)" value={q.compliance.pct === null ? '—' : `${q.compliance.pct.toLocaleString('pt-BR')}%`} hint={<Link href="/qualidade">Qualidade</Link>} /> : null}
        {q.ncs ? <Stat label="Não conformidades abertas" value={q.ncs.open} tone={q.ncs.critical_open ? 'neg' : undefined} /> : null}
        {q.incidents ? <Stat label="Incidentes em aberto" value={q.incidents.open} tone={q.incidents.personal_pending ? 'neg' : undefined} /> : null}
        {q.vulnerabilities ? <Stat label="Vulnerabilidades vencidas" value={q.vulnerabilities.overdue} tone={q.vulnerabilities.overdue ? 'neg' : undefined} /> : null}
      </div>
    ) : null;
  }
  if (on('financeiro')) {
    const f = await financeOverview(ctx, today.slice(0, 7), today.slice(0, 7)).catch(() => null);
    blocks.financeiro = f ? (
      <div className="grid grid-3">
        <Stat label="Contas vencidas" value={f.totals.overdue} tone={f.totals.overdue ? 'neg' : undefined} hint={<Link href="/financeiro?aba=pagar">Contas a pagar</Link>} />
        <Stat label="A vencer em breve" value={f.totals.dueSoon} />
      </div>
    ) : null;
  }

  return (
    <div className="stack">
      <PageHead title={`Olá, ${firstName}`} subtitle="Resumo das informações que você está autorizado(a) a ver." />
      {widgets.map((w) => blocks[w] ? <section key={w} aria-label={WIDGETS[w]!.label}>{blocks[w]}</section> : null)}
      {!widgets.length ? <div className="alert alert-info">Seu painel está vazio. Escolha os blocos abaixo.</div> : null}
      <details className="disclosure small">
        <summary><a>Personalizar painel</a></summary>
        <ActionForm action={panelAction} submitLabel="Salvar painel">
          <p className="muted">Marque os blocos e defina a ordem (1 = primeiro). Cada bloco mostra apenas o que você já pode ver.</p>
          {avail.map((w, i) => (
            <div key={w} className="row">
              <input name={`pos_${w}`} type="number" min={1} max={30} className="input" style={{ width: 70 }} aria-label={`Ordem: ${WIDGETS[w]!.label}`} defaultValue={widgets.includes(w) ? widgets.indexOf(w) + 1 : i + 1 + widgets.length} />
              <label className="check"><input type="checkbox" name="widget" value={w} defaultChecked={widgets.includes(w)} /> {WIDGETS[w]!.label}</label>
            </div>
          ))}
        </ActionForm>
        <ActionForm action={panelAction} submitLabel="Restaurar padrão" submitClass="btn btn-sm"><input type="hidden" name="op" value="padrao" /></ActionForm>
      </details>
    </div>
  );
}
