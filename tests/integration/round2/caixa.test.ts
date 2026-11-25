import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import {
  addEntry, approveMonth, cashFlowReport, closeSession, confirmSession, dreReport, getSession, hasCashAccess, listRegisters, markDivergence, monthView, openSession,
  canCashTab, pendingClose, pendingConference, reopenSession, reverseEntry, saveRegister, yearView,
} from '../../../src/server/modules/cash.ts';
import { getStatement, importStatement, matchLine, parseCsv, parseOfx } from '../../../src/server/modules/cashReconcile.ts';
import { changeBreakdown, checkEntry } from '../../../src/domain/cash.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { addDays, todayLocal } from '../../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';

// Controle de caixa no modelo das planilhas da serventia: caixas individuais (Larissa, Bianca) e o Apoio compartilhado;
// troco automático; repasse × despesa; fechamento; conferência da Bárbara por um botão; OK final do mês; conciliação.
let I: Awaited<ReturnType<typeof ids>>;
let cOwner: Ctx, cBarbara: Ctx, cLarissa: Ctx, cBianca: Ctx, cOutra: Ctx;
let cxLarissa: string, cxApoio: string, day: string;
const today = todayLocal();
const month = today.slice(0, 7);

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  const p = (name: string, roles = [{ roleId: I.roles.COLABORADOR }], sector = I.sectors.ATD) => makePerson({ name, sectorId: sector, jobId: I.jobs.atendente, roles });
  cOwner = await ctxFor((await makePerson({ name: 'Oficial', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true })).userId);
  cBarbara = await ctxFor((await p('Bárbara Fictícia', [{ roleId: I.roles.SUBSTITUTA_LEGAL }], I.sectors.DIR)).userId);
  cLarissa = await ctxFor((await p('Larissa Fictícia')).userId);
  cBianca = await ctxFor((await p('Bianca Fictícia')).userId);
  cOutra = await ctxFor((await p('Outra Fictícia')).userId);
});
afterAll(closePool);

describe('Regras puras', () => {
  it('troco e cédulas (exemplo da planilha: R$ 158,47 com R$ 200,00)', () => {
    expect(checkEntry({ kind: 'ENTRADA', method: 'DINHEIRO', amount: 15847, received: 20000, protocol: '123' })).toEqual({ paid: 15847, received: 20000, change: 4153, pending: 0, protocolTotal: 15847 });
    expect(changeBreakdown(4153)).toEqual([
      { label: 'R$ 20', coin: false, count: 2 }, { label: 'R$ 1', coin: true, count: 1 }, { label: 'R$ 0,50', coin: true, count: 1 }, { label: 'R$ 0,01', coin: true, count: 3 },
    ]);
    // pagamento dividido: protocolo de 1.000,00 = 500,00 em dinheiro + 500,00 no cartão (sem trava de valor menor)
    expect(checkEntry({ kind: 'ENTRADA', method: 'DINHEIRO', amount: 100000, received: 50000, protocol: '1' })).toEqual({ paid: 50000, received: 50000, change: 0, pending: 50000, protocolTotal: 100000 });
    expect(checkEntry({ kind: 'ENTRADA', method: 'CARTAO_CREDITO', amount: 100000, received: 50000, protocol: '1' })).toEqual({ paid: 50000, received: 50000, change: 0, pending: 50000, protocolTotal: 100000 });
    expect(checkEntry({ kind: 'ENTRADA', method: 'PIX', amount: 300, protocol: '1' })).toMatchObject({ paid: 300, pending: 0 });
    expect(() => checkEntry({ kind: 'ENTRADA', method: 'PIX', amount: 15847, received: 20000, protocol: '1' })).toThrow(/não pode passar/);
    expect(() => checkEntry({ kind: 'ENTRADA', method: 'PIX', amount: 100 })).toThrow(/protocolo/);
    expect(() => checkEntry({ kind: 'SAIDA_DESPESA', method: 'DINHEIRO', amount: 100 })).toThrow(/favorecido/);
    expect(checkEntry({ kind: 'SAIDA_DESPESA', method: 'DINHEIRO', amount: 100, payee: 'CASAN – água' })).toEqual({ paid: 100, received: null, change: 0, pending: 0, protocolTotal: null });
  });
});

