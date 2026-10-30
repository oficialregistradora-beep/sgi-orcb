import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx } from '../context.ts';
import { can, requirePermission, requireStepUp } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors.ts';

// Regras jurídicas parametrizadas por vigência, com fundamento, fonte e responsável pela validação (J-07/J-14).
// - Regras que alteram cálculos com efeito (banco de horas, prazos, bloqueios) só se aplicam se VALIDADAS.
// - Estimativas (custos, valores de sobreaviso) aceitam regra PENDENTE, sempre sinalizada.
// - Regras HISTÓRICAS (ex.: CCT anterior) são registradas para rastreabilidade e nunca aplicadas.

export const RULE_SCHEMAS = {
  SOBREAVISO_FRACAO: z.object({ numerador: z.number().int().min(1).max(10), denominador: z.number().int().min(1).max(10) }),
  EFETIVO_DSR_FERIADO_ADICIONAL: z.object({ percentual: z.number().int().min(0).max(300) }),
  ADICIONAL_HORA_EXTRA: z.object({ percentual: z.number().int().min(50).max(300) }),
  DIVISOR_SALARIO_HORAS: z.object({ horas: z.number().int().min(100).max(240) }),
  BANCO_FATOR_CONVERSAO: z.object({ minutosFolgaPorHora: z.number().int().min(60).max(180) }),
  BANCO_PRAZO: z.object({ modo: z.enum(['MESES', 'DIAS_APOS_MES']), quantidade: z.number().int().min(1).max(365) }),
  BANCO_COMUNICACAO_MINIMA: z.object({ horas: z.number().int().min(0).max(168) }),
  FERIAS_VEDAR_INICIO_FDS_FERIADO: z.object({ ativo: z.boolean() }),
  BANCO_FOLGA_DIAS_INICIO: z.object({ dias: z.array(z.number().int().min(0).max(6)).min(1).max(7) }),
  BANCO_DIAS_NAO_UTEIS: z.object({ excluir: z.boolean(), sabadosCursoPorAno: z.number().int().min(0).max(52) }),
} as const;
export type RuleCode = keyof typeof RULE_SCHEMAS;
export type RuleValue<C extends RuleCode> = z.infer<(typeof RULE_SCHEMAS)[C]>;

/** Regras que alteram cálculos com efeito real: exigem validação. */
export const BINDING_RULES: RuleCode[] = [
  'BANCO_FATOR_CONVERSAO', 'BANCO_PRAZO', 'BANCO_COMUNICACAO_MINIMA', 'FERIAS_VEDAR_INICIO_FDS_FERIADO', 'BANCO_FOLGA_DIAS_INICIO', 'BANCO_DIAS_NAO_UTEIS',
];

export const RULE_LABELS: Record<RuleCode, string> = {
  SOBREAVISO_FRACAO: 'Fração da hora de sobreaviso',
  EFETIVO_DSR_FERIADO_ADICIONAL: 'Adicional do trabalho efetivo em domingo/feriado não compensado',
  ADICIONAL_HORA_EXTRA: 'Adicional de hora extraordinária',
  DIVISOR_SALARIO_HORAS: 'Divisor do salário-hora',
  BANCO_FATOR_CONVERSAO: 'Banco de horas — conversão (minutos de folga por hora trabalhada)',
  BANCO_PRAZO: 'Banco de horas — prazo de compensação',
  BANCO_COMUNICACAO_MINIMA: 'Banco de horas — antecedência mínima da comunicação da folga',
  FERIAS_VEDAR_INICIO_FDS_FERIADO: 'Férias — vedar início em sábado, domingo ou feriado',
  BANCO_FOLGA_DIAS_INICIO: 'Banco de horas — dias em que a folga integral pode começar',
  BANCO_DIAS_NAO_UTEIS: 'Banco de horas — trabalho em sábado, domingo e feriado',
};

export const WEEKDAY_NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

