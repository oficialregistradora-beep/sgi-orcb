import type { Ctx } from '@/server/context.ts';
import { listRecurring } from '@/server/modules/recurring.ts';
import { getTemplate } from '@/server/modules/asgard.ts';
import { formatCents, toCents } from '@/domain/money.ts';
import { Empty } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { recurringAction } from '../../actions/recurring.ts';

type Opt = { id: string; label: string };

/** Financeiro → Contratos → Despesas fixas mensais (sem contrato). */
export async function RecurringExpenses({ ctx, costCenters, categories, suppliers }: { ctx: Ctx; costCenters: Opt[]; categories: Opt[]; suppliers: Opt[] }) {
  const [rows, tpl] = await Promise.all([listRecurring(ctx), getTemplate()]);
  const types = tpl?.types ?? [];
  const active = rows.filter((r) => r.active);
  const total = active.reduce((a, r) => a + (r.amount ? toCents(r.amount) : 0), 0);
  const Fields = ({ r, p }: { r?: (typeof rows)[number]; p: string }) => (
    <div className="form-grid">
      <div className="field"><label htmlFor={`${p}-d`}>Descrição</label><input id={`${p}-d`} name="description" className="input" defaultValue={r?.description} required minLength={3} /></div>
      <div className="field"><label htmlFor={`${p}-v`}>Valor mensal (R$)</label><input id={`${p}-v`} name="amount" className="input" inputMode="decimal" defaultValue={r?.amount ? formatCents(toCents(r.amount)).replace('R$ ', '') : ''} placeholder="vazio = a informar" /></div>
      <div className="field"><label htmlFor={`${p}-dd`}>Dia do vencimento</label><input id={`${p}-dd`} name="dueDay" type="number" min={1} max={31} className="input" defaultValue={r?.due_day ?? 10} required /></div>
      <div className="field"><label htmlFor={`${p}-cc`}>Centro de custo</label><select id={`${p}-cc`} name="costCenterId" className="input" defaultValue={r?.cost_center_id}>{costCenters.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></div>
      <div className="field"><label htmlFor={`${p}-ca`}>Categoria</label><select id={`${p}-ca`} name="categoryId" className="input" defaultValue={r?.category_id}>{categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></div>
      <div className="field"><label htmlFor={`${p}-s`}>Fornecedor (opcional)</label><select id={`${p}-s`} name="supplierId" className="input" defaultValue={r?.supplier_id ?? ''}><option value="">—</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></div>
      <div className="field"><label htmlFor={`${p}-t`}>Tipo no Asgard</label><select id={`${p}-t`} name="asgardType" className="input" defaultValue={r?.asgard_type ?? ''}><option value="">—</option>
        {r?.asgard_type && !types.includes(r.asgard_type) ? <option value={r.asgard_type}>{r.asgard_type.trim()} (fora do modelo)</option> : null}
        {types.map((t) => <option key={t} value={t}>{t.trim()}</option>)}</select></div>
    </div>
  );

  return (
    <div className="card">
      <div className="card-head"><div><h2>Despesas fixas mensais</h2>
        <p>Sem contrato formal (assinaturas, tributos, folha, benefícios). Entram em “Lançar despesas fixas do mês” com o valor abaixo — valores que variam são estimativas: confira na solicitação antes de aprovar.</p></div>
        <span className="small muted">{active.length} ativa(s) · {formatCents(total)}/mês</span></div>
      <div className="card-body flush table-wrap" tabIndex={0}>
        {rows.length ? (
          <table className="table">
            <thead><tr><th>Despesa</th><th className="num">Valor</th><th>Dia</th><th>Tipo no Asgard</th><th></th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className={r.active ? (r.amount ? undefined : 'row-warn') : 'row-muted'}>
                <td className="small">{r.description}<div className="muted">{r.category} · {r.cost_center}{r.supplier_name ? ` · ${r.supplier_name}` : ''}{r.active ? '' : ' · inativa'}</div></td>
                <td className="num">{r.amount ? formatCents(toCents(r.amount)) : <span className="tag tag-warn">a informar</span>}</td>
                <td className="small">{r.due_day}</td>
                <td className="small">{r.asgard_type?.trim() ?? '—'}</td>
                <td>
                  <details className="disclosure small"><summary><a>Alterar</a></summary>
                    <ActionForm action={recurringAction} submitLabel="Salvar">
                      <input type="hidden" name="op" value="salvar" /><input type="hidden" name="id" value={r.id} />
                      <Fields r={r} p={`r${r.id.slice(0, 8)}`} />
                      <label className="check" style={{ marginTop: 8 }}><input type="checkbox" name="active" defaultChecked={r.active} /> Ativa</label>
                    </ActionForm>
                  </details>
                  <ActionForm action={recurringAction} submitLabel={r.generated ? 'Desativar' : 'Excluir'} submitClass="btn btn-sm btn-danger" inline
                    confirm={r.generated ? 'Desativar esta despesa fixa? Os lançamentos já gerados continuam no histórico.' : 'Excluir esta despesa fixa?'}>
                    <input type="hidden" name="op" value="remover" /><input type="hidden" name="id" value={r.id} />
                  </ActionForm>
                </td>
              </tr>
            ))}</tbody>
          </table>
        ) : <Empty>Nenhuma despesa fixa mensal cadastrada.</Empty>}
      </div>
      <div className="card-body grid grid-2">
        <div>
          <h3>Incluir</h3>
          <ActionForm action={recurringAction} submitLabel="Incluir" resetOnSuccess>
            <input type="hidden" name="op" value="salvar" />
            <Fields p="nova" />
          </ActionForm>
        </div>
        <div>
          <h3>Importar de planilha</h3>
          <p className="small muted">Planilha no formato do Asgard (Data, Tipo, Descrição, Valor…), por exemplo o livro de um mês já fechado: cada linha vira uma despesa fixa, com o dia do vencimento tirado da data e o tipo do Asgard. A categoria é sugerida pelo tipo; linhas iguais às já cadastradas são ignoradas.</p>
          <ActionForm action={recurringAction} submitLabel="Importar">
            <input type="hidden" name="op" value="importar" />
            <div className="form-grid">
              <div className="field"><label htmlFor="ri-f">Planilha (.xls ou .xlsx)</label><input id="ri-f" name="file" type="file" accept=".xls,.xlsx" className="input" required /></div>
              <div className="field"><label htmlFor="ri-cc">Centro de custo</label><select id="ri-cc" name="costCenterId" className="input">{costCenters.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></div>
              <div className="field"><label htmlFor="ri-ca">Categoria quando não houver sugestão</label><select id="ri-ca" name="categoryId" className="input">{categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></div>
            </div>
          </ActionForm>
        </div>
      </div>
    </div>
  );
}
