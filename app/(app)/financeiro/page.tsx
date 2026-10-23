import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import {
  DISCLAIMER, financeOverview, paymentBlockers, listContracts, listCostCenters, listExpenses, listFinanceCategories, listRevenues, listSuppliers, type ExpenseRow,
} from '@/server/modules/finance.ts';
import { listProjects } from '@/server/modules/projects.ts';
import { directory } from '@/server/modules/directory.ts';
import { addDays, addMonths, todayLocal } from '@/domain/time.ts';
import { formatCents, pct, toCents } from '@/domain/money.ts';
import { fmtDate, label } from '@/ui/format.ts';
import { Empty, PageHead, Stat } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { financeAdminAction, requestExpenseAction } from '../../actions/phase4b.ts';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Financeiro' };

const brl = (db: string | null | undefined) => formatCents(toCents(db));
const monthLabel = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
const STATUS_LABEL: Record<string, string> = { SOLICITADA: 'Aguardando aprovação', APROVADA: 'Aprovada — a pagar', PAGA: 'Paga', REJEITADA: 'Rejeitada', CANCELADA: 'Cancelada' };
const tone = (s: string) => (s === 'PAGA' ? 'tag tag-ok' : s === 'APROVADA' ? 'tag tag-info' : s === 'SOLICITADA' ? 'tag tag-warn' : s === 'REJEITADA' ? 'tag tag-danger' : 'tag');

function ExpenseTable({ rows }: { rows: ExpenseRow[] }) {
  if (!rows.length) return <Empty>Nenhuma despesa.</Empty>;
  const today = todayLocal();
  return (
    <table className="table">
      <thead><tr><th>Despesa</th><th>Centro / categoria</th><th>Competência</th><th>Vencimento</th><th className="num">Valor</th><th>Situação</th></tr></thead>
      <tbody>{rows.map((e) => (
        <tr key={e.id}>
          <td><Link href={`/financeiro/despesas/${e.id}`}>{e.description}</Link><div className="small muted">{e.supplier_name ?? '—'} · {label(e.kind)}{e.origin === 'CONTRATO' ? ' · contrato' : ''} · {e.requested_by_name}</div></td>
          <td className="small">{e.cost_center}<div className="muted">{e.category}</div></td>
          <td className="small">{monthLabel(e.competence)}</td>
          <td className={`small nowrap ${e.status === 'APROVADA' && e.due_date < today ? 'neg' : ''}`}>{fmtDate(e.due_date)}{e.status === 'APROVADA' && e.due_date < today ? ' (vencida)' : ''}</td>
          <td className="num">{brl(e.amount)}</td>
          <td><span className={tone(e.status)}>{STATUS_LABEL[e.status]}</span></td>
        </tr>
      ))}</tbody>
    </table>
  );
}

