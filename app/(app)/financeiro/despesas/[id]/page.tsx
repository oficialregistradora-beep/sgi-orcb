import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { DISCLAIMER, getExpense, listCostCenters, listFinanceCategories, listSuppliers } from '@/server/modules/finance.ts';
import { formatCents, toCents } from '@/domain/money.ts';
import { todayLocal } from '@/domain/time.ts';
import { fmtDate, fmtDateTime, label } from '@/ui/format.ts';
import { PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { expenseAction } from '../../../../actions/phase4b.ts';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Despesa' };

const STATUS: Record<string, [string, string]> = {
  SOLICITADA: ['Aguardando aprovação', 'tag tag-warn'], APROVADA: ['Aprovada — a pagar', 'tag tag-info'], PAGA: ['Paga', 'tag tag-ok'],
  REJEITADA: ['Rejeitada', 'tag tag-danger'], CANCELADA: ['Cancelada', 'tag'],
};
const EVENTS: Record<string, string> = {
  SOLICITADA: 'Solicitada', ALTERADA: 'Alterada', APROVADA: 'Aprovada', REJEITADA: 'Rejeitada', PAGA: 'Pagamento registrado', CANCELADA: 'Cancelada',
  COTACAO: 'Cotação registrada', COTACAO_ESCOLHIDA: 'Cotação escolhida', ANEXO: 'Anexo incluído', AVISO_VENCIMENTO: 'Aviso de vencimento enviado',
};
const brl = (v: string | null) => formatCents(toCents(v));

function Op({ id, op, label: l, cls = 'btn btn-sm', children, confirm, reset }: { id: string; op: string; label: string; cls?: string; children?: React.ReactNode; confirm?: string; reset?: boolean }) {
  return <ActionForm action={expenseAction} submitLabel={l} submitClass={cls} inline confirm={confirm} resetOnSuccess={reset}><input type="hidden" name="expenseId" value={id} /><input type="hidden" name="op" value={op} />{children ? <div className="row">{children}</div> : null}</ActionForm>;
}

async function DespesaPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageCtx();
  const { id } = await params;
  const { expense: e, quotes, attachments, events, can } = await getExpense(ctx, id);
  const [ccs, cats, suppliers] = can.edit ? await Promise.all([listCostCenters(), listFinanceCategories(), listSuppliers(ctx)]) : [[], [], []];
  const [statusLabel, statusClass] = STATUS[e.status]!;
  return (
    <div className="stack">
      <PageHead title={e.description} subtitle={DISCLAIMER} actions={<Link href="/financeiro?aba=pagar" className="btn btn-ghost">Voltar</Link>} />
      <div className="row"><span className={statusClass}>{statusLabel}</span><strong>{brl(e.amount)}</strong><span className="small muted">{label(e.kind)}{e.origin === 'CONTRATO' ? ' · gerada de contrato' : ''}</span></div>
      <div className="card"><div className="card-body">
        <dl className="form-grid small">
          <div><dt className="muted">Fornecedor</dt><dd>{e.supplier_name ?? '—'}</dd></div>
          <div><dt className="muted">Centro de custo</dt><dd>{e.cost_center}</dd></div>
          <div><dt className="muted">Categoria</dt><dd>{e.category}</dd></div>
          <div><dt className="muted">Competência</dt><dd>{e.competence.slice(5, 7)}/{e.competence.slice(0, 4)}</dd></div>
          <div><dt className="muted">Vencimento</dt><dd className={e.status === 'APROVADA' && e.due_date < todayLocal() ? 'neg' : undefined}>{fmtDate(e.due_date)}</dd></div>
          <div><dt className="muted">Projeto</dt><dd>{e.project_id ? <Link href={`/projetos/${e.project_id}`}>{e.project_name}</Link> : '—'}</dd></div>
          <div><dt className="muted">Solicitada por</dt><dd>{e.requested_by_name} · {fmtDateTime(e.requested_at)}</dd></div>
          <div><dt className="muted">Decisão</dt><dd>{e.decided_by_name ? `${e.decided_by_name} · ${fmtDateTime(e.decided_at)}` : '—'}{e.decision_notes ? ` — ${e.decision_notes}` : ''}</dd></div>
          <div><dt className="muted">Pagamento</dt><dd>{e.paid_on ? `${fmtDate(e.paid_on)} · ${label(e.method)} · ${e.paid_by_name}${e.reference ? ` · ref. ${e.reference}` : ''}` : '—'}</dd></div>
        </dl>
        {e.justification ? <p className="small" style={{ marginTop: 8 }}><strong>Justificativa:</strong> {e.justification}</p> : null}
        {e.cancel_reason ? <p className="small neg">Cancelada: {e.cancel_reason}</p> : null}
      </div></div>

      {can.decide ? (
        <div className="card"><div className="card-head"><h2>Decisão</h2><p>{e.requested_by === ctx.principal.userId ? 'Você solicitou esta despesa e, como Oficial, pode decidi-la (segregação dispensada por parâmetro).' : 'Você não solicitou esta despesa.'} A decisão exige o código do autenticador.</p></div>
          <div className="card-body grid grid-2">
            <Op id={id} op="aprovar" label="Aprovar" cls="btn btn-primary"><input name="notes" className="input" placeholder="Observação (opcional)" aria-label="Observação" /></Op>
            <Op id={id} op="rejeitar" label="Rejeitar" cls="btn btn-danger"><input name="notes" className="input" placeholder="Motivo" aria-label="Motivo da rejeição" required minLength={3} /></Op>
          </div>
        </div>
      ) : e.status === 'SOLICITADA' && e.requested_by === ctx.principal.userId ? <div className="alert alert-info small">Aguardando decisão de outra pessoa (segregação de funções).</div> : null}

      {can.pay ? (
        <div className="card"><div className="card-head"><h2>Registrar pagamento</h2><p>Anexe o comprovante antes. {e.requested_by === ctx.principal.userId || e.decided_by === ctx.principal.userId ? 'Como Oficial, você pode pagar mesmo tendo solicitado ou aprovado (segregação dispensada por parâmetro).' : 'Você não solicitou nem aprovou esta despesa.'}</p></div>
          <div className="card-body"><Op id={id} op="pagar" label="Registrar pagamento" cls="btn btn-primary" confirm="O registro de pagamento é definitivo. Confirma?">
            <input name="paidOn" type="date" className="input" aria-label="Data do pagamento" defaultValue={todayLocal()} required />
            <input name="amount" className="input" aria-label="Valor pago" defaultValue={formatCents(toCents(e.amount)).replace('R$ ', '')} required />
            <select name="method" className="input" aria-label="Forma">{['PIX', 'BOLETO', 'TRANSFERENCIA', 'DEBITO_AUTOMATICO', 'CARTAO', 'DINHEIRO'].map((m) => <option key={m} value={m}>{m.replace('_', ' ').toLowerCase()}</option>)}</select>
            <input name="reference" className="input" placeholder="Referência (opcional)" aria-label="Referência" />
          </Op></div>
        </div>
      ) : null}

      {e.kind === 'COMPRA' || quotes.length ? (
        <div className="card"><div className="card-head"><h2>Cotações</h2><p>A aprovação de compra exige a cotação escolhida; escolher outra que não a de menor valor exige justificativa.</p></div>
          <div className="card-body flush table-wrap" tabIndex={0}><table className="table"><tbody>{quotes.map((q) => (
            <tr key={q.id}><td>{q.supplier_name}{q.chosen ? <span className="tag tag-ok" style={{ marginLeft: 6 }}>Escolhida</span> : null}</td><td className="num">{brl(q.amount)}</td>
              <td className="small">{q.file_id ? <a href={`/api/v1/financeiro/arquivos/${q.file_id}`}>orçamento</a> : '—'}</td>
              <td>{can.quote && !q.chosen ? <Op id={id} op="escolher" label="Escolher"><input type="hidden" name="quoteId" value={q.id} /><input name="reason" className="input" placeholder="Justificativa (se não for a menor)" aria-label="Justificativa" /></Op> : null}</td></tr>
          ))}</tbody></table></div>
          {can.quote ? <div className="card-body"><Op id={id} op="cotacao" label="Incluir cotação" reset><input name="supplierName" className="input" placeholder="Fornecedor" aria-label="Fornecedor da cotação" required /><input name="amount" className="input" placeholder="Valor" aria-label="Valor da cotação" required /><input name="file" type="file" className="input" aria-label="Arquivo do orçamento" /></Op></div> : null}
        </div>
      ) : null}

      <div className="card"><div className="card-head"><h2>Notas fiscais, comprovantes e anexos</h2></div>
        <div className="card-body stack" style={{ gap: 6 }}>
          {attachments.map((a) => <div key={a.id} className="small"><span className="tag">{label(a.kind)}</span> <a href={`/api/v1/financeiro/arquivos/${a.file_id}`}>{a.filename}</a> <span className="muted">{a.added_by_name} · {fmtDateTime(a.added_at)}</span> {a.scan_status === 'LIMPO' ? <span className="tag tag-ok">Verificado</span> : <span className="tag tag-warn">Não verificado</span>}</div>)}
          {!attachments.length ? <span className="small muted">Nenhum anexo.</span> : null}
          {can.attach ? <Op id={id} op="anexo" label="Anexar" reset><select name="kind" className="input" aria-label="Tipo">{['NOTA_FISCAL', 'COMPROVANTE', 'ORCAMENTO', 'OUTRO'].map((k) => <option key={k} value={k}>{label(k)}</option>)}</select><input name="file" type="file" className="input" aria-label="Arquivo" required /></Op> : null}
        </div>
      </div>

      {can.edit ? (
        <div className="card"><div className="card-head"><h2>Alterar solicitação</h2></div>
          <div className="card-body"><details className="disclosure"><summary><a>Editar</a></summary>
            <ActionForm action={expenseAction} submitLabel="Salvar"><input type="hidden" name="expenseId" value={id} /><input type="hidden" name="op" value="editar" /><input type="hidden" name="kind" value={e.kind} />
              <div className="form-grid">
                <div className="field"><label>Descrição<input name="description" className="input" defaultValue={e.description} required /></label></div>
                <div className="field"><label>Valor (R$)<input name="amount" className="input" defaultValue={formatCents(toCents(e.amount)).replace('R$ ', '')} required /></label></div>
                <div className="field"><label>Centro de custo<select name="costCenterId" className="input" defaultValue={e.cost_center_id}>{ccs.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select></label></div>
                <div className="field"><label>Categoria<select name="categoryId" className="input" defaultValue={e.category_id}>{cats.filter((c) => c.kind !== 'RECEITA').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label></div>
                <div className="field"><label>Fornecedor<select name="supplierId" className="input" defaultValue={e.supplier_id ?? ''}><option value="">—</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></div>
                <div className="field"><label>Competência<input name="competence" type="month" className="input" defaultValue={e.competence.slice(0, 7)} /></label></div>
                <div className="field"><label>Vencimento<input name="dueDate" type="date" className="input" defaultValue={e.due_date} /></label></div>
                <input type="hidden" name="projectId" value={e.project_id ?? ''} />
              </div>
              <div className="field" style={{ marginTop: 10 }}><label>Justificativa<textarea name="justification" className="input" rows={2} defaultValue={e.justification ?? ''} /></label></div>
            </ActionForm>
          </details></div>
        </div>
      ) : null}

      {can.cancel ? <div className="card"><div className="card-body"><details className="disclosure small"><summary><a>Cancelar despesa</a></summary><Op id={id} op="cancelar" label="Cancelar" cls="btn btn-sm btn-danger"><input name="reason" className="input" placeholder="Motivo" aria-label="Motivo do cancelamento" required minLength={3} /></Op></details></div></div> : null}

      <div className="card"><div className="card-head"><h2>Histórico</h2></div>
        <div className="card-body flush table-wrap" tabIndex={0}><table className="table"><tbody>{events.map((ev) => (
          <tr key={ev.id}><td className="small nowrap">{fmtDateTime(ev.created_at)}</td><td className="small">{EVENTS[ev.event] ?? ev.event}<div className="muted">{ev.user_name ?? 'Rotina automática'}</div></td><td className="small muted" style={{ wordBreak: 'break-word' }}>{Object.keys(ev.details).length ? JSON.stringify(ev.details) : ''}</td></tr>
        ))}</tbody></table></div>
      </div>
    </div>
  );
}

export default withGuard(DespesaPage);
