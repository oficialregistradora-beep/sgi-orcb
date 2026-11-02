import type { Ctx } from '@/server/context.ts';
import { getFinanceAccess } from '@/server/modules/financeAccess.ts';
import { listCostCenters } from '@/server/modules/finance.ts';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { financeAccessAction } from '../../actions/admin.ts';

/** Alcance da pessoa no financeiro, definido pela Oficial: todo o financeiro (administração) ou centros de custo. */
export async function FinanceAccessCard({ ctx, userId }: { ctx: Ctx; userId: string }) {
  const [access, ccs] = await Promise.all([getFinanceAccess(ctx, userId), listCostCenters()]);
  const summary = access.all ? 'todo o financeiro (administração)'
    : access.costCenterIds.length ? `${access.costCenterIds.length} centro(s) de custo` : 'nenhum acesso';
  return (
    <div className="card">
      <div className="card-head"><div><h2>Financeiro — o que esta pessoa vê</h2><p>Hoje: <strong>{summary}</strong>. O papel define o que ela faz (solicitar, aprovar, pagar, cadastrar); aqui você define onde.</p></div></div>
      <div className="card-body">
        <ActionForm action={financeAccessAction} submitLabel="Salvar acesso ao financeiro" confirm="Confirma o acesso desta pessoa ao financeiro?">
          <input type="hidden" name="userId" value={userId} />
          <label className="check"><input type="checkbox" name="all" defaultChecked={access.all} /> <strong>Ver todo o financeiro</strong> (administração: todos os centros de custo, receitas, fluxo de caixa, lançamento mensal e planilha do Asgard)</label>
          <fieldset className="stack" style={{ marginTop: 12 }}>
            <legend className="label">Ou somente estes centros de custo</legend>
            {ccs.length ? ccs.map((c) => (
              <label key={c.id} className="check"><input type="checkbox" name="cc" value={c.id} defaultChecked={access.costCenterIds.includes(c.id)} /> <span className="mono">{c.code}</span> — {c.name}{c.active ? '' : ' (inativo)'}</label>
            )) : <p className="small muted">Nenhum centro de custo cadastrado ainda (Financeiro → Centros e categorias).</p>}
          </fieldset>
          <div className="field" style={{ marginTop: 8 }}><label htmlFor="fa-r">Motivo</label><input id="fa-r" name="reason" className="input" required minLength={5} /></div>
        </ActionForm>
      </div>
    </div>
  );
}
