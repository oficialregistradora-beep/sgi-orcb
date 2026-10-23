import { writeFileSync, mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../src/server/db.ts';
import type { Ctx } from '../../src/server/context.ts';
import {
  addFinanceAttachment, addRevenue, decideExpense, financeOverview, generateContractExpenses, listFinanceCategories, registerPayment, requestExpense, saveContract,
  saveCostCenter, saveSupplier, setBudget,
} from '../../src/server/modules/finance.ts';
import { verifyAuditChain } from '../../src/server/audit.ts';
import { toCents } from '../../src/domain/money.ts';
import { dueDateIn, monthsBetween } from '../../src/domain/finance.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../helpers.ts';

// RODADA 3 (Fase 4b) — 9 meses (jan–set/2026): 3 centros de custo, 2 contratos mensais, orçamento anual,
// ~12 despesas variáveis por mês, decisões e pagamentos por pessoas distintas. Totais conferidos por SQL independente.

const MONTHS = monthsBetween('2026-01', '2026-09');
const metrics: Record<string, number> = {};
let seed = 59;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
let cOwner: Ctx, cSubst: Ctx, cPayer: Ctx, requesters: Ctx[] = [];
const RECEIPT = { name: 'c.pdf', bytes: new TextEncoder().encode('%PDF-1.4\n%sim\n%%EOF') };

beforeAll(async () => {
  await resetDatabase();
  const I = await ids();
  const o = await makePerson({ name: 'Oficial Sim', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
  const s = await makePerson({ name: 'Substituta Sim', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] });
  const p = await makePerson({ name: 'Pagador Sim', sectorId: I.sectors.DIR, jobId: I.jobs.atendente, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] });
  cOwner = await ctxFor(o.userId); cSubst = await ctxFor(s.userId); cPayer = await ctxFor(p.userId);
  for (const [name, sector] of [['Coord RI Sim', I.sectors.RI], ['Coord ATD Sim', I.sectors.ATD], ['Coord RCPN Sim', I.sectors.RCPN]] as const) {
    const c = await makePerson({ name, sectorId: sector, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }, { roleId: I.roles.COORDENACAO_SETOR }] });
    requesters.push(await ctxFor(c.userId));
  }
  (globalThis as Record<string, unknown>).__I = I;
});
afterAll(async () => {
  mkdirSync('docs/test-reports', { recursive: true });
  writeFileSync('docs/test-reports/rodada3-fase4b-metricas.json', JSON.stringify({ executadoEm: new Date().toISOString(), periodo: '2026-01 a 2026-09', metricas: metrics }, null, 2));
  await closePool();
});

