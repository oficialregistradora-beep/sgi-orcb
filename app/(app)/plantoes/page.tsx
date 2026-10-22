import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can, scopeFilter } from '@/server/authz.ts';
import { ForbiddenError } from '@/server/errors.ts';
import { eligibleParticipants, getShift, listShifts, oncallReport } from '@/server/modules/oncall.ts';
import { addMonths, todayLocal, WEEKDAY_NAMES, weekdayOf } from '@/domain/time.ts';
import { fmtDate, fmtDateTime, fmtMin, fmtMoney, fmtTime, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { MonthPicker } from '@/ui/MonthPicker.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import {
  assignShiftAction, cancelShiftAction, closeShiftAction, generateScheduleAction, registerCallAction, voidCallAction,
} from '../../actions/phase2b.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Plantões RCPN' };

export default async function PlantoesPage({ searchParams }: { searchParams: Promise<{ mes?: string; plantao?: string }> }) {
  const ctx = await requirePageCtx();
  if (!scopeFilter(ctx.principal, 'plantoes.ver')) throw new ForbiddenError();
  const sp = await searchParams;
  const today = todayLocal();
  const period = sp.mes && /^\d{4}-\d{2}$/.test(sp.mes) ? sp.mes : today.slice(0, 7);
  const shifts = await listShifts(ctx, period);
  const detail = sp.plantao ? await getShift(ctx, sp.plantao) : null;
  const canManage = can(ctx.principal, 'plantoes.gerenciar');
  const participants = canManage ? await eligibleParticipants(ctx) : [];
  const canClose = can(ctx.principal, 'plantoes.fechar');
  const report = canClose ? await oncallReport(ctx, period) : [];
  const nextMonth = addMonths(`${today.slice(0, 7)}-01`, 1).slice(0, 7);

  return (
    <div className="stack">
      <PageHead
        title="Plantões — Registro Civil das Pessoas Naturais"
        subtitle="Sábados, domingos e feriados. Sobreaviso, trabalho efetivo e banco de horas são apurados separadamente."
        actions={<MonthPicker period={period} base="/plantoes" />}
      />

      {detail ? (
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Plantão de {fmtDate(detail.shift.shift_date)} ({WEEKDAY_NAMES[weekdayOf(detail.shift.shift_date)]})</h2>
              <p>{fmtTime(detail.shift.starts_at)}–{fmtTime(detail.shift.ends_at)} · responsável {detail.shift.employee_name}{detail.shift.substitute_name ? ` · substituto ${detail.shift.substitute_name}` : ''}</p>
            </div>
            <span className={statusTone(detail.shift.status)}>{label(detail.shift.status)}</span>
          </div>
          <div className="card-body stack">
            {detail.warnings.map((w) => <div key={w} className="alert alert-warn small">{w}</div>)}
            <div className="grid grid-3">
              <div><div className="stat-label">Sobreaviso</div><div className="stat-value">{fmtMin(detail.shift.status === 'REALIZADO' ? detail.shift.standby_minutes! : detail.totals.standbyMinutes)}</div></div>
              <div><div className="stat-label">Trabalho efetivo</div><div className="stat-value">{fmtMin(detail.shift.status === 'REALIZADO' ? detail.shift.effective_minutes! : detail.totals.effectiveMinutes)}</div></div>
              <div><div className="stat-label">Destino do efetivo</div><div className="stat-value" style={{ fontSize: 18 }}>{detail.shift.effective_destination ? label(detail.shift.effective_destination === 'BANCO' ? 'BANCO' : 'PAGAMENTO') : '—'}</div></div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Chamado</th><th>Resposta</th><th>Comparecimento</th><th>Descrição</th><th>Registrado por</th><th></th></tr></thead>
                <tbody>
                  {detail.calls.length ? detail.calls.map((c) => (
                    <tr key={c.id} className={c.voided_at ? 'row-muted' : undefined}>
                      <td>{fmtTime(c.called_at)}</td>
                      <td>{c.responded_at ? fmtTime(c.responded_at) : '—'}</td>
                      <td>{c.attended ? `${fmtTime(c.arrival_at!)}–${fmtTime(c.departure_at!)}` : 'Não'}</td>
                      <td className="small">{c.description}{c.voided_at ? <div className="neg">Anulado: {c.void_reason}</div> : null}</td>
                      <td className="small muted">{c.registered_by_name}</td>
                      <td>{!c.voided_at && detail.shift.status === 'PLANEJADO' ? (
                        <ActionForm action={voidCallAction} submitLabel="Anular" submitClass="btn btn-sm btn-ghost" inline>
                          <input type="hidden" name="callId" value={c.id} />
                          <input name="reason" className="input" placeholder="Motivo" aria-label="Motivo" required minLength={5} />
                        </ActionForm>
                      ) : null}</td>
                    </tr>
                  )) : <tr><td colSpan={6} className="muted">Nenhum chamado registrado.</td></tr>}
                </tbody>
              </table>
            </div>
            {detail.shift.status === 'PLANEJADO' ? (
              <div className="grid grid-2">
                <div className="card"><div className="card-head"><h3>Registrar chamado</h3><p>Descreva o serviço, sem dados pessoais dos usuários</p></div><div className="card-body">
                  <ActionForm action={registerCallAction} submitLabel="Registrar" resetOnSuccess>
                    <input type="hidden" name="shiftId" value={detail.shift.id} />
                    <div className="form-grid">
                      <div className="field"><label htmlFor="cl-c">Chamado às</label><input id="cl-c" name="calledAt" type="time" className="input" required /></div>
                      <div className="field"><label htmlFor="cl-r">Respondido às</label><input id="cl-r" name="respondedAt" type="time" className="input" /></div>
                      <div className="field"><label htmlFor="cl-a">Chegada</label><input id="cl-a" name="arrivalAt" type="time" className="input" /></div>
                      <div className="field"><label htmlFor="cl-d">Saída</label><input id="cl-d" name="departureAt" type="time" className="input" /></div>
                    </div>
                    <label className="check" style={{ marginTop: 10 }}><input type="checkbox" name="attended" /> Houve comparecimento à serventia</label>
                    <div className="field" style={{ marginTop: 10 }}><label htmlFor="cl-x">Descrição</label><input id="cl-x" name="description" className="input" placeholder="Ex.: registro de óbito" required minLength={3} /></div>
                  </ActionForm>
                </div></div>
                {canClose && detail.shift.ends_at.getTime() < Date.now() ? (
                  <div className="card"><div className="card-head"><h3>Fechar plantão</h3><p>Congela os totais; não é permitido fechar o próprio plantão</p></div><div className="card-body">
                    <ActionForm action={closeShiftAction} submitLabel="Fechar plantão" confirm="Fechar o plantão? Os registros não poderão mais ser alterados.">
                      <input type="hidden" name="shiftId" value={detail.shift.id} />
                      <div className="field"><label htmlFor="cs-d">Destino do trabalho efetivo ({fmtMin(detail.totals.effectiveMinutes)})</label>
                        <select id="cs-d" name="destination" className="input"><option value="">Sem trabalho efetivo</option><option value="BANCO">Banco de horas</option><option value="PAGAMENTO">Pagamento</option></select>
                      </div>
                      <div className="field" style={{ marginTop: 10 }}><label htmlFor="cs-n">Observação</label><input id="cs-n" name="notes" className="input" /></div>
                    </ActionForm>
                  </div></div>
                ) : null}
              </div>
            ) : <p className="small muted">Fechado por {detail.shift.closed_by_name} em {fmtDateTime(detail.shift.closed_at)}.</p>}
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="card-head"><h2>Escala da competência</h2><p>{shifts.length} plantão(ões) visível(is)</p></div>
        <div className="card-body flush table-wrap">
          {shifts.length ? (
            <table className="table">
              <thead><tr><th>Data</th><th>Responsável</th><th>Substituto</th><th className="num">Chamados</th><th>Situação</th>{canManage ? <th className="no-print">Substituição</th> : null}</tr></thead>
              <tbody>{shifts.map((s) => (
                <tr key={s.id}>
                  <td className="nowrap"><Link href={`/plantoes?mes=${period}&plantao=${s.id}`}>{fmtDate(s.shift_date)}</Link> <span className="muted small">{WEEKDAY_NAMES[weekdayOf(s.shift_date)]!.slice(0, 3)}</span></td>
                  <td>{s.employee_name}</td>
                  <td className="small">{s.substitute_name ?? '—'}</td>
                  <td className="num">{s.calls}</td>
                  <td><span className={statusTone(s.status)}>{label(s.status)}</span></td>
                  {canManage ? (
                    <td style={{ minWidth: 260 }}>{s.status === 'PLANEJADO' && s.shift_date > today ? (
                      <details className="disclosure small"><summary><a>Alterar</a></summary>
                        <ActionForm action={assignShiftAction} submitLabel="Salvar" submitClass="btn btn-sm btn-primary">
                          <input type="hidden" name="shiftId" value={s.id} />
                          <select name="employeeId" className="input" defaultValue={s.employee_id} aria-label="Responsável">{participants.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select>
                          <select name="substituteId" className="input" defaultValue={s.substitute_employee_id ?? ''} aria-label="Substituto" style={{ marginTop: 6 }}><option value="">Sem substituto</option>{participants.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select>
                          <input name="reason" className="input" placeholder="Motivo (férias, troca…)" aria-label="Motivo" required minLength={5} style={{ marginTop: 6 }} />
                        </ActionForm>
                        {s.calls === 0 ? (
                          <ActionForm action={cancelShiftAction} submitLabel="Cancelar plantão" submitClass="btn btn-sm btn-danger" confirm="Cancelar este plantão?">
                            <input type="hidden" name="shiftId" value={s.id} />
                            <input name="reason" className="input" placeholder="Motivo" aria-label="Motivo do cancelamento" required minLength={5} style={{ marginTop: 6 }} />
                          </ActionForm>
                        ) : null}
                      </details>
                    ) : null}</td>
                  ) : null}
                </tr>
              ))}</tbody>
            </table>
          ) : <Empty>Nenhum plantão nesta competência.</Empty>}
        </div>
      </div>

      {canManage ? (
        <div className="grid grid-2">
          <div className="card">
            <div className="card-head"><h2>Gerar escala em rodízio</h2><p>Pula férias e afastamentos; não sobrescreve plantões existentes</p></div>
            <div className="card-body">
              <ActionForm action={generateScheduleAction} submitLabel="Gerar escala">
                <div className="field"><label htmlFor="gs-p">Competência</label><input id="gs-p" name="period" type="month" className="input" defaultValue={nextMonth} required /></div>
                <fieldset className="stack" style={{ gap: 4, marginTop: 10 }}>
                  <legend className="label">Participantes (ordem do rodízio)</legend>
                  {participants.map((p) => (
                    <label key={p.id} className="check"><input type="checkbox" name="participants" value={p.id} defaultChecked={p.sector_code === 'RCPN'} /> {p.full_name}</label>
                  ))}
                </fieldset>
              </ActionForm>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Plantão avulso</h2></div>
            <div className="card-body">
              <ActionForm action={assignShiftAction} submitLabel="Criar plantão" resetOnSuccess>
                <div className="form-grid">
                  <div className="field"><label htmlFor="pa-d">Data</label><input id="pa-d" name="date" type="date" className="input" min={today} required /></div>
                  <div className="field"><label htmlFor="pa-e">Responsável</label><select id="pa-e" name="employeeId" className="input">{participants.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></div>
                  <div className="field"><label htmlFor="pa-s">Substituto</label><select id="pa-s" name="substituteId" className="input"><option value="">—</option>{participants.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></div>
                </div>
                <div className="field" style={{ marginTop: 10 }}><label htmlFor="pa-r">Motivo</label><input id="pa-r" name="reason" className="input" placeholder="Ex.: ponto facultativo municipal" required minLength={5} /></div>
              </ActionForm>
            </div>
          </div>
        </div>
      ) : null}

      {canClose ? (
        <div className="card">
          <div className="card-head"><h2>Relatório da competência (plantões fechados)</h2><p>Valores estimados e informativos — dependentes de CCT e validação jurídica (J-07)</p></div>
          <div className="card-body flush table-wrap">
            {report.length ? (
              <table className="table">
                <thead><tr><th>Funcionário</th><th className="num">Plantões</th><th className="num">Sobreaviso</th><th className="num">Efetivo → banco</th><th className="num">Efetivo → pagamento</th><th className="num">Valor sobreaviso*</th><th className="num">Valor efetivo pago*</th></tr></thead>
                <tbody>{report.map((r) => (
                  <tr key={r.employee_id}>
                    <td>{r.full_name}</td><td className="num">{r.shifts}</td><td className="num">{fmtMin(r.standby_minutes)}</td>
                    <td className="num">{fmtMin(r.effective_bank)}</td><td className="num">{fmtMin(r.effective_paid)}</td>
                    <td className="num">{r.standby_value ? fmtMoney(r.standby_value) : '—'}</td><td className="num">{r.effective_paid_value ? fmtMoney(r.effective_paid_value) : '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            ) : <Empty>Nenhum plantão fechado na competência.</Empty>}
          </div>
          <div className="card-foot small muted">* Visível apenas com permissão de custos. Gratificações eventualmente pagas não compensam o sobreaviso automaticamente.</div>
        </div>
      ) : null}
    </div>
  );
}