export function describeValue(code: RuleCode, v: Record<string, unknown>): string {
  switch (code) {
    case 'SOBREAVISO_FRACAO': return `${v.numerador}/${v.denominador} da hora normal`;
    case 'EFETIVO_DSR_FERIADO_ADICIONAL':
    case 'ADICIONAL_HORA_EXTRA': return `${v.percentual}%`;
    case 'DIVISOR_SALARIO_HORAS': return `${v.horas} horas`;
    case 'BANCO_FATOR_CONVERSAO': return `1 h trabalhada = ${Math.floor(Number(v.minutosFolgaPorHora) / 60)}h${String(Number(v.minutosFolgaPorHora) % 60).padStart(2, '0')} de folga`;
    case 'BANCO_PRAZO': return v.modo === 'MESES' ? `${v.quantidade} meses` : `${v.quantidade} dias após o fim do mês da acumulação`;
    case 'BANCO_COMUNICACAO_MINIMA': return `${v.horas} horas de antecedência`;
    case 'FERIAS_VEDAR_INICIO_FDS_FERIADO': return v.ativo ? 'Vedado' : 'Permitido';
    case 'BANCO_FOLGA_DIAS_INICIO': return `Começa só em: ${(v.dias as number[]).map((d) => WEEKDAY_NAMES[d]).join(', ')}`;
    case 'BANCO_DIAS_NAO_UTEIS': return v.excluir
      ? `Não entra no banco (pago como extra), salvo plantão, casamento ou curso/palestra (até ${v.sabadosCursoPorAno} sábados/ano)`
      : 'Entra no banco normalmente';
  }
}

export type ResolvedRule<C extends RuleCode> = {
  id: string; code: C; value: RuleValue<C>; status: 'VALIDADO' | 'PENDENTE_VALIDACAO'; legalBasis: string; source: string;
  validatedBy: string | null; validFrom: string; validUntil: string | null;
};

/** Regra aplicável na data. `allowPending` somente para estimativas. Regras históricas nunca são retornadas. */
export async function getRule<C extends RuleCode>(db: Db, code: C, date: string, opts: { allowPending: boolean }): Promise<ResolvedRule<C> | null> {
  const r = await queryOne<{
    id: string; value: unknown; status: 'VALIDADO' | 'PENDENTE_VALIDACAO'; legal_basis: string; source: string; validated_by: string | null;
    valid_from: string; valid_until: string | null;
  }>(
    db,
    `SELECT id, value, status, legal_basis, source, validated_by, valid_from, valid_until FROM legal_rules
      WHERE code = $1 AND valid_from <= $2 AND (valid_until IS NULL OR valid_until >= $2)
        AND status = ANY($3::text[])
      ORDER BY (status = 'VALIDADO') DESC, valid_from DESC LIMIT 1`,
    [code, date, opts.allowPending ? ['VALIDADO', 'PENDENTE_VALIDACAO'] : ['VALIDADO']],
  );
  if (!r) return null;
  const parsed = RULE_SCHEMAS[code].safeParse(r.value);
  if (!parsed.success) throw new AppError(`Regra jurídica ${code} com valor inválido no cadastro.`, 500);
  return {
    id: r.id, code, value: parsed.data as RuleValue<C>, status: r.status, legalBasis: r.legal_basis, source: r.source,
    validatedBy: r.validated_by, validFrom: r.valid_from, validUntil: r.valid_until,
  };
}

export function basisText(r: ResolvedRule<RuleCode> | null, fallback: string): string {
  if (!r) return `${fallback} (parâmetro do sistema — sem regra jurídica cadastrada)`;
  return `${describeValue(r.code, r.value as Record<string, unknown>)} — ${r.legalBasis}${r.status === 'VALIDADO' ? ` · validado por ${r.validatedBy}` : ' · PENDENTE DE VALIDAÇÃO'}`;
}

