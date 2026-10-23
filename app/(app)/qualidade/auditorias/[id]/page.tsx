import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { getAudit } from '@/server/modules/quality.ts';
import { directory } from '@/server/modules/directory.ts';
import { fmtDate, fmtDateTime, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { qualityAction } from '../../../../actions/phase5a.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Auditoria' };

export default async function AuditoriaPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageCtx();
  const { id } = await params;
  const { audit: a, items, canConduct } = await getAudit(ctx, id);
  const running = a.status === 'EM_EXECUCAO';
  const dir = canConduct ? await directory(ctx) : null;
  const pending = items.filter((i) => i.result === 'PENDENTE').length;
  const canConclude = running && (a.lead_auditor_id === ctx.principal.userId || ctx.principal.isOwner);

  return (
    <div className="stack">
      <PageHead title={`${a.code} — ${a.title}`} subtitle={<>{label(a.kind)} · {a.sector_name ?? 'Geral'} · Auditor(a) líder {a.lead_name} · {fmtDate(a.planned_date)}</>}
        actions={<><span className={statusTone(a.status)}>{label(a.status)}</span><Link className="btn" href="/qualidade?aba=auditorias">Voltar</Link></>} />
      <div className="card"><div className="card-body"><strong>Escopo:</strong> {a.scope}{a.conclusion ? <div style={{ marginTop: 8 }}><strong>Conclusão</strong> ({fmtDateTime(a.concluded_at)}): {a.conclusion}</div> : null}</div></div>

      {canConduct && a.status === 'PLANEJADA' ? (
        <div className="row">
          <ActionForm action={qualityAction} submitLabel="Iniciar execução" inline><input type="hidden" name="op" value="iniciar_auditoria" /><input type="hidden" name="id" value={id} /></ActionForm>
        </div>
      ) : null}

      <div className="card"><div className="card-head"><h2>Checklist ({items.length} itens{running ? `, ${pending} pendente(s)` : ''})</h2><p>Não conforme abre automaticamente uma não conformidade vinculada ao item.</p></div>
        <div className="card-body flush table-wrap">
          {items.length ? <table className="table"><thead><tr><th>#</th><th>Item</th><th>Resultado</th><th>Evidência</th>{canConduct && running ? <th></th> : null}</tr></thead>
            <tbody>{items.map((i) => (
              <tr key={i.id}>
                <td className="num">{i.position}</td>
                <td>{i.question}{i.nc_id ? <div className="small"><Link href={`/qualidade/nc/${i.nc_id}`}>{i.nc_code}</Link></div> : null}</td>
                <td><span className={statusTone(i.result)}>{label(i.result)}</span>{i.evaluated_by_name ? <div className="small muted">{i.evaluated_by_name}</div> : null}</td>
                <td className="small">{i.evidence ?? ''}{i.file_id ? <div><a href={`/api/v1/qualidade/arquivos/${i.file_id}`}>arquivo</a></div> : null}</td>
                {canConduct && running ? <td>{i.result !== 'NAO_CONFORME' ? (
                  <details className="disclosure small"><summary><a>Avaliar</a></summary>
                    <ActionForm action={qualityAction} submitLabel="Registrar" submitClass="btn btn-sm">
                      <input type="hidden" name="op" value="avaliar_item" /><input type="hidden" name="id" value={id} /><input type="hidden" name="itemId" value={i.id} />
                      <div className="stack" style={{ minWidth: 300 }}>
                        <select name="result" className="input" aria-label="Resultado" defaultValue={i.result === 'PENDENTE' ? 'CONFORME' : i.result}>{['CONFORME', 'NAO_CONFORME', 'OBSERVACAO', 'NAO_APLICAVEL'].map((r) => <option key={r} value={r}>{label(r)}</option>)}</select>
                        <textarea name="evidence" className="input" rows={2} placeholder="Evidência objetiva (obrigatória para não conforme e observação)" aria-label="Evidência" defaultValue={i.evidence ?? ''} />
                        <input name="file" type="file" className="input" aria-label="Arquivo de evidência" />
                        <div className="small muted">Se não conforme:</div>
                        <select name="ncSeverity" className="input" aria-label="Gravidade da não conformidade">{['MENOR', 'MAIOR', 'CRITICA'].map((r) => <option key={r} value={r}>{label(r)}</option>)}</select>
                        <select name="ncResponsibleId" className="input" aria-label="Responsável pelo tratamento"><option value="">Responsável: quem planejou a auditoria</option>{dir!.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select>
                      </div>
                    </ActionForm>
                  </details>) : null}</td> : null}
              </tr>
            ))}</tbody></table> : <Empty>Nenhum item.</Empty>}
        </div>
      </div>

      {canConduct ? (
        <div className="grid grid-2">
          <div className="card"><div className="card-head"><h2>Incluir item</h2></div><div className="card-body">
            <ActionForm action={qualityAction} submitLabel="Incluir" resetOnSuccess><input type="hidden" name="op" value="item_auditoria" /><input type="hidden" name="id" value={id} /><input name="question" className="input" aria-label="Pergunta" required minLength={3} /></ActionForm>
          </div></div>
          {canConclude ? (
            <div className="card"><div className="card-head"><h2>Concluir auditoria</h2><p>Todos os itens avaliados. Itens ligados a requisitos atualizam a avaliação do requisito. Depois de concluída, a auditoria fica imutável.</p></div><div className="card-body">
              <ActionForm action={qualityAction} submitLabel="Concluir" confirm="Concluir a auditoria? Ela ficará imutável."><input type="hidden" name="op" value="concluir_auditoria" /><input type="hidden" name="id" value={id} /><textarea name="conclusion" className="input" rows={3} aria-label="Conclusão" required minLength={5} /></ActionForm>
            </div></div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
