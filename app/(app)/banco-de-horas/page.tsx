import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { getBankOverview, listOccurrences } from '@/server/modules/hourbank.ts';
import { getEmployeeFor } from '@/server/modules/people.ts';
import { todayLocal } from '@/domain/time.ts';
import { fmtDate, fmtDateTime, fmtMin, fmtMoney, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead, Stat } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { compensationAction, justifyAction } from '../../actions/journey.ts';
import { paymentAction } from '../../actions/bank.ts';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Banco de horas' };

async function BancoPage({ searchParams }: { searchParams: Promise<{ funcionario?: string }> }) {
  const ctx = await requirePageCtx();
  const sp = await searchParams;
  const employeeId = sp.funcionario ?? ctx.principal.employeeId;
  if (!employeeId) return <div className="alert alert-info">Seu usuário não está vinculado a um cadastro funcional.</div>;
  const e = await getEmployeeFor(ctx, 'banco.ver', employeeId);
  const own = employeeId === ctx.principal.employeeId;
  const ov = await getBankOverview(ctx, employeeId);
  const occurrences = await listOccurrences(ctx, { employeeId });
  const s = ov.summary;
  const today = todayLocal();
  const canPay = can(ctx.principal, 'banco.pagamentos.registrar', { employeeId, sectorId: e.sector_id });
  const canRequest = can(ctx.principal, 'solicitacoes.criar', { employeeId, sectorId: e.sector_id });

  return (
    <div className="stack">
      <PageHead
        title={own ? 'Meu banco de horas' : `Banco de horas — ${e.full_name}`}
        subtitle={ov.agreement
          ? `${label(ov.agreement.kind)} · compensação em até ${ov.agreement.compensation_months} meses · vigente desde ${fmtDate(ov.agreement.valid_from)}`
          : 'Sem acordo de banco de horas vigente: horas extras são destinadas a pagamento.'}
      />
      <div className="grid grid-4">
        <Stat label="Saldo" value={fmtMin(s.balance, true)} tone={s.balance < 0 ? 'neg' : undefined} hint={s.balance >= ov.highBalanceThreshold ? 'Saldo elevado — planeje compensações' : undefined} />
        <Stat label="Disponível para compensar" value={fmtMin(s.available)} />
        <Stat label={`A vencer em ${ov.alertDays} dias`} value={fmtMin(s.expiringSoon)} tone={s.expiringSoon ? 'warn' : undefined} />
        <Stat label="Vencido (requer pagamento/análise)" value={fmtMin(s.expired)} tone={s.expired ? 'neg' : undefined} />
      </div>
      {ov.cost ? (
        <div className="alert alert-info small">
          Custo estimado (informativo): disponível {fmtMoney(ov.cost.available)} · vencido {fmtMoney(ov.cost.expired)}. {ov.cost.basis}. Parâmetros dependentes de validação jurídica.
        </div>
      ) : null}

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head"><h2>Créditos por vencimento</h2><p>Consumo na ordem do vencimento (PEPS)</p></div>
          <div className="card-body flush table-wrap" tabIndex={0}>
            {ov.lots.length ? (
              <table className="table">
                <thead><tr><th>Origem</th><th>Vence em</th><th className="num">Crédito</th><th className="num">Utilizado</th><th className="num">Restante</th><th>Situação</th></tr></thead>
                <tbody>
                  {ov.lots.map((l) => (
                    <tr key={l.id}>
                      <td>{fmtDate(l.entryDate)}</td><td>{fmtDate(l.expiresOn)}</td>
                      <td className="num">{fmtMin(l.minutes)}</td><td className="num">{fmtMin(l.consumed)}</td><td className="num">{fmtMin(l.remaining)}</td>
                      <td><span className={statusTone(l.status)}>{label(l.status)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty>Nenhum crédito registrado.</Empty>}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Ocorrências</h2><p>Horas extras e diferenças aguardam análise — nada é descontado automaticamente</p></div>
          <div className="card-body flush table-wrap" tabIndex={0}>
            {occurrences.length ? (
              <table className="table">
                <thead><tr><th>Data</th><th>Tipo</th><th className="num">Minutos</th><th>Situação</th></tr></thead>
                <tbody>
                  {occurrences.slice(0, 40).map((o) => (
                    <tr key={o.id}>
                      <td className="nowrap">{fmtDate(o.work_date)}</td>
                      <td>
                        {label(o.type)}
                        {o.employee_justification ? <div className="small muted">Justificativa: {o.employee_justification}</div> : null}
                        {own && o.status === 'PENDENTE' && !o.employee_justification ? (
                          <details className="disclosure small">
                            <summary><a>Justificar</a></summary>
                            <ActionForm action={justifyAction} submitLabel="Enviar justificativa" submitClass="btn btn-sm">
                              <input type="hidden" name="occurrenceId" value={o.id} />
                              <textarea name="text" className="input" required minLength={5} aria-label="Justificativa" />
                            </ActionForm>
                          </details>
                        ) : null}
                      </td>
                      <td className="num">{o.minutes ? fmtMin(o.minutes) : '—'}</td>
                      <td><span className={statusTone(o.status)}>{label(o.status)}</span>{o.resolution ? <div className="small muted">{label(o.resolution)}</div> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty>Nenhuma ocorrência.</Empty>}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Extrato de lançamentos</h2><p>Lançamentos são imutáveis; correções aparecem como estorno</p></div>
        <div className="card-body flush table-wrap" tabIndex={0}>
          {ov.lines.length ? (
            <table className="table">
              <thead><tr><th>Competência</th><th>Tipo</th><th className="num">Minutos</th><th>Vencimento</th><th>Observação</th><th>Registrado em</th></tr></thead>
              <tbody>
                {ov.lines.map((l) => (
                  <tr key={l.id} className={l.reversed ? 'row-muted' : undefined}>
                    <td className="nowrap">{fmtDate(l.entry_date)}</td>
                    <td>{label(l.kind)}{l.reversed ? <span className="tag" style={{ marginLeft: 6 }}>estornado</span> : null}</td>
                    <td className={`num ${l.minutes < 0 ? 'neg' : 'pos'}`}>{fmtMin(l.minutes, true)}</td>
                    <td>{l.expires_on ? fmtDate(l.expires_on) : '—'}</td>
                    <td className="small">{l.notes}</td>
                    <td className="small muted nowrap">{fmtDateTime(l.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>Sem lançamentos.</Empty>}
        </div>
      </div>

      <div className="grid grid-2">
        {canRequest && ov.agreement ? (
          <div className="card">
            <div className="card-head"><h2>Solicitar compensação</h2><p>Disponível: {fmtMin(s.available)}</p></div>
            <div className="card-body">
              <ActionForm action={compensationAction} submitLabel="Enviar solicitação" resetOnSuccess>
                {!own ? <input type="hidden" name="employeeId" value={employeeId} /> : null}
                <div className="form-grid">
                  <div className="field"><label htmlFor="cp-date">Data</label><input id="cp-date" type="date" name="date" min={today} className="input" required /></div>
                  <div className="field"><label htmlFor="cp-mode">Modalidade</label>
                    <select id="cp-mode" name="mode" className="input">
                      {['FOLGA_INTEGRAL', 'COMPENSACAO_PARCIAL', 'ENTRADA_POSTERIOR', 'SAIDA_ANTECIPADA'].map((m) => <option key={m} value={m}>{label(m)}</option>)}
                    </select>
                  </div>
                  <div className="field"><label htmlFor="cp-dur">Duração (HH:MM)</label><input id="cp-dur" name="duration" className="input" placeholder="02:00" pattern="\d{1,3}:[0-5]\d" /><span className="hint">Dispensada na folga integral.</span></div>
                </div>
                <div className="field" style={{ marginTop: 12 }}><label htmlFor="cp-just">Justificativa</label><textarea id="cp-just" name="justification" className="input" required minLength={5} /></div>
              </ActionForm>
            </div>
          </div>
        ) : null}
        {canPay ? (
          <div className="card">
            <div className="card-head"><h2>Registrar pagamento em folha</h2><p>Consome créditos PEPS; exige reautenticação</p></div>
            <div className="card-body">
              <ActionForm action={paymentAction} submitLabel="Registrar pagamento" confirm="Confirma o registro do pagamento destas horas?" resetOnSuccess>
                <input type="hidden" name="employeeId" value={employeeId} />
                <div className="form-grid">
                  <div className="field"><label htmlFor="pg-dur">Horas (HH:MM)</label><input id="pg-dur" name="duration" className="input" pattern="\d{1,3}:[0-5]\d" required /></div>
                  <div className="field"><label htmlFor="pg-ref">Referência</label><input id="pg-ref" name="reference" className="input" placeholder="Folha 10/2026" required /></div>
                </div>
                <label className="check" style={{ marginTop: 12 }}><input type="checkbox" name="onlyExpired" defaultChecked /> Somente créditos vencidos (CLT, art. 59, §3º)</label>
              </ActionForm>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default withGuard(BancoPage);
