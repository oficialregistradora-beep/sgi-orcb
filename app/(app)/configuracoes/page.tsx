import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can, requirePermission } from '@/server/authz.ts';
import { listHolidays, listJobTitles, listSchedules, listSectors, listSettings } from '@/server/modules/admin.ts';
import { listClosings } from '@/server/modules/hourbank.ts';
import { addMonths, todayLocal, WEEKDAY_NAMES } from '@/domain/time.ts';
import { fmtDate, fmtDateTime } from '@/ui/format.ts';
import { PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { holidayAction, jobTitleAction, removeHolidayAction, scheduleAction, sectorAction, settingAction } from '../../actions/admin.ts';
import { booleanSettingAction } from '../../actions/phase2b.ts';
import { RegrasJuridicas } from './RegrasJuridicas.tsx';
import { Integracoes } from './Integracoes.tsx';
import { Rede } from './Rede.tsx';
import { ModelosChecklist } from './ModelosChecklist.tsx';
import { closePeriodAction, reopenPeriodAction } from '../../actions/bank.ts';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Configurações' };

const TABS = {
  setores: 'Setores e cargos', jornadas: 'Jornadas', feriados: 'Feriados', parametros: 'Parâmetros', competencias: 'Competências',
  regras: 'Regras jurídicas', checklists: 'Modelos de checklist', integracoes: 'Integrações', rede: 'Rede',
} as const;

async function ConfigPage({ searchParams }: { searchParams: Promise<{ aba?: string; ano?: string; modelo?: string }> }) {
  const ctx = await requirePageCtx();
  const sp0 = await searchParams;
  // Modelos de checklist e regras jurídicas têm permissões próprias (podem ser delegadas sem acesso às demais configurações).
  const special = (sp0.aba === 'checklists' && (can(ctx.principal, 'checklists.modelos.editar') || can(ctx.principal, 'checklists.modelos.publicar')))
    || (sp0.aba === 'regras' && can(ctx.principal, 'regras.juridicas.gerenciar'));
  if (!special) requirePermission(ctx, 'configuracoes.gerenciar');
  const sp = sp0;
  const tab = (sp.aba && sp.aba in TABS ? sp.aba : 'setores') as keyof typeof TABS;
  const year = Number(sp.ano) || Number(todayLocal().slice(0, 4));
  return (
    <div className="stack">
      <PageHead title="Configurações" subtitle="Estrutura e regras administrativas alteráveis sem modificar código. Toda alteração é auditada." />
      <nav className="tabs">{Object.entries(TABS).map(([k, v]) => <Link key={k} href={`/configuracoes?aba=${k}`} aria-current={tab === k ? 'page' : undefined}>{v}</Link>)}</nav>
      {tab === 'setores' ? <Sectors /> : null}
      {tab === 'jornadas' ? <Schedules /> : null}
      {tab === 'feriados' ? <Holidays year={year} /> : null}
      {tab === 'parametros' ? <Params ctx={ctx} /> : null}
      {tab === 'competencias' ? <Closings canClose={can(ctx.principal, 'banco.periodo.fechar')} /> : null}
      {tab === 'regras' ? <RegrasJuridicas ctx={ctx} /> : null}
      {tab === 'checklists' ? <ModelosChecklist ctx={ctx} modelo={sp.modelo} /> : null}
      {tab === 'integracoes' ? <Integracoes ctx={ctx} /> : null}
      {tab === 'rede' ? <Rede ctx={ctx} /> : null}
    </div>
  );
}

async function Sectors() {
  const [sectors, jobs] = await Promise.all([listSectors(), listJobTitles()]);
  return (
    <div className="grid grid-2">
      <div className="card">
        <div className="card-head"><h2>Setores</h2></div>
        <div className="card-body flush table-wrap" tabIndex={0}>
          <table className="table"><thead><tr><th>Código</th><th>Nome</th><th className="num">Pessoas</th><th>Ativo</th></tr></thead>
            <tbody>{sectors.map((s) => <tr key={s.id}><td className="mono">{s.code}</td><td>{s.name}</td><td className="num">{s.employees}</td><td>{s.active ? 'Sim' : 'Não'}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="card-foot">
          <ActionForm action={sectorAction} submitLabel="Salvar setor" resetOnSuccess>
            <div className="form-grid">
              <div className="field"><label htmlFor="st-id">Editar existente</label><select id="st-id" name="id" className="input"><option value="">Novo setor</option>{sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
              <div className="field"><label htmlFor="st-c">Código</label><input id="st-c" name="code" className="input" required /></div>
              <div className="field"><label htmlFor="st-n">Nome</label><input id="st-n" name="name" className="input" required /></div>
              <div className="field"><label htmlFor="st-p">Subordinado a</label><select id="st-p" name="parentId" className="input"><option value="">—</option>{sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
              <div className="field"><label htmlFor="st-a">Situação</label><select id="st-a" name="active" className="input"><option value="on">Ativo</option><option value="off">Inativo</option></select></div>
            </div>
          </ActionForm>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h2>Cargos</h2></div>
        <div className="card-body flush table-wrap" tabIndex={0}>
          <table className="table"><thead><tr><th>Nome</th><th>Ativo</th></tr></thead>
            <tbody>{jobs.map((j) => <tr key={j.id}><td>{j.name}</td><td>{j.active ? 'Sim' : 'Não'}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="card-foot">
          <ActionForm action={jobTitleAction} submitLabel="Salvar cargo" resetOnSuccess>
            <div className="form-grid">
              <div className="field"><label htmlFor="jt-id">Editar existente</label><select id="jt-id" name="id" className="input"><option value="">Novo cargo</option>{jobs.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}</select></div>
              <div className="field"><label htmlFor="jt-n">Nome</label><input id="jt-n" name="name" className="input" required /></div>
              <div className="field"><label htmlFor="jt-a">Situação</label><select id="jt-a" name="active" className="input"><option value="on">Ativo</option><option value="off">Inativo</option></select></div>
            </div>
          </ActionForm>
        </div>
      </div>
    </div>
  );
}

async function Schedules() {
  const schedules = await listSchedules();
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h2>Jornadas cadastradas</h2></div>
        <div className="card-body flush table-wrap" tabIndex={0}>
          <table className="table"><thead><tr><th>Nome</th><th>Dias</th><th>Tolerância (art. 58 §1º)</th></tr></thead>
            <tbody>{schedules.map((s) => (
              <tr key={s.id}>
                <td>{s.name}<div className="small muted">{s.description}</div></td>
                <td className="small">{s.days.map((d) => <div key={d.weekday}>{WEEKDAY_NAMES[d.weekday]}: {d.start_time}{d.break_start ? `–${d.break_start} / ${d.break_end}` : ''}–{d.end_time}</div>)}</td>
                <td className="small">{s.tolerance_enabled ? `${s.tolerance_per_mark_minutes} min/marcação, ${s.tolerance_daily_minutes} min/dia` : 'Desabilitada'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h2>Nova jornada</h2><p>Limite de 44 horas semanais</p></div>
        <div className="card-body">
          <ActionForm action={scheduleAction} submitLabel="Criar jornada">
            <div className="form-grid">
              <div className="field"><label htmlFor="sc-n">Nome</label><input id="sc-n" name="name" className="input" required /></div>
              <div className="field"><label htmlFor="sc-d">Descrição</label><input id="sc-d" name="description" className="input" /></div>
              <div className="field"><label htmlFor="sc-tp">Tolerância por marcação (min)</label><input id="sc-tp" name="tolerancePerMark" type="number" min="0" max="15" defaultValue="5" className="input" /></div>
              <div className="field"><label htmlFor="sc-td">Tolerância diária (min)</label><input id="sc-td" name="toleranceDaily" type="number" min="0" max="30" defaultValue="10" className="input" /></div>
            </div>
            <label className="check" style={{ margin: '10px 0' }}><input type="checkbox" name="toleranceEnabled" defaultChecked /> Aplicar tolerância (dependente de validação jurídica)</label>
            <div className="table-wrap" tabIndex={0}><table className="table">
              <thead><tr><th>Dia</th><th>Trabalha</th><th>Entrada</th><th>Início intervalo</th><th>Fim intervalo</th><th>Saída</th></tr></thead>
              <tbody>{[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <tr key={d}>
                  <td>{WEEKDAY_NAMES[d]}</td>
                  <td><input type="checkbox" name={`d${d}_on`} defaultChecked={d >= 1 && d <= 5} aria-label={`Trabalha ${WEEKDAY_NAMES[d]}`} /></td>
                  <td><input type="time" name={`d${d}_start`} defaultValue="08:00" className="input" aria-label="Entrada" /></td>
                  <td><input type="time" name={`d${d}_bs`} defaultValue="12:00" className="input" aria-label="Início do intervalo" /></td>
                  <td><input type="time" name={`d${d}_be`} defaultValue="13:00" className="input" aria-label="Fim do intervalo" /></td>
                  <td><input type="time" name={`d${d}_end`} defaultValue="17:00" className="input" aria-label="Saída" /></td>
                </tr>
              ))}</tbody>
            </table></div>
          </ActionForm>
        </div>
      </div>
    </div>
  );
}

async function Holidays({ year }: { year: number }) {
  const rows = await listHolidays(year);
  return (
    <div className="grid grid-2">
      <div className="card">
        <div className="card-head">
          <h2>Feriados de {year}</h2>
          <div className="row"><a className="btn btn-sm" href={`/configuracoes?aba=feriados&ano=${year - 1}`}>‹</a><a className="btn btn-sm" href={`/configuracoes?aba=feriados&ano=${year + 1}`}>›</a></div>
        </div>
        <div className="card-body flush table-wrap" tabIndex={0}>
          <table className="table"><thead><tr><th>Data</th><th>Nome</th><th>Âmbito</th><th></th></tr></thead>
            <tbody>{rows.map((h) => (
              <tr key={h.id}><td>{fmtDate(h.date)}</td><td>{h.name}{h.is_day_off ? '' : <span className="tag" style={{ marginLeft: 6 }}>sem dispensa</span>}</td><td className="small">{h.scope}</td>
                <td><ActionForm action={removeHolidayAction} submitLabel="Excluir" submitClass="btn btn-sm btn-ghost" confirm="Excluir este feriado?" inline><input type="hidden" name="id" value={h.id} /></ActionForm></td></tr>
            ))}</tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h2>Incluir feriado</h2><p>Estaduais (SC) e municipais (Capivari de Baixo) dependem de configuração — pendência P-07</p></div>
        <div className="card-body">
          <ActionForm action={holidayAction} submitLabel="Incluir" resetOnSuccess>
            <div className="form-grid">
              <div className="field"><label htmlFor="h-d">Data</label><input id="h-d" name="date" type="date" className="input" required /></div>
              <div className="field"><label htmlFor="h-n">Nome</label><input id="h-n" name="name" className="input" required /></div>
              <div className="field"><label htmlFor="h-s">Âmbito</label><select id="h-s" name="scope" className="input">{['MUNICIPAL', 'ESTADUAL', 'NACIONAL', 'PONTO_FACULTATIVO', 'INTERNO'].map((s) => <option key={s}>{s}</option>)}</select></div>
            </div>
            <label className="check" style={{ marginTop: 10 }}><input type="checkbox" name="isDayOff" defaultChecked /> Dispensa o expediente</label>
          </ActionForm>
        </div>
      </div>
    </div>
  );
}

async function Params({ ctx }: { ctx: Awaited<ReturnType<typeof requirePageCtx>> }) {
  const rows = await listSettings(ctx);
  return (
    <div className="card">
      <div className="card-head"><h2>Parâmetros institucionais</h2><p>Alterações exigem reautenticação</p></div>
      <div className="card-body flush table-wrap" tabIndex={0}>
        <table className="table"><thead><tr><th>Parâmetro</th><th>Descrição</th><th>Valor</th><th>Atualizado</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.key}>
              <td className="mono small">{r.key}</td><td className="small">{r.description}</td>
              <td>{typeof r.value === 'number' ? (
                <ActionForm action={settingAction} submitLabel="Salvar" submitClass="btn btn-sm" inline>
                  <input type="hidden" name="key" value={r.key} />
                  <input type="number" name="value" defaultValue={r.value} className="input" style={{ width: 110 }} aria-label={r.key} />
                </ActionForm>
              ) : typeof r.value === 'boolean' ? (
                <ActionForm action={booleanSettingAction} submitLabel="Salvar" submitClass="btn btn-sm" inline>
                  <input type="hidden" name="key" value={r.key} />
                  <select name="value" className="input" defaultValue={String(r.value)} aria-label={r.key} style={{ width: 110 }}><option value="true">Sim</option><option value="false">Não</option></select>
                </ActionForm>
              ) : <span className="small">{String(r.value)}</span>}</td>
              <td className="small muted">{fmtDateTime(r.updated_at)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

async function Closings({ canClose }: { canClose: boolean }) {
  const rows = await listClosings();
  const last = addMonths(`${todayLocal().slice(0, 7)}-01`, -1).slice(0, 7);
  return (
    <div className="grid grid-2">
      <div className="card">
        <div className="card-head"><h2>Competências fechadas</h2></div>
        <div className="card-body flush table-wrap" tabIndex={0}>
          <table className="table"><thead><tr><th>Competência</th><th>Fechada por</th><th>Situação</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.id}><td>{r.period}</td><td className="small">{r.closed_by_name} · {fmtDateTime(r.closed_at)}</td><td className="small">{r.reopened_at ? `Reaberta: ${r.reopen_reason}` : 'Fechada'}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
      {canClose ? (
        <div className="card">
          <div className="card-head"><h2>Fechar ou reabrir</h2><p>Competência fechada bloqueia correções e decisões retroativas</p></div>
          <div className="card-body stack">
            <ActionForm action={closePeriodAction} submitLabel="Fechar competência" confirm="Fechar a competência?">
              <div className="field"><label htmlFor="cl-p">Competência</label><input id="cl-p" name="period" type="month" className="input" defaultValue={last} max={last} required /></div>
            </ActionForm>
            <ActionForm action={reopenPeriodAction} submitLabel="Reabrir competência" submitClass="btn">
              <div className="form-grid">
                <div className="field"><label htmlFor="ro-p">Competência</label><input id="ro-p" name="period" type="month" className="input" required /></div>
                <div className="field"><label htmlFor="ro-r">Motivo</label><input id="ro-r" name="reason" className="input" required minLength={5} /></div>
              </div>
            </ActionForm>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default withGuard(ConfigPage);
