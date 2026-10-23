import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { NotFoundError } from '@/server/errors.ts';
import { getRequirement, listRequirements } from '@/server/modules/quality.ts';
import { listDocuments } from '@/server/modules/repository.ts';
import { directory } from '@/server/modules/directory.ts';
import { fmtDate, fmtDateTime, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { qualityAction } from '../../../../actions/phase5a.ts';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Requisito' };

async function RequisitoPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageCtx();
  const { id } = await params;
  const p = ctx.principal;
  const r = (await listRequirements(ctx)).find((x) => x.id === id);
  if (!r) throw new NotFoundError('Requisito não encontrado.');
  const { evidences, reviews } = await getRequirement(ctx, id);
  const manage = can(p, 'qualidade.gerenciar');
  const evaluate = r.owner_user_id === p.userId || manage || can(p, 'qualidade.auditar');
  const docs = evaluate && can(p, 'documentos.ver') ? (await listDocuments(ctx, {})).filter((d) => d.status === 'VIGENTE') : [];
  const dir = manage ? await directory(ctx) : null;

  return (
    <div className="stack">
      <PageHead title={`${r.code} — ${r.title}`} subtitle={<>Fonte: {r.source} · Área {r.area} · Responsável {r.owner_name}</>} actions={<Link className="btn" href="/qualidade?aba=requisitos">Voltar</Link>} />
      <div className="card"><div className="card-body row">
        <span className={statusTone(r.status)}>{label(r.status)}</span>
        {r.status_notes ? <span className="small">{r.status_notes}</span> : null}
        <span className="small muted">Última avaliação: {fmtDateTime(r.last_reviewed_at)} · Próxima: {fmtDate(r.next_review_on)}</span>
      </div></div>

      {evaluate ? (
        <div className="grid grid-2">
          <div className="card"><div className="card-head"><h2>Registrar evidência</h2><p>Documento vigente do repositório e/ou arquivo (verificado pelo antivírus).</p></div><div className="card-body">
            <ActionForm action={qualityAction} submitLabel="Registrar evidência" resetOnSuccess>
              <input type="hidden" name="op" value="evidencia" /><input type="hidden" name="id" value={id} />
              <div className="field"><label>Descrição<input name="description" className="input" required minLength={3} /></label></div>
              <div className="field"><label>Documento do repositório<select name="documentId" className="input"><option value="">—</option>{docs.map((d) => <option key={d.id} value={d.id}>{d.code ? `${d.code} — ` : ''}{d.title}</option>)}</select></label></div>
              <div className="field"><label>Arquivo<input name="file" type="file" className="input" /></label></div>
            </ActionForm>
          </div></div>
          <div className="card"><div className="card-head"><h2>Avaliar</h2><p>“Atendido” exige evidência registrada; os demais exigem justificativa. A avaliação é da serventia — não é certificação.</p></div><div className="card-body">
            <ActionForm action={qualityAction} submitLabel="Registrar avaliação">
              <input type="hidden" name="op" value="avaliar_requisito" /><input type="hidden" name="id" value={id} />
              <div className="field"><label>Situação<select name="status" className="input">{['ATENDIDO', 'PARCIAL', 'NAO_ATENDIDO', 'NAO_APLICAVEL'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></label></div>
              <div className="field"><label>Justificativa / observações<textarea name="notes" className="input" rows={2} /></label></div>
            </ActionForm>
          </div></div>
        </div>
      ) : null}

      <div className="card"><div className="card-head"><h2>Evidências</h2></div><div className="card-body flush table-wrap" tabIndex={0}>
        {evidences.length ? <table className="table"><tbody>{evidences.map((e) => (
          <tr key={e.id}><td>{e.description}{e.document_id ? <div className="small"><Link href={`/documentos/${e.document_id}`}>{e.document_title}</Link></div> : null}
            {e.file_id ? <div className="small"><a href={`/api/v1/qualidade/arquivos/${e.file_id}`}>{e.filename}</a></div> : null}</td>
            <td className="small">{e.added_by_name}<div className="muted">{fmtDateTime(e.added_at)}</div></td></tr>
        ))}</tbody></table> : <Empty>Nenhuma evidência.</Empty>}
      </div></div>

      <div className="card"><div className="card-head"><h2>Histórico de avaliações</h2></div><div className="card-body flush table-wrap" tabIndex={0}>
        {reviews.length ? <table className="table"><tbody>{reviews.map((v, i) => (
          <tr key={i}><td><span className={statusTone(v.status)}>{label(v.status)}</span></td><td className="small">{v.notes ?? ''}</td><td className="small">{v.reviewed_by_name}<div className="muted">{fmtDateTime(v.reviewed_at)}</div></td></tr>
        ))}</tbody></table> : <Empty>Ainda não avaliado.</Empty>}
      </div></div>

      {manage && dir ? (
        <details className="card disclosure"><summary className="card-head"><h2>Editar requisito</h2></summary><div className="card-body">
          <ActionForm action={qualityAction} submitLabel="Salvar">
            <input type="hidden" name="op" value="requisito" /><input type="hidden" name="id" value={id} /><input type="hidden" name="activeField" value="1" />
            <div className="form-grid">
              <div className="field"><label>Código<input name="code" className="input" defaultValue={r.code} required /></label></div>
              <div className="field" style={{ gridColumn: 'span 2' }}><label>Título<input name="title" className="input" defaultValue={r.title} required /></label></div>
              <div className="field" style={{ gridColumn: 'span 2' }}><label>Fonte<input name="source" className="input" defaultValue={r.source} required /></label></div>
              <div className="field"><label>Área<input name="area" className="input" defaultValue={r.area} required /></label></div>
              <div className="field"><label>Responsável<select name="ownerUserId" className="input" defaultValue={r.owner_user_id}>{dir.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label></div>
              <div className="field"><label>Revisar a cada (meses)<input name="reviewMonths" type="number" min={1} max={60} defaultValue={r.review_months} className="input" /></label></div>
              <div className="field"><label className="check"><input type="checkbox" name="active" defaultChecked={r.active} /> Ativo</label></div>
            </div>
          </ActionForm>
        </div></details>
      ) : null}
    </div>
  );
}

export default withGuard(RequisitoPage);
