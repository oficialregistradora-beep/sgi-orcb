import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { withGuard } from '@/server/web/guard.ts';
import type { Ctx } from '@/server/context.ts';
import {
  canConfer, canManageCash, canSeeCashReports, cashFlowReport, dreReport, findSession, getSession, listRegisters, monthView, pendingConference, yearView,
} from '@/server/modules/cash.ts';
import { getStatement, listStatements, SOURCE_LABEL, type Source } from '@/server/modules/cashReconcile.ts';
import { listSectors } from '@/server/modules/admin.ts';
import { directory } from '@/server/modules/directory.ts';
import { CASH_KIND_LABEL, CASH_METHOD_LABEL, type CashMethod } from '@/domain/cash.ts';
import { formatCents, toCents } from '@/domain/money.ts';
import { todayLocal } from '@/domain/time.ts';
import { fmtDate, fmtDateTime, statusTone } from '@/ui/format.ts';
import { Empty, PageHead, Stat } from '@/ui/Stat.tsx';
import { MonthPicker } from '@/ui/MonthPicker.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { CashEntryFields, ChangeCalculator } from '@/ui/CashEntryFields.tsx';
import { cashConferAction, cashOperateAction, cashReconcileAction, cashRegisterAction } from '../../actions/cash.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Controle de caixa' };

const money = (v: string | number | null | undefined) => formatCents(typeof v === 'number' ? v : toCents(v ?? 0));
const METHODS = Object.keys(CASH_METHOD_LABEL) as CashMethod[];

type SP = { aba?: string; caixa?: string; mes?: string; ano?: string; dia?: string; extrato?: string; relatorio?: string; de?: string; ate?: string };