// ---------------------------------------------------------------------------
// Consulta e manutenção
// ---------------------------------------------------------------------------
export async function listLegalRegistry(ctx: Ctx) {
  if (!can(ctx.principal, 'regras.juridicas.gerenciar') && !can(ctx.principal, 'configuracoes.gerenciar')) throw new ForbiddenError();
  const db = getPool();
  const instruments = await query<{ id: string; code: string; kind: string; title: string; valid_from: string | null; valid_until: string | null; status: string; source_url: string | null; notes: string | null }>(
    db, 'SELECT id, code, kind, title, valid_from, valid_until, status, source_url, notes FROM legal_instruments ORDER BY status, valid_from DESC NULLS FIRST');
  const rules = await query<{
    id: string; code: RuleCode; value: Record<string, unknown>; valid_from: string; valid_until: string | null; status: string;
    instrument_code: string | null; legal_basis: string; source: string; validated_by: string | null; validated_at: string | null; notes: string | null;
  }>(
    db,
    `SELECT r.id, r.code, r.value, r.valid_from, r.valid_until, r.status, i.code AS instrument_code, r.legal_basis, r.source,
            r.validated_by, r.validated_at, r.notes
       FROM legal_rules r LEFT JOIN legal_instruments i ON i.id = r.instrument_id
      ORDER BY r.code, r.status = 'HISTORICO_NAO_APLICAR', r.valid_from DESC`,
  );
  return { instruments, rules };
}

const createSchema = z.object({
  code: z.enum(Object.keys(RULE_SCHEMAS) as [RuleCode, ...RuleCode[]]),
  value: z.record(z.string(), z.unknown()),
  validFrom: z.iso.date(),
  validUntil: z.iso.date().nullable().optional(),
  instrumentId: z.uuid().nullable().optional(),
  legalBasis: z.string().trim().min(5).max(500),
  source: z.string().trim().min(3).max(500),
  validatedBy: z.string().trim().min(5).max(200).optional(),
  validatedAt: z.iso.date().optional(),
  notes: z.string().trim().max(1000).optional(),
});

function mapOverlap(e: unknown): never {
  if ((e as { code?: string }).code === '23P01') throw new ConflictError('Já existe regra validada com vigência sobreposta. Encerre a vigência anterior antes.');
  throw e;
}

