'use client';

import { useEffect, useRef, useState } from 'react';
import { CASH_KIND_LABEL, CASH_METHOD_LABEL, changeBreakdown, type CashKind, type CashMethod } from '../domain/cash.ts';
import { formatCents, parseBRL } from '../domain/money.ts';

const safe = (v: string): number | null => { try { return parseBRL(v); } catch { return null; } };

/** Troco e cédulas a devolver, calculados na hora (evita erro de troco no balcão). Pagamento dividido: mostra quanto falta. */
export function ChangePreview({ amount, received }: { amount: number | null; received: number | null }) {
  if (amount == null || received == null) return null;
  if (received < amount) return <p className="small" role="status"><strong>Pagamento dividido:</strong> faltam {formatCents(amount - received)} deste protocolo — lance o restante na outra forma de pagamento (ex.: cartão).</p>;
  const change = received - amount;
  return (
    <div className="alert alert-info small" role="status">
      <strong>Troco: {formatCents(change)}</strong>
      {change > 0 ? <div>{changeBreakdown(change).map((b) => `${b.count} ${b.coin ? 'moeda' : 'nota'}${b.count > 1 ? 's' : ''} de ${b.label}`).join(' · ')}</div> : null}
    </div>
  );
}

const KINDS: Exclude<CashKind, 'ESTORNO' | 'SANGRIA'>[] = ['ENTRADA', 'SAIDA_REPASSE', 'SAIDA_DESPESA', 'SAIDA_DEVOLUCAO', 'SUPRIMENTO'];

/** Campos do lançamento: mostram só o que cada tipo pede (protocolo, favorecido, valor recebido e troco). */
export function CashEntryFields() {
  const [kind, setKind] = useState<Exclude<CashKind, 'ESTORNO' | 'SANGRIA'>>('ENTRADA');
  const [method, setMethod] = useState<CashMethod>('DINHEIRO');
  const [amount, setAmount] = useState('');
  const [received, setReceived] = useState('');
  const box = useRef<HTMLDivElement>(null);
  // Depois de cada lançamento o formulário é limpo: volta também a escolha de movimento e forma de pagamento.
  useEffect(() => {
    const form = box.current?.closest('form');
    if (!form) return;
    const reset = () => { setKind('ENTRADA'); setMethod('DINHEIRO'); setAmount(''); setReceived(''); };
    form.addEventListener('reset', reset);
    return () => form.removeEventListener('reset', reset);
  }, []);
  const cashOnly = kind === 'SUPRIMENTO';
  const needsProtocol = kind === 'ENTRADA' || kind === 'SAIDA_REPASSE' || kind === 'SAIDA_DEVOLUCAO';
  const showReceived = kind === 'ENTRADA';
  return (
    <div className="stack" ref={box}>
      <div className="form-grid">
        <div className="field"><label htmlFor="ce-k">Movimento</label>
          <select id="ce-k" name="kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {KINDS.map((k) => <option key={k} value={k}>{CASH_KIND_LABEL[k]}</option>)}
          </select></div>
        {!cashOnly ? (
          <div className="field"><label htmlFor="ce-m">Forma de pagamento</label>
            <select id="ce-m" name="method" className="input" value={method} onChange={(e) => setMethod(e.target.value as CashMethod)}>
              {(Object.keys(CASH_METHOD_LABEL) as CashMethod[]).map((m) => <option key={m} value={m}>{CASH_METHOD_LABEL[m]}</option>)}
            </select></div>
        ) : null}
        {needsProtocol ? <div className="field"><label htmlFor="ce-p">Nº do protocolo</label><input id="ce-p" name="protocol" className="input" required maxLength={60} /></div> : null}
        {kind === 'SAIDA_DESPESA' ? <div className="field"><label htmlFor="ce-f">Favorecido (ex.: CASAN – água)</label><input id="ce-f" name="payee" className="input" required maxLength={160} /></div> : null}
        <div className="field"><label htmlFor="ce-a">{kind === 'ENTRADA' ? 'Valor do protocolo' : 'Valor'}</label>
          <input id="ce-a" name="amount" className="input" inputMode="decimal" required placeholder="0,00" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        {showReceived ? <div className="field"><label htmlFor="ce-r">{method === 'DINHEIRO' ? 'Valor recebido em dinheiro (entregue)' : 'Valor pago nesta forma'}</label>
          <input id="ce-r" name="received" className="input" inputMode="decimal" placeholder="vazio = valor do protocolo" value={received} onChange={(e) => setReceived(e.target.value)} /></div> : null}
        <div className="field"><label htmlFor="ce-n">Comprovante / NSU (opcional)</label><input id="ce-n" name="reference" className="input" maxLength={120} /></div>
        <div className="field"><label htmlFor="ce-d">Observação (opcional)</label><input id="ce-d" name="description" className="input" maxLength={500} /></div>
      </div>
      {showReceived && received ? <ChangePreview amount={safe(amount)} received={safe(received)} /> : null}
      {showReceived ? <p className="small muted">Pagamento dividido (ex.: protocolo de R$ 1.000 com R$ 500 em dinheiro e R$ 500 no cartão): lance uma linha para cada forma, com o mesmo protocolo e o mesmo valor do protocolo, informando em cada uma o valor recebido naquela forma.</p> : null}
    </div>
  );
}

/** Aba Troco: calculadora avulsa. */
export function ChangeCalculator() {
  const [amount, setAmount] = useState('');
  const [received, setReceived] = useState('');
  return (
    <div className="stack">
      <div className="form-grid">
        <div className="field"><label htmlFor="tc-a">Valor do protocolo</label><input id="tc-a" className="input" inputMode="decimal" placeholder="158,47" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div className="field"><label htmlFor="tc-r">Valor entregue pelo cliente</label><input id="tc-r" className="input" inputMode="decimal" placeholder="200,00" value={received} onChange={(e) => setReceived(e.target.value)} /></div>
      </div>
      <ChangePreview amount={safe(amount)} received={safe(received)} />
    </div>
  );
}
