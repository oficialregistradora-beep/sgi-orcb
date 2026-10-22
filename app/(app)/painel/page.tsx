import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { executiveIndicators, managementDashboard, personalDashboard } from '@/server/modules/dashboard.ts';
import { ALERT_LABELS, type DayAlert } from '@/domain/journey.ts';
import { fmtDate, fmtMin, fmtTime, label } from '@/ui/format.ts';
import { Empty, PageHead, Stat } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { punchAction } from '../../actions/journey.ts';
import { listPendingAcknowledgements, listPendingDocApprovals } from '@/server/modules/repository.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Painel' };

export default async function Painel() {
  const ctx = await requirePageCtx();
  const [me, team, exec, docAcks, docApprovals] = await Promise.all([
    personalDashboard(ctx), managementDashboard(ctx), executiveIndicators(ctx), listPendingAcknowledgements(ctx), listPendingDocApprovals(ctx),
  ]);
  const firstName = ctx.principal.displayName.split(' ')[0];
  return (
    <div className="stack">
      <PageHead title={`Olá, ${firstName}`} subtitle="Resumo das informações que você está autorizado(a) a ver." />
      {docAcks.length || docApprovals.length ? (
        <div className="alert alert-warn small"><div>
          {docAcks.length ? <><strong>{docAcks.length}</strong> documento(s) institucional(is) aguardando sua ciência — <Link href="/documentos?aba=ciencia">ver</Link>. </> : null}
          {docApprovals.length ? <><strong>{docApprovals.length}</strong> versão(ões) aguardando sua aprovação — <Link href="/documentos?aba=aprovacoes">ver</Link>.</> : null}
        </div></div>
      ) : null}

      {me ? (
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
      )}

      {team ? (
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
      ) : null}

      {exec ? (
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
      ) : null}
    </div>
  );
}
