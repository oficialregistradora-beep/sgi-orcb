import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { getPool, query } from '@/server/db.ts';
import { developmentHistory, EVAL_DISCLAIMER, evaluablePeople, evaluators, listEvaluations, listSchedules, listTemplates } from '@/server/modules/evaluations.ts';
import { listTrainings } from '@/server/modules/training.ts';
import { directory } from '@/server/modules/directory.ts';
import { addDays, todayLocal } from '@/domain/time.ts';
import { fmtDate, fmtDateTime, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { EVAL_STATUS, EvalTable, PdiList } from '@/ui/development.tsx';
import { evaluationAction } from '../../actions/phase5b.ts';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Avaliações' };

const KINDS = { EXPERIENCIA: 'Período de experiência', ACOMPANHAMENTO: 'Acompanhamento (30/60/90 dias)', ANUAL: 'Anual', COMPETENCIAS: 'Competências', PRODUTIVIDADE: 'Produtividade', OUTRA: 'Outra' };
const FEEDBACK = { RECONHECIMENTO: 'Reconhecimento', ORIENTACAO: 'Orientação', ALINHAMENTO: 'Alinhamento' };

async function AvaliacoesPage({ searchParams }: { searchParams: Promise<{ aba?: string; modelo?: string }> }) {
  const ctx = await requirePageCtx();
  const p = ctx.principal;
  const sp = await searchParams;
  const manage = can(p, 'avaliacoes.gerenciar');
  const lead = can(p, 'avaliacoes.avaliar');
  const TABS = { minhas: 'Minhas avaliações', avaliar: 'Para avaliar', equipe: 'Equipe', modelos: 'Modelos', programacao: 'Programação' } as const;
  const visible: Record<keyof typeof TABS, boolean> = { minhas: !!p.employeeId, avaliar: lead || manage, equipe: lead || manage, modelos: manage, programacao: manage };
  const first = (Object.keys(TABS) as (keyof typeof TABS)[]).find((k) => visible[k]) ?? 'minhas';
  const tab = (sp.aba && sp.aba in TABS && visible[sp.aba as keyof typeof TABS] ? sp.aba : first) as keyof typeof TABS;
  const today = todayLocal();

  return (
    <div className="stack">
      <PageHead title="Avaliações de desempenho e desenvolvimento" subtitle={EVAL_DISCLAIMER} />
      <nav className="tabs">{(Object.keys(TABS) as (keyof typeof TABS)[]).filter((k) => visible[k]).map((k) => <Link key={k} href={`/avaliacoes?aba=${k}`} aria-current={tab === k ? 'page' : undefined}>{TABS[k]}</Link>)}</nav>

      {tab === 'minhas' && p.employeeId ? await (async () => {
        const h = await developmentHistory(ctx, p.employeeId!);
        const mine = await listEvaluations(ctx, { scope: 'minhas' });
        return (
          <div className="stack">
            <div className="card"><div className="card-head"><h2>Avaliações</h2><p>A ciência não implica concordância: você pode concordar ou registrar discordância com seus motivos.</p></div>
              <div className="card-body flush table-wrap" tabIndex={0}>{mine.length ? <EvalTable rows={mine} today={today} /> : <Empty>Nenhuma avaliação.</Empty>}</div></div>
            <div className="card"><div className="card-head"><h2>Meu plano de desenvolvimento (PDI)</h2></div><div className="card-body flush table-wrap" tabIndex={0}>
              <PdiList items={h.pdi} action={evaluationAction} canProgress canClose={false} />
            </div></div>
            <div className="card"><div className="card-head"><h2>Feedbacks documentados</h2></div><div className="card-body flush table-wrap" tabIndex={0}>
              {h.feedbacks.length ? <table className="table"><tbody>{h.feedbacks.map((f) => (
                <tr key={f.id}><td className="small nowrap">{fmtDateTime(f.created_at)}<div className="muted">{FEEDBACK[f.kind as keyof typeof FEEDBACK]} · {f.author_name}</div></td>
                  <td style={{ whiteSpace: 'pre-wrap' }}>{f.content}{f.employee_comment ? <div className="small muted">Meu comentário: {f.employee_comment}</div> : null}</td>
                  <td>{f.acknowledged_at ? <span className="tag tag-ok">Ciente</span> : (
                    <ActionForm action={evaluationAction} submitLabel="Registrar ciência" submitClass="btn btn-sm"><input type="hidden" name="op" value="ciencia_feedback" /><input type="hidden" name="feedbackId" value={f.id} />
                      <input name="comment" className="input" placeholder="Comentário (opcional)" aria-label="Comentário" /></ActionForm>)}</td></tr>
              ))}</tbody></table> : <Empty>Nenhum feedback.</Empty>}
            </div></div>
          </div>
        );
      })() : null}

      {tab === 'avaliar' ? await (async () => {
        const rows = await listEvaluations(ctx, { scope: 'avaliar' });
        return <div className="card"><div className="card-body flush table-wrap" tabIndex={0}>{rows.length ? <EvalTable rows={rows} today={today} showEmployee /> : <Empty>Nenhuma avaliação atribuída a você.</Empty>}</div></div>;
      })() : null}

      {tab === 'equipe' ? await (async () => {
        const [rows, people, templates, trainings] = await Promise.all([listEvaluations(ctx, { scope: 'todas' }), evaluablePeople(ctx), listTemplates(ctx), listTrainings(ctx).catch(() => [])]);
        const evUsers = manage ? await evaluators(ctx) : [];
        const dir = manage ? await directory(ctx) : null;
        const published = templates.filter((t) => t.status === 'PUBLICADO');
        const peopleOpts = people.map((e) => <option key={e.id} value={e.id}>{e.full_name} ({e.sector_name})</option>);
        return (
          <div className="stack">
            <div className="card"><div className="card-head"><h2>Avaliações da equipe</h2></div><div className="card-body flush table-wrap" tabIndex={0}>
              {rows.length ? <EvalTable rows={rows.filter((v) => v.employee_user_id !== p.userId)} today={today} showEmployee /> : <Empty>Nenhuma avaliação.</Empty>}</div></div>
            <div className="card"><div className="card-head"><h2>Histórico por pessoa</h2></div><div className="card-body row">
              {people.map((e) => <Link key={e.id} className="btn btn-sm" href={`/avaliacoes/pessoa/${e.id}`}>{e.full_name}</Link>)}</div></div>
            <div className="grid grid-2">
              <div className="card"><div className="card-head"><h2>Nova avaliação</h2><p>{manage ? 'Atribua a um avaliador habilitado (nunca o próprio avaliado).' : 'Você será o avaliador.'}</p></div><div className="card-body">
                {published.length ? (
                  <ActionForm action={evaluationAction} submitLabel="Criar avaliação">
                    <input type="hidden" name="op" value="criar" />
                    <div className="form-grid">
                      <div className="field"><label>Avaliado(a)<select name="employeeId" className="input" required>{peopleOpts}</select></label></div>
                      <div className="field"><label>Modelo<select name="templateId" className="input" required>{published.map((t) => <option key={t.id} value={t.id}>{t.name} (v{t.version})</option>)}</select></label></div>
                      {manage && dir ? <div className="field"><label>Avaliador(a)<select name="evaluatorUserId" className="input" defaultValue={p.userId}>{dir.users.filter((u) => evUsers.includes(u.id)).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label></div> : null}
                      <div className="field"><label>Período / referência<input name="periodLabel" className="input" required placeholder="Ex.: Anual 2026" /></label></div>
                      <div className="field"><label>Prazo<input name="dueDate" type="date" className="input" defaultValue={addDays(today, 15)} required /></label></div>
                    </div>
                  </ActionForm>
                ) : <Empty>Nenhum modelo publicado.</Empty>}
              </div></div>
              <div className="card"><div className="card-head"><h2>Feedback documentado</h2><p>Fica no histórico; a pessoa é avisada e registra ciência.</p></div><div className="card-body">
                <ActionForm action={evaluationAction} submitLabel="Registrar feedback" resetOnSuccess>
                  <input type="hidden" name="op" value="feedback" />
                  <div className="form-grid">
                    <div className="field"><label>Pessoa<select name="employeeId" className="input" required>{peopleOpts}</select></label></div>
                    <div className="field"><label>Tipo<select name="kind" className="input">{Object.entries(FEEDBACK).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label></div>
                  </div>
                  <div className="field"><label>Feedback<textarea name="content" className="input" rows={3} required minLength={5} /></label></div>
                </ActionForm>
              </div></div>
            </div>
            <div className="card"><div className="card-head"><h2>Item de PDI fora do ciclo</h2></div><div className="card-body">
              <ActionForm action={evaluationAction} submitLabel="Incluir no PDI" resetOnSuccess>
                <input type="hidden" name="op" value="pdi" />
                <div className="form-grid">
                  <div className="field"><label>Pessoa<select name="employeeId" className="input" required>{peopleOpts}</select></label></div>
                  <div className="field"><label>Objetivo<input name="goal" className="input" required minLength={3} /></label></div>
                  <div className="field"><label>Ação<input name="action" className="input" required minLength={3} /></label></div>
                  <div className="field"><label>Treinamento recomendado<select name="trainingId" className="input"><option value="">—</option>{trainings.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.code} — {t.title}</option>)}</select></label></div>
                  <div className="field"><label>Prazo<input name="dueDate" type="date" className="input" defaultValue={addDays(today, 60)} required /></label></div>
                </div>
              </ActionForm>
            </div></div>
          </div>
        );
      })() : null}

      {tab === 'modelos' ? await (async () => {
        const templates = await listTemplates(ctx);
        const edit = templates.find((t) => t.id === sp.modelo);
        return (
          <div className="stack">
            <div className="card"><div className="card-body flush table-wrap" tabIndex={0}>
              {templates.length ? <table className="table"><thead><tr><th>Modelo</th><th>Tipo</th><th>Escala</th><th>Critérios</th><th>Situação</th><th></th></tr></thead>
                <tbody>{templates.map((t) => (
                  <tr key={t.id} className={t.status === 'INATIVO' ? 'row-muted' : undefined}>
                    <td>{t.name} <span className="muted small">v{t.version}</span>{t.self_assessment ? <div className="small muted">com autoavaliação</div> : null}</td>
                    <td className="small">{KINDS[t.kind as keyof typeof KINDS]}</td><td className="small">1 a {t.scale_max}</td>
                    <td className="small">{t.criteria.map((k) => `${k.title}${k.weight > 1 ? ` (peso ${k.weight})` : ''}`).join('; ')}</td>
                    <td><span className={statusTone(t.status === 'PUBLICADO' ? 'PUBLICADO' : t.status)}>{label(t.status)}</span></td>
                    <td className="nowrap">{t.status !== 'INATIVO' ? <Link className="btn btn-sm" href={`/avaliacoes?aba=modelos&modelo=${t.id}#form-modelo`}>{t.status === 'RASCUNHO' ? 'Editar' : 'Nova versão'}</Link> : null}
                      {t.status === 'RASCUNHO' ? <ActionForm action={evaluationAction} submitLabel="Publicar" submitClass="btn btn-sm btn-primary" inline confirm="Publicar? A versão publicada não pode ser alterada."><input type="hidden" name="op" value="publicar_modelo" /><input type="hidden" name="id" value={t.id} /></ActionForm> : null}</td>
                  </tr>
                ))}</tbody></table> : <Empty>Nenhum modelo.</Empty>}
            </div></div>
            <div className="card" id="form-modelo"><div className="card-head"><h2>{edit ? (edit.status === 'RASCUNHO' ? `Editar rascunho: ${edit.name}` : `Nova versão de ${edit.name}`) : 'Novo modelo'}</h2>
              <p>Critérios, um por linha: <code>GRUPO | Critério | peso | descrição</code> (grupos: COMPETENCIA, PRODUTIVIDADE, COMPORTAMENTO, CONHECIMENTO, OUTRO).</p></div><div className="card-body">
              <ActionForm action={evaluationAction} submitLabel="Salvar rascunho" key={edit?.id ?? 'novo'}>
                <input type="hidden" name="op" value="modelo" />{edit ? <input type="hidden" name="id" value={edit.id} /> : null}
                <div className="form-grid">
                  <div className="field" style={{ gridColumn: 'span 2' }}><label>Nome<input name="name" className="input" required minLength={3} defaultValue={edit?.name} /></label></div>
                  <div className="field"><label>Tipo<select name="kind" className="input" defaultValue={edit?.kind}>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label></div>
                  <div className="field"><label>Escala (1 a)<input name="scaleMax" type="number" min={2} max={10} className="input" defaultValue={edit?.scale_max ?? 5} /></label></div>
                </div>
                <div className="field"><label>Critérios<textarea name="criteria" className="input" rows={6} required defaultValue={edit?.criteria.map((k) => [k.grp, k.title, k.weight, k.description ?? ''].join(' | ').replace(/ \| $/, '')).join('\n')}
                  placeholder={'COMPETENCIA | Qualidade técnica dos atos | 2\nCOMPORTAMENTO | Atendimento ao usuário | 1\nPRODUTIVIDADE | Cumprimento de prazos | 2'} /></label></div>
                <div className="field"><label>Orientações ao avaliador<textarea name="instructions" className="input" rows={2} defaultValue={edit?.instructions ?? ''} /></label></div>
                <label className="check"><input type="checkbox" name="selfAssessment" defaultChecked={edit?.self_assessment} /> Prever autoavaliação do avaliado</label>
              </ActionForm>
            </div></div>
          </div>
        );
      })() : null}

      {tab === 'programacao' ? await (async () => {
        const [rows, templates, dir] = await Promise.all([listSchedules(ctx), listTemplates(ctx), directory(ctx)]);
        const families = [...new Map(templates.filter((t) => t.status === 'PUBLICADO').map((t) => [t.family_key, t.name])).entries()];
        const name = (f: string) => templates.find((t) => t.family_key === f)?.name ?? '—';
        const counts = await query<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM evaluations WHERE schedule_id IS NOT NULL AND status = 'PENDENTE'");
        return (
          <div className="stack">
            <div className="alert alert-info small">As avaliações programadas são criadas automaticamente pela rotina diária, com a antecedência definida, e atribuídas à coordenação do setor (ou à Substituta/Oficial). Prazos — inclusive os do período de experiência — são definidos pela serventia; o sistema não altera contratos. Pendentes geradas: {counts[0]!.n}.</div>
            <div className="card"><div className="card-body flush table-wrap" tabIndex={0}>
              {rows.length ? <table className="table"><thead><tr><th>Programação</th><th>Modelo</th><th>Quando</th><th>Setor</th><th className="num">Geradas</th><th>Situação</th></tr></thead>
                <tbody>{rows.map((s) => <tr key={s.id} className={s.active ? undefined : 'row-muted'}><td>{s.name}</td><td className="small">{name(s.template_family)}</td>
                  <td className="small">{s.trigger === 'ANUAL' ? `Anual em ${String(s.annual_day).padStart(2, '0')}/${String(s.annual_month).padStart(2, '0')}` : `${s.days_after} dias após a admissão`} · criada {s.lead_days} dia(s) antes</td>
                  <td className="small">{s.sector_name ?? 'Todos'}</td><td className="num">{s.generated}</td><td>{s.active ? <span className="tag tag-ok">Ativa</span> : <span className="tag">Inativa</span>}</td></tr>)}</tbody></table> : <Empty>Nenhuma programação.</Empty>}
            </div></div>
            <div className="card"><div className="card-head"><h2>Nova programação</h2><p>Ex.: “Acompanhamento 30 dias”, “60 dias”, “90 dias” (três programações) ou “Avaliação anual” em 15/03.</p></div><div className="card-body">
              {families.length ? (
                <ActionForm action={evaluationAction} submitLabel="Salvar programação" resetOnSuccess>
                  <input type="hidden" name="op" value="programacao" />
                  <div className="form-grid">
                    <div className="field"><label>Nome<input name="name" className="input" required minLength={3} /></label></div>
                    <div className="field"><label>Modelo<select name="templateFamily" className="input">{families.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label></div>
                    <div className="field"><label>Quando<select name="trigger" className="input"><option value="DIAS_APOS_ADMISSAO">Dias após a admissão</option><option value="ANUAL">Anual</option></select></label></div>
                    <div className="field"><label>Dias após a admissão<input name="daysAfter" type="number" min={1} max={3650} className="input" /></label></div>
                    <div className="field"><label>Dia (anual)<input name="annualDay" type="number" min={1} max={28} className="input" /></label></div>
                    <div className="field"><label>Mês (anual)<input name="annualMonth" type="number" min={1} max={12} className="input" /></label></div>
                    <div className="field"><label>Criar com antecedência (dias)<input name="leadDays" type="number" min={0} max={60} defaultValue={7} className="input" /></label></div>
                    <div className="field"><label>Setor<select name="sectorId" className="input"><option value="">Todos</option>{dir.sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></div>
                  </div>
                </ActionForm>
              ) : <Empty>Publique um modelo antes.</Empty>}
            </div></div>
          </div>
        );
      })() : null}
      <p className="small muted">Situações: {Object.values(EVAL_STATUS).join(' · ')}</p>
    </div>
  );
}

export default withGuard(AvaliacoesPage);