describe('Cadastro e acesso', () => {
  it('só a Oficial cadastra; individual tem uma operadora; compartilhado tem vários usuários', async () => {
    await expect(saveRegister(cBarbara, { code: 'LAR', name: 'Caixa Larissa', sectorId: I.sectors.ATD, shared: false, defaultFloatCents: 10000, operatorIds: [cLarissa.principal.userId] })).rejects.toThrow();
    await expect(saveRegister(cOwner, { code: 'LAR', name: 'Caixa Larissa', sectorId: I.sectors.ATD, shared: false, defaultFloatCents: 10000, operatorIds: [] })).rejects.toThrow(/exatamente uma/);
    cxLarissa = await saveRegister(cOwner, { code: 'LAR', name: 'Caixa Larissa', sectorId: I.sectors.ATD, shared: false, defaultFloatCents: 10000, operatorIds: [cLarissa.principal.userId] });
    cxApoio = await saveRegister(cOwner, { code: 'APOIO', name: 'Caixa do Apoio', sectorId: I.sectors.DIR, shared: true, defaultFloatCents: 5000,
      operatorIds: [cLarissa.principal.userId, cBianca.principal.userId] });
    expect((await listRegisters(cLarissa)).map((r) => r.code).sort()).toEqual(['APOIO', 'LAR']);
    expect((await listRegisters(cBianca)).map((r) => r.code)).toEqual(['APOIO']);
    expect(await hasCashAccess(getPool(), cOutra.principal)).toBe(false);
    expect((await listRegisters(cBarbara)).length).toBe(2);
  });
});

