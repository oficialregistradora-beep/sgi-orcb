// Plantões e sobreaviso — regras puras. Sobreaviso, trabalho efetivo e banco de horas são apurados
// separadamente; gratificações nunca compensam o sobreaviso automaticamente (J-07).

export type OncallCall = { attended: boolean; arrival: Date | null; departure: Date | null; voided: boolean };

export type OncallTotals = { shiftMinutes: number; effectiveMinutes: number; effectiveInsideMinutes: number; standbyMinutes: number };

/**
 * Trabalho efetivo = união dos intervalos de comparecimento (inclusive além do horário do plantão).
 * Sobreaviso = duração do plantão menos o trabalho efetivo ocorrido dentro da janela do plantão.
 */
export function computeOncall(start: Date, end: Date, calls: OncallCall[]): OncallTotals {
  const intervals = calls
    .filter((c) => !c.voided && c.attended && c.arrival && c.departure)
    .map((c) => [c.arrival!.getTime(), c.departure!.getTime()] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const iv of intervals) {
    const last = merged.at(-1);
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([...iv]);
  }
  const s = start.getTime();
  const e = end.getTime();
  const toMin = (ms: number) => Math.round(ms / 60000);
  const effective = merged.reduce((a, [x, y]) => a + (y - x), 0);
  const inside = merged.reduce((a, [x, y]) => a + Math.max(0, Math.min(y, e) - Math.max(x, s)), 0);
  const shift = e - s;
  return {
    shiftMinutes: toMin(shift),
    effectiveMinutes: toMin(effective),
    effectiveInsideMinutes: toMin(inside),
    standbyMinutes: toMin(shift - inside),
  };
}

function toCents(v: string): bigint {
  if (!/^\d+(\.\d{1,2})?$/.test(v)) throw new Error('Valor inválido');
  const [i, f = ''] = v.split('.');
  return BigInt(i!) * 100n + BigInt(f.padEnd(2, '0'));
}

function fmtCents(c: bigint): string {
  const s = c.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

function divRound(num: bigint, den: bigint): bigint {
  return (num * 2n + den) / (den * 2n);
}

/** Valores estimados (informativos): sobreaviso = hora ÷ divisor; efetivo = hora × (1 + adicional%) se pago. */
export function oncallValues(
  standbyMinutes: number,
  effectiveMinutes: number,
  monthlySalary: string,
  divisorHours: number,
  standbyDivisor: number,
  premiumPercent: number,
): { standby: string; effectiveIfPaid: string } {
  const salary = toCents(monthlySalary);
  const standby = divRound(salary * BigInt(standbyMinutes), BigInt(divisorHours) * 60n * BigInt(standbyDivisor));
  const effective = divRound(salary * BigInt(100 + premiumPercent) * BigInt(effectiveMinutes), BigInt(divisorHours) * 60n * 100n);
  return { standby: fmtCents(standby), effectiveIfPaid: fmtCents(effective) };
}

/**
 * Escala em rodízio: distribui as datas entre os participantes, pulando quem estiver indisponível
 * (férias, afastamento) e designando como substituto o próximo disponível.
 */
export function buildRotation(
  dates: string[],
  participants: string[],
  unavailable: (employeeId: string, date: string) => boolean,
  startIndex = 0,
): { date: string; employeeId: string | null; substituteId: string | null }[] {
  const n = participants.length;
  let cursor = n ? startIndex % n : 0;
  return dates.map((date) => {
    // Ordem de tentativa a partir do cursor, sem alterá-lo durante a busca.
    const order = Array.from({ length: n }, (_, k) => (cursor + k) % n).filter((idx) => !unavailable(participants[idx]!, date));
    const [first, second] = order;
    if (first === undefined) return { date, employeeId: null, substituteId: null };
    cursor = (first + 1) % n;
    return { date, employeeId: participants[first]!, substituteId: second === undefined ? null : participants[second]! };
  });
}
