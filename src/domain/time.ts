// Utilitários de data/hora no fuso America/Sao_Paulo. Datas de competência são strings 'YYYY-MM-DD'
// (sem fuso); instantes são Date (UTC). Usa Intl para respeitar eventual retorno de horário de verão.

export const TZ = 'America/Sao_Paulo';

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export type LocalParts = { date: string; minutes: number; seconds: number; weekday: number };

export function toLocalParts(instant: Date): LocalParts {
  const p: Record<string, string> = {};
  for (const part of partsFmt.formatToParts(instant)) p[part.type] = part.value;
  const date = `${p.year}-${p.month}-${p.day}`;
  return {
    date,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    seconds: Number(p.second),
    weekday: weekdayOf(date),
  };
}

/** Deslocamento do fuso (minutos) em relação ao UTC no instante dado. Ex.: -180 para UTC-3. */
function offsetMinutesAt(instant: Date): number {
  const lp = toLocalParts(instant);
  const [y, m, d] = lp.date.split('-').map(Number) as [number, number, number];
  const asUtc = Date.UTC(y, m - 1, d, Math.floor(lp.minutes / 60), lp.minutes % 60, lp.seconds);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/** Converte data local + 'HH:MM' (America/Sao_Paulo) no instante UTC correspondente. */
export function localToInstant(date: string, hhmm: string): Date {
  assertDate(date);
  const mins = parseHHMM(hhmm);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, Math.floor(mins / 60), mins % 60);
  let guess = new Date(naive - offsetMinutesAt(new Date(naive)) * 60000);
  // Segunda iteração corrige transições de horário de verão.
  guess = new Date(naive - offsetMinutesAt(guess) * 60000);
  return guess;
}

export function assertDate(date: string): void {
  if (!isValidDate(date)) throw new Error(`Data inválida: ${date}`);
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function parseHHMM(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(hhmm);
  if (!m) throw new Error(`Horário inválido: ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Horário inválido: ${hhmm}`);
  return h * 60 + min;
}

export function formatHHMM(minutesOfDay: number): string {
  const h = Math.floor(minutesOfDay / 60);
  const m = minutesOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Formata uma duração em minutos como ±HH:MM (ex.: -01:05). */
export function formatDuration(minutes: number, signed = false): string {
  const sign = minutes < 0 ? '-' : signed && minutes > 0 ? '+' : '';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** 0 = domingo … 6 = sábado. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Soma meses mantendo o dia; se o mês de destino for mais curto, usa o último dia (31/08 + 6 = 28/02). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export function diffDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function monthRange(period: string): { from: string; to: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error(`Competência inválida: ${period}`);
  const from = `${period}-01`;
  return { from, to: addDays(addMonths(from, 1), -1) };
}

export function todayLocal(now = new Date()): string {
  return toLocalParts(now).date;
}

export function formatDateBR(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

export const WEEKDAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'] as const;
