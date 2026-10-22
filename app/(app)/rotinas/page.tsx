import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { AREAS, listProcessInstances, listProcessTemplates, listRoutines } from '@/server/modules/routines.ts';
import { directory } from '@/server/modules/directory.ts';
import { formatHHMM, WEEKDAY_NAMES } from '@/domain/time.ts';
import { fmtDate, fmtDateTime, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { processInstanceAction, processTemplateAction, routineAction } from '../../actions/phase4a.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Rotinas e processos' };

const TABS = { rotinas: 'Rotinas recorrentes', andamento: 'Processos em andamento', modelos: 'Modelos de processo' } as const;
const hm = (m: number | null) => (m == null ? '' : formatHHMM(m));

type Routine = Awaited<ReturnType<typeof listRoutines>>[number];
type Dir = Awaited<ReturnType<typeof directory>>;

function describe(r: Routine) {
  const when = r.frequency === 'DIARIA' ? 'Todos os dias' : r.frequency === 'SEMANAL' ? r.weekdays.map((w) => WEEKDAY_NAMES[w]!.slice(0, 3)).join(', ')
    : r.frequency === 'MENSAL' ? `Dia ${r.month_day} de cada mês` : `${r.month_day}/${String(r.month).padStart(2, '0')} de cada ano`;
  return `${when}${r.business_days_only ? ' (dias úteis; se não útil, no próximo dia útil)' : ''}${r.times.length ? ` · ${r.times.map(hm).join(', ')}` : ''}${r.block_start != null ? ` · bloco ${hm(r.block_start)}–${hm(r.block_end)}` : ''}`;
}

