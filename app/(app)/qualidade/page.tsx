import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { listAudits, listNcs, listRequirements, listRisks } from '@/server/modules/quality.ts';
import { listAssets, listBackups, listVulnerabilities, qualityOverview } from '@/server/modules/security.ts';
import { directory } from '@/server/modules/directory.ts';
import { riskBand } from '@/domain/quality.ts';
import { addDays, todayLocal } from '@/domain/time.ts';
import { fmtDate, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead, Stat } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { qualityAction, securityAction } from '../../actions/phase5a.ts';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Qualidade e segurança' };

const DISCLAIMER = 'Ferramenta de apoio à gestão da qualidade (inclusive ao PQTA): os indicadores refletem o que a serventia registrou e não constituem declaração de conformidade nem certificação.';

function Heatmap({ grid }: { grid: number[][] }) {
  return (
    <div>
      <div className="heat" role="table" aria-label="Matriz de riscos: impacto (linhas) × probabilidade (colunas)">
        {grid.map((row, i) => (
          <div key={i} role="row" style={{ display: 'contents' }}>
            <span className="hl" role="rowheader">{5 - i}</span>
            {row.map((n, j) => <span key={j} role="cell" className={`hc b-${riskBand(j + 1, 5 - i)} ${n ? '' : 'zero'}`} title={`Impacto ${5 - i} × probabilidade ${j + 1}`}>{n || '·'}</span>)}
          </div>
        ))}
        <span />{[1, 2, 3, 4, 5].map((n) => <span key={n} className="hl">{n}</span>)}
      </div>
      <div className="small muted">Linhas: impacto · colunas: probabilidade</div>
    </div>
  );
}

const SEV_OPTIONS = ['BAIXA', 'MEDIA', 'ALTA', 'CRITICA'];
const RISK_CATS = ['OPERACIONAL', 'SEGURANCA_INFORMACAO', 'DADOS_PESSOAIS', 'CONTINUIDADE', 'LEGAL_NORMATIVO', 'FINANCEIRO', 'PESSOAS', 'IMAGEM'];
const ASSET_KINDS = ['COMPUTADOR', 'NOTEBOOK', 'IMPRESSORA', 'SCANNER', 'SERVIDOR', 'REDE', 'NOBREAK', 'SOFTWARE_LICENCA', 'CERTIFICADO_DIGITAL', 'TOKEN_SMARTCARD', 'CELULAR', 'MOBILIARIO', 'OUTRO'];
const opts = (xs: string[]) => xs.map((x) => <option key={x} value={x}>{label(x)}</option>);

