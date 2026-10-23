import { requirePageCtx } from '@/server/web/session.ts';
import { getPool } from '@/server/db.ts';
import { can } from '@/server/authz.ts';
import { computeRange, ensureProcessed, getTodayStatus } from '@/server/modules/timeclock.ts';
import { getEmployeeFor } from '@/server/modules/people.ts';
import { ALERT_LABELS } from '@/domain/journey.ts';
import { monthRange, todayLocal, WEEKDAY_NAMES, weekdayOf } from '@/domain/time.ts';
import { fmtDate, fmtMin, fmtTime, label } from '@/ui/format.ts';
import { PageHead } from '@/ui/Stat.tsx';
import { Clock } from '@/ui/Clock.tsx';
import { MonthPicker } from '@/ui/MonthPicker.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { correctionAction, extraAuthorizationAction, punchAction } from '../../actions/journey.ts';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Jornada' };

async function JornadaPage({ searchParams }: { searchParams: Promise<{ mes?: string; funcionario?: string }> }) {
  const ctx = await requirePageCtx();
  const sp = await searchParams;
  const today = todayLocal();
  const period = sp.mes && /^\d{4}-\d{2}$/.test(sp.mes) ? sp.mes : today.slice(0, 7);
  const employeeId = sp.funcionario ?? ctx.principal.employeeId;
  if (!employeeId) return <div className="alert alert-info">Seu usuário não está vinculado a um cadastro funcional.</div>;
  const e = await getEmployeeFor(ctx, 'jornada.ver', employeeId);
  const own = employeeId === ctx.principal.employeeId;
  await ensureProcessed(employeeId);
  const { from, to } = monthRange(period);
  const end = to > today ? today : to;
  const days = from <= end ? await computeRange(getPool(), employeeId, from, end) : [];
  const shown = days.filter((d) => d.inEmployment).reverse();
  const totals = shown.reduce((a, d) => ({ exp: a.exp + d.result.expected, wk: a.wk + d.result.worked, diff: a.diff + (d.date < today ? d.result.diff : 0) }), { exp: 0, wk: 0, diff: 0 });
  const status = own ? await getTodayStatus(ctx) : null;
  const monthPunches = shown.flatMap((d) => d.punches.filter((p) => !p.annulled).map((p) => ({ id: p.id, date: d.date, t: fmtTime(p.punched_at) })));
  const canRequest = can(ctx.principal, 'solicitacoes.criar', { employeeId, sectorId: e.sector_id });

  return (
    <div className="stack">
      <PageHead
        title={own ? 'Minha jornada' : `Jornada — ${e.full_name}`}
        subtitle="Controle administrativo interno de frequência (não constitui REP — Portaria MTP nº 671/2021)."
        actions={<MonthPicker period={period} base="/jornada" extra={{ funcionario: own ? undefined : employeeId }} />}
      />

      {status ? (
        <div className="grid grid-2">
          <div className="card">
            <div className="card-body row-between">
              <Clock />
              <ActionForm action={punchAction} submitLabel={`Registrar ${label(status.nextKind).toLowerCase()}`} submitClass="btn btn-primary btn-lg" inline>{null}</ActionForm>
            </div>
            <div className="card-foot small muted">O horário registrado é o do servidor da serventia, não o do seu computador.</div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Hoje</h2><p>{fmtDate(status.today)} · {status.day.scheduleName ?? 'sem jornada atribuída'}</p></div>
            <div className="card-body stack">
              <div className="punch-list">
                {status.day.punches.length ? status.day.punches.map((p, i) => (
                  <div key={p.id} className={`punch ${p.annulled ? 'annulled' : ''}`}>
                    <div className="k">{label(['ENTRADA', 'SAIDA_INTERVALO', 'RETORNO_INTERVALO', 'SAIDA'][i] ?? 'ADICIONAL')}</div>
                    <div className="t">{fmtTime(p.punched_at)}</div>
                  </div>
                )) : <span className="muted small">Nenhuma marcação hoje.</span>}
              </div>
              <div className="small">Trabalhado até agora: <strong>{fmtMin(status.day.result.worked)}</strong> de {fmtMin(status.day.result.expected)} previstos.</div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="card-head">
          <h2>Espelho da competência</h2>
          <p>Previsto {fmtMin(totals.exp)} · Trabalhado {fmtMin(totals.wk)} · Diferença apurada {fmtMin(totals.diff, true)}</p>
        </div>
        <div className="card-body flush table-wrap" tabIndex={0}>
          <table className="table">
            <thead>
              <tr><th>Data</th><th>Situação</th><th>Marcações</th><th className="num">Previsto</th><th className="num">Trabalhado</th><th className="num">Diferença</th><th>Alertas</th></tr>
            </thead>
            <tbody>
              {shown.map((d) => {
                const r = d.result;
                const off = r.kind !== 'UTIL';
                return (
                  <tr key={d.date} className={off && !d.punches.length ? 'row-muted' : undefined}>
                    <td className="nowrap">{fmtDate(d.date)} <span className="muted small">{WEEKDAY_NAMES[weekdayOf(d.date)]!.slice(0, 3)}</span></td>
                    <td className="small">{d.holidayName ? `Feriado: ${d.holidayName}` : d.absenceType ? label(d.absenceType) : label(r.kind)}</td>
                    <td className="small">
                      {d.punches.map((p) => (
                        <span key={p.id} className={p.annulled ? 'muted' : undefined} title={p.annulled ? `Desconsiderada: ${p.annul_reason ?? ''}` : label(p.source)} style={{ marginRight: 8, textDecoration: p.annulled ? 'line-through' : undefined }}>
                          {fmtTime(p.punched_at)}{p.source !== 'WEB' ? '*' : ''}
                        </span>
                      ))}
                    </td>
                    <td className="num">{r.expected ? fmtMin(r.expected) : '—'}</td>
                    <td className="num">{r.worked ? fmtMin(r.worked) : '—'}</td>
                    <td className={`num ${r.diff > 0 ? 'pos' : r.diff < 0 ? 'neg' : ''}`}>
                      {d.date === today ? <span className="muted small">em curso</span> : r.diff ? fmtMin(r.diff, true) : '—'}
                      {r.toleranceApplied ? <span className="muted small" title="Variação dentro da tolerância do art. 58, §1º, da CLT"> (tol.)</span> : null}
                    </td>
                    <td className="small">{r.alerts.filter((a) => !(d.date === today && a === 'MARCACAO_INCOMPLETA')).map((a) => <div key={a} className="neg">{ALERT_LABELS[a]}</div>)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="card-foot small muted">* marcação incluída por correção aprovada ou importação. Marcações riscadas foram desconsideradas por decisão registrada; o registro original é preservado.</div>
      </div>

      {canRequest ? (
        <div className="grid grid-3">
          <div className="card">
            <div className="card-head"><h2>Incluir marcação esquecida</h2></div>
            <div className="card-body">
              <ActionForm action={correctionAction} submitLabel="Solicitar inclusão" resetOnSuccess>
                <input type="hidden" name="action" value="INCLUIR" />
                {!own ? <input type="hidden" name="employeeId" value={employeeId} /> : null}
                <div className="form-grid">
                  <div className="field"><label htmlFor="c-date">Data</label><input id="c-date" name="date" type="date" className="input" max={today} required /></div>
                  <div className="field"><label htmlFor="c-time">Horário</label><input id="c-time" name="time" type="time" className="input" required /></div>
                </div>
                <div className="field" style={{ marginTop: 12 }}><label htmlFor="c-just">Justificativa</label><textarea id="c-just" name="justification" className="input" required minLength={5} /></div>
              </ActionForm>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Desconsiderar marcação indevida</h2></div>
            <div className="card-body">
              <ActionForm action={correctionAction} submitLabel="Solicitar desconsideração" resetOnSuccess>
                <input type="hidden" name="action" value="DESCONSIDERAR" />
                {!own ? <input type="hidden" name="employeeId" value={employeeId} /> : null}
                <div className="field">
                  <label htmlFor="d-punch">Marcação</label>
                  <select id="d-punch" name="punchId" className="input" required>
                    <option value="">Selecione…</option>
                    {monthPunches.map((p) => <option key={p.id} value={`${p.id}|${p.date}`}>{fmtDate(p.date)} às {p.t}</option>)}
                  </select>
                </div>
                <div className="field" style={{ marginTop: 12 }}><label htmlFor="d-just">Justificativa</label><textarea id="d-just" name="justification" className="input" required minLength={5} /></div>
              </ActionForm>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Autorização prévia de hora extra</h2></div>
            <div className="card-body">
              <ActionForm action={extraAuthorizationAction} submitLabel="Solicitar autorização" resetOnSuccess>
                {!own ? <input type="hidden" name="employeeId" value={employeeId} /> : null}
                <div className="form-grid">
                  <div className="field"><label htmlFor="x-date">Data</label><input id="x-date" name="date" type="date" className="input" min={today} required /></div>
                  <div className="field"><label htmlFor="x-dur">Duração (HH:MM)</label><input id="x-dur" name="duration" className="input" placeholder="01:00" pattern="\d{1,3}:[0-5]\d" required /></div>
                  <div className="field"><label htmlFor="x-dest">Destino</label>
                    <select id="x-dest" name="destination" className="input"><option value="BANCO">Banco de horas</option><option value="PAGAMENTO">Pagamento</option></select>
                  </div>
                </div>
                <div className="field" style={{ marginTop: 12 }}><label htmlFor="x-just">Motivo</label><textarea id="x-just" name="justification" className="input" required minLength={5} /></div>
              </ActionForm>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default withGuard(JornadaPage);