/** Um dia de caixa: lançamentos, troco, fechamento e, para a Bárbara, divergências e confirmação num clique. */
async function DayDetail({ ctx, sessionId }: { ctx: Ctx; sessionId: string }) {
  const v = await getSession(ctx, sessionId);
  const s = v.session;
  const sum = v.summary;
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><div><h2>{s.register_name} — {fmtDate(s.work_date)}</h2>
          <p><span className={statusTone(s.status === 'CONFERIDO' ? 'CONCLUIDA' : s.status === 'FECHADO' ? 'PENDENTE' : 'EM_ANDAMENTO')}>{s.status === 'ABERTO' ? 'Aberto' : s.status === 'FECHADO' ? 'Fechado — aguardando conferência' : 'Conferido'}</span>
            {' '}aberto por {s.opened_by_name}{s.closed_by_name ? ` · fechado por ${s.closed_by_name}` : ''}{s.checked_by_name ? ` · conferido por ${s.checked_by_name} em ${fmtDateTime(s.checked_at)}` : ''}</p></div></div>
        <div className="card-body">
          <div className="grid grid-4">
            <Stat label="Fundo de troco" value={money(s.opening_float)} />
            <Stat label="Entradas (todas as formas)" value={formatCents(sum.totalEntradas)} hint={METHODS.filter((m) => sum.entradas[m]).map((m) => `${CASH_METHOD_LABEL[m]} ${formatCents(sum.entradas[m])}`).join(' · ') || '—'} />
            <Stat label="Saídas" value={formatCents(sum.repasses + sum.despesas + sum.devolucoes)} hint={`Repasses ${formatCents(sum.repasses)} · Despesas ${formatCents(sum.despesas)} · Devoluções ${formatCents(sum.devolucoes)}`} />
            <Stat label="Dinheiro esperado na gaveta" value={formatCents(sum.expectedCash)} hint={sum.suprimentos || sum.sangrias ? `Suprimentos ${formatCents(sum.suprimentos)} · Sangrias ${formatCents(sum.sangrias)}` : undefined} />
          </div>
          {s.status !== 'ABERTO' ? (
            <p className="small" style={{ marginTop: 12 }}>Fechamento: contado <strong>{money(s.counted_cash)}</strong> · enviado ao depósito {money(s.sent_to_deposit)} ·
              {' '}diferença <strong className={toCents(s.difference) ? 'neg' : 'pos'}>{money(s.difference)}</strong>{s.close_notes ? ` · ${s.close_notes}` : ''}{s.check_notes ? ` · Conferência: ${s.check_notes}` : ''}</p>
          ) : null}
        </div>
      </div>

      {v.can.add ? (
        <div className="card"><div className="card-head"><h2>Novo lançamento</h2><p>Uma linha por pagamento e por forma de pagamento (pagamento misto = duas linhas). Nada é apagado: erro se corrige com estorno.</p></div>
          <div className="card-body">
            <ActionForm action={cashOperateAction} submitLabel="Lançar" resetOnSuccess>
              <input type="hidden" name="op" value="lancar" /><input type="hidden" name="sessionId" value={s.id} />
              <CashEntryFields />
            </ActionForm>
          </div></div>
      ) : null}

      <div className="card"><div className="card-head"><h2>Lançamentos</h2><p>{v.entries.length} linha(s)</p></div>
        <div className="card-body flush table-wrap" tabIndex={0}>
          {v.entries.length ? (
            <table className="table">
              <thead><tr><th>Hora</th>{s.shared ? <th>Usuário</th> : null}<th>Movimento</th><th>Forma</th><th>Protocolo / favorecido</th><th className="num">Valor</th><th className="num">Recebido</th><th className="num">Troco</th><th>Comprovante / obs.</th><th>Conferência</th></tr></thead>
              <tbody>{v.entries.map((e) => (
                <tr key={e.id} className={e.divergence ? 'row-warn' : e.reversed_by_id || e.kind === 'ESTORNO' ? 'row-muted' : undefined}>
                  <td className="small nowrap">{fmtDateTime(e.created_at).slice(-5)}</td>
                  {s.shared ? <td className="small">{e.operator_name}</td> : null}
                  <td className="small">{e.kind === 'ESTORNO' ? `Estorno de ${CASH_KIND_LABEL[e.orig_kind!].split(' (')[0]!.toLowerCase()}` : CASH_KIND_LABEL[e.kind]}{e.reversed_by_id ? <div className="muted">estornado</div> : null}</td>
                  <td className="small">{CASH_METHOD_LABEL[e.method]}</td>
                  <td className="small">{e.protocol ?? e.payee ?? '—'}</td>
                  <td className="num">{money(e.amount)}</td>
                  <td className="num small">{e.received ? money(e.received) : ''}</td>
                  <td className="num small">{toCents(e.change_given) ? money(e.change_given) : ''}</td>
                  <td className="small">{[e.reference, e.description].filter(Boolean).join(' · ')}
                    {e.reconciled.map((r) => <span key={r} className="tag tag-ok" style={{ marginLeft: 4 }}>conciliado: {r === 'BANCO' ? 'banco' : r === 'CARTAO' ? 'cartão' : 'dep. prévio'}</span>)}
                    {v.can.add && !e.reversed_by_id && e.kind !== 'ESTORNO' ? (
                      <details className="disclosure"><summary><a>Estornar</a></summary>
                        <ActionForm action={cashOperateAction} submitLabel="Estornar" submitClass="btn btn-sm btn-danger" confirm="Lançar o estorno desta linha?">
                          <input type="hidden" name="op" value="estornar" /><input type="hidden" name="entryId" value={e.id} />
                          <input name="reason" className="input" placeholder="Motivo" aria-label="Motivo do estorno" required minLength={3} />
                        </ActionForm></details>
                    ) : null}</td>
                  <td className="small" style={{ minWidth: 180 }}>
                    {e.divergence ? <div className="neg">Divergência: {e.divergence}{e.divergence_by ? ` (${e.divergence_by})` : ''}</div> : null}
                    {v.can.diverge ? (
                      <ActionForm action={cashConferAction} submitLabel={e.divergence ? 'Atualizar' : 'Apontar'} submitClass="btn btn-sm" inline>
                        <input type="hidden" name="op" value="divergencia" /><input type="hidden" name="entryId" value={e.id} />
                        <input name="note" className="input" placeholder="Divergência (vazio = retirar)" aria-label="Divergência" defaultValue={e.divergence ?? ''} />
                      </ActionForm>
                    ) : null}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          ) : <Empty>Nenhum lançamento neste dia.</Empty>}
        </div></div>

      {v.can.close ? (
        <div className="card"><div className="card-head"><h2>Fechamento do dia</h2><p>Conte o dinheiro da gaveta. O sistema compara com o esperado ({formatCents(sum.expectedCash)}) e avisa a conferência.</p></div>
          <div className="card-body">
            <ActionForm action={cashOperateAction} submitLabel="Fechar o caixa" confirm="Fechar o caixa do dia? Depois só a conferência reabre.">
              <input type="hidden" name="op" value="fechar" /><input type="hidden" name="sessionId" value={s.id} />
              <div className="form-grid">
                <div className="field"><label htmlFor="cf-c">Dinheiro contado na gaveta</label><input id="cf-c" name="counted" className="input" inputMode="decimal" required placeholder="0,00" /></div>
                <div className="field"><label htmlFor="cf-d">Enviado para depósito</label><input id="cf-d" name="deposit" className="input" inputMode="decimal" placeholder="0,00" /></div>
                <div className="field"><label htmlFor="cf-n">Observação</label><input id="cf-n" name="notes" className="input" maxLength={1000} /></div>
              </div>
            </ActionForm>
          </div></div>
      ) : null}

      {v.can.confirm || v.can.reopen ? (
        <div className="grid grid-2">
          {v.can.confirm ? (
            <div className="card"><div className="card-head"><h2>Bárbara: confirmar o dia</h2><p>Um clique confere todas as linhas do dia e trava. Anote antes as divergências na coluna "Conferência".</p></div>
              <div className="card-body">
                <ActionForm action={cashConferAction} submitLabel="Confirmar dia" confirm="Confirmar a conferência deste dia? Depois as linhas ficam travadas.">
                  <input type="hidden" name="op" value="confirmar" /><input type="hidden" name="sessionId" value={s.id} />
                  <div className="field"><label htmlFor="cc-n">Observação (opcional)</label><input id="cc-n" name="notes" className="input" maxLength={500} /></div>
                </ActionForm>
              </div></div>
          ) : <div className="alert alert-warn small">Você lançou neste dia: a confirmação cabe a outra pessoa (ou à Oficial).</div>}
          {v.can.reopen ? (
            <div className="card"><div className="card-head"><h2>Reabrir para correção</h2><p>Volta o dia para a operadora refazer a contagem.</p></div>
              <div className="card-body">
                <ActionForm action={cashConferAction} submitLabel="Reabrir" submitClass="btn">
                  <input type="hidden" name="op" value="reabrir" /><input type="hidden" name="sessionId" value={s.id} />
                  <div className="field"><label htmlFor="cr-r">Motivo</label><input id="cr-r" name="reason" className="input" required minLength={5} /></div>
                </ActionForm>
              </div></div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

async function CaixaPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePageCtx();
  const sp = await searchParams;
  const p = ctx.principal;
  const registers = await listRegisters(ctx);
  const confer = canConfer(p);
  const manage = canManageCash(p);
  const reports = canSeeCashReports(p);
  if (!registers.length && !confer && !manage) {
    return <div className="stack"><PageHead title="Controle de caixa" /><div className="alert alert-warn">Você não opera nenhum caixa. Fale com a Oficial.</div></div>;
  }
  const TABS: [string, string, boolean][] = [
    ['hoje', 'Frente de caixa', registers.length > 0], ['mes', 'Mês', registers.length > 0], ['ano', 'Ano', registers.length > 0],
    ['conferencia', 'Conferência', confer], ['troco', 'Troco', true], ['relatorios', 'Relatórios', reports], ['conciliacao', 'Conciliação', confer || manage], ['caixas', 'Caixas', manage],
  ];
  const visible = TABS.filter((t) => t[2]);
  const tab = sp.dia ? 'dia' : visible.some((t) => t[0] === sp.aba) ? sp.aba! : visible[0]![0];
  const today = todayLocal();
  const month = /^\d{4}-\d{2}$/.test(sp.mes ?? '') ? sp.mes! : today.slice(0, 7);
  const reg = registers.find((r) => r.id === sp.caixa) ?? registers.find((r) => r.active) ?? registers[0];
  const regPicker = (aba: string) => registers.length > 1 ? (
    <nav className="tabs" aria-label="Caixa">{registers.filter((r) => r.active).map((r) => <Link key={r.id} href={`/caixa?aba=${aba}&caixa=${r.id}&mes=${month}`} aria-current={reg?.id === r.id ? 'page' : undefined}>{r.name}</Link>)}</nav>
  ) : null;

  return (
    <div className="stack">
      <PageHead title="Controle de caixa" subtitle="Atendimento e administrativo: abertura, lançamentos, troco, fechamento, conferência da Bárbara no dia seguinte e aprovação final do mês." />
      <nav className="tabs">{visible.map(([k, l]) => <Link key={k} href={`/caixa?aba=${k}${reg ? `&caixa=${reg.id}` : ''}`} aria-current={tab === k ? 'page' : undefined}>{l}</Link>)}</nav>

      {tab === 'dia' ? <DayDetail ctx={ctx} sessionId={sp.dia!} /> : null}

      {tab === 'hoje' && reg ? await (async () => {
        const sid = await findSession(ctx, reg.id, today);
        return (
          <div className="stack">
            {regPicker('hoje')}
            {sid ? <DayDetail ctx={ctx} sessionId={sid} /> : (
              <div className="card"><div className="card-head"><h2>Abrir o caixa de hoje — {reg.name}</h2><p>O fundo de troco vem do que ficou na gaveta no último fechamento (ou do padrão do caixa).</p></div>
                <div className="card-body">
                  <ActionForm action={cashOperateAction} submitLabel="Abrir caixa">
                    <input type="hidden" name="op" value="abrir" /><input type="hidden" name="registerId" value={reg.id} />
                    <div className="field"><label htmlFor="ca-f">Fundo de troco (deixe em branco para o sugerido)</label><input id="ca-f" name="float" className="input" inputMode="decimal" placeholder="sugerido" /></div>
                  </ActionForm>
                </div></div>
            )}
          </div>
        );
      })() : null}

      {tab === 'mes' && reg ? await (async () => {
        const m = await monthView(ctx, reg.id, month);
        return (
          <div className="stack">
            {regPicker('mes')}
            <MonthPicker period={month} base="/caixa" extra={{ aba: 'mes', caixa: reg.id }} />
            <div className="grid grid-4">
              <Stat label="Entradas no mês" value={formatCents(m.totals.entradas)} />
              <Stat label="Repasses · despesas · devoluções" value={formatCents(m.totals.repasses + m.totals.despesas + m.totals.devolucoes)} hint={`${formatCents(m.totals.repasses)} · ${formatCents(m.totals.despesas)} · ${formatCents(m.totals.devolucoes)}`} />
              <Stat label="Diferenças de caixa" value={formatCents(m.totals.diferencas)} tone={m.totals.diferencas ? 'neg' : undefined} />
              <Stat label="Dias sem conferência · divergências" value={`${m.totals.pendentes} · ${m.totals.divergencias}`} tone={m.totals.pendentes || m.totals.divergencias ? 'neg' : undefined} />
            </div>
            <div className="card"><div className="card-body flush table-wrap" tabIndex={0}>
              {m.days.length ? (
                <table className="table">
                  <thead><tr><th>Dia</th>{METHODS.map((k) => <th key={k} className="num">{CASH_METHOD_LABEL[k]}</th>)}<th className="num">Repasses</th><th className="num">Despesas</th><th className="num">Devoluções</th><th className="num">Diferença</th><th>Situação</th></tr></thead>
                  <tbody>{m.days.map((d) => (
                    <tr key={d.session.id}>
                      <td className="nowrap"><Link href={`/caixa?dia=${d.session.id}`}>{fmtDate(d.session.work_date)}</Link></td>
                      {METHODS.map((k) => <td key={k} className="num small">{d.summary.entradas[k] ? formatCents(d.summary.entradas[k]) : ''}</td>)}
                      <td className="num small">{formatCents(d.summary.repasses)}</td><td className="num small">{formatCents(d.summary.despesas)}</td><td className="num small">{formatCents(d.summary.devolucoes)}</td>
                      <td className={`num small ${toCents(d.session.difference) ? 'neg' : ''}`}>{d.session.difference ? money(d.session.difference) : '—'}</td>
                      <td><span className={statusTone(d.session.status === 'CONFERIDO' ? 'CONCLUIDA' : 'PENDENTE')}>{d.session.status === 'CONFERIDO' ? 'Conferido' : d.session.status === 'FECHADO' ? 'A conferir' : 'Aberto'}</span>{d.divergences ? <span className="tag tag-danger" style={{ marginLeft: 4 }}>{d.divergences} div.</span> : null}</td>
                    </tr>
                  ))}</tbody>
                </table>
              ) : <Empty>Nenhum dia de caixa neste mês.</Empty>}
            </div></div>
            {m.approval ? <div className="alert alert-info small">Aprovação final do mês: {m.approval.approved_by_name}, {fmtDateTime(m.approval.approved_at)}{m.approval.notes ? ` — ${m.approval.notes}` : ''}.</div>
              : m.canApprove ? (
                <div className="card"><div className="card-head"><h2>Aprovação final do mês (Bárbara)</h2><p>Todos os dias estão conferidos. A aprovação pede o código do autenticador.</p></div>
                  <div className="card-body"><ActionForm action={cashConferAction} submitLabel="Aprovar o mês" confirm="Registrar a aprovação final deste mês?">
                    <input type="hidden" name="op" value="aprovar-mes" /><input type="hidden" name="registerId" value={reg.id} /><input type="hidden" name="month" value={month} />
                    <div className="field"><label htmlFor="am-n">Observação (opcional)</label><input id="am-n" name="notes" className="input" maxLength={500} /></div>
                  </ActionForm></div></div>
              ) : m.days.length ? <p className="small muted">A aprovação final do mês fica disponível quando todos os dias estiverem conferidos.</p> : null}
          </div>
        );
      })() : null}

      {tab === 'ano' && reg ? await (async () => {
        const year = Number(sp.ano) || Number(today.slice(0, 4));
        const rows = await yearView(ctx, reg.id, year);
        return (
          <div className="stack">
            {regPicker('ano')}
            <div className="row"><Link className="btn btn-sm" href={`/caixa?aba=ano&caixa=${reg.id}&ano=${year - 1}`}>‹ {year - 1}</Link><strong>{year}</strong><Link className="btn btn-sm" href={`/caixa?aba=ano&caixa=${reg.id}&ano=${year + 1}`}>{year + 1} ›</Link></div>
            <div className="card"><div className="card-body flush table-wrap" tabIndex={0}>
              <table className="table">
                <thead><tr><th>Mês</th><th className="num">Dias</th><th className="num">Entradas</th><th className="num">Repasses</th><th className="num">Despesas</th><th className="num">Devoluções</th><th className="num">Diferenças</th><th>Situação</th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.month} className={r.days ? undefined : 'row-muted'}>
                    <td><Link href={`/caixa?aba=mes&caixa=${reg.id}&mes=${r.month}`}>{r.month.slice(5)}/{r.month.slice(0, 4)}</Link></td>
                    <td className="num">{r.days}</td><td className="num">{formatCents(r.entradas)}</td><td className="num">{formatCents(r.repasses)}</td><td className="num">{formatCents(r.despesas)}</td>
                    <td className="num">{formatCents(r.devolucoes)}</td><td className={`num ${r.diferencas ? 'neg' : ''}`}>{formatCents(r.diferencas)}</td>
                    <td>{r.approved ? <span className="tag tag-ok">Aprovado</span> : r.days ? <span className="tag tag-warn">{r.pendentes ? `${r.pendentes} dia(s) a conferir` : 'Aguardando aprovação'}</span> : '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div></div>
          </div>
        );
      })() : null}

      {tab === 'conferencia' ? await (async () => {
        const pend = await pendingConference(ctx);
        return (
          <div className="card"><div className="card-head"><h2>Dias fechados aguardando conferência</h2><p>Confira PIX, cartão e depósitos com os extratos (aba Conciliação) e confirme cada dia com um clique.</p></div>
            <div className="card-body flush table-wrap" tabIndex={0}>
              {pend.length ? <table className="table"><thead><tr><th>Dia</th><th>Caixa</th><th>Fechado por</th><th className="num">Diferença</th><th></th></tr></thead>
                <tbody>{pend.map((d) => (
                  <tr key={d.id}><td>{fmtDate(d.work_date)}</td><td>{d.register_name}</td><td>{d.closed_by_name}</td><td className={`num ${toCents(d.difference) ? 'neg' : ''}`}>{money(d.difference)}</td>
                    <td><Link className="btn btn-sm btn-primary" href={`/caixa?dia=${d.id}`}>Conferir</Link></td></tr>
                ))}</tbody></table> : <Empty>Nenhum dia aguardando conferência.</Empty>}
            </div></div>
        );
      })() : null}

      {tab === 'troco' ? (
        <div className="card"><div className="card-head"><h2>Calculadora de troco</h2><p>Mostra o troco e as notas e moedas a devolver.</p></div><div className="card-body"><ChangeCalculator /></div></div>
      ) : null}

      {tab === 'relatorios' ? await (async () => {
        const kind = sp.relatorio === 'dre' ? 'dre' : 'fluxo';
        const sub = (
          <nav className="tabs"><Link href={`/caixa?aba=relatorios&relatorio=fluxo&mes=${month}`} aria-current={kind === 'fluxo' ? 'page' : undefined}>Fluxo de caixa mensal</Link>
            <Link href={`/caixa?aba=relatorios&relatorio=dre&mes=${month}`} aria-current={kind === 'dre' ? 'page' : undefined}>DRE gerencial</Link></nav>
        );
        if (kind === 'fluxo') {
          const regId = registers.some((r) => r.id === sp.caixa) ? sp.caixa! : null;
          const f = await cashFlowReport(ctx, month, regId);
          return (
            <div className="stack">{sub}
              <MonthPicker period={month} base="/caixa" extra={{ aba: 'relatorios', relatorio: 'fluxo', caixa: regId ?? undefined }} />
              <nav className="tabs" aria-label="Caixa"><Link href={`/caixa?aba=relatorios&relatorio=fluxo&mes=${month}`} aria-current={!regId ? 'page' : undefined}>Todos (consolidado)</Link>
                {registers.map((r) => <Link key={r.id} href={`/caixa?aba=relatorios&relatorio=fluxo&mes=${month}&caixa=${r.id}`} aria-current={regId === r.id ? 'page' : undefined}>{r.name}</Link>)}</nav>
              <div className="grid grid-4">
                <Stat label="Entradas realizadas" value={formatCents(f.totals.entradas)} /><Stat label="Saídas realizadas" value={formatCents(f.totals.saidas)} />
                <Stat label="Saldo do mês" value={formatCents(f.totals.saldo)} tone={f.totals.saldo < 0 ? 'neg' : undefined} />
                <Stat label="Previsto a pagar (financeiro)" value={f.withFinance ? formatCents(f.totals.previsto) : '—'} hint={f.withFinance ? 'Despesas solicitadas e aprovadas com vencimento no mês' : 'Só na visão consolidada, para quem vê todo o financeiro'} />
              </div>
              <div className="card"><div className="card-body flush table-wrap" tabIndex={0}>
                {f.rows.length ? <table className="table">
                  <thead><tr><th>Dia</th>{METHODS.map((k) => <th key={k} className="num">{CASH_METHOD_LABEL[k]}</th>)}{f.withFinance ? <th className="num">Receitas (financeiro)</th> : null}
                    <th className="num">Repasses</th><th className="num">Despesas caixa</th><th className="num">Devoluções</th>{f.withFinance ? <><th className="num">Pagamentos (financeiro)</th><th className="num">Previsto</th></> : null}<th className="num">Saldo do dia</th><th className="num">Acumulado</th></tr></thead>
                  <tbody>{f.rows.map((r) => (
                    <tr key={r.date}><td className="nowrap">{fmtDate(r.date)}</td>{METHODS.map((k) => <td key={k} className="num small">{r.methods[k] ? formatCents(r.methods[k]) : ''}</td>)}
                      {f.withFinance ? <td className="num small">{r.receitasFinanceiro ? formatCents(r.receitasFinanceiro) : ''}</td> : null}
                      <td className="num small">{r.repasses ? formatCents(r.repasses) : ''}</td><td className="num small">{r.despesasCaixa ? formatCents(r.despesasCaixa) : ''}</td><td className="num small">{r.devolucoes ? formatCents(r.devolucoes) : ''}</td>
                      {f.withFinance ? <><td className="num small">{r.pagamentosFinanceiro ? formatCents(r.pagamentosFinanceiro) : ''}</td><td className="num small muted">{r.previsto ? formatCents(r.previsto) : ''}</td></> : null}
                      <td className={`num ${r.saldoDia < 0 ? 'neg' : ''}`}>{formatCents(r.saldoDia)}</td><td className="num">{formatCents(r.acumulado)}</td></tr>
                  ))}</tbody></table> : <Empty>Sem movimento no mês.</Empty>}
              </div></div>
            </div>
          );
        }
        const de = /^\d{4}-\d{2}$/.test(sp.de ?? '') ? sp.de! : month;
        const ate = /^\d{4}-\d{2}$/.test(sp.ate ?? '') ? sp.ate! : month;
        const d = await dreReport(ctx, de, ate);
        const line = (l: string, v: number, strong = false, indent = false) => <tr><td style={indent ? { paddingLeft: 24 } : undefined}>{strong ? <strong>{l}</strong> : l}</td><td className={`num ${v < 0 ? 'neg' : ''}`}>{strong ? <strong>{formatCents(v)}</strong> : formatCents(v)}</td></tr>;
        return (
          <div className="stack">{sub}
            <form className="row" action="/caixa"><input type="hidden" name="aba" value="relatorios" /><input type="hidden" name="relatorio" value="dre" />
              <label className="small">De <input type="month" name="de" defaultValue={de} className="input" /></label><label className="small">Até <input type="month" name="ate" defaultValue={ate} className="input" /></label>
              <button className="btn btn-sm" type="submit">Atualizar</button></form>
            <div className="card"><div className="card-head"><h2>DRE gerencial — {de === ate ? de.split('-').reverse().join('/') : `${de.split('-').reverse().join('/')} a ${ate.split('-').reverse().join('/')}`}</h2>
              <p>Gerencial: não substitui a escrituração nem o Livro Diário Auxiliar.{d.withFinance ? '' : ' Despesas do financeiro só aparecem para quem vê todo o financeiro.'}</p></div>
              <div className="card-body flush"><table className="table"><tbody>
                {line('Receita bruta de atos (entradas do caixa)', d.receitaBruta, true)}
                {line('(−) Repasses a terceiros', -d.repasses, false, true)}
                {line('(−) Devoluções a clientes', -d.devolucoes, false, true)}
                {line('Receita líquida', d.receitaLiquida, true)}
                {line('(−) Despesas pagas no caixa', -d.despesasCaixa, false, true)}
                {d.despesasFinanceiro.map((x) => <tr key={x.name}><td style={{ paddingLeft: 24 }}>(−) {x.name} (financeiro)</td><td className="num neg">{formatCents(-x.cents)}</td></tr>)}
                {line('Resultado do período', d.resultado, true)}
              </tbody></table></div></div>
          </div>
        );
      })() : null}

      {tab === 'conciliacao' ? await (async () => {
        if (sp.extrato) {
          const v = await getStatement(ctx, sp.extrato);
          return (
            <div className="stack">
              <div className="row"><Link className="btn btn-ghost btn-sm" href={`/caixa?aba=conciliacao&mes=${v.statement.month}`}>← Voltar</Link><strong>{SOURCE_LABEL[v.statement.source]} — {v.statement.filename}</strong></div>
              <div className="card"><div className="card-head"><h2>Linhas do arquivo</h2><p>{v.lines.filter((l) => l.matched_entry_id).length} de {v.lines.filter((l) => Number(l.amount) > 0).length} entradas conciliadas</p></div>
                <div className="card-body flush table-wrap" tabIndex={0}>
                  <table className="table"><thead><tr><th>Data</th><th className="num">Valor</th><th>Histórico / NSU / protocolo</th><th>Lançamento do caixa</th><th></th></tr></thead>
                    <tbody>{v.lines.map((l) => (
                      <tr key={l.id} className={Number(l.amount) <= 0 ? 'row-muted' : !l.matched_entry_id ? 'row-warn' : undefined}>
                        <td className="nowrap">{fmtDate(l.line_date)}</td><td className="num">{money(l.amount)}</td>
                        <td className="small">{[l.description, l.document, l.protocol ? `prot. ${l.protocol}` : null].filter(Boolean).join(' · ')}</td>
                        <td className="small">{l.matched_entry_id ? `${l.entry_register} ${fmtDate(l.entry_date!)} · ${CASH_METHOD_LABEL[l.entry_method as CashMethod]}${l.entry_protocol ? ` · prot. ${l.entry_protocol}` : ''}${l.manual ? ' (manual)' : ''}` : Number(l.amount) > 0 ? 'Não localizado' : 'Débito (não se concilia)'}</td>
                        <td style={{ minWidth: 220 }}>{Number(l.amount) > 0 ? (
                          <ActionForm action={cashReconcileAction} submitLabel={l.matched_entry_id ? 'Desfazer' : 'Conciliar'} submitClass="btn btn-sm" inline>
                            <input type="hidden" name="op" value="conciliar" /><input type="hidden" name="lineId" value={l.id} />
                            {!l.matched_entry_id ? <select name="entryId" className="input" aria-label="Lançamento" required><option value="">Escolha…</option>
                              {v.unmatched.map((u) => <option key={u.id} value={u.id}>{fmtDate(u.work_date)} {u.register_code} {money(u.amount)} {CASH_METHOD_LABEL[u.method as CashMethod]}{u.protocol ? ` prot. ${u.protocol}` : ''}</option>)}</select> : null}
                          </ActionForm>) : null}</td>
                      </tr>
                    ))}</tbody></table>
                </div></div>
              <div className="card"><div className="card-head"><h2>Lançamentos do mês sem correspondência neste tipo de extrato</h2><p>Pendências para a conferência da Bárbara.</p></div>
                <div className="card-body flush table-wrap" tabIndex={0}>
                  {v.unmatched.length ? <table className="table"><thead><tr><th>Dia</th><th>Caixa</th><th>Forma</th><th className="num">Valor</th><th>Protocolo</th><th>Usuário</th></tr></thead>
                    <tbody>{v.unmatched.map((u) => <tr key={u.id}><td>{fmtDate(u.work_date)}</td><td>{u.register_code}</td><td>{CASH_METHOD_LABEL[u.method as CashMethod]}</td><td className="num">{money(u.amount)}</td><td>{u.protocol ?? '—'}</td><td>{u.operator_name}</td></tr>)}</tbody></table>
                    : <Empty>Tudo conciliado.</Empty>}
                </div></div>
              <div className="row">
                <ActionForm action={cashReconcileAction} submitLabel="Conciliar de novo automaticamente" submitClass="btn btn-sm" inline><input type="hidden" name="op" value="reprocessar" /><input type="hidden" name="statementId" value={v.statement.id} /></ActionForm>
                <ActionForm action={cashReconcileAction} submitLabel="Excluir este extrato" submitClass="btn btn-sm btn-danger" confirm="Excluir o extrato e as conciliações dele?" inline><input type="hidden" name="op" value="excluir" /><input type="hidden" name="statementId" value={v.statement.id} /></ActionForm>
              </div>
            </div>
          );
        }
        const list = await listStatements(ctx, month);
        return (
          <div className="stack">
            <MonthPicker period={month} base="/caixa" extra={{ aba: 'conciliacao' }} />
            <div className="card"><div className="card-head"><h2>Importar extrato do mês</h2><p>Banco: OFX (recomendado) ou CSV. Máquina de cartão: CSV ou XLSX com data, valor bruto e NSU. Livro de depósito prévio: CSV ou XLSX com protocolo, data e valor.</p></div>
              <div className="card-body">
                <ActionForm action={cashReconcileAction} submitLabel="Importar e conciliar" resetOnSuccess>
                  <input type="hidden" name="op" value="importar" /><input type="hidden" name="month" value={month} />
                  <div className="form-grid">
                    <div className="field"><label htmlFor="ci-s">Tipo</label><select id="ci-s" name="source" className="input">{(Object.keys(SOURCE_LABEL) as Source[]).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</select></div>
                    <div className="field"><label htmlFor="ci-l">Identificação (opcional)</label><input id="ci-l" name="label" className="input" placeholder="ex.: Conta corrente, Stone" maxLength={120} /></div>
                    <div className="field"><label htmlFor="ci-f">Arquivo</label><input id="ci-f" name="file" type="file" accept=".ofx,.csv,.txt,.xlsx" className="input" required /></div>
                  </div>
                </ActionForm>
              </div></div>
            <div className="card"><div className="card-body flush table-wrap" tabIndex={0}>
              {list.length ? <table className="table"><thead><tr><th>Tipo</th><th>Arquivo</th><th>Importado</th><th className="num">Conciliadas</th></tr></thead>
                <tbody>{list.map((s) => <tr key={s.id}><td>{SOURCE_LABEL[s.source]}{s.label ? <div className="small muted">{s.label}</div> : null}</td><td><Link href={`/caixa?aba=conciliacao&extrato=${s.id}`}>{s.filename}</Link></td>
                  <td className="small">{s.imported_by_name} · {fmtDateTime(s.imported_at)}</td><td className={`num ${s.matched < s.credits ? 'neg' : ''}`}>{s.matched} de {s.credits}</td></tr>)}</tbody></table>
                : <Empty>Nenhum extrato importado neste mês.</Empty>}
            </div></div>
          </div>
        );
      })() : null}

      {tab === 'caixas' ? await (async () => {
        const [sectors, dir] = await Promise.all([listSectors(), directory(ctx)]);
        const form = (r?: (typeof registers)[number]) => (
          <ActionForm action={cashRegisterAction} submitLabel={r ? 'Salvar' : 'Criar caixa'} resetOnSuccess={!r}>
            {r ? <input type="hidden" name="id" value={r.id} /> : null}
            <div className="form-grid">
              <div className="field"><label>Código<input name="code" className="input" required defaultValue={r?.code} placeholder="LARISSA" /></label></div>
              <div className="field"><label>Nome<input name="name" className="input" required defaultValue={r?.name} placeholder="Caixa Larissa" /></label></div>
              <div className="field"><label>Setor<select name="sectorId" className="input" defaultValue={r?.sector_id}>{sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></div>
              <div className="field"><label>Fundo de troco padrão<input name="float" className="input" inputMode="decimal" defaultValue={r ? money(r.default_float).replace('R$ ', '') : ''} placeholder="100,00" /></label></div>
            </div>
            <label className="check"><input type="checkbox" name="shared" defaultChecked={r?.shared} /> Compartilhado (ex.: Apoio): cada lançamento grava o usuário que lançou</label>
            {r ? <label className="check"><input type="checkbox" name="active" value="off" /> Desativar este caixa</label> : null}
            <fieldset className="stack"><legend className="label">Operadora(s)</legend>
              {dir.users.map((u) => <label key={u.id} className="check"><input type="checkbox" name="operators" value={u.id} defaultChecked={r?.operators.some((o) => o.id === u.id)} /> {u.display_name}</label>)}</fieldset>
          </ActionForm>
        );
        return (
          <div className="stack">
            <div className="card"><div className="card-head"><h2>Novo caixa</h2><p>Individual: uma operadora (ex.: Larissa, Bianca). Compartilhado: vários usuários (ex.: Apoio).</p></div><div className="card-body">{form()}</div></div>
            {registers.map((r) => (
              <details key={r.id} className="card disclosure"><summary className="card-head"><h2 style={{ display: 'inline' }}>{r.name}</h2> <span className="small muted">{r.code} · {r.sector_name} · {r.shared ? 'compartilhado' : 'individual'} · {r.operators.map((o) => o.name).join(', ')}{r.active ? '' : ' · desativado'}</span></summary>
                <div className="card-body">{form(r)}</div></details>
            ))}
          </div>
        );
      })() : null}
    </div>
  );
}

export default withGuard(CaixaPage);
