// Apuração diária de jornada — regras puras, sem acesso a banco.
// Parâmetros jurídicos (tolerância, limites) são configuráveis e dependem de validação jurídica (J-04, J-12).

export type ScheduleDay = {
  start: number; // minutos desde 00:00
  breakStart: number | null;
  breakEnd: number | null;
  end: number;
};

export type Tolerance = { enabled: boolean; perMark: number; daily: number };

export type DayKind = 'UTIL' | 'DESCANSO' | 'FERIADO' | 'AUSENCIA_ABONADA';

export type DayAlert =
  | 'MARCACAO_INCOMPLETA'
  | 'INTERVALO_INSUFICIENTE'
  | 'HORAS_EXTRAS_ACIMA_LIMITE'
  | 'JORNADA_ACIMA_10H'
  | 'TRABALHO_EM_DIA_NAO_UTIL'
  | 'INTERJORNADA_INFERIOR_11H';

export const ALERT_LABELS: Record<DayAlert, string> = {
  MARCACAO_INCOMPLETA: 'Marcações em número ímpar (falta entrada ou saída)',
  INTERVALO_INSUFICIENTE: 'Intervalo intrajornada inferior a 1 hora em jornada acima de 6 horas (CLT art. 71)',
  HORAS_EXTRAS_ACIMA_LIMITE: 'Horas extras acima do limite diário (CLT art. 59)',
  JORNADA_ACIMA_10H: 'Jornada diária superior a 10 horas',
  TRABALHO_EM_DIA_NAO_UTIL: 'Trabalho em descanso semanal ou feriado — requer análise',
  INTERJORNADA_INFERIOR_11H: 'Descanso entre jornadas inferior a 11 horas (CLT art. 66)',
};

export type DayInput = {
  punches: number[]; // minutos do dia das marcações válidas
  schedule: ScheduleDay | null; // null = dia sem expediente previsto
  holiday: boolean; // feriado com dispensa
  absence: { countsAsWorked: boolean } | null;
  compensatedMinutes: number; // compensações aprovadas para o dia
  tolerance: Tolerance;
  maxDailyExtraMinutes: number;
  restSincePreviousMinutes: number | null; // da última marcação do dia anterior até a primeira do dia
};

export type DayResult = {
  kind: DayKind;
  expected: number;
  worked: number;
  compensated: number;
  rawDiff: number;
  diff: number;
  toleranceApplied: boolean;
  incomplete: boolean;
  intervals: [number, number][];
  alerts: DayAlert[];
};

export function scheduleMinutes(s: ScheduleDay): number {
  const brk = s.breakStart !== null && s.breakEnd !== null ? s.breakEnd - s.breakStart : 0;
  return s.end - s.start - brk;
}

function scheduleMarks(s: ScheduleDay): number[] {
  return s.breakStart !== null && s.breakEnd !== null ? [s.start, s.breakStart, s.breakEnd, s.end] : [s.start, s.end];
}

export function computeDay(input: DayInput): DayResult {
  const punches = [...input.punches].sort((a, b) => a - b);
  const intervals: [number, number][] = [];
  for (let i = 0; i + 1 < punches.length; i += 2) intervals.push([punches[i]!, punches[i + 1]!]);
  const incomplete = punches.length % 2 === 1;
  const worked = intervals.reduce((acc, [a, b]) => acc + (b - a), 0);

  let kind: DayKind;
  let expected = 0;
  if (input.absence?.countsAsWorked) kind = 'AUSENCIA_ABONADA';
  else if (input.holiday) kind = 'FERIADO';
  else if (!input.schedule) kind = 'DESCANSO';
  else {
    kind = 'UTIL';
    expected = scheduleMinutes(input.schedule);
  }

  const compensated = Math.max(0, Math.min(input.compensatedMinutes, expected));
  const rawDiff = worked + compensated - expected;
  let diff = rawDiff;
  let toleranceApplied = false;

  // CLT art. 58 §1º: variações de até 5 min por marcação, limitadas a 10 min diários, não são computadas.
  // Ultrapassado o limite, computa-se a totalidade (Súmula 366 do TST).
  if (input.tolerance.enabled && kind === 'UTIL' && !incomplete && rawDiff !== 0 && input.schedule) {
    if (compensated > 0) {
      if (Math.abs(rawDiff) <= input.tolerance.daily) {
        diff = 0;
        toleranceApplied = true;
      }
    } else {
      const marks = scheduleMarks(input.schedule);
      if (punches.length === marks.length) {
        const deviations = punches.map((p, i) => Math.abs(p - marks[i]!));
        const total = deviations.reduce((a, b) => a + b, 0);
        if (deviations.every((d) => d <= input.tolerance.perMark) && total <= input.tolerance.daily) {
          diff = 0;
          toleranceApplied = true;
        }
      }
    }
  }

  const alerts: DayAlert[] = [];
  if (incomplete) alerts.push('MARCACAO_INCOMPLETA');
  if (worked > 360) {
    let maxGap = 0;
    for (let i = 0; i + 1 < intervals.length; i++) maxGap = Math.max(maxGap, intervals[i + 1]![0] - intervals[i]![1]);
    if (maxGap < 60) alerts.push('INTERVALO_INSUFICIENTE');
  }
  if (diff > input.maxDailyExtraMinutes && kind === 'UTIL') alerts.push('HORAS_EXTRAS_ACIMA_LIMITE');
  if (worked > 600) alerts.push('JORNADA_ACIMA_10H');
  if (worked > 0 && (kind === 'DESCANSO' || kind === 'FERIADO')) alerts.push('TRABALHO_EM_DIA_NAO_UTIL');
  if (input.restSincePreviousMinutes !== null && punches.length > 0 && input.restSincePreviousMinutes < 660) {
    alerts.push('INTERJORNADA_INFERIOR_11H');
  }

  return { kind, expected, worked, compensated, rawDiff, diff, toleranceApplied, incomplete, intervals, alerts };
}

export type OccurrenceType = 'HORA_EXTRA' | 'DIFERENCA_NEGATIVA' | 'MARCACAO_INCOMPLETA';

/**
 * Ocorrências que exigem análise humana. Diferenças negativas NÃO viram débito automático e horas extras
 * NÃO são descartadas: ambas ficam pendentes até decisão de pessoa autorizada (J-05, J-06).
 */
export function deriveOccurrences(r: DayResult): { type: OccurrenceType; minutes: number }[] {
  if (r.incomplete) return [{ type: 'MARCACAO_INCOMPLETA', minutes: 0 }];
  if (r.diff > 0) return [{ type: 'HORA_EXTRA', minutes: r.diff }];
  if (r.diff < 0) return [{ type: 'DIFERENCA_NEGATIVA', minutes: -r.diff }];
  return [];
}

/** Sugere o tipo da próxima marcação a partir da quantidade de marcações válidas do dia. */
export function nextPunchKind(countToday: number): 'ENTRADA' | 'SAIDA_INTERVALO' | 'RETORNO_INTERVALO' | 'SAIDA' | 'ADICIONAL' {
  return (['ENTRADA', 'SAIDA_INTERVALO', 'RETORNO_INTERVALO', 'SAIDA'] as const)[countToday] ?? 'ADICIONAL';
}