describe('Dia de caixa', () => {
  it('abre com o fundo de troco; só a operadora lança; colega não vê', async () => {
    await expect(openSession(cBianca, cxLarissa)).rejects.toThrow(/não opera/);
    day = await openSession(cLarissa, cxLarissa);
    await expect(openSession(cLarissa, cxLarissa)).rejects.toThrow(/já foi aberto/);
    expect((await getSession(cLarissa, day)).session.opening_float).toBe('100.00');
    await expect(getSession(cOutra, day)).rejects.toThrow(/não encontrado/);
  });

  it('entradas por forma de pagamento, troco gravado, repasse × despesa × devolução, sangria; estorno anula', async () => {
    const { id: e1 } = await addEntry(cLarissa, day, { kind: 'ENTRADA', method: 'DINHEIRO', protocol: '1001', amountCents: 15847, receivedCents: 20000 });
    await addEntry(cLarissa, day, { kind: 'ENTRADA', method: 'PIX', protocol: '1002', amountCents: 30000 });
    await addEntry(cLarissa, day, { kind: 'ENTRADA', method: 'CARTAO_DEBITO', protocol: '1003', amountCents: 12000, reference: 'NSU 778899' });
    await addEntry(cLarissa, day, { kind: 'SAIDA_REPASSE', method: 'DINHEIRO', protocol: '1001', amountCents: 2500, description: 'Correios' });
    await addEntry(cLarissa, day, { kind: 'SAIDA_DESPESA', method: 'DINHEIRO', payee: 'CASAN – água', amountCents: 8000 });
    await expect(addEntry(cLarissa, day, { kind: 'SAIDA_DESPESA', method: 'DINHEIRO', amountCents: 8000 })).rejects.toThrow(/favorecido/);
    const { id: wrong } = await addEntry(cLarissa, day, { kind: 'ENTRADA', method: 'DINHEIRO', protocol: '1004', amountCents: 5000 });
    await reverseEntry(cLarissa, wrong, 'Lançado em duplicidade');
    await expect(reverseEntry(cLarissa, wrong, 'De novo')).rejects.toThrow(/já foi estornado/);
    await expect(query(getPool(), 'DELETE FROM cash_entries WHERE id = $1', [e1])).rejects.toThrow();
    const v = await getSession(cLarissa, day);
    expect(v.entries.find((e) => e.id === e1)!.change_given).toBe('41.53');
    expect(v.summary.entradas).toEqual({ DINHEIRO: 15847, PIX: 30000, CARTAO_DEBITO: 12000, CARTAO_CREDITO: 0, DEPOSITO: 0 });
    expect(v.summary.repasses).toBe(2500);
    expect(v.summary.despesas).toBe(8000);
    // fundo 100,00 + dinheiro 158,47 − repasse 25,00 − despesa 80,00 = 153,47
    expect(v.summary.expectedCash).toBe(15347);
  });

  it('sangria e fechamento só por quem fecha (Bárbara); operadora não; calcula esperado e diferença; reabertura', async () => {
    await expect(addEntry(cLarissa, day, { kind: 'SANGRIA', method: 'DINHEIRO', amountCents: 1000 })).rejects.toThrow(/sangria/i);
    await expect(closeSession(cLarissa, day, { countedCents: 15347 })).rejects.toThrow(/fechar o caixa/);
    expect((await getSession(cLarissa, day)).can).toMatchObject({ add: true, sangria: false, close: false });
    expect((await getSession(cBarbara, day)).can).toMatchObject({ add: false, sangria: true, close: true });
    expect((await pendingClose(cBarbara)).map((d) => d.id)).toEqual([day]);
    expect(await pendingClose(cLarissa)).toEqual([]);
    const r = await closeSession(cBarbara, day, { countedCents: 15300, sentToDepositCents: 5000 });
    expect(r).toEqual({ expected: 15347, difference: -47 });
    await expect(addEntry(cLarissa, day, { kind: 'ENTRADA', method: 'PIX', protocol: '9', amountCents: 100 })).rejects.toThrow(/fechado/);
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'CAIXA_CONFERIR'", [cOwner.principal.userId]))!.n).toBe(1);
    expect((await pendingConference(cBarbara)).map((p) => p.id)).toEqual([day]);
    await reopenSession(cBarbara, day, 'Contagem refeita');
    await closeSession(cBarbara, day, { countedCents: 15347, sentToDepositCents: 5000 });
  });

  it('Bárbara aponta divergência e confirma o dia com um clique; quem lançou não confere; depois trava', async () => {
    const v = await getSession(cBarbara, day);
    expect(v.can.confirm).toBe(true);
    const pix = v.entries.find((e) => e.method === 'PIX')!;
    await expect(markDivergence(cLarissa, pix.id, 'x')).rejects.toThrow(/Somente quem confere/);
    await markDivergence(cBarbara, pix.id, 'PIX não localizado no extrato');
    await confirmSession(cBarbara, day, 'Conferido');
    await expect(markDivergence(cBarbara, pix.id, null)).rejects.toThrow(/já foi conferido/);
    const after = await getSession(cBarbara, day);
    expect(after.session.status).toBe('CONFERIDO');
    expect(after.entries.find((e) => e.id === pix.id)!.divergence).toContain('não localizado');
  });

  it('Apoio compartilhado grava o usuário de cada lançamento; quem lançou não confere o próprio dia', async () => {
    const d = await openSession(cBianca, cxApoio);
    await addEntry(cBianca, d, { kind: 'ENTRADA', method: 'DEPOSITO', protocol: '2001', amountCents: 45000 });
    await addEntry(cLarissa, d, { kind: 'ENTRADA', method: 'DINHEIRO', protocol: '2002', amountCents: 1000 });
    const v = await getSession(cOwner, d);
    expect(v.entries.map((e) => e.operator_name)).toEqual(['Bianca Fictícia', 'Larissa Fictícia']);
    await closeSession(cOwner, d, { countedCents: 6000 });
    await query(getPool(), "INSERT INTO cash_register_operators (register_id, user_id) VALUES ($1, $2)", [cxApoio, cBarbara.principal.userId]);
    await query(getPool(), "UPDATE cash_sessions SET status = 'ABERTO', closed_at = NULL, counted_cash = NULL WHERE id = $1", [d]);
    await addEntry(cBarbara, d, { kind: 'SUPRIMENTO', method: 'DINHEIRO', amountCents: 1000 });
    await closeSession(cOwner, d, { countedCents: 7000 });
    await expect(confirmSession(cBarbara, d)).rejects.toThrow(/próprio caixa/);
    await confirmSession(cOwner, d);
  });
});

