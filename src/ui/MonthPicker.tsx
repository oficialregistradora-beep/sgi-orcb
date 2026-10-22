import { addMonths } from '../domain/time.ts';

/** Navegação de competência via links (sem JavaScript). */
export function MonthPicker({ period, base, extra = {} }: { period: string; base: string; extra?: Record<string, string | undefined> }) {
  const prev = addMonths(`${period}-01`, -1).slice(0, 7);
  const next = addMonths(`${period}-01`, 1).slice(0, 7);
  const q = (p: string) => {
    const s = new URLSearchParams({ ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v)) as Record<string, string>, mes: p });
    return `${base}?${s.toString()}`;
  };
  const [y, m] = period.split('-');
  const raw = new Date(Date.UTC(Number(y), Number(m) - 1, 15)).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const name = raw.charAt(0).toUpperCase() + raw.slice(1);
  return (
    <div className="row" aria-label="Competência">
      <a className="btn btn-sm" href={q(prev)} aria-label="Mês anterior">‹</a>
      <span style={{ minWidth: 140, textAlign: 'center', fontWeight: 500 }}>{name}</span>
      <a className="btn btn-sm" href={q(next)} aria-label="Próximo mês">›</a>
    </div>
  );
}
