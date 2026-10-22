import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { getPool } from '@/server/db.ts';
import { can } from '@/server/authz.ts';
import { listJobTitles, listSchedules, listSectors } from '@/server/modules/admin.ts';
import {
  getEmployeeFor, getEmployeeSchedules, getJobHistory, getSensitiveData, listAbsences, listAgreements, listSalaryHistory,
} from '@/server/modules/people.ts';
import { todayLocal } from '@/domain/time.ts';
import { fmtDate, fmtDateTime, fmtMoney, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import {
  absenceAction, agreementAction, assignScheduleAction, cancelAbsenceAction, revokeAgreementAction, salaryAction, sensitiveAction,
  terminateAction, updateEmployeeAction,
} from '../../../actions/people.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Funcionário' };

const ABSENCE_TYPES = ['FERIAS', 'ATESTADO_MEDICO', 'LICENCA_MATERNIDADE', 'LICENCA_PATERNIDADE', 'LICENCA_OUTRA', 'FALTA_JUSTIFICADA', 'AFASTAMENTO_INSS', 'OUTRO'];

export default async function FuncionarioPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sensiveis?: string; salario?: string }> }) {
  const ctx = await requirePageCtx();
  const { id } = await params;
  const sp = await searchParams;
  const e = await getEmployeeFor(ctx, 'pessoas.ver', id);
  const res = { employeeId: e.id, sectorId: e.sector_id };
  const p = ctx.principal;
  const db = getPool();
  const active = e.status !== 'DESLIGADO';
  const [history, schedules, agreements, absences] = await Promise.all([getJobHistory(ctx, id), getEmployeeSchedules(db, id), listAgreements(db, id), listAbsences(db, id)]);
  const canEdit = can(p, 'pessoas.editar', res) && active;
  const [sectors, jobs, allSchedules] = canEdit || can(p, 'jornada.escalas.gerenciar', res) ? await Promise.all([listSectors(), listJobTitles(), listSchedules()]) : [[], [], []];
  // Dados sensíveis e salário só são carregados mediante ação explícita (cada consulta é auditada).
  const sensitive = sp.sensiveis === '1' && can(p, 'pessoas.sensiveis.ver', res) ? await getSensitiveData(ctx, id) : null;
  const salaries = sp.salario === '1' && can(p, 'pessoas.salario.ver', res) ? await listSalaryHistory(ctx, id) : null;
  const today = todayLocal();

  return (
    <div className="stack">
      <PageHead
        title={e.social_name || e.full_name}
        subtitle={<>{e.job_title} · {e.sector_name} · matrícula <span className="mono">{e.registration_code}</span> · admissão {fmtDate(e.admission_date)}{e.termination_date ? ` · desligamento ${fmtDate(e.termination_date)}` : ''}</>}
        actions={<>
          <span className={statusTone(e.status)}>{label(e.status)}</span>
          {can(p, 'jornada.ver', res) ? <Link className="btn btn-sm" href={`/jornada?funcionario=${id}`}>Jornada</Link> : null}
          {can(p, 'banco.ver', res) ? <Link className="btn btn-sm" href={`/banco-de-horas?funcionario=${id}`}>Banco de horas</Link> : null}
        </>}
      />

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head"><h2>Dados funcionais</h2></div>
          <div className="card-body">
            {canEdit ? (
              <ActionForm action={updateEmployeeAction} submitLabel="Salvar alterações">
                <input type="hidden" name="employeeId" value={id} />
                <div className="form-grid">
                  <div className="field"><label htmlFor="u-fn">Nome completo</label><input id="u-fn" name="fullName" className="input" defaultValue={e.full_name} required /></div>
                  <div className="field"><label htmlFor="u-sn">Nome social</label><input id="u-sn" name="socialName" className="input" defaultValue={e.social_name ?? ''} /></div>
                  <div className="field"><label htmlFor="u-jt">Cargo</label><select id="u-jt" name="jobTitleId" className="input" defaultValue={e.job_title_id}>{jobs.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}</select></div>
                  <div className="field"><label htmlFor="u-fd">Função</label><input id="u-fd" name="functionDescription" className="input" defaultValue={e.function_description ?? ''} /></div>
                  <div className="field"><label htmlFor="u-se">Setor</label><select id="u-se" name="sectorId" className="input" defaultValue={e.sector_id}>{sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
                  <div className="field"><label htmlFor="u-ct">Contrato</label><select id="u-ct" name="contractType" className="input" defaultValue={e.contract_type}>{['CLT', 'ESTAGIO', 'APRENDIZ', 'TEMPORARIO', 'OUTRO'].map((c) => <option key={c}>{c}</option>)}</select></div>
                  <div className="field"><label htmlFor="u-wh">Horas semanais</label><input id="u-wh" name="weeklyHours" type="number" step="0.5" className="input" defaultValue={e.weekly_hours} /></div>
                  <div className="field"><label htmlFor="u-cd">Vigência da mudança de cargo/setor</label><input id="u-cd" name="changeDate" type="date" className="input" defaultValue={today} /></div>
                  <div className="field"><label htmlFor="u-cr">Motivo</label><input id="u-cr" name="changeReason" className="input" placeholder="Promoção, transferência…" /></div>
                </div>
              </ActionForm>
            ) : (
              <dl className="small">
                <div>Contrato: {e.contract_type} · {e.weekly_hours} h semanais</div>
                <div>Função: {e.function_description ?? '—'}</div>
                <div>Acesso: {e.email ?? 'sem usuário'} {e.user_status ? `(${label(e.user_status)})` : ''}</div>
              </dl>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Histórico de cargos e setores</h2></div>
          <div className="card-body flush table-wrap">
            {history.length ? (
              <table className="table"><thead><tr><th>Desde</th><th>Cargo</th><th>Setor</th><th>Motivo</th></tr></thead>
                <tbody>{history.map((h, i) => <tr key={i}><td>{fmtDate(h.start_date)}</td><td>{h.job_title}</td><td className="small">{h.sector_name}</td><td className="small">{h.reason}</td></tr>)}</tbody>
              </table>
            ) : <Empty>Sem histórico.</Empty>}
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head"><h2>Jornada contratual</h2></div>
          <div className="card-body stack">
            {schedules.length ? (
              <table className="table"><thead><tr><th>Jornada</th><th>Vigência</th></tr></thead>
                <tbody>{schedules.map((s) => <tr key={s.id}><td>{s.name}</td><td>{fmtDate(s.valid_from)} – {s.valid_until ? fmtDate(s.valid_until) : 'atual'}</td></tr>)}</tbody>
              </table>
            ) : <div className="alert alert-warn small">Sem jornada atribuída: a apuração considera todos os dias como descanso.</div>}
            {active && can(p, 'jornada.escalas.gerenciar', res) ? (
              <ActionForm action={assignScheduleAction} submitLabel="Atribuir jornada">
                <input type="hidden" name="employeeId" value={id} />
                <div className="form-grid">
                  <div className="field"><label htmlFor="as-s">Jornada</label><select id="as-s" name="scheduleId" className="input">{allSchedules.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
                  <div className="field"><label htmlFor="as-f">A partir de</label><input id="as-f" name="validFrom" type="date" className="input" defaultValue={today} required /></div>
                </div>
              </ActionForm>
            ) : null}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Acordo de banco de horas</h2><p>CLT, art. 59</p></div>
          <div className="card-body stack">
            {agreements.length ? (
              <table className="table"><thead><tr><th>Modalidade</th><th>Prazo</th><th>Vigência</th><th>Instrumento</th><th></th></tr></thead>
                <tbody>{agreements.map((a) => (
                  <tr key={a.id}>
                    <td className="small">{label(a.kind)}{a.allows_negative_balance ? <div className="muted">admite saldo negativo</div> : null}</td>
                    <td>{a.compensation_months} meses</td>
                    <td className="small">{fmtDate(a.valid_from)} – {a.valid_until ? fmtDate(a.valid_until) : 'atual'}</td>
                    <td className="small">{a.document_reference}</td>
                    <td>{!a.valid_until && can(p, 'banco.acordos.gerenciar', res) ? (
                      <ActionForm action={revokeAgreementAction} submitLabel="Encerrar" submitClass="btn btn-sm btn-danger" inline>
                        <input type="hidden" name="employeeId" value={id} /><input type="hidden" name="agreementId" value={a.id} />
                        <input type="date" name="endDate" className="input" defaultValue={today} aria-label="Data de encerramento" />
                      </ActionForm>
                    ) : null}</td>
                  </tr>
                ))}</tbody>
              </table>
            ) : <div className="alert alert-info small">Sem acordo: horas extras não podem ser destinadas ao banco.</div>}
            {active && can(p, 'banco.acordos.gerenciar', res) ? (
              <details className="disclosure">
                <summary className="btn btn-sm">Cadastrar acordo</summary>
                <ActionForm action={agreementAction} submitLabel="Cadastrar acordo">
                  <input type="hidden" name="employeeId" value={id} />
                  <div className="form-grid">
                    <div className="field"><label htmlFor="ag-k">Modalidade</label><select id="ag-k" name="kind" className="input"><option value="INDIVIDUAL_ESCRITO">Individual escrito (até 6 meses)</option><option value="COLETIVO">Coletivo (até 12 meses)</option></select></div>
                    <div className="field"><label htmlFor="ag-m">Prazo de compensação (meses)</label><input id="ag-m" name="compensationMonths" type="number" min="1" max="12" defaultValue="6" className="input" /></div>
                    <div className="field"><label htmlFor="ag-f">Início</label><input id="ag-f" name="validFrom" type="date" defaultValue={today} className="input" /></div>
                    <div className="field"><label htmlFor="ag-u">Término (opcional)</label><input id="ag-u" name="validUntil" type="date" className="input" /></div>
                    <div className="field"><label htmlFor="ag-x">Limite diário de extras (min)</label><input id="ag-x" name="maxDailyExtraMinutes" type="number" min="0" max="240" defaultValue="120" className="input" /></div>
                    <div className="field"><label htmlFor="ag-d">Instrumento assinado</label><input id="ag-d" name="documentReference" className="input" placeholder="Acordo nº / arquivo" required /></div>
                  </div>
                  <label className="check" style={{ marginTop: 10 }}><input type="checkbox" name="allowsNegativeBalance" /> Admite saldo negativo (dependente de validação jurídica)</label>
                </ActionForm>
              </details>
            ) : null}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Férias, afastamentos e ausências</h2></div>
        <div className="card-body stack">
          {absences.length ? (
            <div className="table-wrap"><table className="table"><thead><tr><th>Tipo</th><th>Período</th><th>Abonada</th><th>Observação</th><th>Situação</th><th></th></tr></thead>
              <tbody>{absences.map((a) => (
                <tr key={a.id} className={a.status === 'CANCELADA' ? 'row-muted' : undefined}>
                  <td>{label(a.type)}</td><td className="nowrap">{fmtDate(a.start_date)} – {fmtDate(a.end_date)}</td><td>{a.counts_as_worked ? 'Sim' : 'Não'}</td>
                  <td className="small">{a.notes}</td><td>{a.status === 'ATIVA' ? 'Ativa' : 'Cancelada'}</td>
                  <td>{a.status === 'ATIVA' && can(p, 'jornada.ausencias.gerenciar', res) ? (
                    <ActionForm action={cancelAbsenceAction} submitLabel="Cancelar" submitClass="btn btn-sm btn-danger" inline>
                      <input type="hidden" name="employeeId" value={id} /><input type="hidden" name="absenceId" value={a.id} />
                      <input name="reason" className="input" placeholder="Motivo" aria-label="Motivo" required minLength={5} />
                    </ActionForm>
                  ) : null}</td>
                </tr>
              ))}</tbody></table></div>
          ) : <Empty>Nenhuma ausência lançada.</Empty>}
          {active && can(p, 'jornada.ausencias.gerenciar', res) ? (
            <ActionForm action={absenceAction} submitLabel="Lançar ausência" resetOnSuccess>
              <input type="hidden" name="employeeId" value={id} />
              <div className="form-grid">
                <div className="field"><label htmlFor="ab-t">Tipo</label><select id="ab-t" name="type" className="input">{ABSENCE_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></div>
                <div className="field"><label htmlFor="ab-s">Início</label><input id="ab-s" name="startDate" type="date" className="input" required /></div>
                <div className="field"><label htmlFor="ab-e">Fim</label><input id="ab-e" name="endDate" type="date" className="input" required /></div>
                <div className="field"><label htmlFor="ab-n">Observação</label><input id="ab-n" name="notes" className="input" /></div>
              </div>
              <label className="check" style={{ marginTop: 10 }}><input type="checkbox" name="countsAsWorked" defaultChecked /> Ausência abonada (sem diferença negativa)</label>
            </ActionForm>
          ) : null}
        </div>
      </div>

      <div className="grid grid-2">
        {can(p, 'pessoas.sensiveis.ver', res) ? (
          <div className="card">
            <div className="card-head"><h2>Dados pessoais sensíveis</h2><p>Criptografados · cada consulta é registrada</p></div>
            <div className="card-body">
              {sensitive ? (
                can(p, 'pessoas.sensiveis.editar', res) ? (
                  <ActionForm action={sensitiveAction} submitLabel="Salvar dados sensíveis">
                    <input type="hidden" name="employeeId" value={id} />
                    <div className="form-grid">
                      {([['cpf', 'CPF'], ['rg', 'RG'], ['birthDate', 'Nascimento'], ['phone', 'Telefone'], ['personalEmail', 'E-mail pessoal'], ['address', 'Endereço'], ['bankAccount', 'Dados bancários'], ['emergencyContact', 'Contato de emergência']] as const).map(([k, l]) => (
                        <div className="field" key={k}><label htmlFor={`s-${k}`}>{l}</label><input id={`s-${k}`} name={k} type={k === 'birthDate' ? 'date' : 'text'} className="input" defaultValue={sensitive[k] ?? ''} /></div>
                      ))}
                    </div>
                    <div className="field" style={{ marginTop: 12 }}><label htmlFor="s-h">Observações de saúde (restritas)</label><textarea id="s-h" name="healthNotes" className="input" defaultValue={sensitive.healthNotes ?? ''} /></div>
                  </ActionForm>
                ) : (
                  <dl className="small">{Object.entries(sensitive).map(([k, v]) => <div key={k}><span className="muted">{k}:</span> {v ?? '—'}</div>)}</dl>
                )
              ) : <Link className="btn btn-sm" href={`/equipe/${id}?sensiveis=1`}>Exibir dados sensíveis (acesso registrado)</Link>}
            </div>
          </div>
        ) : null}
        {can(p, 'pessoas.salario.ver', res) ? (
          <div className="card">
            <div className="card-head"><h2>Histórico salarial</h2><p>Acesso restrito e registrado</p></div>
            <div className="card-body stack">
              {salaries ? (
                <>
                  {salaries.length ? (
                    <table className="table"><thead><tr><th>Vigência</th><th className="num">Salário mensal</th><th>Motivo</th><th>Registrado</th></tr></thead>
                      <tbody>{salaries.map((s) => <tr key={s.effective_date}><td>{fmtDate(s.effective_date)}</td><td className="num">{fmtMoney(s.monthly_amount)}</td><td className="small">{s.reason}</td><td className="small muted">{fmtDateTime(s.created_at)}</td></tr>)}</tbody>
                    </table>
                  ) : <Empty>Sem registros.</Empty>}
                  {active && can(p, 'pessoas.salario.editar', res) ? (
                    <ActionForm action={salaryAction} submitLabel="Registrar alteração salarial" resetOnSuccess>
                      <input type="hidden" name="employeeId" value={id} />
                      <div className="form-grid">
                        <div className="field"><label htmlFor="sl-a">Valor mensal (R$)</label><input id="sl-a" name="monthlyAmount" className="input" placeholder="3500,00" required /></div>
                        <div className="field"><label htmlFor="sl-d">Vigência</label><input id="sl-d" name="effectiveDate" type="date" className="input" defaultValue={today} required /></div>
                        <div className="field"><label htmlFor="sl-r">Motivo</label><input id="sl-r" name="reason" className="input" required /></div>
                      </div>
                    </ActionForm>
                  ) : null}
                </>
              ) : <Link className="btn btn-sm" href={`/equipe/${id}?salario=1`}>Exibir histórico salarial (acesso registrado)</Link>}
            </div>
          </div>
        ) : null}
      </div>

      {active && can(p, 'pessoas.editar', res) && e.user_id !== p.userId ? (
        <div className="card">
          <div className="card-head"><h2>Desligamento</h2><p>Revoga acessos imediatamente e preserva todos os registros</p></div>
          <div className="card-body">
            <ActionForm action={terminateAction} submitLabel="Registrar desligamento" submitClass="btn btn-danger" confirm="Confirma o desligamento? Os acessos serão revogados imediatamente.">
              <input type="hidden" name="employeeId" value={id} />
              <div className="form-grid">
                <div className="field"><label htmlFor="t-d">Data</label><input id="t-d" name="terminationDate" type="date" className="input" defaultValue={today} required /></div>
                <div className="field"><label htmlFor="t-r">Motivo</label><input id="t-r" name="reason" className="input" required minLength={5} /></div>
              </div>
              <p className="small muted" style={{ marginTop: 8 }}>Após o registro: conferir devolução de equipamentos, documentos e apurar o saldo do banco de horas na rescisão (checklist completo previsto na próxima iteração).</p>
            </ActionForm>
          </div>
        </div>
      ) : null}
    </div>
  );
}
