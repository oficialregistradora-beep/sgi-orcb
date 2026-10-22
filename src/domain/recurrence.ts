import { addDays, diffDays, formatHHMM, weekdayOf } from './time.ts';

// Regras puras de recorrência das rotinas, dependências entre tarefas e geometria do Gantt.

export type RoutineRule = {
  frequency: 'DIARIA' | 'SEMANAL' | 'MENSAL' | 'ANUAL';
  times: number[];
  weekdays: number[];
  month_day: number | null;
  month: number | null;
  business_days_only: boolean;
  starts_on: string;
  ends_on: string | null;
};

export type Occurrence = { key: string; date: string; dueTime: number | null };

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function nextBusinessDay(date: string, isBusinessDay: (d: string) => boolean): string {
  let d = date;
  for (let i = 0; i < 15 && !isBusinessDay(d); i++) d = addDays(d, 1);
  return d;
}

/** Data efetiva da ocorrência mensal/anual de um mês: dia pedido (ou último dia do mês), adiada ao próximo dia útil se exigido. */
function targetIn(year: number, month: number, day: number, r: RoutineRule, isBusinessDay: (d: string) => boolean): string {
  const dd = Math.min(day, lastDayOfMonth(year, month));
  const base = `${year}-${String(month).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  return r.business_days_only ? nextBusinessDay(base, isBusinessDay) : base;
}

/** A rotina ocorre nesta data? (Para MENSAL/ANUAL, considera também o adiamento vindo do mês anterior.) */
export function occursOn(r: RoutineRule, date: string, isBusinessDay: (d: string) => boolean): boolean {
  if (date < r.starts_on || (r.ends_on && date > r.ends_on)) return false;
  const business = isBusinessDay(date);
  switch (r.frequency) {
    case 'DIARIA':
      return !r.business_days_only || business;
    case 'SEMANAL':
      return r.weekdays.includes(weekdayOf(date)) && (!r.business_days_only || business);
    case 'MENSAL':
    case 'ANUAL': {
      const y = Number(date.slice(0, 4));
      const m = Number(date.slice(5, 7));
      const candidates: [number, number][] = [[y, m], m === 1 ? [y - 1, 12] : [y, m - 1]];
      return candidates.some(([cy, cm]) => (r.frequency === 'MENSAL' || cm === r.month) && targetIn(cy, cm, r.month_day!, r, isBusinessDay) === date);
    }
  }
}

/** Ocorrências (com chave única) da rotina na data: uma por horário configurado, ou uma única no dia. */
export function routineOccurrences(r: RoutineRule, date: string, isBusinessDay: (d: string) => boolean): Occurrence[] {
  if (!occursOn(r, date, isBusinessDay)) return [];
  if (!r.times.length) return [{ key: date, date, dueTime: null }];
  return [...new Set(r.times)].sort((a, b) => a - b).map((t) => ({ key: `${date}T${formatHHMM(t)}`, date, dueTime: t }));
}

/** Verdadeiro se a nova dependência (task → dependsOn) fecharia um ciclo. */
export function createsCycle(edges: { task_id: string; depends_on_id: string }[], task: string, dependsOn: string): boolean {
  if (task === dependsOn) return true;
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.task_id, [...(next.get(e.task_id) ?? []), e.depends_on_id]);
  // Há caminho de dependsOn até task? Então task → dependsOn fecha o ciclo.
  const seen = new Set<string>();
  const stack = [dependsOn];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === task) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(next.get(cur) ?? []));
  }
  return false;
}

export type GanttBar = { id: string; left: number; width: number; clippedStart: boolean; clippedEnd: boolean };

/** Posição (em % da janela from..to, inclusiva) de cada item com início e fim. Itens fora da janela são omitidos. */
export function ganttBars(items: { id: string; start: string | null; end: string | null }[], from: string, to: string): GanttBar[] {
  const total = diffDays(from, to) + 1;
  const out: GanttBar[] = [];
  for (const it of items) {
    const s = it.start ?? it.end;
    const e = it.end ?? it.start;
    if (!s || !e || e < from || s > to) continue;
    const cs = s < from ? from : s;
    const ce = e > to ? to : e;
    out.push({
      id: it.id,
      left: (diffDays(from, cs) / total) * 100,
      width: ((diffDays(cs, ce) + 1) / total) * 100,
      clippedStart: s < from, clippedEnd: e > to,
    });
  }
  return out;
}