describe('Pagamento dividido e permissões por aba', () => {
  it('protocolo de 1.000,00 pago 500,00 em dinheiro + 500,00 no cartão', async () => {
    const d = await openSession(cBianca, cxApoio).catch(async () => (await query<{ id: string }>(getPool(), "SELECT id FROM cash_sessions WHERE register_id = $1 AND work_date = $2", [cxApoio, today]))[0]!.id);
    await query(getPool(), "UPDATE cash_sessions SET status = 'ABERTO', closed_at = NULL, counted_cash = NULL WHERE id = $1", [d]);
    const a = await addEntry(cBianca, d, { kind: 'ENTRADA', method: 'DINHEIRO', protocol: '5000', amountCents: 100000, receivedCents: 50000 });
    expect(a.pending).toBe(50000);
    const b = await addEntry(cBianca, d, { kind: 'ENTRADA', method: 'CARTAO_CREDITO', protocol: '5000', amountCents: 100000, receivedCents: 50000 });
    expect(b.pending).toBe(50000);
    const rows = (await getSession(cOwner, d)).entries.filter((e) => e.protocol === '5000');
    expect(rows.map((e) => [e.method, e.amount, e.protocol_total])).toEqual([['DINHEIRO', '500.00', '1000.00'], ['CARTAO_CREDITO', '500.00', '1000.00']]);
    for (const e of rows) await reverseEntry(cBianca, e.id, 'Teste de pagamento dividido');
    await closeSession(cOwner, d, { countedCents: 7000 });
    await confirmSession(cOwner, d);
  });

  it('cada aba é uma permissão: caixa vê só Frente de caixa e Troco; Bárbara e Oficial veem tudo', () => {
    const tabs = ['hoje', 'mes', 'ano', 'conferencia', 'troco', 'relatorios', 'conciliacao', 'caixas'] as const;
    expect(tabs.filter((t) => canCashTab(cLarissa.principal, t))).toEqual(['hoje', 'troco']);
    expect(tabs.filter((t) => canCashTab(cBarbara.principal, t))).toEqual(['hoje', 'mes', 'ano', 'conferencia', 'troco', 'relatorios', 'conciliacao']);
    expect(tabs.filter((t) => canCashTab(cOwner.principal, t))).toEqual([...tabs]);
  });
});

describe('Mês, ano e relatórios', () => {
  it('OK final do mês só com todos os dias conferidos; reautenticação', async () => {
    const m = await monthView(cBarbara, cxLarissa, month);
    expect(m.totals).toMatchObject({ entradas: 57847, repasses: 2500, despesas: 8000, pendentes: 0, divergencias: 1 });
    expect(m.canApprove).toBe(true);
    await expect(approveMonth({ ...cBarbara, stepUpAt: null }, cxLarissa, month)).rejects.toThrow('reautenticação');
    await approveMonth(cBarbara, cxLarissa, month, 'Mês conferido');
    await expect(approveMonth(cBarbara, cxLarissa, month)).rejects.toThrow(/já foi aprovado/);
    await expect(monthView(cLarissa, cxLarissa, month)).rejects.toThrow(); // caixas não veem Mês nem Ano
    await expect(yearView(cLarissa, cxLarissa, 2026)).rejects.toThrow();
    expect((await monthView(cOwner, cxLarissa, month)).approval).not.toBeNull();
    const y = await yearView(cBarbara, cxLarissa, Number(month.slice(0, 4)));
    expect(y.find((r) => r.month === month)).toMatchObject({ days: 1, approved: true });
  });

  it('fluxo de caixa e DRE: só quem confere; repasse e devolução saem da receita, despesa do resultado', async () => {
    await expect(cashFlowReport(cLarissa, month, null)).rejects.toThrow();
    const f = await cashFlowReport(cOwner, month, null);
    const row = f.rows.find((r) => r.date === today)!;
    expect(row.methods.DEPOSITO).toBe(45000);
    expect(row.repasses).toBe(2500);
    const d = await dreReport(cOwner, month, month);
    expect(d.receitaBruta).toBe(57847 + 46000);
    expect(d.receitaLiquida).toBe(57847 + 46000 - 2500);
    expect(d.resultado).toBe(57847 + 46000 - 2500 - 8000);
  });
});

