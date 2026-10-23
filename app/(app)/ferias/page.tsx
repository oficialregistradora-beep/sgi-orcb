import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { getVacationOverview, teamVacations } from '@/server/modules/vacation.ts';
import { describePayload } from '@/server/modules/requests.ts';
import { addDays, todayLocal } from '@/domain/time.ts';
import { fmtDate, fmtDateTime, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { cancelVacationAction, requestVacationAction } from '../../actions/phase2b.ts';
import { reviewPeriodAction } from '../../actions/phase2c.ts';
import { ART130_BANDS } from '@/domain/vacation.ts';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Férias' };

async function FeriasPage({ searchParams }: { searchParams: Promise<{ funcionario?: string }> }) {
  const ctx = await requirePageCtx();
  const sp = await searchParams;
  const employeeId = sp.funcionario ?? ctx.principal.employeeId;
  const own = employeeId === ctx.principal.employeeId;
  const overview = employeeId ? await getVacationOverview(ctx, employeeId) : null;
  const team = await teamVacations(ctx);
  const today = todayLocal();

  return (
    <div className="stack">
      <PageHead
        title={own ? 'Minhas férias' : `Férias — ${overview?.employee.full_name ?? ''}`}
        subtitle="Períodos aquisitivo e concessivo, fracionamento (até 3 períodos, um com 14 dias ou mais) e abono pecuniário — CLT arts. 129 a 145."
      />

      {overview ? (
        <div className="grid grid-2">
          <div className="card">
            <div className="card-head"><h2>Períodos aquisitivos</h2><p>Admissão em {fmtDate(overview.employee.admission_date)}</p></div>
            <div className="card-body flush table-wrap" tabIndex={0}>
              <table className="table">
                <thead><tr><th>#</th><th>Aquisição</th><th>Gozar até</th><th className="num">Direito</th><th className="num">Gozados</th><th className="num">Abono</th><th className="num">Saldo</th><th>Faltas (art. 130)</th><th>Situação</th></tr></thead>
                <tbody>{overview.periods.map((p) => {
                  const a = overview.absences.get(p.start)!;
                  const rv = overview.reviews.get(p.start);
                  return (
                    <tr key={p.start}>
                      <td>{p.index}</td>
                      <td className="small nowrap">{fmtDate(p.start)} – {fmtDate(p.end)}</td>
                      <td className="small nowrap">{fmtDate(p.concessiveEnd)}</td>
                      <td className="num">{p.entitlement}</td>
                      <td className="num">{p.enjoyed}</td><td className="num">{p.sold}</td><td className="num">{p.remaining}</td>
                      <td className="small">
                        {a.unjustified.length} injustificada(s){a.pending.length ? <span className="neg"> · {a.pending.length} pendente(s)</span> : null}
                        {a.justified.length ? <div className="muted">{a.justified.length} abonada(s)/compensada(s) — não contam</div> : null}
                        {a.partialNotCounted ? <div className="muted">{a.partialNotCounted} atraso(s)/saída(s) — não convertidos em falta</div> : null}
                        {rv ? <div className="pos">Conferido por {rv.reviewer} em {fmtDateTime(rv.reviewed_at)}{rv.art133_loss ? ' — perda (art. 133)' : ''}</div>
                          : p.end < today ? <div className="neg">Conferência pendente</div> : null}
                      </td>
                      <td><span className={statusTone(p.status)}>{label(p.status)}</span></td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
            <div className="card-foot small muted">
              Art. 130: {ART130_BANDS.map((b) => `${b.faixa} → ${b.dias ? `${b.dias} dias` : 'perda'}`).join(' · ')}. Contam somente faltas integrais injustificadas
              confirmadas; atrasos e saídas antecipadas não são convertidos em faltas. A aprovação exige conferência atualizada.
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Solicitar férias</h2><p>Comunicação com 30 dias de antecedência (art. 135)</p></div>
            <div className="card-body">
              <ActionForm action={requestVacationAction} submitLabel="Enviar solicitação" resetOnSuccess>
                {!own ? <input type="hidden" name="employeeId" value={employeeId!} /> : null}
                <div className="form-grid">
                  <div className="field"><label htmlFor="fv-s">Início</label><input id="fv-s" name="start" type="date" className="input" min={addDays(today, 1)} required /></div>
                  <div className="field"><label htmlFor="fv-e">Fim</label><input id="fv-e" name="end" type="date" className="input" min={addDays(today, 1)} required /></div>
                  <div className="field"><label htmlFor="fv-a">Abono pecuniário (dias)</label><input id="fv-a" name="soldDays" type="number" min="0" max="10" defaultValue="0" className="input" /></div>
                </div>
                <div className="field" style={{ marginTop: 10 }}><label htmlFor="fv-n">Observação</label><input id="fv-n" name="notes" className="input" /></div>
                <p className="small muted" style={{ marginTop: 8 }}>Não é permitido iniciar nos dois dias que antecedem feriado ou domingo. O saldo restante não pode ficar abaixo de 5 dias.</p>
              </ActionForm>
            </div>
          </div>
        </div>
      ) : <div className="alert alert-info">Seu usuário não está vinculado a um cadastro funcional.</div>}

      {overview?.canReview ? (
        <div className="card">
          <div className="card-head"><h2>Conferência das faltas do período aquisitivo</h2><p>Registra a faixa do art. 130 e a memória de cálculo · exige reautenticação</p></div>
          <div className="card-body">
            <ActionForm action={reviewPeriodAction} submitLabel="Registrar conferência">
              <input type="hidden" name="employeeId" value={overview.employee.id} />
              <div className="form-grid">
                <div className="field"><label htmlFor="rv-p">Período aquisitivo</label>
                  <select id="rv-p" name="periodStart" className="input">
                    {overview.periods.filter((p) => p.end < today).map((p) => <option key={p.start} value={p.start}>{p.index}: {fmtDate(p.start)} – {fmtDate(p.end)}</option>)}
                  </select>
                </div>
                <div className="field"><label htmlFor="rv-n">Observação</label><input id="rv-n" name="notes" className="input" /></div>
              </div>
              <details className="disclosure small" style={{ marginTop: 10 }}>
                <summary><a>Perda do direito (art. 133) — tratamento manual</a></summary>
                <label className="check"><input type="checkbox" name="art133Loss" /> Registrar perda do direito neste período</label>
                <input name="art133Reason" className="input" placeholder="Fundamento (inciso do art. 133 e fatos)" aria-label="Fundamento" style={{ marginTop: 6 }} />
              </details>
            </ActionForm>
            {[...overview.reviews.values()].map((rv) => (
              <details key={rv.id} className="disclosure small" style={{ marginTop: 10 }}>
                <summary><a>Memória de cálculo — período iniciado em {fmtDate(rv.period_start)}</a></summary>
                <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(rv.calculation, null, 2)}</pre>
              </details>
            ))}
          </div>
        </div>
      ) : null}

      {overview ? (
        <div className="card">
          <div className="card-head"><h2>Solicitações</h2></div>
          <div className="card-body flush table-wrap" tabIndex={0}>
            {overview.requests.length ? (
              <table className="table">
                <thead><tr><th>Pedido em</th><th>Período</th><th>Situação</th><th>Observação</th></tr></thead>
                <tbody>{overview.requests.map((r) => (
                  <tr key={r.id}>
                    <td className="small">{fmtDateTime(r.created_at)}</td>
                    <td className="small">{describePayload('FERIAS', r.payload)}</td>
                    <td><span className={statusTone(r.cancelled ? 'CANCELADA' : r.status)}>{label(r.cancelled ? 'CANCELADA' : r.status)}</span></td>
                    <td className="small">{r.decision_notes ?? ((r.payload.warnings as string[] | undefined)?.filter((w) => !w.includes('art. 130')).join(' ') || '—')}</td>
                  </tr>
                ))}</tbody>
              </table>
            ) : <Empty>Nenhuma solicitação de férias.</Empty>}
          </div>
        </div>
      ) : null}

      {team ? (
        <div className="grid grid-2">
          <div className="card">
            <div className="card-head"><h2>Alertas de vencimento</h2><p>Saldos a gozar perto do fim do período concessivo ou vencidos</p></div>
            <div className="card-body flush table-wrap" tabIndex={0}>
              {team.alerts.length ? (
                <table className="table"><thead><tr><th>Funcionário</th><th>Período</th><th className="num">Saldo</th><th>Gozar até</th><th>Situação</th></tr></thead>
                  <tbody>{team.alerts.map((a) => (
                    <tr key={`${a.employeeId}${a.period}`}><td><Link href={`/ferias?funcionario=${a.employeeId}`}>{a.name}</Link></td><td>{a.period}</td><td className="num">{a.remaining}</td><td>{fmtDate(a.concessiveEnd)}</td><td><span className={statusTone(a.status)}>{label(a.status)}</span></td></tr>
                  ))}</tbody>
                </table>
              ) : <Empty>Nenhum período a vencer.</Empty>}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Programação de férias</h2></div>
            <div className="card-body flush table-wrap" tabIndex={0}>
              {team.scheduled.length ? (
                <table className="table"><thead><tr><th>Funcionário</th><th>Período</th><th className="num">Dias</th>{team.canApprove ? <th></th> : null}</tr></thead>
                  <tbody>{team.scheduled.map((s) => (
                    <tr key={s.request_id}>
                      <td>{s.full_name}</td><td className="nowrap small">{fmtDate(s.start_date)} – {fmtDate(s.end_date)}</td><td className="num">{s.enjoyed_days}{s.sold_days ? ` + ${s.sold_days} abono` : ''}</td>
                      {team.canApprove ? <td>{s.start_date > today ? (
                        <details className="disclosure small"><summary><a>Cancelar</a></summary>
                          <ActionForm action={cancelVacationAction} submitLabel="Confirmar cancelamento" submitClass="btn btn-sm btn-danger">
                            <input type="hidden" name="requestId" value={s.request_id} />
                            <input name="reason" className="input" placeholder="Motivo" aria-label="Motivo" required minLength={5} />
                          </ActionForm>
                        </details>
                      ) : null}</td> : null}
                    </tr>
                  ))}</tbody>
                </table>
              ) : <Empty>Nenhuma férias programada.</Empty>}
            </div>
            <div className="card-foot small">Aprovações em <Link href="/solicitacoes?aba=aprovar">Solicitações → Para decidir</Link>.</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default withGuard(FeriasPage);
