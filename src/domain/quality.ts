import { addDays, diffDays } from './time.ts';

// Regras puras de qualidade e segurança. Classificações são convenções internas de gestão (ajustáveis), não normas.

export type RiskBand = 'BAIXO' | 'MODERADO' | 'ALTO' | 'CRITICO';

/** Faixa do risco na matriz 5×5 (probabilidade × impacto): 1–4 baixo, 5–9 moderado, 10–16 alto, 20–25 crítico. */
export function riskBand(probability: number, impact: number): RiskBand {
  if (![probability, impact].every((x) => Number.isInteger(x) && x >= 1 && x <= 5)) throw new Error('Probabilidade e impacto devem estar entre 1 e 5.');
  const level = probability * impact;
  return level >= 20 ? 'CRITICO' : level >= 10 ? 'ALTO' : level >= 5 ? 'MODERADO' : 'BAIXO';
}

/** Mapa de calor: contagem de riscos por célula [impacto 5..1][probabilidade 1..5]. */
export function heatmap(risks: { probability: number; impact: number }[]): number[][] {
  const grid = Array.from({ length: 5 }, () => Array(5).fill(0) as number[]);
  for (const r of risks) grid[5 - r.impact]![r.probability - 1]!++;
  return grid;
}

export type Severity = 'BAIXA' | 'MEDIA' | 'ALTA' | 'CRITICA';

/** Prazo de correção de vulnerabilidade conforme a política (dias por severidade). */
export function vulnerabilityDue(detectedOn: string, severity: Severity, policy: Record<Severity, number>): string {
  return addDays(detectedOn, policy[severity]);
}

export type BackupRecord = { system: string; kind: 'BACKUP' | 'TESTE_RESTAURACAO'; performed_on: string; result: 'SUCESSO' | 'PARCIAL' | 'FALHA' };
export type BackupStatus = { system: string; lastBackup: string | null; lastBackupResult: string | null; lastRestoreOk: string | null; restoreOverdue: boolean; daysSinceRestore: number | null };

/** Situação por sistema: último backup e último teste de restauração BEM-SUCEDIDO; atraso pelo intervalo máximo. */
export function backupStatus(records: BackupRecord[], today: string, maxDays: number): BackupStatus[] {
  const systems = [...new Set(records.map((r) => r.system))].sort();
  return systems.map((system) => {
    const mine = records.filter((r) => r.system === system).sort((a, b) => b.performed_on.localeCompare(a.performed_on));
    const lastBackup = mine.find((r) => r.kind === 'BACKUP') ?? null;
    const lastRestoreOk = mine.find((r) => r.kind === 'TESTE_RESTAURACAO' && r.result === 'SUCESSO') ?? null;
    const days = lastRestoreOk ? diffDays(lastRestoreOk.performed_on, today) : null;
    return {
      system, lastBackup: lastBackup?.performed_on ?? null, lastBackupResult: lastBackup?.result ?? null,
      lastRestoreOk: lastRestoreOk?.performed_on ?? null, daysSinceRestore: days, restoreOverdue: days === null || days > maxDays,
    };
  });
}

/** Itens com data de vencimento dentro do aviso (ou vencidos). */
export function expiring<T extends { expires: string | null }>(items: T[], today: string, noticeDays: number) {
  return items.filter((i) => i.expires && diffDays(today, i.expires) <= noticeDays).map((i) => ({ ...i, daysLeft: diffDays(today, i.expires!) }))
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

export type ReqStatus = 'NAO_AVALIADO' | 'ATENDIDO' | 'PARCIAL' | 'NAO_ATENDIDO' | 'NAO_APLICAVEL';

/** Índice de atendimento: atendido = 1, parcial = 0,5; não aplicáveis fora do denominador; não avaliados contam como não atendidos. */
export function complianceIndex(statuses: ReqStatus[]): { pct: number | null; counts: Record<ReqStatus, number> } {
  const counts = { NAO_AVALIADO: 0, ATENDIDO: 0, PARCIAL: 0, NAO_ATENDIDO: 0, NAO_APLICAVEL: 0 } as Record<ReqStatus, number>;
  for (const s of statuses) counts[s]++;
  const applicable = statuses.length - counts.NAO_APLICAVEL;
  return { pct: applicable ? Math.round(((counts.ATENDIDO + counts.PARCIAL * 0.5) / applicable) * 1000) / 10 : null, counts };
}

/** Código sequencial legível: PREFIXO-ANO-NNN. */
export function sequenceCode(prefix: string, year: number, n: number): string {
  return `${prefix}-${year}-${String(n).padStart(3, '0')}`;
}