describe('Conciliação', () => {
  it('lê OFX e CSV (banco, cartão com NSU, livro de depósito prévio)', () => {
    const ofx = '<OFX><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>' + today.replace(/-/g, '') + '120000<TRNAMT>300.00<FITID>abc<MEMO>PIX RECEBIDO</STMTTRN>'
      + '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>' + today.replace(/-/g, '') + '<TRNAMT>-50,00<MEMO>TARIFA</STMTTRN></OFX>';
    expect(parseOfx(ofx)).toEqual([
      { date: today, cents: 30000, description: 'PIX RECEBIDO', document: 'abc', protocol: null },
      { date: today, cents: -5000, description: 'TARIFA', document: null, protocol: null },
    ]);
    const csv = `Extrato maquininha\nData da venda;Bandeira;Valor bruto;Valor líquido;NSU\n${today.split('-').reverse().join('/')};Visa;120,00;117,60;778899\n`;
    expect(parseCsv(csv, 'CARTAO')).toEqual([{ date: today, cents: 12000, description: null, document: '778899', protocol: null }]);
    expect(() => parseCsv('Data;Valor\n01/11/2026;10,00', 'DEPOSITO_PREVIO')).toThrow(/Protocolo/);
  });

  it('importa e concilia automaticamente; o que sobra fica pendente; conciliação manual', async () => {
    const yyyymmdd = today.replace(/-/g, '');
    const ofx = `<OFX><STMTTRN><DTPOSTED>${yyyymmdd}<TRNAMT>300.00<FITID>p1<MEMO>PIX</STMTTRN><STMTTRN><DTPOSTED>${yyyymmdd}<TRNAMT>450.00<FITID>d1<MEMO>DEPOSITO</STMTTRN>`
      + `<STMTTRN><DTPOSTED>${yyyymmdd}<TRNAMT>99.99<FITID>x1<MEMO>OUTRO</STMTTRN></OFX>`;
    await expect(importStatement(cLarissa, { name: 'extrato.ofx', bytes: Buffer.from(ofx) }, { source: 'BANCO', month })).rejects.toThrow();
    const bank = await importStatement(cBarbara, { name: 'extrato.ofx', bytes: Buffer.from(ofx) }, { source: 'BANCO', month, label: 'Conta corrente' });
    expect(bank).toMatchObject({ lines: 3, matched: 2 });
    await expect(importStatement(cBarbara, { name: 'de-novo.ofx', bytes: Buffer.from(ofx) }, { source: 'BANCO', month })).rejects.toThrow(/já foi importado/);
    const card = await importStatement(cBarbara, { name: 'cartao.csv', bytes: Buffer.from(`Data;Valor bruto;NSU\n${today.split('-').reverse().join('/')};120,00;778899\n`) }, { source: 'CARTAO', month });
    expect(card.matched).toBe(1);
    const dp = await importStatement(cBarbara, { name: 'deposito-previo.csv', bytes: Buffer.from(`Protocolo;Data;Valor\n2001;${today.split('-').reverse().join('/')};450,00\n`) }, { source: 'DEPOSITO_PREVIO', month });
    expect(dp.matched).toBe(1);

    const st = await getStatement(cBarbara, bank.id);
    const orphan = st.lines.find((l) => l.amount === '99.99')!;
    expect(orphan.matched_entry_id).toBeNull();
    const pix = st.lines.find((l) => l.amount === '300.00')!;
    await matchLine(cBarbara, pix.id, null);
    expect((await getStatement(cBarbara, bank.id)).unmatched.some((u) => u.amount === '300.00')).toBe(true);
    await matchLine(cBarbara, pix.id, pix.matched_entry_id);
    const v = await getSession(cBarbara, day);
    expect(v.entries.find((e) => e.method === 'PIX')!.reconciled).toEqual(['BANCO']);
    expect(v.entries.find((e) => e.method === 'CARTAO_DEBITO')!.reconciled).toEqual(['CARTAO']);
  });

  it('próximo dia: fundo de troco sugerido é o que ficou na gaveta; cadeia de auditoria íntegra', async () => {
    await query(getPool(), 'UPDATE cash_sessions SET work_date = $2 WHERE id = $1', [day, addDays(today, -1)]);
    await query(getPool(), 'DELETE FROM cash_month_approvals');
    const next = await openSession(cLarissa, cxLarissa);
    expect((await getSession(cLarissa, next)).session.opening_float).toBe('103.47'); // 153,47 contados − 50,00 ao depósito
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