async function QualidadePage({ searchParams }: { searchParams: Promise<{ aba?: string; ativo?: string }> }) {
  const ctx = await requirePageCtx();
  const sp = await searchParams;
  const p = ctx.principal;
  const has = (x: string) => p.isOwner || can(p, x);
  const view = ['qualidade.ver', 'qualidade.gerenciar', 'qualidade.auditar'].some(has);
  const assetsView = view || has('ativos.gerenciar');
  if (!view && !assetsView && !has('incidentes.gerenciar')) redirect('/qualidade/incidentes');
  const manage = has('qualidade.gerenciar');
  const auditor = has('qualidade.auditar');
  const assetsAdmin = has('ativos.gerenciar');
  const TABS = { painel: 'Painel', requisitos: 'Requisitos', auditorias: 'Auditorias', nc: 'Não conformidades', riscos: 'Riscos', ativos: 'Ativos', backups: 'Backups', vulnerabilidades: 'Vulnerabilidades' } as const;
  const visible: Record<keyof typeof TABS, boolean> = { painel: true, requisitos: view, auditorias: view, nc: view, riscos: view, ativos: assetsView, backups: assetsView, vulnerabilidades: assetsView };
  const tab = (sp.aba && sp.aba in TABS && visible[sp.aba as keyof typeof TABS] ? sp.aba : 'painel') as keyof typeof TABS;
  const today = todayLocal();
  const dir = await directory(ctx);
  const userOpts = dir.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>);
  const sectorOpts = dir.sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>);

  return (
    <div className="stack">
      <PageHead title="Qualidade e segurança da informação" subtitle={DISCLAIMER} actions={<Link className="btn" href="/qualidade/incidentes">Incidentes</Link>} />
      <nav className="tabs">{(Object.keys(TABS) as (keyof typeof TABS)[]).filter((k) => visible[k]).map((k) => <Link key={k} href={`/qualidade?aba=${k}`} aria-current={tab === k ? 'page' : undefined}>{TABS[k]}</Link>)}</nav>

      {tab === 'painel' ? await (async () => {
        const o = await qualityOverview(ctx);
        const overdueRestore = o.backups?.filter((b) => b.restoreOverdue) ?? [];
        return (
          <div className="stack">
            <div className="grid grid-4">
              {o.compliance ? <Stat label="Índice de atendimento (registrado)" value={o.compliance.pct === null ? '—' : `${o.compliance.pct.toLocaleString('pt-BR')}%`}
                hint={`${o.compliance.total} requisito(s) · ${o.compliance.counts.NAO_AVALIADO} não avaliado(s) · ${o.compliance.reviewDue} com reavaliação devida`} /> : null}
              {o.ncs ? <Stat label="Não conformidades abertas" value={o.ncs.open} tone={o.ncs.critical_open ? 'neg' : undefined}
                hint={`${o.ncs.critical_open} maior/crítica · ${o.ncs.awaiting} aguardando eficácia${o.ncs.avg_days_to_close !== null ? ` · ${o.ncs.avg_days_to_close} dias em média p/ encerrar` : ''}`} /> : null}
              {o.actions ? <Stat label="Ações em aberto" value={o.actions.open} tone={o.actions.overdue ? 'neg' : undefined}
                hint={`${o.actions.overdue} atrasada(s)${o.actions.done_12m ? ` · ${Math.round((o.actions.done_on_time_12m / o.actions.done_12m) * 100)}% no prazo (12 meses)` : ''}`} /> : null}
              {o.risks ? <Stat label="Riscos ativos" value={o.risks.total} tone={o.risks.bands.CRITICO ? 'neg' : undefined}
                hint={`${o.risks.bands.CRITICO} crítico(s) · ${o.risks.bands.ALTO} alto(s) · ${o.risks.reviewDue} reavaliação devida`} /> : null}
              {o.incidents ? <Stat label="Incidentes em aberto" value={o.incidents.open} tone={o.incidents.personal_pending ? 'neg' : undefined}
                hint={`${o.incidents.personal_pending} com avaliação LGPD pendente · ${o.incidents.last_12m} em 12 meses`} /> : null}
              {o.vulnerabilities ? <Stat label="Vulnerabilidades abertas" value={o.vulnerabilities.open} tone={o.vulnerabilities.overdue ? 'neg' : undefined} hint={`${o.vulnerabilities.overdue} com prazo vencido`} /> : null}
              {o.backups ? <Stat label="Sistemas com backup registrado" value={o.backups.length} tone={overdueRestore.length ? 'neg' : undefined} hint={`${overdueRestore.length} com teste de restauração em atraso`} /> : null}
              {o.expiring ? <Stat label="Vencimentos próximos" value={o.expiring.length} tone={o.expiring.some((e) => e.daysLeft < 0) ? 'neg' : undefined} hint="Garantias, licenças e certificados digitais" /> : null}
            </div>
            {o.risks ? (
              <div className="grid grid-2">
                <div className="card"><div className="card-head"><h2>Riscos — inerente</h2></div><div className="card-body"><Heatmap grid={o.risks.heatmap} /></div></div>
                <div className="card"><div className="card-head"><h2>Riscos — residual</h2><p>Após os controles (quando avaliado; senão, igual ao inerente).</p></div><div className="card-body"><Heatmap grid={o.risks.residualHeatmap} /></div></div>
              </div>
            ) : null}
            {o.audits?.length ? (
              <div className="card"><div className="card-head"><h2>Auditorias planejadas e em execução</h2></div>
                <div className="card-body flush table-wrap" tabIndex={0}><table className="table"><tbody>{o.audits.map((a) => <tr key={a.id}><td><Link href={`/qualidade/auditorias/${a.id}`}>{a.code}</Link> — {a.title}</td><td className="small">{fmtDate(a.planned_date)}</td><td><span className={statusTone(a.status)}>{label(a.status)}</span></td></tr>)}</tbody></table></div></div>
            ) : null}
            {overdueRestore.length ? <div className="alert alert-danger small">Teste de restauração em atraso: {overdueRestore.map((b) => `${b.system} (${b.lastRestoreOk ? `último ok em ${fmtDate(b.lastRestoreOk)}` : 'nunca testado com sucesso'})`).join('; ')}.</div> : null}
            {o.expiring?.length ? <div className="alert alert-warn small">{o.expiring.map((e) => <div key={`${e.id}${e.what}`}>{e.what} de <strong>{e.tag}</strong> ({e.name}) {e.daysLeft < 0 ? `vencida há ${-e.daysLeft} dia(s)` : `vence em ${e.daysLeft} dia(s)`} — {fmtDate(e.expires)}.</div>)}</div> : null}
          </div>
        );
      })() : null}

      {tab === 'requisitos' ? await (async () => {
        const rows = await listRequirements(ctx);
        const areas = [...new Set(rows.map((r) => r.area))];
        return (
          <div className="stack">
            <div className="alert alert-info small">Nenhum requisito é pré-carregado: cadastre cada requisito a partir da fonte oficial consultada (provimentos, normas, regulamento do PQTA vigente etc.), indicando a fonte.</div>
            <div className="card"><div className="card-body flush table-wrap" tabIndex={0}>
              {rows.length ? <table className="table"><thead><tr><th>Requisito</th><th>Área</th><th>Responsável</th><th>Avaliação</th><th>Próxima revisão</th><th className="num">Evidências</th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.id} className={r.active ? undefined : 'row-muted'}>
                    <td><Link href={`/qualidade/requisitos/${r.id}`}>{r.code}</Link> — {r.title}<div className="small muted">Fonte: {r.source}</div></td>
                    <td className="small">{r.area}</td><td className="small">{r.owner_name}</td>
                    <td><span className={statusTone(r.status)}>{label(r.status)}</span>{r.status_notes ? <div className="small muted">{r.status_notes}</div> : null}</td>
                    <td className={`small ${r.next_review_on && r.next_review_on <= today ? 'neg' : ''}`}>{fmtDate(r.next_review_on)}</td>
                    <td className="num">{r.evidences}</td>
                  </tr>
                ))}</tbody></table> : <Empty>Nenhum requisito cadastrado.</Empty>}
            </div></div>
            {manage ? (
              <div className="card"><div className="card-head"><h2>Novo requisito</h2></div><div className="card-body">
                <ActionForm action={qualityAction} submitLabel="Salvar requisito" resetOnSuccess>
                  <input type="hidden" name="op" value="requisito" />
                  <div className="form-grid">
                    <div className="field"><label>Código<input name="code" className="input" required placeholder="EX.: DOC-01" /></label></div>
                    <div className="field" style={{ gridColumn: 'span 2' }}><label>Título<input name="title" className="input" required minLength={3} /></label></div>
                    <div className="field" style={{ gridColumn: 'span 2' }}><label>Fonte (norma, item, documento consultado)<input name="source" className="input" required minLength={3} /></label></div>
                    <div className="field"><label>Área<input name="area" className="input" list="areas" required /></label><datalist id="areas">{areas.map((a) => <option key={a} value={a} />)}</datalist></div>
                    <div className="field"><label>Responsável<select name="ownerUserId" className="input" required defaultValue={p.userId}>{userOpts}</select></label></div>
                    <div className="field"><label>Revisar a cada (meses)<input name="reviewMonths" type="number" min={1} max={60} defaultValue={12} className="input" /></label></div>
                  </div>
                </ActionForm>
              </div></div>
            ) : null}
          </div>
        );
      })() : null}

      {tab === 'auditorias' ? await (async () => {
        const [rows, reqs] = await Promise.all([listAudits(ctx), auditor ? listRequirements(ctx) : Promise.resolve([])]);
        const areas = [...new Set(reqs.filter((r) => r.active).map((r) => r.area))];
        return (
          <div className="stack">
            <div className="card"><div className="card-body flush table-wrap" tabIndex={0}>
              {rows.length ? <table className="table"><thead><tr><th>Auditoria</th><th>Tipo</th><th>Setor auditado</th><th>Auditor(a) líder</th><th>Data</th><th className="num">Itens</th><th className="num">NC</th><th>Situação</th></tr></thead>
                <tbody>{rows.map((a) => (
                  <tr key={a.id}><td><Link href={`/qualidade/auditorias/${a.id}`}>{a.code}</Link> — {a.title}</td><td className="small">{label(a.kind)}</td><td className="small">{a.sector_name ?? 'Geral'}</td>
                    <td className="small">{a.lead_name}</td><td className="small">{fmtDate(a.planned_date)}</td><td className="num">{a.items}{a.pending && a.status === 'EM_EXECUCAO' ? <span className="small muted"> ({a.pending} pend.)</span> : null}</td>
                    <td className="num">{a.nc}</td><td><span className={statusTone(a.status)}>{label(a.status)}</span></td></tr>
                ))}</tbody></table> : <Empty>Nenhuma auditoria.</Empty>}
            </div></div>
            {auditor ? (
              <div className="card"><div className="card-head"><h2>Planejar auditoria interna</h2><p>O(a) auditor(a) líder não pode pertencer ao setor auditado (independência).</p></div><div className="card-body">
                <ActionForm action={qualityAction} submitLabel="Planejar">
                  <input type="hidden" name="op" value="auditoria" />
                  <div className="form-grid">
                    <div className="field" style={{ gridColumn: 'span 2' }}><label>Título<input name="title" className="input" required minLength={3} /></label></div>
                    <div className="field"><label>Tipo<select name="kind" className="input">{opts(['INTERNA', 'DOCUMENTAL', 'SEGURANCA_INFORMACAO', 'LGPD', 'PROCESSOS', 'OUTRA'])}</select></label></div>
                    <div className="field"><label>Setor auditado<select name="sectorId" className="input"><option value="">Geral</option>{sectorOpts}</select></label></div>
                    <div className="field"><label>Auditor(a) líder<select name="leadAuditorId" className="input" defaultValue={p.userId}>{userOpts}</select></label></div>
                    <div className="field"><label>Data planejada<input name="plannedDate" type="date" className="input" defaultValue={addDays(today, 14)} required /></label></div>
                    <div className="field"><label>Importar requisitos da área<select name="importArea" className="input"><option value="">—</option>{areas.map((a) => <option key={a} value={a}>{a}</option>)}</select></label></div>
                  </div>
                  <div className="field" style={{ marginTop: 12 }}><label>Escopo<textarea name="scope" className="input" rows={2} required minLength={3} /></label></div>
                  <div className="field" style={{ marginTop: 12 }}><label>Perguntas do checklist (uma por linha)<textarea name="questions" className="input" rows={4} /></label></div>
                </ActionForm>
              </div></div>
            ) : null}
          </div>
        );
      })() : null}

      {tab === 'nc' ? await (async () => {
        const rows = await listNcs(ctx);
        return (
          <div className="stack">
            <div className="card"><div className="card-body flush table-wrap" tabIndex={0}>
              {rows.length ? <table className="table"><thead><tr><th>Não conformidade</th><th>Origem</th><th>Gravidade</th><th>Responsável</th><th className="num">Ações</th><th>Situação</th></tr></thead>
                <tbody>{rows.map((n) => (
                  <tr key={n.id} className={n.status === 'ENCERRADA' || n.status === 'CANCELADA' ? 'row-muted' : undefined}>
                    <td><Link href={`/qualidade/nc/${n.id}`}>{n.code}</Link><div className="small muted">{n.description.slice(0, 140)}</div></td>
                    <td className="small">{label(n.origin)}</td><td><span className={statusTone(n.severity === 'MENOR' ? 'MODERADO' : 'CRITICA')}>{label(n.severity)}</span></td>
                    <td className="small">{n.responsible_name}<div className="muted">{n.sector_name ?? ''}</div></td>
                    <td className="num">{n.actions}{n.actions_overdue ? <span className="small neg"> ({n.actions_overdue} atrasada)</span> : null}</td>
                    <td><span className={statusTone(n.status)}>{label(n.status)}</span></td>
                  </tr>
                ))}</tbody></table> : <Empty>Nenhuma não conformidade.</Empty>}
            </div></div>
            {manage ? (
              <div className="card"><div className="card-head"><h2>Registrar não conformidade</h2><p>Não conformidades de auditoria são abertas automaticamente ao avaliar o item.</p></div><div className="card-body">
                <ActionForm action={qualityAction} submitLabel="Abrir não conformidade">
                  <input type="hidden" name="op" value="nc" />
                  <div className="form-grid">
                    <div className="field"><label>Origem<select name="origin" className="input">{opts(['AUTOAVALIACAO', 'RECLAMACAO', 'OUTRA'])}</select></label></div>
                    <div className="field"><label>Gravidade<select name="severity" className="input">{opts(['MENOR', 'MAIOR', 'CRITICA'])}</select></label></div>
                    <div className="field"><label>Setor<select name="sectorId" className="input"><option value="">—</option>{sectorOpts}</select></label></div>
                    <div className="field"><label>Responsável pelo tratamento<select name="responsibleUserId" className="input">{userOpts}</select></label></div>
                  </div>
                  <div className="field" style={{ marginTop: 12 }}><label>Descrição (fato e evidência)<textarea name="description" className="input" rows={3} required minLength={5} /></label></div>
                </ActionForm>
              </div></div>
            ) : null}
          </div>
        );
      })() : null}

      {tab === 'riscos' ? await (async () => {
        const rows = await listRisks(ctx);
        const sel = (n: string, d?: number | null, req = true) => <select name={n} className="input" defaultValue={d ?? ''} required={req}>{req ? null : <option value="">—</option>}{[1, 2, 3, 4, 5].map((x) => <option key={x} value={x}>{x}</option>)}</select>;
        const RiskFields = ({ r }: { r?: (typeof rows)[number] }) => (
          <>
            <div className="form-grid">
              <div className="field" style={{ gridColumn: 'span 2' }}><label>Risco<input name="title" className="input" required minLength={3} defaultValue={r?.title} /></label></div>
              <div className="field"><label>Categoria<select name="category" className="input" defaultValue={r?.category}>{opts(RISK_CATS)}</select></label></div>
              <div className="field"><label>Probabilidade (1–5){sel('probability', r?.probability)}</label></div>
              <div className="field"><label>Impacto (1–5){sel('impact', r?.impact)}</label></div>
              <div className="field"><label>Tratamento<select name="treatment" className="input" defaultValue={r?.treatment}>{opts(['MITIGAR', 'ACEITAR', 'TRANSFERIR', 'EVITAR'])}</select></label></div>
              <div className="field"><label>Prob. residual{sel('residualProbability', r?.residual_probability, false)}</label></div>
              <div className="field"><label>Impacto residual{sel('residualImpact', r?.residual_impact, false)}</label></div>
              <div className="field"><label>Responsável<select name="ownerUserId" className="input" defaultValue={r?.owner_user_id ?? p.userId}>{userOpts}</select></label></div>
              <div className="field"><label>Revisar a cada (meses)<input name="reviewMonths" type="number" min={1} max={36} defaultValue={r?.review_months ?? 6} className="input" /></label></div>
            </div>
            <div className="field" style={{ marginTop: 12 }}><label>Descrição / causas e consequências<textarea name="description" className="input" rows={2} defaultValue={r?.description ?? ''} /></label></div>
            <div className="field" style={{ marginTop: 12 }}><label>Controles existentes<textarea name="controls" className="input" rows={2} defaultValue={r?.controls ?? ''} /></label></div>
            <div className="field" style={{ marginTop: 12 }}><label>Observações desta avaliação<input name="notes" className="input" /></label></div>
          </>
        );
        return (
          <div className="stack">
            <div className="card"><div className="card-body flush table-wrap" tabIndex={0}>
              {rows.length ? <table className="table"><thead><tr><th>Risco</th><th>Categoria</th><th>P×I</th><th>Residual</th><th>Tratamento</th><th>Responsável</th><th>Revisão</th><th className="num">Ações</th>{manage ? <th></th> : null}</tr></thead>
                <tbody>{rows.map((r) => {
                  const band = riskBand(r.probability, r.impact);
                  return (
                    <tr key={r.id} className={r.status === 'ATIVO' ? undefined : 'row-muted'}>
                      <td><strong>{r.code}</strong> — {r.title}{r.controls ? <div className="small muted">Controles: {r.controls.slice(0, 120)}</div> : null}</td>
                      <td className="small">{label(r.category)}</td>
                      <td><span className={statusTone(band)}>{r.probability}×{r.impact} = {r.level} · {label(band)}</span></td>
                      <td className="small">{r.residual_probability ? `${r.residual_probability}×${r.residual_impact} (${label(riskBand(r.residual_probability, r.residual_impact!))})` : '—'}</td>
                      <td className="small">{label(r.treatment)}</td><td className="small">{r.owner_name}</td>
                      <td className={`small ${r.status === 'ATIVO' && r.next_review_on <= today ? 'neg' : ''}`}>{r.status === 'ATIVO' ? fmtDate(r.next_review_on) : 'Encerrado'}</td>
                      <td className="num">{r.actions}{r.actions_open ? <span className="small muted"> ({r.actions_open} abertas)</span> : null}</td>
                      {manage ? <td>{r.status === 'ATIVO' ? (
                        <details className="disclosure small"><summary><a>Reavaliar / ação</a></summary>
                          <div className="stack" style={{ minWidth: 420 }}>
                            <ActionForm action={qualityAction} submitLabel="Registrar reavaliação"><input type="hidden" name="op" value="risco" /><input type="hidden" name="id" value={r.id} /><RiskFields r={r} /></ActionForm>
                            <ActionForm action={qualityAction} submitLabel="Criar ação" resetOnSuccess>
                              <input type="hidden" name="op" value="acao" /><input type="hidden" name="riskId" value={r.id} />
                              <div className="form-grid">
                                <div className="field"><label>Tipo<select name="kind" className="input">{opts(['PREVENTIVA', 'MELHORIA'])}</select></label></div>
                                <div className="field"><label>Ação<input name="title" className="input" required minLength={3} /></label></div>
                                <div className="field"><label>Responsável<select name="responsibleUserId" className="input">{userOpts}</select></label></div>
                                <div className="field"><label>Prazo<input name="dueDate" type="date" className="input" defaultValue={addDays(today, 30)} required /></label></div>
                              </div>
                            </ActionForm>
                            <ActionForm action={qualityAction} submitLabel="Encerrar risco" submitClass="btn btn-sm btn-danger"><input type="hidden" name="op" value="encerrar_risco" /><input type="hidden" name="id" value={r.id} /><input name="notes" className="input" placeholder="Justificativa" aria-label="Justificativa" required minLength={5} /></ActionForm>
                          </div>
                        </details>) : null}</td> : null}
                    </tr>
                  );
                })}</tbody></table> : <Empty>Nenhum risco cadastrado.</Empty>}
            </div></div>
            <div className="small muted">Faixas (convenção interna ajustável): 1–4 baixo · 5–9 moderado · 10–16 alto · 20–25 crítico. Aceitar risco alto ou crítico é decisão da Oficial.</div>
            {manage ? <div className="card"><div className="card-head"><h2>Novo risco</h2></div><div className="card-body"><ActionForm action={qualityAction} submitLabel="Registrar risco" resetOnSuccess><input type="hidden" name="op" value="risco" /><RiskFields /></ActionForm></div></div> : null}
          </div>
        );
      })() : null}

      {tab === 'ativos' ? await (async () => {
        const rows = await listAssets(ctx);
        const edit = rows.find((a) => a.id === sp.ativo && a.status !== 'BAIXADO');
        return (
          <div className="stack">
            <div className="card"><div className="card-body flush table-wrap" tabIndex={0}>
              {rows.length ? <table className="table"><thead><tr><th>Ativo</th><th>Tipo</th><th>Local / setor</th><th>Responsável</th><th>Criticidade</th><th>Garantia</th><th>Validade</th><th>Situação</th>{assetsAdmin ? <th></th> : null}</tr></thead>
                <tbody>{rows.map((a) => (
                  <tr key={a.id} className={a.status === 'BAIXADO' ? 'row-muted' : undefined}>
                    <td><strong>{a.tag}</strong> — {a.name}{a.serial ? <div className="small muted">Série {a.serial}</div> : null}</td>
                    <td className="small">{label(a.kind)}</td><td className="small">{a.location ?? '—'}<div className="muted">{a.sector_name ?? ''}</div></td>
                    <td className="small">{a.responsible_name ?? '—'}</td><td className="small">{label(a.criticality)}</td>
                    <td className={`small ${a.warranty_until && a.warranty_until < today ? 'muted' : ''}`}>{fmtDate(a.warranty_until)}</td>
                    <td className={`small ${a.expires_on && a.expires_on < today && a.status !== 'BAIXADO' ? 'neg' : ''}`}>{fmtDate(a.expires_on)}</td>
                    <td><span className={statusTone(a.status)}>{label(a.status)}</span>{a.disposal_reason ? <div className="small muted">{a.disposal_reason}</div> : null}</td>
                    {assetsAdmin ? <td>{a.status !== 'BAIXADO' ? (
                      <details className="disclosure small"><summary><a>Opções</a></summary><div className="stack" style={{ minWidth: 280 }}>
                        <Link href={`/qualidade?aba=ativos&ativo=${a.id}#form-ativo`}>Editar / movimentar</Link>
                        <ActionForm action={securityAction} submitLabel="Registrar manutenção" submitClass="btn btn-sm"><input type="hidden" name="op" value="manutencao" /><input type="hidden" name="id" value={a.id} /><input name="notes" className="input" placeholder="Serviço realizado" aria-label="Serviço realizado" required minLength={3} /></ActionForm>
                        <ActionForm action={securityAction} submitLabel="Dar baixa" submitClass="btn btn-sm btn-danger" confirm="Dar baixa no ativo?"><input type="hidden" name="op" value="baixa" /><input type="hidden" name="id" value={a.id} /><input name="reason" className="input" placeholder="Motivo e destinação (ex.: descarte com sanitização de dados)" aria-label="Motivo da baixa" required minLength={3} /></ActionForm>
                      </div></details>) : null}</td> : null}
                  </tr>
                ))}</tbody></table> : <Empty>Nenhum ativo inventariado.</Empty>}
            </div></div>
            {assetsAdmin ? (
              <div className="card" id="form-ativo"><div className="card-head"><h2>{edit ? `Editar ${edit.tag}` : 'Novo ativo'}</h2>{edit ? <Link href="/qualidade?aba=ativos">Cancelar edição</Link> : null}</div><div className="card-body">
                <ActionForm action={securityAction} submitLabel="Salvar ativo" resetOnSuccess={!edit} key={edit?.id ?? 'novo'}>
                  <input type="hidden" name="op" value="ativo" />{edit ? <input type="hidden" name="id" value={edit.id} /> : null}
                  <div className="form-grid">
                    <div className="field"><label>Identificação/patrimônio<input name="tag" className="input" required defaultValue={edit?.tag} /></label></div>
                    <div className="field" style={{ gridColumn: 'span 2' }}><label>Descrição<input name="name" className="input" required minLength={2} defaultValue={edit?.name} /></label></div>
                    <div className="field"><label>Tipo<select name="kind" className="input" defaultValue={edit?.kind}>{opts(ASSET_KINDS)}</select></label></div>
                    <div className="field"><label>Nº de série<input name="serial" className="input" defaultValue={edit?.serial ?? ''} /></label></div>
                    <div className="field"><label>Localização<input name="location" className="input" defaultValue={edit?.location ?? ''} /></label></div>
                    <div className="field"><label>Setor<select name="sectorId" className="input" defaultValue={edit?.sector_id ?? ''}><option value="">—</option>{sectorOpts}</select></label></div>
                    <div className="field"><label>Responsável<select name="responsibleUserId" className="input" defaultValue={edit?.responsible_user_id ?? ''}><option value="">—</option>{userOpts}</select></label></div>
                    <div className="field"><label>Criticidade<select name="criticality" className="input" defaultValue={edit?.criticality ?? 'MEDIA'}>{opts(['BAIXA', 'MEDIA', 'ALTA'])}</select></label></div>
                    <div className="field"><label>Situação<select name="status" className="input" defaultValue={edit?.status ?? 'EM_USO'}>{opts(['EM_USO', 'ESTOQUE', 'MANUTENCAO'])}</select></label></div>
                    <div className="field"><label>Aquisição<input name="acquiredOn" type="date" className="input" defaultValue={edit?.acquired_on ?? ''} /></label></div>
                    <div className="field"><label>Garantia até<input name="warrantyUntil" type="date" className="input" defaultValue={edit?.warranty_until ?? ''} /></label></div>
                    <div className="field"><label>Validade (licença/certificado)<input name="expiresOn" type="date" className="input" defaultValue={edit?.expires_on ?? ''} /></label></div>
                  </div>
                  <div className="field" style={{ marginTop: 12 }}><label>Observações<input name="notes" className="input" defaultValue={edit?.notes ?? ''} /></label></div>
                </ActionForm>
              </div></div>
            ) : null}
          </div>
        );
      })() : null}

      {tab === 'backups' ? await (async () => {
        const { rows, status } = await listBackups(ctx);
        return (
          <div className="stack">
            <div className="card"><div className="card-head"><h2>Situação por sistema</h2><p>Teste de restauração bem-sucedido exigido a cada intervalo configurado (política interna).</p></div>
              <div className="card-body flush table-wrap" tabIndex={0}>{status.length ? <table className="table"><thead><tr><th>Sistema</th><th>Último backup</th><th>Último teste de restauração ok</th><th>Situação</th></tr></thead>
                <tbody>{status.map((b) => <tr key={b.system}><td>{b.system}</td><td className="small">{fmtDate(b.lastBackup)} {b.lastBackupResult ? <span className={statusTone(b.lastBackupResult)}>{label(b.lastBackupResult)}</span> : null}</td>
                  <td className="small">{fmtDate(b.lastRestoreOk)}{b.daysSinceRestore !== null ? ` (${b.daysSinceRestore} dias)` : ''}</td>
                  <td>{b.restoreOverdue ? <span className="tag tag-danger">Teste em atraso</span> : <span className="tag tag-ok">Em dia</span>}</td></tr>)}</tbody></table> : <Empty>Nenhum registro.</Empty>}</div></div>
            {assetsAdmin ? (
              <div className="card"><div className="card-head"><h2>Registrar backup ou teste de restauração</h2><p>Registros são imutáveis. Anexe o relatório da ferramenta quando houver.</p></div><div className="card-body">
                <ActionForm action={securityAction} submitLabel="Registrar" resetOnSuccess>
                  <input type="hidden" name="op" value="backup" />
                  <div className="form-grid">
                    <div className="field"><label>Tipo<select name="kind" className="input">{opts(['BACKUP', 'TESTE_RESTAURACAO'])}</select></label></div>
                    <div className="field"><label>Sistema<input name="system" className="input" list="systems" required minLength={2} /></label><datalist id="systems">{status.map((s) => <option key={s.system} value={s.system} />)}</datalist></div>
                    <div className="field"><label>Data<input name="performedOn" type="date" className="input" defaultValue={today} max={today} required /></label></div>
                    <div className="field"><label>Resultado<select name="result" className="input">{opts(['SUCESSO', 'PARCIAL', 'FALHA'])}</select></label></div>
                    <div className="field"><label>Relatório (opcional)<input name="file" type="file" className="input" /></label></div>
                  </div>
                  <div className="field" style={{ marginTop: 12 }}><label>Observações (obrigatório se não houve sucesso)<input name="notes" className="input" /></label></div>
                </ActionForm>
              </div></div>
            ) : null}
            <div className="card"><div className="card-head"><h2>Histórico</h2></div><div className="card-body flush table-wrap" tabIndex={0}>
              {rows.length ? <table className="table"><thead><tr><th>Data</th><th>Sistema</th><th>Tipo</th><th>Resultado</th><th>Observações</th><th>Registrado por</th></tr></thead>
                <tbody>{rows.map((b) => <tr key={b.id}><td className="small">{fmtDate(b.performed_on)}</td><td>{b.system}</td><td className="small">{label(b.kind)}</td><td><span className={statusTone(b.result)}>{label(b.result)}</span></td>
                  <td className="small">{b.notes ?? ''}{b.file_id ? <> · <a href={`/api/v1/qualidade/arquivos/${b.file_id}`}>relatório</a></> : null}</td><td className="small">{b.recorded_by_name}</td></tr>)}</tbody></table> : <Empty>Nenhum registro.</Empty>}
            </div></div>
          </div>
        );
      })() : null}

      {tab === 'vulnerabilidades' ? await (async () => {
        const [rows, assets] = await Promise.all([listVulnerabilities(ctx), listAssets(ctx)]);
        return (
          <div className="stack">
            <div className="card"><div className="card-body flush table-wrap" tabIndex={0}>
              {rows.length ? <table className="table"><thead><tr><th>Vulnerabilidade</th><th>Ativo</th><th>Severidade</th><th>Detectada</th><th>Prazo</th><th>Situação</th>{assetsAdmin ? <th></th> : null}</tr></thead>
                <tbody>{rows.map((v) => {
                  const open = v.status === 'ABERTA' || v.status === 'EM_TRATAMENTO';
                  return (
                    <tr key={v.id} className={open ? undefined : 'row-muted'}>
                      <td>{v.title}<div className="small muted">Fonte: {v.source}{v.resolution ? ` · ${v.resolution}` : ''}</div></td>
                      <td className="small">{v.asset_tag ?? '—'}</td><td><span className={statusTone(v.severity)}>{label(v.severity)}</span></td>
                      <td className="small">{fmtDate(v.detected_on)}</td><td className={`small ${v.overdue ? 'neg' : ''}`}>{fmtDate(v.due_on)}{v.overdue ? ' (vencido)' : ''}</td>
                      <td><span className={statusTone(v.status)}>{label(v.status)}</span></td>
                      {assetsAdmin ? <td>{open ? (
                        <details className="disclosure small"><summary><a>Atualizar</a></summary>
                          <ActionForm action={securityAction} submitLabel="Salvar" submitClass="btn btn-sm">
                            <input type="hidden" name="op" value="vuln_status" /><input type="hidden" name="id" value={v.id} />
                            <select name="status" className="input" aria-label="Situação">{v.status === 'ABERTA' ? <option value="EM_TRATAMENTO">Em tratamento</option> : null}<option value="CORRIGIDA">Corrigida</option><option value="RISCO_ACEITO">Risco aceito</option></select>
                            <input name="resolution" className="input" placeholder="Correção aplicada ou justificativa" aria-label="Resolução" />
                          </ActionForm>
                        </details>) : null}</td> : null}
                    </tr>
                  );
                })}</tbody></table> : <Empty>Nenhuma vulnerabilidade registrada.</Empty>}
            </div></div>
            {assetsAdmin ? (
              <div className="card"><div className="card-head"><h2>Registrar vulnerabilidade</h2><p>O prazo de correção é calculado pela severidade, conforme a política interna configurada.</p></div><div className="card-body">
                <ActionForm action={securityAction} submitLabel="Registrar" resetOnSuccess>
                  <input type="hidden" name="op" value="vulnerabilidade" />
                  <div className="form-grid">
                    <div className="field" style={{ gridColumn: 'span 2' }}><label>Descrição<input name="title" className="input" required minLength={3} /></label></div>
                    <div className="field"><label>Fonte (boletim, varredura, fornecedor)<input name="source" className="input" required minLength={2} /></label></div>
                    <div className="field"><label>Ativo<select name="assetId" className="input"><option value="">—</option>{assets.filter((a) => a.status !== 'BAIXADO').map((a) => <option key={a.id} value={a.id}>{a.tag} — {a.name}</option>)}</select></label></div>
                    <div className="field"><label>Severidade<select name="severity" className="input" defaultValue="MEDIA">{opts(SEV_OPTIONS)}</select></label></div>
                    <div className="field"><label>Detectada em<input name="detectedOn" type="date" className="input" defaultValue={today} max={today} required /></label></div>
                  </div>
                </ActionForm>
              </div></div>
            ) : null}
          </div>
        );
      })() : null}
    </div>
  );
}

export default withGuard(QualidadePage);
