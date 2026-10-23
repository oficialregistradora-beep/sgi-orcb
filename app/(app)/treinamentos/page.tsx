import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { getPool, query } from '@/server/db.ts';
import { complianceMatrix, listTrainings, myTrainings, pendingValidations } from '@/server/modules/training.ts';
import { listDocuments } from '@/server/modules/repository.ts';
import { directory } from '@/server/modules/directory.ts';
import { todayLocal } from '@/domain/time.ts';
import { fmtDate, fmtMin, label } from '@/ui/format.ts';
import { Empty, PageHead, Stat } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { trainingAction } from '../../actions/phase5b.ts';
import { KIND_LABEL, Situation, TrainingFields } from '@/ui/development.tsx';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Treinamentos' };

async function TreinamentosPage({ searchParams }: { searchParams: Promise<{ aba?: string }> }) {
  const ctx = await requirePageCtx();
  const p = ctx.principal;
  const sp = await searchParams;
  const manage = can(p, 'treinamentos.gerenciar');
  const registrar = can(p, 'treinamentos.registrar');
  const teamView = registrar || (can(p, 'treinamentos.ver') && p.grants.get('treinamentos.ver')?.scope !== 'PROPRIO') || p.isOwner;
  if (!can(p, 'treinamentos.ver') && !manage) return <div className="stack"><PageHead title="Treinamentos" /><div className="alert alert-warn">Você não tem acesso a este módulo.</div></div>;
  const TABS = { meus: 'Meus treinamentos', equipe: 'Capacitação da equipe', catalogo: 'Catálogo', validacoes: 'Validações' } as const;
  const visible: Record<keyof typeof TABS, boolean> = { meus: !!p.employeeId, equipe: teamView, catalogo: true, validacoes: registrar };
  const first = (Object.keys(TABS) as (keyof typeof TABS)[]).find((k) => visible[k])!;
  const tab = (sp.aba && sp.aba in TABS && visible[sp.aba as keyof typeof TABS] ? sp.aba : first) as keyof typeof TABS;
  const today = todayLocal();

  return (
    <div className="stack">
      <PageHead title="Treinamentos e capacitação" subtitle="Cursos, estudo de POPs, certificados, reciclagens e avaliações de aprendizagem." />
      <nav className="tabs">{(Object.keys(TABS) as (keyof typeof TABS)[]).filter((k) => visible[k]).map((k) => <Link key={k} href={`/treinamentos?aba=${k}`} aria-current={tab === k ? 'page' : undefined}>{TABS[k]}</Link>)}</nav>

      {tab === 'meus' ? await (async () => {
        const rows = await myTrainings(ctx);
        const pend = rows.filter((r) => r.required && ['PENDENTE', 'VENCIDO', 'NOVA_VERSAO'].includes(r.situation)).length;
        return (
          <div className="stack">
            <div className="grid grid-3">
              <Stat label="Obrigatórios pendentes ou vencidos" value={pend} tone={pend ? 'neg' : undefined} />
              <Stat label="Em dia" value={rows.filter((r) => r.situation === 'VALIDO' || r.situation === 'A_VENCER').length} />
              <Stat label="Carga horária concluída" value={fmtMin(rows.flatMap((r) => r.records).filter((x) => x.status === 'CONCLUIDO').reduce((a, x) => a + (x.minutes ?? 0), 0))} />
            </div>
            <div className="card"><div className="card-body flush table-wrap" tabIndex={0}>
              {rows.length ? <table className="table"><thead><tr><th>Treinamento</th><th>Tipo</th><th>Situação</th><th>Concluído</th><th>Validade</th><th></th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.training.id}>
                    <td><Link href={`/treinamentos/${r.training.id}`}>{r.training.code}</Link> — {r.training.title}{r.required ? <span className="tag" style={{ marginLeft: 6 }}>Obrigatório</span> : null}</td>
                    <td className="small">{KIND_LABEL[r.training.kind]}</td>
                    <td><Situation s={r.situation} />{r.records.some((x) => x.status === 'PENDENTE_VALIDACAO') ? <div className="small muted">certificado em validação</div> : null}</td>
                    <td className="small">{fmtDate(r.completedOn)}</td><td className="small">{r.expiresOn ? fmtDate(r.expiresOn) : '—'}</td>
                    <td><Link className="btn btn-sm" href={`/treinamentos/${r.training.id}`}>{r.training.kind === 'ESTUDO_POP' && r.situation !== 'VALIDO' ? 'Estudar' : 'Abrir'}</Link></td>
                  </tr>
                ))}</tbody></table> : <Empty>Nenhum treinamento atribuído a você.</Empty>}
            </div></div>
          </div>
        );
      })() : null}

      {tab === 'equipe' ? await (async () => {
        const m = await complianceMatrix(ctx);
        return (
          <div className="stack">
            <div className="grid grid-3">
              <Stat label="Capacitação obrigatória em dia" value={m.summary.pct === null ? '—' : `${m.summary.pct.toLocaleString('pt-BR')}%`} hint={`${m.summary.ok} de ${m.summary.required} exigências`} />
              <Stat label="Treinamentos vencidos" value={m.summary.expired} tone={m.summary.expired ? 'neg' : undefined} />
              <Stat label="Pessoas" value={m.rows.length} />
            </div>
            <div className="card"><div className="card-head"><h2>Matriz de capacitação obrigatória</h2></div><div className="card-body flush table-wrap" tabIndex={0}>
              {m.trainings.length ? <table className="table"><thead><tr><th>Pessoa</th>{m.trainings.map((t) => <th key={t.id} title={t.title}>{t.code}</th>)}</tr></thead>
                <tbody>{m.rows.map((r) => <tr key={r.person.id}><td>{r.person.full_name}<div className="small muted">{r.person.sector_name}</div></td>
                  {r.cells.map((c, i) => <td key={i}>{c ? <Situation s={c} /> : <span className="muted small">n/a</span>}</td>)}</tr>)}</tbody></table> : <Empty>Nenhum treinamento obrigatório cadastrado.</Empty>}
            </div></div>
          </div>
        );
      })() : null}

      {tab === 'catalogo' ? await (async () => {
        const rows = await listTrainings(ctx);
        const dir = manage ? await directory(ctx) : null;
        const jobs = manage ? await query<{ id: string; name: string }>(getPool(), 'SELECT id, name FROM job_titles ORDER BY name') : [];
        const docs = manage && can(p, 'documentos.ver') ? (await listDocuments(ctx, {})).filter((d) => d.status === 'VIGENTE') : [];
        return (
          <div className="stack">
            <div className="card"><div className="card-body flush table-wrap" tabIndex={0}>
              {rows.length ? <table className="table"><thead><tr><th>Treinamento</th><th>Tipo</th><th>Público</th><th>Carga</th><th>Reciclagem</th><th>Avaliação</th></tr></thead>
                <tbody>{rows.map((t) => (
                  <tr key={t.id} className={t.active ? undefined : 'row-muted'}>
                    <td><Link href={`/treinamentos/${t.id}`}>{t.code}</Link> — {t.title}{t.document_title ? <div className="small muted">Documento: {t.document_title}</div> : null}</td>
                    <td className="small">{KIND_LABEL[t.kind]}</td>
                    <td className="small">{t.mandatory ? <strong>Obrigatório · </strong> : 'Opcional · '}{t.audience_type === 'TODOS' ? 'todos' : t.audience_type === 'SETORES' ? `${t.sectors.length} setor(es)` : `${t.jobs.length} cargo(s)`}</td>
                    <td className="small">{t.workload_minutes ? fmtMin(t.workload_minutes) : '—'}</td>
                    <td className="small">{t.validity_months ? `${t.validity_months} meses` : 'Não'}</td>
                    <td className="small">{t.has_assessment ? `${t.questions} questões · mín. ${t.pass_score}%` : '—'}</td>
                  </tr>
                ))}</tbody></table> : <Empty>Nenhum treinamento cadastrado.</Empty>}
            </div></div>
            {manage && dir ? (
              <div className="card"><div className="card-head"><h2>Novo treinamento</h2><p>Defina o público obrigatório e, se houver, a validade (reciclagem) e a avaliação de aprendizagem.</p></div><div className="card-body">
                <ActionForm action={trainingAction} submitLabel="Salvar treinamento">
                  <input type="hidden" name="op" value="treinamento" />
                  <TrainingFields sectors={dir.sectors} jobs={jobs} docs={docs.map((d) => ({ id: d.id, title: `${d.code ? `${d.code} — ` : ''}${d.title}` }))} />
                </ActionForm>
              </div></div>
            ) : null}
          </div>
        );
      })() : null}

      {tab === 'validacoes' ? await (async () => {
        const rows = await pendingValidations(ctx);
        return (
          <div className="card"><div className="card-head"><h2>Certificados aguardando validação</h2><p>Confira o certificado antes de validar. Ninguém valida o próprio registro.</p></div><div className="card-body flush table-wrap" tabIndex={0}>
            {rows.length ? <table className="table"><thead><tr><th>Pessoa</th><th>Treinamento</th><th>Conclusão</th><th>Certificado</th><th></th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}><td>{r.full_name}</td><td>{r.training_code} — {r.training_title}{r.notes ? <div className="small muted">{r.notes}</div> : null}</td><td className="small">{fmtDate(r.completed_on)}{r.minutes ? ` · ${fmtMin(r.minutes)}` : ''}</td>
                  <td className="small">{r.certificate_file_id ? <a href={`/api/v1/treinamentos/certificados/${r.certificate_file_id}`}>baixar</a> : '—'}</td>
                  <td><ActionForm action={trainingAction} submitLabel="Registrar" submitClass="btn btn-sm">
                    <input type="hidden" name="op" value="validar" /><input type="hidden" name="recordId" value={r.id} />
                    <div className="row"><select name="decision" className="input" aria-label="Decisão"><option value="aprovar">Validar</option><option value="recusar">Recusar</option></select>
                      <input name="notes" className="input" placeholder="Observação (obrigatória na recusa)" aria-label="Observação" /></div>
                  </ActionForm></td></tr>
              ))}</tbody></table> : <Empty>Nada aguardando validação.</Empty>}
          </div></div>
        );
      })() : null}
    </div>
  );
}

export default withGuard(TreinamentosPage);