function RoutineFields({ r, dir, prefix }: { r?: Routine; dir: Dir; prefix: string }) {
  const id = (n: string) => `${prefix}-${n}`;
  return (
    <>
      {r ? <input type="hidden" name="id" value={r.id} /> : null}
      <div className="form-grid">
        <div className="field"><label htmlFor={id('n')}>Nome</label><input id={id('n')} name="name" className="input" required minLength={3} defaultValue={r?.name} placeholder="Verificar centrais eletrônicas" /></div>
        <div className="field"><label htmlFor={id('a')}>Área</label><select id={id('a')} name="area" className="input" defaultValue={r?.area ?? 'RI'}>{AREAS.map((a) => <option key={a} value={a}>{label(a)}</option>)}</select></div>
        <div className="field"><label htmlFor={id('s')}>Setor</label><select id={id('s')} name="sectorId" className="input" required defaultValue={r?.sector_id ?? ''}><option value="" disabled>Selecione…</option>{dir.sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div className="field"><label htmlFor={id('u')}>Responsável</label><select id={id('u')} name="assigneeUserId" className="input" defaultValue={r?.assignee_user_id ?? ''}><option value="">Setor (a assumir)</option>{dir.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></div>
        <div className="field"><label htmlFor={id('f')}>Frequência</label><select id={id('f')} name="frequency" className="input" defaultValue={r?.frequency ?? 'DIARIA'}>{['DIARIA', 'SEMANAL', 'MENSAL', 'ANUAL'].map((f) => <option key={f} value={f}>{label(f)}</option>)}</select></div>
        <div className="field"><label htmlFor={id('t')}>Horários no dia (opcional)</label><input id={id('t')} name="times" className="input" placeholder="09:00, 11:00, 14:00, 16:00" defaultValue={r?.times.map(hm).join(', ')} /></div>
        <div className="field"><label htmlFor={id('md')}>Dia do mês (mensal/anual)</label><input id={id('md')} name="monthDay" type="number" min={1} max={31} className="input" defaultValue={r?.month_day ?? ''} /></div>
        <div className="field"><label htmlFor={id('m')}>Mês (anual)</label><input id={id('m')} name="month" type="number" min={1} max={12} className="input" defaultValue={r?.month ?? ''} /></div>
        <div className="field"><label htmlFor={id('p')}>Prioridade</label><select id={id('p')} name="priority" className="input" defaultValue={r?.priority ?? 'MEDIA'}>{['IMEDIATA', 'URGENTE', 'ALTA', 'MEDIA', 'BAIXA'].map((p) => <option key={p} value={p}>{label(p)}</option>)}</select></div>
        <div className="field"><label htmlFor={id('bs')}>Bloco de prioridade — início</label><input id={id('bs')} name="blockStart" type="time" className="input" defaultValue={hm(r?.block_start ?? null)} /></div>
        <div className="field"><label htmlFor={id('be')}>Bloco — fim</label><input id={id('be')} name="blockEnd" type="time" className="input" defaultValue={hm(r?.block_end ?? null)} /></div>
        <div className="field"><label htmlFor={id('so')}>Vigência — início</label><input id={id('so')} name="startsOn" type="date" className="input" defaultValue={r?.starts_on} /></div>
        <div className="field"><label htmlFor={id('eo')}>Vigência — fim</label><input id={id('eo')} name="endsOn" type="date" className="input" defaultValue={r?.ends_on ?? ''} /></div>
      </div>
      <fieldset className="row" style={{ marginTop: 10 }}><legend className="label">Dias da semana (semanal)</legend>
        {WEEKDAY_NAMES.map((w, i) => <label key={w} className="check"><input type="checkbox" name="weekdays" value={i} defaultChecked={r?.weekdays.includes(i)} /> {w.slice(0, 3)}</label>)}
      </fieldset>
      <div className="row" style={{ marginTop: 10 }}>
        <label className="check"><input type="checkbox" name="businessDaysOnly" defaultChecked={r?.business_days_only ?? true} /> Somente dias úteis</label>
        <label className="check"><input type="checkbox" name="active" defaultChecked={r?.active ?? true} /> Ativa</label>
      </div>
      <div className="field" style={{ marginTop: 10 }}><label htmlFor={id('d')}>Instruções</label><textarea id={id('d')} name="description" className="input" rows={2} defaultValue={r?.description ?? ''} /></div>
    </>
  );
}

export default async function RotinasPage({ searchParams }: { searchParams: Promise<{ aba?: string }> }) {
  const ctx = await requirePageCtx();
  const sp = await searchParams;
  const tab = (sp.aba && sp.aba in TABS ? sp.aba : 'rotinas') as keyof typeof TABS;
  const p = ctx.principal;
  const canManage = p.isOwner || can(p, 'rotinas.gerenciar');
  const dir = await directory(ctx);
  return (
    <div className="stack">
      <PageHead title="Rotinas e processos" subtitle="Atividades diárias, semanais, mensais e anuais geradas automaticamente como tarefas; fluxos de trabalho com etapas, responsáveis, prazos e aprovações."
        actions={<Link className="btn" href="/tarefas">Tarefas</Link>} />
      <nav className="tabs">{Object.entries(TABS).map(([k, v]) => <Link key={k} href={`/rotinas?aba=${k}`} aria-current={tab === k ? 'page' : undefined}>{v}</Link>)}</nav>

      {tab === 'rotinas' ? await (async () => {
        const routines = await listRoutines(ctx);
        return (
          <div className="stack">
            <div className="card"><div className="card-body flush table-wrap">
              {routines.length ? <table className="table"><thead><tr><th>Rotina</th><th>Quando</th><th>Responsável</th><th>Prioridade</th><th className="num">Geradas</th>{canManage ? <th></th> : null}</tr></thead>
                <tbody>{routines.map((r) => (
                  <tr key={r.id} className={r.active ? undefined : 'row-muted'}>
                    <td>{r.name}<div className="small muted">{label(r.area)} · {r.sector_name}{r.active ? '' : ' · inativa'}</div></td>
                    <td className="small">{describe(r)}</td>
                    <td className="small">{r.assignee_name ?? 'Setor'}</td>
                    <td><span className={statusTone(r.priority)}>{label(r.priority)}</span></td>
                    <td className="num">{r.generated}</td>
                    {canManage ? <td style={{ minWidth: 260 }}><details className="disclosure small"><summary><a>Editar</a></summary><ActionForm action={routineAction} submitLabel="Salvar"><RoutineFields r={r} dir={dir} prefix={`r${r.id.slice(0, 6)}`} /></ActionForm></details></td> : null}
                  </tr>
                ))}</tbody></table> : <Empty>Nenhuma rotina cadastrada.</Empty>}
            </div></div>
            {canManage ? (
              <div className="card"><div className="card-head"><h2>Nova rotina</h2><p>Ex.: verificação das centrais 4×/dia (09:00, 11:00, 14:00, 16:00); notificações e matrículas eletrônicas no bloco 16:00–17:00.</p></div>
                <div className="card-body"><ActionForm action={routineAction} submitLabel="Criar rotina" resetOnSuccess><RoutineFields dir={dir} prefix="nr" /></ActionForm></div>
              </div>
            ) : null}
          </div>
        );
      })() : null}

      {tab === 'andamento' ? await (async () => {
        const [instances, templates] = await Promise.all([listProcessInstances(ctx), listProcessTemplates()]);
        return (
          <div className="stack">
            <div className="card"><div className="card-body flush table-wrap">
              {instances.length ? <table className="table"><thead><tr><th>Processo</th><th>Situação</th><th>Etapas</th><th>Etapa atual</th><th>Início</th><th></th></tr></thead>
                <tbody>{instances.map((i) => (
                  <tr key={i.id}><td>{i.title}<div className="small muted">{i.template_name} · {i.started_by_name}</div></td>
                    <td><span className={statusTone(i.status)}>{label(i.status)}</span></td>
                    <td className="small">{i.steps_done}/{i.steps}</td>
                    <td className="small">{i.current_step ?? '—'}</td>
                    <td className="small">{fmtDateTime(i.started_at)}</td>
                    <td><Link className="small" href={`/tarefas?visao=lista&q=${encodeURIComponent(i.title)}&situacao=TODAS`}>Etapas</Link>
                      {i.status === 'EM_ANDAMENTO' ? <details className="disclosure small"><summary><a>Cancelar</a></summary><ActionForm action={processInstanceAction} submitLabel="Cancelar processo" submitClass="btn btn-sm btn-danger"><input type="hidden" name="op" value="cancelar" /><input type="hidden" name="instanceId" value={i.id} /><input name="reason" className="input" placeholder="Motivo" aria-label="Motivo" required minLength={5} /></ActionForm></details> : null}</td></tr>
                ))}</tbody></table> : <Empty>Nenhum processo iniciado.</Empty>}
            </div></div>
            {templates.some((t) => t.active) ? (
              <div className="card"><div className="card-head"><h2>Iniciar processo</h2><p>Cada etapa vira uma tarefa, liberada após a anterior.</p></div>
                <div className="card-body"><ActionForm action={processInstanceAction} submitLabel="Iniciar" resetOnSuccess>
                  <input type="hidden" name="op" value="iniciar" />
                  <div className="form-grid">
                    <div className="field"><label htmlFor="ip-t">Modelo</label><select id="ip-t" name="templateId" className="input">{templates.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.steps.length} etapas)</option>)}</select></div>
                    <div className="field"><label htmlFor="ip-n">Identificação</label><input id="ip-n" name="title" className="input" required minLength={3} placeholder="Ex.: Admissão — nome" /></div>
                  </div>
                </ActionForm></div>
              </div>
            ) : null}
          </div>
        );
      })() : null}

      {tab === 'modelos' ? await (async () => {
        const templates = await listProcessTemplates();
        const roleOpts = dir.roles.map((r) => <input key={r.id} type="hidden" name="roleOptions" value={`${r.id}::${r.name}`} />);
        const stepsText = (t: (typeof templates)[number]) => t.steps.map((s) => [s.title, s.sla_days, s.role_name ?? '', s.requires_approval ? 's' : 'n', s.required_documents ?? ''].join(' | ')).join('\n');
        const Fields = ({ t }: { t?: (typeof templates)[number] }) => (
          <>
            {t ? <input type="hidden" name="id" value={t.id} /> : null}{roleOpts}
            <div className="form-grid">
              <div className="field"><label>Nome<input name="name" className="input" required minLength={3} defaultValue={t?.name} /></label></div>
              <div className="field"><label>Setor<select name="sectorId" className="input" defaultValue={t?.sector_id ?? ''} required><option value="" disabled>Selecione…</option>{dir.sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></div>
              <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" name="active" defaultChecked={t?.active ?? true} /> Ativo</label>
            </div>
            <div className="field" style={{ marginTop: 10 }}><label>Etapas — uma por linha: <span className="mono">Título | prazo (dias) | papel responsável | aprovação s/n | documentos exigidos</span>
              <textarea name="steps" className="input mono" rows={6} required defaultValue={t ? stepsText(t) : ''} placeholder={'Coletar documentos | 2 | Coordenação de setor | n | RG, CPF\nConferir cadastro | 1 | | s |\nArquivar | 1 | | n |'} /></label></div>
            <p className="small muted">Papéis disponíveis: {dir.roles.map((r) => r.name).join(', ')}. Processos já iniciados não mudam quando o modelo é alterado.</p>
            <div className="field"><label>Descrição<textarea name="description" className="input" rows={2} defaultValue={t?.description ?? ''} /></label></div>
          </>
        );
        return (
          <div className="stack">
            {templates.map((t) => (
              <div className="card" key={t.id}>
                <div className="card-head"><div><h2>{t.name}</h2><p>{t.sector_name} · {t.instances} execução(ões){t.active ? '' : ' · inativo'}</p></div></div>
                <div className="card-body">
                  <ol className="small" style={{ paddingLeft: 18 }}>{t.steps.map((s) => <li key={s.position}>{s.title} — {s.sla_days} dia(s){s.role_name ? ` · ${s.role_name}` : ''}{s.requires_approval ? ' · exige aprovação' : ''}{s.required_documents ? ` · docs: ${s.required_documents}` : ''}</li>)}</ol>
                  {canManage ? <details className="disclosure small" style={{ marginTop: 8 }}><summary><a>Editar modelo</a></summary><ActionForm action={processTemplateAction} submitLabel="Salvar modelo"><Fields t={t} /></ActionForm></details> : null}
                </div>
              </div>
            ))}
            {!templates.length ? <Empty>Nenhum modelo de processo.</Empty> : null}
            {canManage ? <div className="card"><div className="card-head"><h2>Novo modelo de processo</h2></div><div className="card-body"><ActionForm action={processTemplateAction} submitLabel="Criar modelo" resetOnSuccess><Fields /></ActionForm></div></div> : null}
          </div>
        );
      })() : null}
      <p className="small muted">O sistema organiza atividades internas. Não realiza qualificação registral, não pratica atos e não substitui os sistemas oficiais.</p>
    </div>
  );
}