export async function createRule(ctx: Ctx, input: z.input<typeof createSchema>): Promise<string> {
  requirePermission(ctx, 'regras.juridicas.gerenciar');
  const d = createSchema.parse(input);
  const value = RULE_SCHEMAS[d.code].parse(d.value);
  if (d.validUntil && d.validUntil < d.validFrom) throw new AppError('Fim da vigência anterior ao início.');
  if (!!d.validatedBy !== !!d.validatedAt) throw new AppError('Para registrar como validada, informe o responsável e a data da validação.');
  await requireStepUp(getPool(), ctx);
  return tx(async (c) => {
    const status = d.validatedBy ? 'VALIDADO' : 'PENDENTE_VALIDACAO';
    if (status === 'VALIDADO') await assertNoValidatedOverlap(c, d.code, d.validFrom, d.validUntil ?? null, null);
    const r = await queryOne<{ id: string }>(
      c,
      `INSERT INTO legal_rules (code, value, valid_from, valid_until, status, instrument_id, legal_basis, source, validated_by, validated_at, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [d.code, JSON.stringify(value), d.validFrom, d.validUntil ?? null, status, d.instrumentId ?? null, d.legalBasis, d.source,
        d.validatedBy ?? null, d.validatedAt ?? null, d.notes ?? null, ctx.principal.userId],
    ).catch(mapOverlap);
    await audit(c, ctx, {
      action: 'REGRA_JURIDICA_CADASTRADA', entityType: 'legal_rule', entityId: r!.id,
      summary: `${RULE_LABELS[d.code]}: ${describeValue(d.code, value as Record<string, unknown>)} a partir de ${d.validFrom} (${status})`,
      data: { legalBasis: d.legalBasis, source: d.source, validatedBy: d.validatedBy ?? null },
    });
    return r!.id;
  });
}

async function assertNoValidatedOverlap(c: Db, code: string, from: string, until: string | null, exceptId: string | null): Promise<void> {
  const o = await queryOne(
    c,
    `SELECT 1 FROM legal_rules WHERE code = $1 AND status = 'VALIDADO' AND id IS DISTINCT FROM $4
        AND daterange(valid_from, valid_until, '[]') && daterange($2::date, $3::date, '[]')`,
    [code, from, until, exceptId],
  );
  if (o) throw new ConflictError('Já existe regra validada com vigência sobreposta. Encerre a vigência anterior antes.');
}

const validateSchema = z.object({ ruleId: z.uuid(), validatedBy: z.string().trim().min(5).max(200), validatedAt: z.iso.date(), notes: z.string().trim().max(1000).optional() });

/** Registra a validação por profissional responsável (nome e registro). A regra passa a produzir efeitos. */
export async function validateRule(ctx: Ctx, input: z.input<typeof validateSchema>): Promise<void> {
  requirePermission(ctx, 'regras.juridicas.gerenciar');
  const d = validateSchema.parse(input);
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    const r = await queryOne<{ code: string; status: string; valid_from: string; valid_until: string | null }>(
      c, 'SELECT code, status, valid_from, valid_until FROM legal_rules WHERE id = $1 FOR UPDATE', [d.ruleId]);
    if (!r) throw new NotFoundError();
    if (r.status !== 'PENDENTE_VALIDACAO') throw new AppError('Somente regras pendentes podem ser validadas.');
    await assertNoValidatedOverlap(c, r.code, r.valid_from, r.valid_until, d.ruleId);
    await query(c, "UPDATE legal_rules SET status = 'VALIDADO', validated_by = $2, validated_at = $3, notes = coalesce($4, notes) WHERE id = $1", [
      d.ruleId, d.validatedBy, d.validatedAt, d.notes ?? null,
    ]).catch(mapOverlap);
    await audit(c, ctx, { action: 'REGRA_JURIDICA_VALIDADA', entityType: 'legal_rule', entityId: d.ruleId, summary: `Regra ${r.code} validada por ${d.validatedBy} em ${d.validatedAt}` });
  });
}

export async function closeRule(ctx: Ctx, ruleId: string, validUntil: string, reason: string): Promise<void> {
  requirePermission(ctx, 'regras.juridicas.gerenciar');
  z.uuid().parse(ruleId);
  z.iso.date().parse(validUntil);
  if (reason.trim().length < 5) throw new AppError('Informe o motivo.');
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    const r = await queryOne<{ code: string; valid_from: string }>(c, 'SELECT code, valid_from FROM legal_rules WHERE id = $1 FOR UPDATE', [ruleId]);
    if (!r) throw new NotFoundError();
    if (validUntil < r.valid_from) throw new AppError('Data anterior ao início da vigência.');
    await query(c, 'UPDATE legal_rules SET valid_until = $2, closed_by = $3, closed_at = now() WHERE id = $1', [ruleId, validUntil, ctx.principal.userId]);
    await audit(c, ctx, { action: 'REGRA_JURIDICA_ENCERRADA', entityType: 'legal_rule', entityId: ruleId, summary: `Vigência da regra ${r.code} encerrada em ${validUntil}`, data: { reason } });
  });
}

const instrumentSchema = z.object({
  instrumentId: z.uuid(),
  status: z.enum(['VIGENTE_LEITURA_PENDENTE', 'VIGENTE_VALIDADO', 'HISTORICO']),
  notes: z.string().trim().min(5).max(1000),
});

export async function setInstrumentStatus(ctx: Ctx, input: z.input<typeof instrumentSchema>): Promise<void> {
  requirePermission(ctx, 'regras.juridicas.gerenciar');
  const d = instrumentSchema.parse(input);
  await requireStepUp(getPool(), ctx);
  await tx(async (c) => {
    const r = await query(c, 'UPDATE legal_instruments SET status = $2, notes = $3 WHERE id = $1 RETURNING code', [d.instrumentId, d.status, d.notes]);
    if (!r.length) throw new NotFoundError();
    await audit(c, ctx, { action: 'INSTRUMENTO_SITUACAO', entityType: 'legal_instrument', entityId: d.instrumentId, summary: `Instrumento ${(r[0] as { code: string }).code}: ${d.status}`, data: { notes: d.notes } });
  });
}
