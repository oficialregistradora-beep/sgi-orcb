import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import {
  listCategories, listDirectory, listDocuments, listPendingAcknowledgements, listPendingDocApprovals, listReviewsDue, type DocStatus,
} from '@/server/modules/repository.ts';
import { fmtDate, fmtDateTime, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { MetaFields } from './MetaFields.tsx';
import { categoryAction, createDocumentAction } from '../../actions/phase3.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Gestão documental' };

const STATUSES: (DocStatus | 'TODOS')[] = ['VIGENTE', 'EM_APROVACAO', 'RASCUNHO', 'OBSOLETO', 'ARQUIVADO', 'TODOS'];

export default async function DocumentosPage({ searchParams }: { searchParams: Promise<{ aba?: string; q?: string; categoria?: string; situacao?: string }> }) {
  const ctx = await requirePageCtx();
  const p = ctx.principal;
  const sp = await searchParams;
  const canEdit = can(p, 'documentos.editar');
  const canManage = can(p, 'documentos.gerenciar');
  const canApprove = can(p, 'documentos.aprovar');
  const tabs = [
    { key: 'repositorio', label: 'Repositório', show: true },
    { key: 'ciencia', label: 'Para ciência', show: true },
    { key: 'aprovacoes', label: 'Aprovações', show: canApprove },
    { key: 'revisoes', label: 'Revisões', show: canEdit || canManage || canApprove },
    { key: 'novo', label: 'Novo documento', show: canEdit },
    { key: 'categorias', label: 'Categorias', show: canManage },
  ].filter((t) => t.show);
  const tab = tabs.find((t) => t.key === sp.aba)?.key ?? 'repositorio';
  const status = STATUSES.includes(sp.situacao as DocStatus) ? (sp.situacao as DocStatus) : undefined;
  const categories = await listCategories();
  const acks = await listPendingAcknowledgements(ctx);

  return (
    <div className="stack">
      <PageHead title="Gestão documental" subtitle="Repositório institucional com versões, aprovação, vigência, revisão periódica, ciência e controle de acesso." />
      <nav className="tabs">
        {tabs.map((t) => (
          <Link key={t.key} href={`/documentos?aba=${t.key}`} aria-current={tab === t.key ? 'page' : undefined}>
            {t.label}{t.key === 'ciencia' && acks.length ? <span className="tag tag-warn" style={{ marginLeft: 6 }}>{acks.length}</span> : null}
          </Link>
        ))}
      </nav>

      {tab === 'repositorio' ? await (async () => {
        const docs = await listDocuments(ctx, { q: sp.q, categoryId: sp.categoria, status });
        return (
          <div className="card">
            <div className="card-head">
              <form className="row" method="get" action="/documentos" role="search">
                <input type="hidden" name="aba" value="repositorio" />
                <input name="q" className="input" placeholder="Pesquisar título, código ou conteúdo" aria-label="Pesquisar" defaultValue={sp.q ?? ''} style={{ minWidth: 240 }} />
                <select name="categoria" className="input" aria-label="Categoria" defaultValue={sp.categoria ?? ''}>
                  <option value="">Todas as categorias</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <select name="situacao" className="input" aria-label="Situação" defaultValue={sp.situacao ?? ''}>
                  <option value="">Em uso (exceto arquivados)</option>
                  {STATUSES.map((s) => <option key={s} value={s}>{s === 'TODOS' ? 'Todas as situações' : label(s)}</option>)}
                </select>
                <button type="submit" className="btn">Filtrar</button>
              </form>
            </div>
            <div className="card-body flush table-wrap">
              {docs.length ? (
                <table className="table">
                  <thead><tr><th>Documento</th><th>Categoria</th><th>Situação</th><th>Vigência</th><th>Próxima revisão</th><th>Responsável</th></tr></thead>
                  <tbody>{docs.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <Link href={`/documentos/${d.id}`}>{d.title}</Link>
                        <div className="small muted">{d.code ? <span className="mono">{d.code}</span> : null}{d.current_version_number ? ` · v${d.current_version_number}` : ''}
                          {d.confidentiality !== 'INTERNO' ? <> · <span className="tag">{label(d.confidentiality)}</span></> : null}
                          {d.requires_acknowledgement && d.status === 'VIGENTE' && d.access.audience ? (d.my_ack ? ' · ciência registrada' : <> · <span className="tag tag-warn">ciência pendente</span></>) : null}
                        </div>
                      </td>
                      <td className="small">{d.category_name}</td>
                      <td><span className={statusTone(d.status)}>{label(d.status)}</span>{d.pending_version_id && d.status === 'VIGENTE' ? <div className="small muted">revisão em aprovação</div> : null}</td>
                      <td className="small nowrap">{d.effective_from ? fmtDate(d.effective_from) : '—'}</td>
                      <td className="small nowrap">{d.next_review_on ? fmtDate(d.next_review_on) : '—'}</td>
                      <td className="small">{d.responsible_name}</td>
                    </tr>
                  ))}</tbody>
                </table>
              ) : <Empty>Nenhum documento encontrado.</Empty>}
            </div>
          </div>
        );
      })() : null}

      {tab === 'ciencia' ? (
        <div className="card">
          <div className="card-head"><h2>Documentos aguardando sua ciência</h2><p>Leia o documento e registre a ciência (assinatura eletrônica simples, vinculada à versão).</p></div>
          <div className="card-body flush table-wrap">
            {acks.length ? (
              <table className="table"><thead><tr><th>Documento</th><th>Versão</th><th>Vigente desde</th></tr></thead>
                <tbody>{acks.map((d) => <tr key={d.id}><td><Link href={`/documentos/${d.id}`}>{d.title}</Link>{d.code ? <span className="small muted mono"> {d.code}</span> : null}</td><td>v{d.version}</td><td>{fmtDate(d.effective_from)}</td></tr>)}</tbody>
              </table>
            ) : <Empty>Nenhuma ciência pendente.</Empty>}
          </div>
        </div>
      ) : null}

      {tab === 'aprovacoes' ? await (async () => {
        const rows = await listPendingDocApprovals(ctx);
        return (
          <div className="card">
            <div className="card-head"><h2>Versões aguardando sua decisão</h2><p>Versões elaboradas ou submetidas por você não aparecem aqui (segregação de funções).</p></div>
            <div className="card-body flush table-wrap">
              {rows.length ? (
                <table className="table"><thead><tr><th>Documento</th><th>Versão</th><th>Submetida em</th></tr></thead>
                  <tbody>{rows.map((d) => <tr key={d.id}><td><Link href={`/documentos/${d.id}`}>{d.title}</Link></td><td>v{d.version}</td><td>{fmtDateTime(d.submitted_at)}</td></tr>)}</tbody>
                </table>
              ) : <Empty>Nenhuma versão aguardando decisão.</Empty>}
            </div>
          </div>
        );
      })() : null}

      {tab === 'revisoes' ? await (async () => {
        const rows = await listReviewsDue(ctx);
        return (
          <div className="card">
            <div className="card-head"><h2>Revisões periódicas</h2><p>Documentos vigentes com revisão vencida ou próxima.</p></div>
            <div className="card-body flush table-wrap">
              {rows.length ? (
                <table className="table"><thead><tr><th>Documento</th><th>Revisão prevista</th><th>Responsável</th></tr></thead>
                  <tbody>{rows.map((d) => (
                    <tr key={d.id}><td><Link href={`/documentos/${d.id}`}>{d.title}</Link></td>
                      <td><span className={d.overdue ? 'tag tag-danger' : 'tag tag-warn'}>{fmtDate(d.next_review_on)}{d.overdue ? ' — vencida' : ''}</span></td><td className="small">{d.responsible_name}</td></tr>
                  ))}</tbody>
                </table>
              ) : <Empty>Nenhuma revisão vencida ou próxima.</Empty>}
            </div>
          </div>
        );
      })() : null}

      {tab === 'novo' ? await (async () => {
        const dir = await listDirectory(ctx);
        return (
          <div className="card">
            <div className="card-head"><h2>Novo documento</h2><p>O documento nasce em rascunho; só fica disponível ao público após aprovação por outra pessoa.</p></div>
            <div className="card-body">
              <ActionForm action={createDocumentAction} submitLabel="Criar rascunho">
                <MetaFields categories={categories} dir={dir} prefix="novo" />
              </ActionForm>
            </div>
          </div>
        );
      })() : null}

      {tab === 'categorias' ? (
        <div className="stack">
          <div className="alert alert-info small"><div>
            Prazos de retenção <strong>não foram presumidos</strong>: definem-se pela tabela de temporalidade da serventia, com fundamento registrado
            (pendência J-15). Sem prazo definido, o descarte de conteúdo fica bloqueado.
          </div></div>
          <div className="card">
            <div className="card-head"><h2>Categorias</h2><p>{categories.length} categoria(s)</p></div>
            <div className="card-body flush table-wrap">
              <table className="table">
                <thead><tr><th>Categoria</th><th>Revisão</th><th>Retenção</th><th>Confidencialidade padrão</th><th className="num">Docs</th><th></th></tr></thead>
                <tbody>{categories.map((c) => (
                  <tr key={c.id} className={c.active ? undefined : 'row-muted'}>
                    <td>{c.name}<div className="small muted mono">{c.code}</div></td>
                    <td className="small">{c.review_months ? `${c.review_months} meses` : '—'}</td>
                    <td className="small">{c.retention_months ? `${c.retention_months} meses` : <span className="tag tag-warn">A definir</span>}{c.retention_basis ? <div className="muted">{c.retention_basis}</div> : null}</td>
                    <td className="small">{label(c.default_confidentiality)}</td>
                    <td className="num">{c.documents}</td>
                    <td style={{ minWidth: 220 }}>
                      <details className="disclosure small"><summary><a>Editar</a></summary>
                        <ActionForm action={categoryAction} submitLabel="Salvar" submitClass="btn btn-sm btn-primary">
                          <input type="hidden" name="id" value={c.id} />
                          <CategoryFields c={c} />
                        </ActionForm>
                      </details>
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Nova categoria</h2></div>
            <div className="card-body"><ActionForm action={categoryAction} submitLabel="Criar categoria" resetOnSuccess><CategoryFields /></ActionForm></div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CategoryFields({ c }: { c?: Awaited<ReturnType<typeof listCategories>>[number] }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <input name="code" className="input mono" placeholder="CÓDIGO" aria-label="Código" required defaultValue={c?.code} />
      <input name="name" className="input" placeholder="Nome" aria-label="Nome" required minLength={3} defaultValue={c?.name} />
      <input name="reviewMonths" type="number" min={1} max={120} className="input" placeholder="Revisão (meses)" aria-label="Revisão em meses" defaultValue={c?.review_months ?? ''} />
      <input name="retentionMonths" type="number" min={1} max={1200} className="input" placeholder="Retenção (meses)" aria-label="Retenção em meses" defaultValue={c?.retention_months ?? ''} />
      <input name="retentionBasis" className="input" placeholder="Fundamento da retenção" aria-label="Fundamento da retenção" defaultValue={c?.retention_basis ?? ''} />
      <select name="defaultConfidentiality" className="input" aria-label="Confidencialidade padrão" defaultValue={c?.default_confidentiality ?? 'INTERNO'}>
        {['INTERNO', 'RESTRITO', 'CONFIDENCIAL'].map((x) => <option key={x} value={x}>{label(x)}</option>)}
      </select>
      <label className="check"><input type="checkbox" name="active" defaultChecked={c?.active ?? true} /> Ativa</label>
    </div>
  );
}
