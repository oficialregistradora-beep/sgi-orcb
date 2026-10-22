import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { acknowledgementReport, getDocument, listCategories, listDirectory, maxFileBytes } from '@/server/modules/repository.ts';
import { statementFor } from '@/server/modules/documents.ts';
import { ALLOWED_FILES } from '@/server/files.ts';
import { fmtDate, fmtDateTime, label, statusTone } from '@/ui/format.ts';
import { PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { MetaFields } from '../MetaFields.tsx';
import {
  acknowledgeAction, decideAction, lifecycleAction, saveDraftAction, submitAction, updateMetadataAction,
} from '../../../actions/phase3.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Documento' };

const EVENT_LABELS: Record<string, string> = {
  CRIADO: 'Documento criado', METADADOS: 'Dados alterados', RASCUNHO_SALVO: 'Rascunho salvo', SUBMETIDO: 'Versão submetida', REJEITADO: 'Versão rejeitada',
  APROVADO: 'Versão aprovada', CIENCIA: 'Ciência registrada', OBSOLETO: 'Declarado obsoleto', ARQUIVADO: 'Arquivado', DESCARTE: 'Descarte de conteúdo',
  AVISO_REVISAO: 'Aviso de revisão enviado',
};

function kb(n: number) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export default async function DocumentoPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageCtx();
  const { id } = await params;
  const { doc, access, versions, events, draftFile, myAck, canDecide } = await getDocument(ctx, id);
  const current = versions.find((v) => v.id === doc.current_version_id) ?? null;
  const pending = versions.find((v) => v.id === doc.pending_version_id) ?? null;
  const showMeta = access.edit || access.manage;
  const [categories, dir] = showMeta ? await Promise.all([listCategories(), listDirectory(ctx)]) : [[], { users: [], sectors: [] }];
  const report = (access.manage || doc.responsible_user_id === ctx.principal.userId || ctx.principal.isOwner) && doc.requires_acknowledgement
    ? await acknowledgementReport(ctx, id) : null;
  const maxMb = Math.floor((await maxFileBytes()) / 1048576);
  const accept = Object.keys(ALLOWED_FILES).map((e) => `.${e}`).join(',');

  return (
    <div className="stack">
      <PageHead
        title={doc.title}
        subtitle={<>{doc.code ? <span className="mono">{doc.code} · </span> : null}{doc.category_name} · Setor {doc.sector_name} · Responsável: {doc.responsible_name}</>}
        actions={<Link href="/documentos" className="btn btn-ghost">Voltar ao repositório</Link>}
      />
      <div className="row">
        <span className={statusTone(doc.status)}>{label(doc.status)}</span>
        <span className="tag">{label(doc.confidentiality)}</span>
        {doc.effective_from ? <span className="small muted">Vigente desde {fmtDate(doc.effective_from)}</span> : null}
        {doc.next_review_on ? <span className={doc.next_review_on < new Date().toISOString().slice(0, 10) ? 'tag tag-danger' : 'small muted'}>Próxima revisão: {fmtDate(doc.next_review_on)}</span> : null}
        {doc.retention_until ? <span className="small muted">Retenção até {fmtDate(doc.retention_until)}</span> : null}
      </div>
      {doc.summary ? <p className="muted">{doc.summary}</p> : null}

      {doc.requires_acknowledgement && current && access.audience ? (
        myAck ? <div className="alert alert-ok small"><div>Ciência registrada em {fmtDateTime(myAck)} para a versão {current.version_number}.</div></div> : (
          <div className="card">
            <div className="card-head"><h2>Registrar ciência</h2><p>Leia o documento abaixo antes de registrar.</p></div>
            <div className="card-body">
              <ActionForm action={acknowledgeAction} submitLabel="Registrar ciência">
                <input type="hidden" name="documentId" value={doc.id} />
                <label className="check"><input type="checkbox" name="confirmed" required /> {statementFor('CIENCIA', current.content_sha256)}</label>
              </ActionForm>
            </div>
          </div>
        )
      ) : null}

      {current ? (
        <div className="card">
          <div className="card-head">
            <div><h2>Versão vigente — v{current.version_number}</h2><p>Aprovada por {current.decided_by_name} em {fmtDateTime(current.decided_at)}</p></div>
            <a className="btn btn-sm" href={`/api/v1/documentos/${doc.id}/exportar/${current.id}`}>Exportar (JSON com hashes)</a>
          </div>
          <div className="card-body stack">
            {current.content.texto ? <div className="doc" style={{ whiteSpace: 'pre-wrap' }}>{current.content.texto}</div> : null}
            {current.content.arquivo ? (
              <div className="row">
                {current.file_purged ? <span className="tag">Arquivo descartado após retenção</span>
                  : <a className="btn btn-sm btn-primary" href={`/api/v1/documentos/${doc.id}/arquivo/${current.id}`}>Baixar {current.content.arquivo.nome}</a>}
                <span className="small muted">{kb(current.content.arquivo.bytes)} · SHA-256 <span className="mono hash">{current.content.arquivo.sha256}</span></span>
              </div>
            ) : null}
            <p className="small muted">Hash da versão (SHA-256): <span className="mono hash">{current.content_sha256}</span></p>
          </div>
        </div>
      ) : null}

      {pending ? (
        <div className="card">
          <div className="card-head"><div><h2>Versão {pending.version_number} aguardando aprovação</h2><p>Submetida por {pending.submitted_by_name} em {fmtDateTime(pending.created_at)}{pending.content.elaboradoPor ? ` · elaborada por ${pending.content.elaboradoPor.nome}` : ''}</p></div></div>
          <div className="card-body stack">
            {pending.content.notaVersao ? <p className="small"><strong>Nota da versão:</strong> {pending.content.notaVersao}</p> : null}
            {pending.content.texto ? <div className="doc" style={{ whiteSpace: 'pre-wrap' }}>{pending.content.texto}</div> : null}
            {pending.content.arquivo ? <a className="btn btn-sm" href={`/api/v1/documentos/${doc.id}/arquivo/${pending.id}`}>Baixar {pending.content.arquivo.nome}</a> : null}
            <p className="small muted">Hash (SHA-256): <span className="mono hash">{pending.content_sha256}</span></p>
            {canDecide ? (
              <div className="grid grid-2">
                <ActionForm action={decideAction} submitLabel="Aprovar e tornar vigente" confirm="A versão passará a vigorar imediatamente. Confirma?">
                  <input type="hidden" name="documentId" value={doc.id} /><input type="hidden" name="versionId" value={pending.id} /><input type="hidden" name="decision" value="APROVADA" />
                  <input name="notes" className="input" placeholder="Observação (opcional)" aria-label="Observação" />
                  <label className="check" style={{ marginTop: 6 }}><input type="checkbox" name="confirmed" required /> {statementFor('APROVACAO', pending.content_sha256)}</label>
                </ActionForm>
                <ActionForm action={decideAction} submitLabel="Rejeitar" submitClass="btn btn-danger">
                  <input type="hidden" name="documentId" value={doc.id} /><input type="hidden" name="versionId" value={pending.id} /><input type="hidden" name="decision" value="REJEITADA" />
                  <input name="notes" className="input" placeholder="Motivo da rejeição" aria-label="Motivo da rejeição" required minLength={5} />
                </ActionForm>
              </div>
            ) : access.approve ? <p className="small muted">Você elaborou ou submeteu esta versão: a decisão cabe a outra pessoa (segregação de funções).</p> : null}
          </div>
        </div>
      ) : null}

      {access.edit && !pending ? (
        <div className="card">
          <div className="card-head"><div><h2>{doc.current_version_id ? 'Rascunho da próxima revisão' : 'Rascunho'}</h2>
            <p>{doc.draft?.texto || draftFile ? `Última edição em ${fmtDateTime(doc.draft_updated_at)}` : 'Inclua o texto e/ou um arquivo e submeta à aprovação.'}</p></div></div>
          <div className="card-body stack">
            <details className="disclosure" open={!current || !!doc.draft}>
            <summary><a>{current && !doc.draft ? 'Iniciar revisão' : 'Editar rascunho'}</a></summary>
            <div className="stack">
            <ActionForm action={saveDraftAction} submitLabel="Salvar rascunho">
              <input type="hidden" name="documentId" value={doc.id} />
              <div className="field"><label htmlFor="d-texto">Texto do documento</label>
                <textarea id="d-texto" name="texto" className="input" rows={12} maxLength={200000} defaultValue={doc.draft?.texto ?? current?.content.texto ?? ''} />
              </div>
              <div className="form-grid" style={{ marginTop: 12 }}>
                <div className="field"><label htmlFor="d-nota">Nota da versão {doc.current_version_id ? '(obrigatória na revisão)' : ''}</label>
                  <input id="d-nota" name="notaVersao" className="input" maxLength={1000} defaultValue={doc.draft?.notaVersao ?? ''} /></div>
                <div className="field"><label htmlFor="d-file">Arquivo (até {maxMb} MB: PDF, DOCX, XLSX, ODT, ODS, PNG, JPG, TXT)</label>
                  <input id="d-file" name="file" type="file" className="input" accept={accept} /></div>
              </div>
              {draftFile ? (
                <div className="row small" style={{ marginTop: 8 }}>
                  <a href={`/api/v1/documentos/${doc.id}/arquivo/rascunho`}>{draftFile.filename}</a><span className="muted">{kb(draftFile.size_bytes)}</span>
                  <label className="check"><input type="checkbox" name="removeFile" /> Remover arquivo</label>
                </div>
              ) : null}
            </ActionForm>
            <ActionForm action={submitAction} submitLabel="Submeter à aprovação" submitClass="btn btn-primary" confirm="O conteúdo do rascunho será congelado como nova versão. Confirma?">
              <input type="hidden" name="documentId" value={doc.id} />
              <p className="small muted">Salve o rascunho antes de submeter. A aprovação cabe a outra pessoa com permissão.</p>
            </ActionForm>
            </div>
            </details>
          </div>
        </div>
      ) : null}

      {report ? (
        <div className="card">
          <div className="card-head"><div><h2>Ciência da versão {report.versionNumber}</h2><p>{report.done} de {report.total} pessoa(s) do público</p></div></div>
          <div className="card-body flush table-wrap">
            <table className="table"><thead><tr><th>Pessoa</th><th>Setor</th><th>Ciência</th></tr></thead>
              <tbody>{report.rows.map((r) => (
                <tr key={r.id}><td>{r.display_name}</td><td className="small">{r.sector_name ?? '—'}</td>
                  <td>{r.signed_at ? <span className="tag tag-ok">{fmtDateTime(r.signed_at)}</span> : <span className="tag tag-warn">Pendente</span>}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      ) : null}

      {showMeta ? (
        <div className="card">
          <div className="card-head"><div><h2>Dados e acesso</h2><p>{doc.current_version_id && !access.manage ? 'Alterações de acesso em documento publicado exigem permissão de gestão.' : 'Alterações ficam registradas no histórico.'}</p></div></div>
          <div className="card-body">
            <details className="disclosure"><summary><a>Editar dados e acesso</a></summary>
              <ActionForm action={updateMetadataAction} submitLabel="Salvar dados">
                <input type="hidden" name="documentId" value={doc.id} />
                <MetaFields categories={categories} dir={dir} doc={doc} prefix="ed" />
              </ActionForm>
            </details>
          </div>
        </div>
      ) : null}

      {access.manage ? (
        <div className="card">
          <div className="card-head"><div><h2>Ciclo de vida</h2><p>Obsolescência, arquivamento e descarte após a retenção.</p></div></div>
          <div className="card-body grid grid-3">
            {doc.status === 'VIGENTE' ? (
              <ActionForm action={lifecycleAction} submitLabel="Declarar obsoleto" submitClass="btn">
                <input type="hidden" name="documentId" value={doc.id} /><input type="hidden" name="op" value="OBSOLETO" />
                <input name="reason" className="input" placeholder="Motivo" aria-label="Motivo da obsolescência" required minLength={5} />
              </ActionForm>
            ) : null}
            {doc.status !== 'ARQUIVADO' ? (
              <ActionForm action={lifecycleAction} submitLabel="Arquivar" submitClass="btn" confirm="Arquivar o documento? Ele sai do repositório em uso.">
                <input type="hidden" name="documentId" value={doc.id} /><input type="hidden" name="op" value="ARQUIVADO" />
                <input name="reason" className="input" placeholder="Motivo" aria-label="Motivo do arquivamento" required minLength={5} />
              </ActionForm>
            ) : null}
            {can(ctx.principal, 'documentos.descartar') && (doc.status === 'ARQUIVADO' || doc.status === 'OBSOLETO') ? (
              <ActionForm action={lifecycleAction} submitLabel="Descartar conteúdo dos arquivos" submitClass="btn btn-danger" confirm="O conteúdo dos arquivos será eliminado definitivamente (metadados e hashes permanecem). Confirma?">
                <input type="hidden" name="documentId" value={doc.id} /><input type="hidden" name="op" value="DESCARTE" />
                <input name="reason" className="input" placeholder="Fundamento do descarte" aria-label="Fundamento do descarte" required minLength={5} />
                <p className="small muted">{doc.retention_until ? `Permitido a partir de ${fmtDate(doc.retention_until)}.` : 'Bloqueado: prazo de retenção não definido.'}</p>
              </ActionForm>
            ) : null}
          </div>
        </div>
      ) : null}

      {access.history ? (
        <div className="grid grid-2">
          <div className="card">
            <div className="card-head"><h2>Versões</h2></div>
            <div className="card-body flush table-wrap">
              <table className="table"><thead><tr><th>Versão</th><th>Decisão</th><th>Ciências</th><th></th></tr></thead>
                <tbody>{versions.map((v) => (
                  <tr key={v.id}>
                    <td>v{v.version_number}<div className="small muted">{fmtDateTime(v.created_at)} · {v.submitted_by_name}</div>{v.content.notaVersao ? <div className="small">{v.content.notaVersao}</div> : null}</td>
                    <td>{v.decision ? <span className={statusTone(v.decision)}>{label(v.decision)}</span> : <span className="tag tag-warn">Aguardando</span>}
                      {v.decided_by_name ? <div className="small muted">{v.decided_by_name}</div> : null}{v.decision_notes ? <div className="small">{v.decision_notes}</div> : null}
                      {v.superseded_at ? <div className="small muted">Substituída em {fmtDate(v.superseded_at.toISOString().slice(0, 10))}</div> : null}</td>
                    <td className="num">{v.acks}</td>
                    <td><a className="small" href={`/api/v1/documentos/${doc.id}/exportar/${v.id}`}>Exportar</a></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Histórico</h2></div>
            <div className="card-body flush table-wrap">
              <table className="table"><tbody>{events.map((e) => (
                <tr key={e.id}><td className="small nowrap">{fmtDateTime(e.created_at)}</td><td className="small">{EVENT_LABELS[e.event] ?? e.event}<div className="muted">{e.user_name ?? 'Rotina automática'}</div></td>
                  <td className="small muted" style={{ wordBreak: 'break-word' }}>{Object.keys(e.details).length ? JSON.stringify(e.details) : ''}</td></tr>
              ))}</tbody></table>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