describe('Rodada 3 (4b) — nove meses de operação financeira', () => {
  it('opera 9 meses com segregação em todas as etapas', async () => {
    const I = (globalThis as Record<string, unknown>).__I as Awaited<ReturnType<typeof ids>>;
    const cats = Object.fromEntries((await listFinanceCategories()).map((c) => [c.code, c.id]));
    const ccs = [
      await saveCostCenter(cOwner, { code: 'RI', name: 'RI', sectorId: I.sectors.RI, active: true }),
      await saveCostCenter(cOwner, { code: 'ATD', name: 'ATD', sectorId: I.sectors.ATD, active: true }),
      await saveCostCenter(cOwner, { code: 'RCPN', name: 'RCPN', sectorId: I.sectors.RCPN, active: true }),
    ];
    const sup = await saveSupplier(cOwner, { name: 'Fornecedor Sim', document: '11.222.333/0001-81' });
    await saveContract(cOwner, { supplierId: sup, object: 'Locação', costCenterId: ccs[0]!, categoryId: cats.ALUGUEL!, startDate: '2025-06-01', monthlyCents: 380000, dueDay: 31 });
    await saveContract(cOwner, { supplierId: sup, object: 'Internet', costCenterId: ccs[1]!, categoryId: cats.SISTEMAS!, startDate: '2026-03-15', endDate: '2026-08-14', monthlyCents: 19990, dueDay: 10 });
    for (const cc of ccs) await setBudget(cOwner, { year: 2026, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], costCenterId: cc, categoryId: cats.MATERIAL!, amountCents: 150000 });
    let requested = 0, approved = 0, rejected = 0, paid = 0, contractual = 0;
    for (const m of MONTHS) {
      contractual += await generateContractExpenses(cOwner, m);
      await addRevenue(cOwner, { competence: m, receivedOn: `${m}-15`, categoryId: cats.RECEITA_EMOL!, description: `Receita ${m}`, amountCents: 1500000 + Math.floor(rnd() * 300000) });
      for (let i = 0; i < 12; i++) {
        const k = Math.floor(rnd() * 3);
        await requestExpense(requesters[k]!, { kind: 'VARIAVEL', description: `Material ${m} #${i}`, costCenterId: ccs[k]!, categoryId: cats.MATERIAL!,
          amountCents: 1000 + Math.floor(rnd() * 40000), competence: m, dueDate: dueDateIn(m, 20) });
        requested++;
      }
      // Decisões: Substituta decide; as fixas são aprovadas pela Substituta (geradas pela Oficial).
      for (const e of await query<{ id: string }>(getPool(), "SELECT id FROM expenses WHERE competence = $1 AND status = 'SOLICITADA'", [`${m}-01`])) {
        if (rnd() < 0.1) { await decideExpense(cSubst, e.id, false, 'Fora da prioridade (sim)'); rejected++; } else { await decideExpense(cSubst, e.id, true); approved++; }
      }
      // Pagamentos pelo Pagador (não solicitou nem aprovou), no vencimento; ~5% ficam em aberto no último mês.
      for (const e of await query<{ id: string; amount: string; due_date: string }>(getPool(), "SELECT id, amount::text, due_date FROM expenses WHERE competence = $1 AND status = 'APROVADA'", [`${m}-01`])) {
        if (m === '2026-09' && rnd() < 0.3) continue;
        await addFinanceAttachment(cPayer, { expenseId: e.id }, 'COMPROVANTE', RECEIPT);
        await registerPayment(cPayer, e.id, { paidOn: e.due_date, amountCents: toCents(e.amount), method: rnd() < 0.5 ? 'PIX' : 'BOLETO' });
        paid++;
      }
    }
    Object.assign(metrics, { despesas_solicitadas: requested, mensalidades_de_contrato: contractual, aprovadas: approved, rejeitadas: rejected, pagas: paid });
    expect(contractual).toBe(9 + 6); // locação jan–set; internet mar–ago (6 competências, inclusive as de vigência parcial)
    const early = await query(getPool(), "SELECT e.id FROM expenses e JOIN contracts k ON k.id = e.contract_id WHERE e.due_date < k.start_date");
    expect(early).toEqual([]);
  });

  it('segregação respeitada em 100% dos registros', async () => {
    const v = await queryOne<{ self_approved: number; payer_conflict: number }>(getPool(),
      `SELECT count(*) FILTER (WHERE e.decided_by = e.requested_by)::int AS self_approved,
              count(*) FILTER (WHERE p.paid_by IN (e.requested_by, e.decided_by))::int AS payer_conflict
         FROM expenses e LEFT JOIN expense_payments p ON p.expense_id = e.id`);
    expect(v).toEqual({ self_approved: 0, payer_conflict: 0 });
  });

  it('totais do relatório conferem com SQL independente (centavos exatos)', async () => {
    const o = await financeOverview(cOwner, '2026-01', '2026-09');
    const sql = await queryOne<{ paid: string; committed: string; budget: string; payments: string; revenue: string }>(getPool(),
      `SELECT (SELECT coalesce(sum(amount),0) FROM expenses WHERE status = 'PAGA' AND competence BETWEEN '2026-01-01' AND '2026-09-01')::text AS paid,
              (SELECT coalesce(sum(amount),0) FROM expenses WHERE status = 'APROVADA' AND competence BETWEEN '2026-01-01' AND '2026-09-01')::text AS committed,
              (SELECT coalesce(sum(amount),0) FROM budget_lines WHERE year = 2026 AND month BETWEEN 1 AND 9)::text AS budget,
              (SELECT coalesce(sum(amount),0) FROM expense_payments WHERE paid_on BETWEEN '2026-01-01' AND '2026-09-30')::text AS payments,
              (SELECT coalesce(sum(CASE WHEN reverses_id IS NULL THEN amount ELSE -amount END),0) FROM revenue_entries WHERE received_on BETWEEN '2026-01-01' AND '2026-09-30')::text AS revenue`);
    expect(o.totals.paid).toBe(toCents(sql!.paid));
    expect(o.totals.committed).toBe(toCents(sql!.committed));
    expect(o.totals.budget).toBe(toCents(sql!.budget));
    expect(o.flow.reduce((a, r) => a + r.outflow, 0)).toBe(toCents(sql!.payments));
    expect(o.flow.reduce((a, r) => a + r.inflow, 0)).toBe(toCents(sql!.revenue));
    expect(o.flow.at(-1)!.balance).toBe(toCents(sql!.revenue) - toCents(sql!.payments));
    const sumBva = o.budgetVsActual.reduce((a, r) => a + r.paid, 0);
    expect(sumBva).toBe(toCents(sql!.paid));
    Object.assign(metrics, { pago_centavos: o.totals.paid, comprometido_centavos: o.totals.committed, orcamento_centavos: o.totals.budget, receitas_centavos: toCents(sql!.revenue) });
  });

  it('cada mensalidade de contrato lançada uma única vez por competência', async () => {
    const dup = await query(getPool(), "SELECT contract_id, competence FROM expenses WHERE origin = 'CONTRATO' AND status <> 'CANCELADA' GROUP BY 1,2 HAVING count(*) > 1");
    expect(dup).toEqual([]);
  });

  it('trilha de auditoria íntegra', async () => {
    const r = await verifyAuditChain(getPool());
    metrics.eventos_auditoria = r.total;
    expect(r.ok).toBe(true);
  });
});