async function FinanceiroPage({ searchParams }: { searchParams: Promise<{ aba?: string; situacao?: string; mes?: string; centro?: string; q?: string; de?: string; ate?: string; ano?: string }> }) {
  const ctx = await requirePageCtx();
  const sp = await searchParams;
  const p = ctx.principal;
  const has = (x: string) => p.isOwner || can(p, x);
  const anyFin = ['financeiro.ver', 'financeiro.solicitar', 'financeiro.aprovar', 'financeiro.pagar', 'financeiro.cadastros', 'financeiro.receitas'].some(has);
  if (!anyFin) return <div className="stack"><PageHead title="Financeiro" /><div className="alert alert-warn">Você não tem acesso ao módulo financeiro.</div></div>;
  const TABS = {
    painel: 'Painel', pagar: 'Contas a pagar', nova: 'Solicitar despesa', contratos: 'Contratos', fornecedores: 'Fornecedores', orcamento: 'Orçamento',
    receitas: 'Receitas', relatorios: 'Relatórios', cadastros: 'Centros e categorias',
  } as const;
  const visible: Record<keyof typeof TABS, boolean> = {
    painel: true, pagar: true, nova: has('financeiro.solicitar'), contratos: true, fornecedores: true, orcamento: has('financeiro.cadastros') || has('financeiro.ver'),
    receitas: has('financeiro.receitas'), relatorios: true, cadastros: has('financeiro.cadastros'),
  };
  const tab = (sp.aba && sp.aba in TABS && visible[sp.aba as keyof typeof TABS] ? sp.aba : 'painel') as keyof typeof TABS;
  const today = todayLocal();
  const month = /^\d{4}-\d{2}$/.test(sp.mes ?? '') ? sp.mes! : today.slice(0, 7);
  const [ccs, cats] = await Promise.all([listCostCenters(), listFinanceCategories()]);
  const expenseCats = cats.filter((c) => c.kind !== 'RECEITA' && c.active);
  const admin = has('financeiro.cadastros');

  return (
    <div className="stack">
      <PageHead title="Financeiro gerencial" subtitle={DISCLAIMER} />
      <nav className="tabs">{(Object.keys(TABS) as (keyof typeof TABS)[]).filter((k) => visible[k]).map((k) => <Link key={k} href={`/financeiro?aba=${k}`} aria-current={tab === k ? 'page' : undefined}>{TABS[k]}</Link>)}</nav>

      {tab === 'painel' ? await (async () => {
        const from = addMonths(`${today.slice(0, 7)}-01`, -5).slice(0, 7);
        const o = await financeOverview(ctx, from, today.slice(0, 7));
        const pending = await listExpenses(ctx, { status: 'ABERTAS' });
        const toDecide = pending.filter((e) => e.status === 'SOLICITADA' && e.requested_by !== p.userId && has('financeiro.aprovar'));
        const toPay = pending.filter((e) => e.status === 'APROVADA' && has('financeiro.pagar') && e.requested_by !== p.userId && e.decided_by !== p.userId);
        const { alerts } = await listContracts(ctx);
        const blockers = await paymentBlockers(ctx);
        return (
          <div className="stack">
            <div className="grid grid-4">
              <Stat label="Pago (últimos 6 meses)" value={formatCents(o.totals.paid)} hint={o.totals.budget ? `Orçamento ${formatCents(o.totals.budget)}` : 'Sem orçamento cadastrado'} />
              <Stat label="Comprometido (aprovado a pagar)" value={formatCents(o.totals.committed)} />
              <Stat label="Contas vencidas" value={o.totals.overdue} tone={o.totals.overdue ? 'neg' : undefined} hint={`${o.totals.dueSoon} a vencer em breve`} />
              <Stat label="Aguardando você" value={toDecide.length + toPay.length} hint={`${toDecide.length} para aprovar · ${toPay.length} para pagar`} />
            </div>
            {blockers.length ? <div className="alert alert-danger small"><strong>Segregação de funções:</strong> {blockers.length} despesa(s) aprovada(s) não têm quem as pague, porque todas as pessoas com permissão de pagamento solicitaram ou aprovaram cada uma ({blockers.slice(0, 3).map((b) => b.description).join('; ')}). Designe mais uma pessoa com a permissão “Registrar pagamentos” em Usuários e permissões.</div> : null}
            {alerts.length ? <div className="alert alert-warn small">{alerts.map((a) => <div key={a.id}>Contrato <strong>{a.object}</strong> ({a.supplier_name}) {a.daysLeft < 0 ? `venceu há ${-a.daysLeft} dia(s)` : `termina em ${a.daysLeft} dia(s)`} — {fmtDate(a.end_date)}.</div>)}</div> : null}
            {toDecide.length ? <div className="card"><div className="card-head"><h2>Para sua aprovação</h2></div><div className="card-body flush table-wrap" tabIndex={0}><ExpenseTable rows={toDecide} /></div></div> : null}
            {toPay.length ? <div className="card"><div className="card-head"><h2>Para pagamento</h2></div><div className="card-body flush table-wrap" tabIndex={0}><ExpenseTable rows={toPay} /></div></div> : null}
            <div className="card">
              <div className="card-head"><h2>Fluxo de caixa gerencial</h2><p>{o.full ? 'Regime de caixa: receitas lançadas × pagamentos registrados.' : 'Somente as saídas dos centros de custo do seu setor.'}</p></div>
              <div className="card-body flush table-wrap" tabIndex={0}><table className="table"><thead><tr><th>Mês</th><th className="num">Entradas</th><th className="num">Saídas</th><th className="num">Resultado</th><th className="num">Saldo acumulado</th><th className="num">A pagar (vencimento)</th></tr></thead>
                <tbody>{o.flow.map((r) => <tr key={r.month}><td>{monthLabel(r.month)}</td><td className="num">{formatCents(r.inflow)}</td><td className="num">{formatCents(r.outflow)}</td><td className={`num ${r.net < 0 ? 'neg' : ''}`}>{formatCents(r.net)}</td><td className="num">{formatCents(r.balance)}</td><td className="num">{formatCents(r.payable)}</td></tr>)}</tbody></table></div>
            </div>
            <div className="grid grid-2">
              <div className="card"><div className="card-head"><h2>Projeção de saídas</h2><p>Maior entre orçamento e o já conhecido (lançado + contratos).</p></div>
                <div className="card-body flush table-wrap" tabIndex={0}><table className="table"><thead><tr><th>Mês</th><th className="num">Orçamento</th><th className="num">Contratos</th><th className="num">Lançado</th><th className="num">Projetado</th></tr></thead>
                  <tbody>{o.projection.map((r) => <tr key={r.month}><td>{monthLabel(r.month)}</td><td className="num">{formatCents(r.budget)}</td><td className="num">{formatCents(r.contractual)}</td><td className="num">{formatCents(r.scheduled)}</td><td className="num"><strong>{formatCents(r.projected)}</strong></td></tr>)}</tbody></table></div>
              </div>
              <div className="card"><div className="card-head"><h2>Despesas por setor (6 meses)</h2></div>
                <div className="card-body flush table-wrap" tabIndex={0}><table className="table"><thead><tr><th>Setor</th><th className="num">Pago</th><th className="num">Comprometido</th></tr></thead>
                  <tbody>{o.bySector.map((r) => <tr key={r.name}><td>{r.name}</td><td className="num">{formatCents(r.paid)}</td><td className="num">{formatCents(r.committed)}</td></tr>)}</tbody></table></div>
              </div>
            </div>
            {o.personnel ? (
              <div className="card"><div className="card-head"><h2>Custo de pessoal (salários vigentes)</h2><p>Somente salários-base cadastrados; encargos e benefícios dependem de validação contábil.</p></div>
                <div className="card-body flush table-wrap" tabIndex={0}><table className="table"><thead><tr><th>Setor</th><th className="num">Pessoas</th><th className="num">Salários/mês</th></tr></thead>
                  <tbody>{o.personnel.map((r) => <tr key={r.sector}><td>{r.sector}</td><td className="num">{r.employees}</td><td className="num">{formatCents(r.monthly)}</td></tr>)}
                    <tr><td><strong>Total</strong></td><td className="num">{o.personnel.reduce((a, r) => a + r.employees, 0)}</td><td className="num"><strong>{formatCents(o.personnel.reduce((a, r) => a + r.monthly, 0))}</strong></td></tr></tbody></table></div>
              </div>
            ) : null}
          </div>
        );
      })() : null}

      {tab === 'pagar' ? await (async () => {
        const rows = await listExpenses(ctx, { status: sp.situacao || 'ABERTAS', month: sp.mes, costCenterId: sp.centro, q: sp.q });
        const total = rows.reduce((a, e) => a + toCents(e.amount), 0);
        return (
          <div className="card">
            <div className="card-head">
              <form className="row" method="get" action="/financeiro" role="search">
                <input type="hidden" name="aba" value="pagar" />
                <input name="q" className="input" placeholder="Descrição ou fornecedor" aria-label="Pesquisar" defaultValue={sp.q ?? ''} />
                <select name="situacao" className="input" aria-label="Situação" defaultValue={sp.situacao ?? ''}>
                  <option value="">Em aberto</option><option value="TODAS">Todas</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <input name="mes" type="month" className="input" aria-label="Competência" defaultValue={sp.mes ?? ''} />
                <select name="centro" className="input" aria-label="Centro de custo" defaultValue={sp.centro ?? ''}><option value="">Todos os centros</option>{ccs.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select>
                <button type="submit" className="btn">Filtrar</button>
              </form>
              <span className="small muted">{rows.length} despesa(s) · {formatCents(total)}</span>
            </div>
            <div className="card-body flush table-wrap" tabIndex={0}><ExpenseTable rows={rows} /></div>
          </div>
        );
      })() : null}

      {tab === 'nova' ? await (async () => {
        const [suppliers, projects] = await Promise.all([listSuppliers(ctx), listProjects(ctx)]);
        return (
          <div className="card">
            <div className="card-head"><h2>Solicitar despesa ou compra</h2><p>A solicitação segue para aprovação por outra pessoa. Compras exigem justificativa e cotações.</p></div>
            <div className="card-body"><ActionForm action={requestExpenseAction} submitLabel="Enviar para aprovação">
              <div className="form-grid">
                <div className="field"><label htmlFor="ex-k">Tipo</label><select id="ex-k" name="kind" className="input"><option value="VARIAVEL">Despesa variável</option><option value="FIXA">Despesa fixa</option><option value="COMPRA">Compra</option></select></div>
                <div className="field" style={{ gridColumn: 'span 2' }}><label htmlFor="ex-d">Descrição</label><input id="ex-d" name="description" className="input" required minLength={3} /></div>
                <div className="field"><label htmlFor="ex-v">Valor (R$)</label><input id="ex-v" name="amount" className="input" inputMode="decimal" placeholder="0,00" required /></div>
                <div className="field"><label htmlFor="ex-cc">Centro de custo</label><select id="ex-cc" name="costCenterId" className="input" required>{ccs.filter((c) => c.active && (has('financeiro.cadastros') || can(p, 'financeiro.solicitar', { sectorId: c.sector_id }))).map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select></div>
                <div className="field"><label htmlFor="ex-c">Categoria</label><select id="ex-c" name="categoryId" className="input" required>{expenseCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
                <div className="field"><label htmlFor="ex-s">Fornecedor</label><select id="ex-s" name="supplierId" className="input"><option value="">—</option>{suppliers.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
                <div className="field"><label htmlFor="ex-p">Projeto (opcional)</label><select id="ex-p" name="projectId" className="input"><option value="">—</option>{projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
                <div className="field"><label htmlFor="ex-m">Competência</label><input id="ex-m" name="competence" type="month" className="input" defaultValue={month} required /></div>
                <div className="field"><label htmlFor="ex-due">Vencimento</label><input id="ex-due" name="dueDate" type="date" className="input" defaultValue={addDays(today, 7)} required /></div>
                <div className="field"><label htmlFor="ex-f">Nota fiscal / orçamento (opcional)</label><input id="ex-f" name="file" type="file" className="input" /></div>
                <div className="field"><label htmlFor="ex-fk">Tipo do anexo</label><select id="ex-fk" name="fileKind" className="input"><option value="NOTA_FISCAL">Nota fiscal</option><option value="ORCAMENTO">Orçamento</option><option value="OUTRO">Outro</option></select></div>
              </div>
              <div className="field" style={{ marginTop: 12 }}><label htmlFor="ex-j">Justificativa (obrigatória para compras)</label><textarea id="ex-j" name="justification" className="input" rows={2} /></div>
            </ActionForm></div>
          </div>
        );
      })() : null}

      {tab === 'contratos' ? await (async () => {
        const [{ rows, alerts }, suppliers] = await Promise.all([listContracts(ctx), listSuppliers(ctx)]);
        return (
          <div className="stack">
            {alerts.length ? <div className="alert alert-warn small">{alerts.length} contrato(s) dentro do prazo de aviso de término.</div> : null}
            <div className="card"><div className="card-body flush table-wrap" tabIndex={0}>
              {rows.length ? <table className="table"><thead><tr><th>Contrato</th><th>Vigência</th><th className="num">Mensal</th><th>Vencimento</th><th>Reajuste</th><th>Situação</th>{admin ? <th></th> : null}</tr></thead>
                <tbody>{rows.map((k) => (
                  <tr key={k.id} className={k.status === 'VIGENTE' ? undefined : 'row-muted'}>
                    <td>{k.object}<div className="small muted">{k.supplier_name} · {k.cost_center} · {k.category}</div></td>
                    <td className="small nowrap">{fmtDate(k.start_date)} – {k.end_date ? fmtDate(k.end_date) : 'indeterminado'}</td>
                    <td className="num">{k.monthly_amount ? brl(k.monthly_amount) : '—'}</td>
                    <td className="small">{k.due_day ? `dia ${k.due_day}` : '—'}</td>
                    <td className="small">{k.readjustment ?? '—'}</td>
                    <td><span className={k.status === 'VIGENTE' ? 'tag tag-ok' : 'tag'}>{k.status === 'VIGENTE' ? 'Vigente' : 'Encerrado'}</span></td>
                    {admin ? <td>{k.status === 'VIGENTE' ? <details className="disclosure small"><summary><a>Encerrar</a></summary><ActionForm action={financeAdminAction} submitLabel="Encerrar" submitClass="btn btn-sm btn-danger"><input type="hidden" name="op" value="encerrar_contrato" /><input type="hidden" name="id" value={k.id} /><input name="reason" className="input" placeholder="Motivo" aria-label="Motivo" required minLength={3} /></ActionForm></details> : null}</td> : null}
                  </tr>
                ))}</tbody></table> : <Empty>Nenhum contrato.</Empty>}
            </div></div>
            {admin ? (
              <div className="grid grid-2">
                <div className="card"><div className="card-head"><h2>Lançar despesas fixas do mês</h2><p>Gera, para aprovação, as mensalidades dos contratos vigentes (sem duplicar).</p></div>
                  <div className="card-body"><ActionForm action={financeAdminAction} submitLabel="Gerar lançamentos"><input type="hidden" name="op" value="gerar_fixas" /><input name="month" type="month" className="input" aria-label="Competência" defaultValue={month} required /></ActionForm></div>
                </div>
                <div className="card"><div className="card-head"><h2>Novo contrato</h2></div>
                  <div className="card-body"><ActionForm action={financeAdminAction} submitLabel="Salvar contrato" resetOnSuccess>
                    <input type="hidden" name="op" value="contrato" />
                    <div className="form-grid">
                      <div className="field"><label>Fornecedor<select name="supplierId" className="input" required>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></div>
                      <div className="field"><label>Objeto<input name="object" className="input" required minLength={3} /></label></div>
                      <div className="field"><label>Centro de custo<select name="costCenterId" className="input" required>{ccs.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select></label></div>
                      <div className="field"><label>Categoria<select name="categoryId" className="input" required>{expenseCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label></div>
                      <div className="field"><label>Início<input name="startDate" type="date" className="input" required /></label></div>
                      <div className="field"><label>Término<input name="endDate" type="date" className="input" /></label></div>
                      <div className="field"><label>Valor mensal (R$)<input name="monthly" className="input" inputMode="decimal" /></label></div>
                      <div className="field"><label>Dia de vencimento<input name="dueDay" type="number" min={1} max={31} className="input" /></label></div>
                      <div className="field"><label>Valor total (R$)<input name="total" className="input" inputMode="decimal" /></label></div>
                      <div className="field"><label>Aviso de término (dias)<input name="noticeDays" type="number" min={0} max={365} className="input" defaultValue={60} /></label></div>
                      <div className="field"><label>Reajuste (conforme contrato)<input name="readjustment" className="input" /></label></div>
                      <div className="field"><label>Arquivo do contrato<input name="file" type="file" className="input" /></label></div>
                    </div>
                  </ActionForm></div>
                </div>
              </div>
            ) : null}
          </div>
        );
      })() : null}

      {tab === 'fornecedores' ? await (async () => {
        const rows = await listSuppliers(ctx);
        return (
          <div className="stack">
            <div className="card"><div className="card-body flush table-wrap" tabIndex={0}>
              {rows.length ? <table className="table"><thead><tr><th>Fornecedor</th><th>Documento</th><th>Contato</th><th className="num">Contratos vigentes</th></tr></thead>
                <tbody>{rows.map((s) => <tr key={s.id} className={s.active ? undefined : 'row-muted'}><td>{s.name}</td><td className="small mono">{s.document_type} ••••{s.document_last4}</td><td className="small">{s.email ?? ''} {s.phone ?? ''}</td><td className="num">{s.contracts}</td></tr>)}</tbody></table> : <Empty>Nenhum fornecedor.</Empty>}
            </div></div>
            {admin ? (
              <div className="card"><div className="card-head"><h2>Novo fornecedor</h2><p>CNPJ/CPF é validado e guardado cifrado; a tela mostra só os 4 últimos dígitos.</p></div>
                <div className="card-body"><ActionForm action={financeAdminAction} submitLabel="Salvar fornecedor" resetOnSuccess>
                  <input type="hidden" name="op" value="fornecedor" />
                  <div className="form-grid">
                    <div className="field"><label>Nome / razão social<input name="name" className="input" required minLength={2} /></label></div>
                    <div className="field"><label>CNPJ ou CPF<input name="document" className="input mono" required /></label></div>
                    <div className="field"><label>E-mail<input name="email" type="email" className="input" /></label></div>
                    <div className="field"><label>Telefone<input name="phone" className="input" /></label></div>
                  </div>
                </ActionForm></div>
              </div>
            ) : null}
          </div>
        );
      })() : null}

      {tab === 'orcamento' ? await (async () => {
        const year = Number(sp.ano) || Number(today.slice(0, 4));
        const o = await financeOverview(ctx, `${year}-01`, `${year}-12`);
        const ccName = new Map(ccs.map((c) => [c.id, `${c.code} — ${c.name}`]));
        const catName = new Map(cats.map((c) => [c.id, c.name]));
        return (
          <div className="stack">
            <div className="row"><a className="btn btn-sm" href={`/financeiro?aba=orcamento&ano=${year - 1}`}>‹ {year - 1}</a><strong>{year}</strong><a className="btn btn-sm" href={`/financeiro?aba=orcamento&ano=${year + 1}`}>{year + 1} ›</a></div>
            <div className="card"><div className="card-head"><h2>Previsto × realizado — {year}</h2><p>Realizado = pago; comprometido = aprovado a pagar.</p></div>
              <div className="card-body flush table-wrap" tabIndex={0}>{o.budgetVsActual.length ? <table className="table"><thead><tr><th>Centro de custo</th><th>Categoria</th><th className="num">Previsto</th><th className="num">Realizado</th><th className="num">Comprometido</th><th className="num">Disponível</th><th className="num">Uso</th></tr></thead>
                <tbody>{o.budgetVsActual.map((r) => (
                  <tr key={`${r.cost_center_id}${r.category_id}`}><td className="small">{ccName.get(r.cost_center_id)}</td><td className="small">{catName.get(r.category_id)}</td><td className="num">{formatCents(r.budget)}</td><td className="num">{formatCents(r.paid)}</td>
                    <td className="num">{formatCents(r.committed)}</td><td className={`num ${r.available < 0 ? 'neg' : ''}`}>{formatCents(r.available)}</td>
                    <td className="num">{r.usedPct === null ? 'sem previsão' : `${r.usedPct}%`}</td></tr>
                ))}</tbody></table> : <Empty>Sem orçamento nem despesas no ano.</Empty>}</div>
            </div>
            {admin ? (
              <div className="card"><div className="card-head"><h2>Registrar previsão</h2></div>
                <div className="card-body"><ActionForm action={financeAdminAction} submitLabel="Salvar previsão">
                  <input type="hidden" name="op" value="orcamento" /><input type="hidden" name="year" value={year} />
                  <div className="form-grid">
                    <div className="field"><label>Centro de custo<select name="costCenterId" className="input">{ccs.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select></label></div>
                    <div className="field"><label>Categoria<select name="categoryId" className="input">{expenseCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label></div>
                    <div className="field"><label>Valor mensal (R$)<input name="amount" className="input" inputMode="decimal" required /></label></div>
                    <div className="field"><label>Aplicar a<select name="scope" className="input"><option value="ano">Todos os meses de {year}</option><option value="mes">Somente o mês</option></select></label></div>
                    <div className="field"><label>Mês (se "somente o mês")<input name="month" type="number" min={1} max={12} className="input" defaultValue={Number(today.slice(5, 7))} /></label></div>
                  </div>
                </ActionForm></div>
              </div>
            ) : null}
          </div>
        );
      })() : null}

      {tab === 'receitas' ? await (async () => {
        const rows = await listRevenues(ctx, sp.mes);
        const recCats = cats.filter((c) => c.kind === 'RECEITA' && c.active);
        return (
          <div className="stack">
            <div className="alert alert-info small">Registro gerencial para o fluxo de caixa. Não substitui os livros, a escrituração nem os relatórios oficiais de emolumentos.</div>
            <div className="card"><div className="card-body flush table-wrap" tabIndex={0}>{rows.length ? <table className="table"><thead><tr><th>Recebido em</th><th>Competência</th><th>Descrição</th><th>Categoria</th><th className="num">Valor</th><th></th></tr></thead>
              <tbody>{rows.map((r) => <tr key={r.id} className={r.reversed ? 'row-muted' : undefined}><td className="small">{fmtDate(r.received_on)}</td><td className="small">{monthLabel(r.competence)}</td><td className="small">{r.description}</td><td className="small">{r.category}</td>
                <td className={`num ${r.reverses_id ? 'neg' : ''}`}>{r.reverses_id ? '−' : ''}{brl(r.amount)}</td>
                <td>{!r.reverses_id && !r.reversed ? <details className="disclosure small"><summary><a>Estornar</a></summary><ActionForm action={financeAdminAction} submitLabel="Estornar" submitClass="btn btn-sm btn-danger"><input type="hidden" name="op" value="estornar_receita" /><input type="hidden" name="id" value={r.id} /><input name="reason" className="input" placeholder="Motivo" aria-label="Motivo" required minLength={3} /></ActionForm></details> : null}</td></tr>)}</tbody></table> : <Empty>Nenhum lançamento.</Empty>}</div></div>
            <div className="card"><div className="card-head"><h2>Lançar receita</h2></div>
              <div className="card-body"><ActionForm action={financeAdminAction} submitLabel="Lançar" resetOnSuccess>
                <input type="hidden" name="op" value="receita" />
                <div className="form-grid">
                  <div className="field"><label>Competência<input name="competence" type="month" className="input" defaultValue={month} required /></label></div>
                  <div className="field"><label>Recebido em<input name="receivedOn" type="date" className="input" defaultValue={today} required /></label></div>
                  <div className="field"><label>Categoria<select name="categoryId" className="input">{recCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label></div>
                  <div className="field"><label>Descrição<input name="description" className="input" required minLength={3} /></label></div>
                  <div className="field"><label>Valor (R$)<input name="amount" className="input" inputMode="decimal" required /></label></div>
                </div>
              </ActionForm></div>
            </div>
          </div>
        );
      })() : null}

      {tab === 'relatorios' ? await (async () => {
        const de = /^\d{4}-\d{2}$/.test(sp.de ?? '') ? sp.de! : today.slice(0, 7);
        const ate = /^\d{4}-\d{2}$/.test(sp.ate ?? '') && sp.ate! >= de ? sp.ate! : de;
        const o = await financeOverview(ctx, de, ate);
        const Table = ({ title, rows }: { title: string; rows: typeof o.byCategory }) => {
          const total = rows.reduce((a, r) => a + r.paid, 0);
          return (
            <div className="card"><div className="card-head"><h2>{title}</h2></div>
              <div className="card-body flush table-wrap" tabIndex={0}><table className="table"><thead><tr><th>Item</th><th className="num">Pago</th><th className="num">%</th><th className="num">Comprometido</th><th className="num">Solicitado</th></tr></thead>
                <tbody>{rows.map((r) => <tr key={r.name}><td>{r.name}</td><td className="num">{formatCents(r.paid)}</td><td className="num">{pct(r.paid, total) ?? '—'}</td><td className="num">{formatCents(r.committed)}</td><td className="num">{formatCents(r.requested)}</td></tr>)}</tbody></table></div>
            </div>
          );
        };
        return (
          <div className="stack">
            <form className="row" method="get" action="/financeiro">
              <input type="hidden" name="aba" value="relatorios" />
              <label className="small">De <input name="de" type="month" className="input" defaultValue={de} /></label>
              <label className="small">Até <input name="ate" type="month" className="input" defaultValue={ate} /></label>
              <button type="submit" className="btn">Atualizar</button>
              <a className="btn" href={`/api/v1/financeiro/relatorio?de=${de}&ate=${ate}`}>Exportar CSV</a>
            </form>
            <div className="grid grid-4">
              <Stat label="Pago" value={formatCents(o.totals.paid)} />
              <Stat label="Previsto (orçamento)" value={formatCents(o.totals.budget)} hint={o.totals.budget ? `${pct(o.totals.paid, o.totals.budget)}% realizado` : '—'} />
              <Stat label="Comprometido" value={formatCents(o.totals.committed)} />
              <Stat label="Solicitado (pendente)" value={formatCents(o.totals.requested)} />
            </div>
            <div className="grid grid-2"><Table title="Por categoria" rows={o.byCategory} /><Table title="Por centro de custo" rows={o.byCostCenter} /></div>
            <Table title="Por setor" rows={o.bySector} />
          </div>
        );
      })() : null}

      {tab === 'cadastros' ? await (async () => {
        const dir = await directory(ctx);
        return (
          <div className="grid grid-2">
            <div className="card"><div className="card-head"><h2>Centros de custo</h2></div>
              <div className="card-body flush table-wrap" tabIndex={0}><table className="table"><tbody>{ccs.map((c) => <tr key={c.id} className={c.active ? undefined : 'row-muted'}><td className="mono small">{c.code}</td><td>{c.name}</td><td className="small">{c.sector_name}</td></tr>)}</tbody></table></div>
              <div className="card-body"><ActionForm action={financeAdminAction} submitLabel="Incluir centro" resetOnSuccess>
                <input type="hidden" name="op" value="centro" /><input type="hidden" name="active" value="on" />
                <div className="form-grid"><div className="field"><label>Código<input name="code" className="input mono" required /></label></div><div className="field"><label>Nome<input name="name" className="input" required /></label></div>
                  <div className="field"><label>Setor<select name="sectorId" className="input">{dir.sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></div></div>
              </ActionForm></div>
            </div>
            <div className="card"><div className="card-head"><h2>Categorias</h2><p>Gerenciais; não constituem plano de contas contábil.</p></div>
              <div className="card-body flush table-wrap" tabIndex={0}><table className="table"><tbody>{cats.map((c) => <tr key={c.id} className={c.active ? undefined : 'row-muted'}><td className="mono small">{c.code}</td><td>{c.name}</td><td className="small">{c.kind.replace('_', ' ').toLowerCase()}</td></tr>)}</tbody></table></div>
              <div className="card-body"><ActionForm action={financeAdminAction} submitLabel="Incluir categoria" resetOnSuccess>
                <input type="hidden" name="op" value="categoria" /><input type="hidden" name="active" value="on" />
                <div className="form-grid"><div className="field"><label>Código<input name="code" className="input mono" required /></label></div><div className="field"><label>Nome<input name="name" className="input" required /></label></div>
                  <div className="field"><label>Tipo<select name="kind" className="input">{['DESPESA_FIXA', 'DESPESA_VARIAVEL', 'PESSOAL', 'INVESTIMENTO', 'RECEITA'].map((k) => <option key={k} value={k}>{k.replace('_', ' ').toLowerCase()}</option>)}</select></label></div></div>
              </ActionForm></div>
            </div>
          </div>
        );
      })() : null}
    </div>
  );
}

export default withGuard(FinanceiroPage);
