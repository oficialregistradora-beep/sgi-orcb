// Valores monetários em CENTAVOS (inteiros) na aplicação; numeric(14,2) no banco. Evita erros de ponto flutuante.

export const MAX_CENTS = 99_999_999_999_99; // limite de numeric(14,2)

/** Converte o texto do banco ("1234.56", "-10.00") em centavos. */
export function toCents(db: string | number | null | undefined): number {
  if (db === null || db === undefined || db === '') return 0;
  const s = String(db).trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Valor monetário inválido: ${s}`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '0').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

/** Centavos → texto para o banco ("1234.56"). */
export function centsToDb(c: number): string {
  if (!Number.isInteger(c)) throw new Error('Centavos devem ser inteiros.');
  const neg = c < 0;
  const a = Math.abs(c);
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/** Entrada do usuário ("1.234,56", "1234,5", "1234.56", "R$ 10") → centavos; null se vazio. Lança em formato inválido. */
export function parseBRL(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  let s = input.replace(/R\$\s*/i, '').replace(/\s/g, '');
  if (!s) return null;
  if (/,/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // formato brasileiro
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // "1.234" = mil duzentos e trinta e quatro
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('Valor inválido. Use o formato 1.234,56.');
  const c = toCents(s);
  if (c > MAX_CENTS) throw new Error('Valor acima do limite.');
  return c;
}

export function formatCents(c: number): string {
  const neg = c < 0;
  const a = Math.abs(c);
  const int = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}R$ ${int},${String(a % 100).padStart(2, '0')}`;
}

/** Percentual com uma casa (realizado / previsto). null quando não há previsão. */
export function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}
