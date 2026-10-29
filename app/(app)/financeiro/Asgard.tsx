import type { Ctx } from '@/server/context.ts';
import { getTemplate, listDefaults, listMonth } from '@/server/modules/asgard.ts';
import { formatCents, toCents } from '@/domain/money.ts';
import { fmtDate, fmtDateTime } from '@/ui/format.ts';
import { Empty } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { asgardAction } from '../../actions/asgard.ts';

const SOURCE: Record<string, string> = { DESPESA: 'desta despesa', FORNECEDOR: 'do fornecedor', CATEGORIA: 'da categoria' };

/** Financeiro → Relatórios → Gerar relatório XLS Asgard. */
export async function AsgardReport({ ctx, month, canConfigure }: { ctx: Ctx; month: string; canConfigure: boolean }) {
  const [tpl, rows, defaults] = await Promise.all([getTemplate(), listMonth(ctx, month), listDefaults(ctx)]);
  const types = tpl?.types ?? [];
  const missing = rows.filter((r) => !r.type).length;
  const total = rows.reduce((a, r) => a + toCents(r.amount), 0);
  const TypeSelect = ({ name, value, label, empty }: { name: string; value: string | null; label: string; empty: string }) => (
    <select name={name} className="input" defaultValue={value ?? ''} aria-label={label}>
      <option value="">{empty}</option>
      {types.map((t) => <option key={t} value={t}>{t.trim()}</option>)}
    </select>
  );

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><div><h2>Modelo do Asgard</h2>
          <p>{tpl ? <>Em uso: <strong>{tpl.filename}</strong> · {types.length} tipos · enviado por {tpl.uploaded_by_name} em {fmtDateTime(tpl.uploaded_at)}</> : 'Nenhum modelo enviado ainda.'}</p></div></div>
        {canConfigure ? (
          <div className="card-body">
            <ActionForm action={asgardAction} submitLabel={tpl ? 'Substituir modelo' : 'Enviar modelo'}>
              <input type="hidden" name="op" value="modelo" />
              <div className="field"><label htmlFor="as-f">Planilha modelo exportada do Asgard (.xls ou .xlsx)</label><input id="as-f" name="file" type="file" accept=".xls,.xlsx" className="input" required /></div>
              <span className="hint">A lista de tipos é lida do próprio modelo. Se os tipos mudarem no Asgard, exporte e envie o modelo de novo.</span>
            </ActionForm>
          </div>
        ) : null}
      </div>

      {tpl ? (
        <>
          <form className="row" method="get" action="/financeiro">
            <input type="hidden" name="aba" value="relatorios" /><input type="hidden" name="sub" value="asgard" />
            <label className="small">Mês de referência (pagamentos) <input name="mes" type="month" className="input" defaultValue={month} /></label>
            <button type="submit" className="btn">Atualizar</button>
            {rows.length && !missing
              ? <a className="btn btn-primary" href={`/api/v1/financeiro/asgard?mes=${month}`}>Gerar relatório XLS Asgard</a>
              : <span className="small muted">{rows.length ? `Defina o tipo de ${missing} despesa(s) para gerar a planilha.` : 'Nenhuma despesa paga neste mês.'}</span>}
          </form>

          <div className="card">
            <div className="card-head"><div><h2>Despesas pagas em {month.slice(5)}/{month.slice(0, 4)}</h2>
              <p>{rows.length} pagamento(s) · {formatCents(total)} · uma linha da planilha por pagamento, na data em que foi pago</p></div></div>
            <div className="card-body flush table-wrap" tabIndex={0}>
              {rows.length ? (
                <table className="table">
                  <thead><tr><th>Data</th><th>Descrição</th><th className="num">Valor</th><th>Tipo no Asgard · Nº doc. fiscal · Nº autorização prévia</th></tr></thead>
                  <tbody>{rows.map((r) => (
                    <tr key={r.expense_id} className={r.type ? undefined : 'row-warn'}>
                      <td className="small nowrap">{fmtDate(r.paid_on)}</td>
                      <td className="small">{r.description}<div className="muted">{r.supplier_name ?? '—'} · {r.category}</div></td>
                      <td className="num">{formatCents(toCents(r.amount))}</td>
                      <td className="small">
                        <ActionForm action={asgardAction} submitLabel="Salvar" submitClass="btn btn-sm" inline>
                          <input type="hidden" name="op" value="despesa" /><input type="hidden" name="expenseId" value={r.expense_id} />
                          <TypeSelect name="asgardType" value={r.own_type} label="Tipo no Asgard" empty={r.type && r.type_source !== 'DESPESA' ? `Padrão: ${r.type.trim()}` : 'Escolha o tipo…'} />
                          <input name="fiscalDoc" className="input" defaultValue={r.fiscal_doc ?? ''} placeholder="Nº doc. fiscal" aria-label="Nº do documento fiscal" style={{ width: 130 }} />
                          <input name="priorAuth" className="input" defaultValue={r.prior_auth ?? ''} placeholder="Nº autorização" aria-label="Nº da autorização prévia" inputMode="numeric" style={{ width: 120 }} />
                        </ActionForm>
                        {r.type ? <div className="muted">Tipo {SOURCE[r.type_source!]}: {r.type.trim()}</div> : <span className="tag tag-warn">Sem tipo</span>}
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              ) : <Empty>Nenhuma despesa paga neste mês.</Empty>}
            </div>
          </div>

          {canConfigure ? (
            <div className="card">
              <div className="card-head"><div><h2>Correspondência padrão</h2>
                <p>Tipo do Asgard usado quando a despesa não tem um tipo próprio. O do fornecedor prevalece sobre o da categoria.</p></div></div>
              <div className="card-body grid grid-2">
                {([['categoria', 'Categorias', defaults.categories], ['fornecedor', 'Fornecedores', defaults.suppliers]] as const).map(([target, title, list]) => (
                  <div key={target}>
                    <h3>{title}</h3>
                    {list.length ? list.map((c) => (
                      <ActionForm key={c.id} action={asgardAction} submitLabel="Salvar" submitClass="btn btn-sm" inline>
                        <input type="hidden" name="op" value="padrao" /><input type="hidden" name="target" value={target} /><input type="hidden" name="id" value={c.id} />
                        <span className="small" style={{ minWidth: 160 }}>{c.name}</span>
                        <TypeSelect name="asgardType" value={c.asgard_type} label={`Tipo do Asgard para ${c.name}`} empty="(sem tipo)" />
                      </ActionForm>
                    )) : <Empty>Nenhum cadastro.</Empty>}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
