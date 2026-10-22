import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx } from '../context.ts';
import { can, requirePermission, requireStepUp } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ForbiddenError, NotFoundError } from '../errors.ts';
import { canonicalJson, sha256Hex } from '../crypto.ts';
import { getSetting } from '../settings.ts';
import { ALERT_LABELS } from '../../domain/journey.ts';
import { summarize } from '../../domain/hourBank.ts';
import { formatHHMM, monthRange, todayLocal, toLocalParts, WEEKDAY_NAMES } from '../../domain/time.ts';
import { computeRange, ensureProcessed } from './timeclock.ts';
import { getEmployeeFor, type EmployeeRow } from './people.ts';
import { activeAgreement, loadLedger } from './ledger.ts';
import { notifyEmployee, notifyUsers, usersWithPermission } from './notifications.ts';

// Assinatura eletrônica SIMPLES (Lei 14.063/2020, art. 4º, I) para atos administrativos internos (J-08).
// Cada assinatura vincula: identidade autenticada, versão exata (hash SHA-256), manifestação expressa e evidências.

export const DOC_KINDS = {
  ESPELHO: { category: 'Espelho de jornada', title: 'Espelho mensal de frequência' },
  EXTRATO_BANCO: { category: 'Extrato de banco de horas', title: 'Extrato mensal do banco de horas' },
  TERMO_ENTREGA: { category: 'Termos e declarações', title: 'Termo de entrega' },
} as const;

// Segunda etapa (aprovação por pessoa autorizada) configurável por tipo documental, sem alterar código.
const APPROVAL_DEFAULTS: Record<DocKind, boolean> = { ESPELHO: true, EXTRATO_BANCO: true, TERMO_ENTREGA: false };

export async function requiresApproval(db: Db, kind: DocKind): Promise<boolean> {
  return (await getSetting<boolean>(db, `documentos.aprovacao.${kind}`, APPROVAL_DEFAULTS[kind])) === true;
}
export type DocKind = keyof typeof DOC_KINDS;

export const RESSALVA_JORNADA =
  'Controle administrativo interno de frequência. Não constitui registro eletrônico de ponto (REP) nos termos da ' +
  'Portaria MTP nº 671/2021, cuja adequação depende de validação jurídica específica.';

export type Act = 'CIENCIA' | 'APROVACAO' | 'CONCORDANCIA' | 'CONTESTACAO';

export function statementFor(act: Act, hash: string): string {
  const v = hash.slice(0, 16);
  switch (act) {
    case 'CIENCIA':
      return `Declaro que tomei ciência do conteúdo deste documento (versão ${v}…). A ciência não implica concordância.`;
    case 'CONCORDANCIA':
      return `Declaro que concordo com o conteúdo deste documento (versão ${v}…).`;
    case 'CONTESTACAO':
      return `Registro contestação ao conteúdo deste documento (versão ${v}…), pelos motivos que exponho.`;
    case 'APROVACAO':
      return `Na qualidade de responsável autorizado(a), aprovo a conferência deste documento (versão ${v}…).`;
  }
}

function employeeHeader(e: EmployeeRow) {
  return { nome: e.social_name || e.full_name, matricula: e.registration_code, cargo: e.job_title, setor: e.sector_name };
}

async function buildTimesheet(db: Db, e: EmployeeRow, period: string) {
  const { from, to } = monthRange(period);
  const days = await computeRange(db, e.id, from, to);
  const occ = await query<{ work_date: string; type: string; minutes: number; status: string; resolution: string | null }>(
    db,
    "SELECT work_date, type, minutes, status, resolution FROM daily_occurrences WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3 AND status <> 'SUPERADA' ORDER BY work_date, type",
    [e.id, from, to],
  );
  const totals = { previsto: 0, trabalhado: 0, compensado: 0, extras: 0, negativas: 0 };
  const dias = days
    .filter((d) => d.inEmployment)
    .map((d) => {
      const r = d.result;
      totals.previsto += r.expected;
      totals.trabalhado += r.worked;
      totals.compensado += r.compensated;
      if (r.diff > 0) totals.extras += r.diff;
      if (r.diff < 0) totals.negativas += -r.diff;
      return {
        data: d.date,
        diaSemana: WEEKDAY_NAMES[new Date(`${d.date}T12:00:00Z`).getUTCDay()]!,
        situacao: r.kind,
        feriado: d.holidayName,
        ausencia: d.absenceType,
        marcacoes: d.punches.filter((p) => !p.annulled).map((p) => ({
          hora: formatHHMM(toLocalParts(p.punched_at).minutes),
          origem: p.source === 'CORRECAO' ? 'Correção aprovada' : p.source === 'IMPORTACAO' ? 'Importação' : 'Registro web',
        })),
        desconsideradas: d.punches.filter((p) => p.annulled).map((p) => formatHHMM(toLocalParts(p.punched_at).minutes)),
        previsto: r.expected,
        trabalhado: r.worked,
        compensado: r.compensated,
        diferenca: r.diff,
        toleranciaAplicada: r.toleranceApplied,
        alertas: r.alerts.map((a) => ALERT_LABELS[a]),
        ocorrencias: occ.filter((o) => o.work_date === d.date).map((o) => ({ tipo: o.type, minutos: o.minutes, situacao: o.status, decisao: o.resolution })),
      };
    });
  return {
    tipo: 'ESPELHO', layout: 1,
    orgao: await getSetting(db, 'org.nome', 'Ofício de Registros'),
    competencia: period,
    ressalva: RESSALVA_JORNADA,
    funcionario: employeeHeader(e),
    jornadaContratual: days.find((d) => d.scheduleName)?.scheduleName ?? null,
    dias,
    totais: totals,
  };
}

async function buildBankStatement(db: Db, e: EmployeeRow, period: string) {
  const { from, to } = monthRange(period);
  const { entries, allocations } = await loadLedger(db, e.id);
  const upTo = entries.filter((x) => x.entryDate <= to);
  const ids = new Set(upTo.map((x) => x.id));
  const summary = summarize(upTo, allocations.filter((a) => ids.has(a.debitEntryId)), to, 30);
  const lines = await query<{ entry_date: string; kind: string; minutes: number; expires_on: string | null; notes: string | null }>(
    db,
    'SELECT entry_date, kind, minutes, expires_on, notes FROM hour_bank_entries WHERE employee_id = $1 AND entry_date BETWEEN $2 AND $3 ORDER BY entry_date, created_at',
    [e.id, from, to],
  );
  const agreement = await activeAgreement(db, e.id, to);
  return {
    tipo: 'EXTRATO_BANCO', layout: 1,
    orgao: await getSetting(db, 'org.nome', 'Ofício de Registros'),
    competencia: period,
    funcionario: employeeHeader(e),
    acordo: agreement ? { modalidade: agreement.kind, prazoMeses: agreement.compensation_months } : null,
    lancamentos: lines.map((l) => ({ data: l.entry_date, tipo: l.kind, minutos: l.minutes, vencimento: l.expires_on, observacao: l.notes })),
    posicaoAoFinalDaCompetencia: {
      saldo: summary.balance, disponivel: summary.available, aVencerEm30Dias: summary.expiringSoon, vencidoRequerPagamento: summary.expired,
    },
    observacao: 'Saldos informativos. Créditos vencidos não compensados requerem pagamento ou análise (CLT, art. 59, §3º).',
  };
}

/** Gera (ou reutiliza, se o conteúdo for idêntico) a versão do documento mensal para assinatura. */
export async function prepareMonthlyDocument(ctx: Ctx, kind: DocKind, employeeId: string, period: string): Promise<string> {
  const e = await getEmployeeFor(ctx, kind === 'ESPELHO' ? 'jornada.ver' : 'banco.ver', employeeId);
  const { to } = monthRange(period);
  if (to >= todayLocal()) throw new AppError('O documento mensal só pode ser gerado após o término da competência.');
  await ensureProcessed(employeeId);
  const db = getPool();
  const pending = (await queryOne<{ n: number }>(
    db, "SELECT count(*)::int AS n FROM daily_occurrences WHERE employee_id = $1 AND status = 'PENDENTE' AND to_char(work_date,'YYYY-MM') = $2",
    [employeeId, period]))!.n;
  if (pending > 0) throw new AppError(`Há ${pending} ocorrência(s) pendente(s) de análise nesta competência. Conclua a análise antes de gerar o documento.`);
  const content = kind === 'ESPELHO' ? await buildTimesheet(db, e, period) : await buildBankStatement(db, e, period);
  return tx((c) => storeVersion(c, ctx, { kind, refKey: `${employeeId}:${period}`, title: `${DOC_KINDS[kind].title} — ${period}`, employeeId, sectorId: e.sector_id, ownerName: e.full_name, content }));
}

/**
 * Grava nova versão do documento (ou reutiliza a última, se o conteúdo for idêntico) e avisa o titular.
 * Deve ser chamada dentro de uma transação.
 */
export async function storeVersion(
  c: Db,
  ctx: Ctx,
  d: { kind: DocKind; refKey: string; title: string; employeeId: string; sectorId: string; ownerName: string; content: Record<string, unknown> },
): Promise<string> {
  const hash = sha256Hex(canonicalJson(d.content));
  let doc = await queryOne<{ id: string }>(c, 'SELECT id FROM documents WHERE reference_type = $1 AND reference_key = $2 FOR UPDATE', [d.kind, d.refKey]);
  if (!doc) {
    doc = await queryOne<{ id: string }>(
      c,
      `INSERT INTO documents (category, title, confidentiality, owner_employee_id, sector_id, reference_type, reference_key, created_by)
       VALUES ($1,$2,'RESTRITO',$3,$4,$5,$6,$7) RETURNING id`,
      [DOC_KINDS[d.kind].category, d.title, d.employeeId, d.sectorId, d.kind, d.refKey, ctx.principal.userId],
    );
  }
  const last = await queryOne<{ id: string; version_number: number; content_sha256: string }>(
    c, 'SELECT id, version_number, content_sha256 FROM document_versions WHERE document_id = $1 ORDER BY version_number DESC LIMIT 1', [doc!.id]);
  if (last && last.content_sha256 === hash) return last.id;
  const v = await queryOne<{ id: string }>(
    c,
    'INSERT INTO document_versions (document_id, version_number, content, content_sha256, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [doc!.id, (last?.version_number ?? 0) + 1, JSON.stringify(d.content), hash, ctx.principal.userId],
  );
  await audit(c, ctx, {
    action: 'DOCUMENTO_VERSAO', entityType: 'document_version', entityId: v!.id,
    summary: `${d.title} de ${d.ownerName}: versão ${(last?.version_number ?? 0) + 1} (sha256 ${hash.slice(0, 16)}…)`,
  });
  await notifyEmployee(c, d.employeeId, {
    kind: 'DOCUMENTO_PARA_ASSINATURA', title: `${d.title} disponível`,
    body: 'Confira e registre sua manifestação.', link: `/documentos-pessoais?doc=${v!.id}`, priority: 'ALTA',
  });
  return v!.id;
}

export type VersionView = {
  versionId: string; documentId: string; kind: DocKind; title: string; versionNumber: number; isLatest: boolean;
  content: Record<string, unknown>; contentSha256: string; createdAt: Date; ownerEmployeeId: string; sectorId: string;
  signatures: { id: string; act: Act; signer_name: string; signed_at: Date; comment: string | null; statement: string }[];
  requiresApproval: boolean;
};

async function loadVersion(db: Db, versionId: string) {
  z.uuid().parse(versionId);
  const v = await queryOne<{
    id: string; document_id: string; version_number: number; content: Record<string, unknown>; content_sha256: string; created_at: Date;
    reference_type: DocKind; title: string; owner_employee_id: string; sector_id: string; latest: number;
  }>(
    db,
    `SELECT v.id, v.document_id, v.version_number, v.content, v.content_sha256, v.created_at, d.reference_type, d.title,
            d.owner_employee_id, d.sector_id,
            (SELECT max(version_number) FROM document_versions x WHERE x.document_id = v.document_id) AS latest
       FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = $1`,
    [versionId],
  );
  if (!v) throw new NotFoundError('Documento não encontrado.');
  // Documentos do repositório institucional têm controle de acesso próprio (inclusive confidenciais): não são abertos aqui.
  if (!(v.reference_type in DOC_KINDS)) throw new NotFoundError('Documento não encontrado.');
  return v;
}

function viewPermission(kind: DocKind) {
  return kind === 'ESPELHO' ? 'jornada.ver' : kind === 'EXTRATO_BANCO' ? 'banco.ver' : 'pessoas.ver';
}

export async function getVersion(ctx: Ctx, versionId: string): Promise<VersionView> {
  const db = getPool();
  const v = await loadVersion(db, versionId);
  requirePermission(ctx, viewPermission(v.reference_type), { employeeId: v.owner_employee_id, sectorId: v.sector_id });
  const signatures = await query<VersionView['signatures'][number]>(
    db,
    `SELECT s.id, s.act, u.display_name AS signer_name, s.signed_at, s.comment, s.statement
       FROM signatures s JOIN users u ON u.id = s.signer_user_id WHERE s.document_version_id = $1 ORDER BY s.signed_at`,
    [versionId],
  );
  return {
    versionId: v.id, documentId: v.document_id, kind: v.reference_type, title: v.title, versionNumber: v.version_number,
    isLatest: v.version_number === v.latest, content: v.content, contentSha256: v.content_sha256, createdAt: v.created_at,
    ownerEmployeeId: v.owner_employee_id, sectorId: v.sector_id, signatures, requiresApproval: await requiresApproval(db, v.reference_type),
  };
}

export async function listEmployeeDocuments(ctx: Ctx, employeeId: string) {
  await getEmployeeFor(ctx, 'jornada.ver', employeeId);
  return query<{
    document_id: string; title: string; reference_type: DocKind; version_id: string; version_number: number; created_at: Date;
    employee_ack: string | null; approved: boolean;
  }>(
    getPool(),
    `SELECT d.id AS document_id, d.title, d.reference_type, v.id AS version_id, v.version_number, v.created_at,
            (SELECT s.act FROM signatures s WHERE s.document_version_id = v.id AND s.act IN ('CIENCIA','CONTESTACAO','CONCORDANCIA') ORDER BY s.signed_at LIMIT 1) AS employee_ack,
            EXISTS (SELECT 1 FROM signatures s WHERE s.document_version_id = v.id AND s.act = 'APROVACAO') AS approved
       FROM documents d
       JOIN LATERAL (SELECT * FROM document_versions x WHERE x.document_id = d.id ORDER BY version_number DESC LIMIT 1) v ON TRUE
      WHERE d.owner_employee_id = $1 AND d.reference_type IN ('ESPELHO','EXTRATO_BANCO','TERMO_ENTREGA')
      ORDER BY d.reference_key DESC, d.reference_type`,
    [employeeId],
  );
}

const signSchema = z.object({
  versionId: z.uuid(),
  act: z.enum(['CIENCIA', 'APROVACAO', 'CONCORDANCIA', 'CONTESTACAO']),
  comment: z.string().trim().max(2000).optional(),
  confirmed: z.literal(true, { error: 'É necessário confirmar expressamente a manifestação.' }),
});

export async function signVersion(ctx: Ctx, input: z.input<typeof signSchema>): Promise<string> {
  const d = signSchema.parse(input);
  await requireStepUp(getPool(), ctx);
  return tx(async (c) => {
    const v = await loadVersion(c, d.versionId);
    await query(c, "SELECT pg_advisory_xact_lock(hashtext('sign:' || $1))", [v.id]);
    if (v.version_number !== v.latest) throw new AppError('Esta versão foi substituída. Assine a versão mais recente.');
    if (sha256Hex(canonicalJson(v.content)) !== v.content_sha256) {
      throw new AppError('Falha de integridade: o conteúdo não corresponde ao hash registrado. Operação bloqueada.', 500, 'INTEGRIDADE');
    }
    const existing = await query<{ act: Act; signer_user_id: string }>(c, 'SELECT act, signer_user_id FROM signatures WHERE document_version_id = $1', [v.id]);
    const isOwnerEmployee = ctx.principal.employeeId === v.owner_employee_id;
    if (d.act === 'APROVACAO') {
      if (isOwnerEmployee) throw new ForbiddenError('O próprio funcionário não pode aprovar seu documento.');
      if (!(await requiresApproval(c, v.reference_type))) throw new AppError('Este tipo de documento não exige aprovação (configuração).');
      requirePermission(ctx, 'espelho.aprovar', { employeeId: v.owner_employee_id, sectorId: v.sector_id });
      const employeeAck = existing.find((s) => s.act !== 'APROVACAO');
      if (!employeeAck) throw new AppError('Dupla conferência: aguarde a manifestação do funcionário antes da aprovação.');
      if (employeeAck.act === 'CONTESTACAO' && !d.comment) throw new AppError('O documento foi contestado: registre a análise da contestação no comentário.');
    } else {
      if (!isOwnerEmployee) throw new ForbiddenError('Somente o titular pode registrar ciência, concordância ou contestação.');
      if (d.act === 'CONTESTACAO' && (!d.comment || d.comment.length < 5)) throw new AppError('Descreva os motivos da contestação.');
      const mine = existing.filter((s) => s.signer_user_id === ctx.principal.userId).map((s) => s.act);
      if ((d.act === 'CONTESTACAO' && mine.some((a) => a === 'CIENCIA' || a === 'CONCORDANCIA')) ||
          ((d.act === 'CIENCIA' || d.act === 'CONCORDANCIA') && mine.includes('CONTESTACAO'))) {
        throw new AppError('Manifestação incompatível com outra já registrada nesta versão.');
      }
    }
    if (existing.some((s) => s.act === d.act && s.signer_user_id === ctx.principal.userId)) throw new AppError('Manifestação já registrada.');

    const signatureId = await recordSignature(c, ctx, { id: v.id, contentSha256: v.content_sha256, title: v.title, versionNumber: v.version_number }, d.act, d.comment);
    if (d.act !== 'APROVACAO' && (await requiresApproval(c, v.reference_type))) {
      const approvers = await usersWithPermission(c, 'espelho.aprovar', v.sector_id, ctx.principal.userId);
      await notifyUsers(c, approvers, {
        kind: 'DOCUMENTO_PARA_APROVACAO', title: d.act === 'CONTESTACAO' ? 'Documento CONTESTADO aguardando análise' : 'Documento aguardando aprovação',
        body: v.title, link: `/documentos-pessoais?doc=${v.id}`, priority: d.act === 'CONTESTACAO' ? 'ALTA' : 'NORMAL',
      });
    } else if (d.act === 'APROVACAO') {
      await notifyEmployee(c, v.owner_employee_id, { kind: 'DOCUMENTO_APROVADO', title: 'Documento aprovado', body: v.title, link: `/documentos-pessoais?doc=${v.id}` });
    }
    return signatureId;
  });
}

/**
 * Registra a assinatura eletrônica simples com evidências (identidade, sessão, MFA, reautenticação, IP, navegador)
 * vinculadas ao hash da versão. Deve ser chamada na transação, após as verificações de permissão e de regra.
 */
export async function recordSignature(
  c: Db, ctx: Ctx, v: { id: string; contentSha256: string; title: string; versionNumber: number }, act: Act, comment?: string | null,
): Promise<string> {
  const session = await queryOne<{ auth_method: string; mfa_verified_at: Date | null; step_up_at: Date | null }>(
    c, 'SELECT auth_method, mfa_verified_at, step_up_at FROM sessions WHERE id = $1', [ctx.sessionId]);
  const signedAt = new Date();
  const statement = statementFor(act, v.contentSha256);
  const evidence = {
    documentVersionId: v.id, contentSha256: v.contentSha256, signerUserId: ctx.principal.userId, act, statement,
    comment: comment ?? null, signedAt: signedAt.toISOString(), sessionId: ctx.sessionId, authMethod: session?.auth_method ?? ctx.authMethod,
    mfaVerifiedAt: session?.mfa_verified_at?.toISOString() ?? null, stepUpAt: session?.step_up_at?.toISOString() ?? null,
    ip: ctx.ip, userAgent: ctx.userAgent,
  };
  const s = await queryOne<{ id: string }>(
    c,
    `INSERT INTO signatures (document_version_id, signer_user_id, act, statement, comment, content_sha256, signed_at, session_id, auth_method,
                             mfa_verified_at, step_up_at, ip, user_agent, evidence_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [v.id, ctx.principal.userId, act, statement, comment ?? null, v.contentSha256, signedAt, ctx.sessionId, evidence.authMethod,
      session?.mfa_verified_at ?? null, session?.step_up_at ?? null, ctx.ip, ctx.userAgent?.slice(0, 400) ?? null, sha256Hex(canonicalJson(evidence))],
  ).catch((e: { code?: string }) => {
    if (e.code === '23505') throw new AppError('Manifestação já registrada.');
    throw e;
  });
  await audit(c, ctx, {
    action: `ASSINATURA_${act}`, entityType: 'document_version', entityId: v.id,
    summary: `${act} em "${v.title}" v${v.versionNumber} (sha256 ${v.contentSha256.slice(0, 16)}…)`,
  });
  return s!.id;
}

/** Verificação independente: recalcula o hash do conteúdo e o hash de evidências de cada assinatura. */
export async function verifyVersion(ctx: Ctx, versionId: string) {
  const v = await getVersion(ctx, versionId);
  const db = getPool();
  const contentOk = sha256Hex(canonicalJson(v.content)) === v.contentSha256;
  const sigs = await query<{
    id: string; act: string; statement: string; comment: string | null; content_sha256: string; signed_at: Date; session_id: string;
    auth_method: string; mfa_verified_at: Date | null; step_up_at: Date | null; ip: string | null; user_agent: string | null; evidence_sha256: string; signer_user_id: string;
  }>(db, 'SELECT * FROM signatures WHERE document_version_id = $1', [versionId]);
  return {
    contentOk,
    signatures: sigs.map((s) => {
      const evidence = {
        documentVersionId: versionId, contentSha256: s.content_sha256, signerUserId: s.signer_user_id, act: s.act, statement: s.statement,
        comment: s.comment, signedAt: s.signed_at.toISOString(), sessionId: s.session_id, authMethod: s.auth_method,
        mfaVerifiedAt: s.mfa_verified_at?.toISOString() ?? null, stepUpAt: s.step_up_at?.toISOString() ?? null, ip: s.ip, userAgent: s.user_agent,
      };
      return { id: s.id, act: s.act, ok: s.content_sha256 === v.contentSha256 && sha256Hex(canonicalJson(evidence)) === s.evidence_sha256 };
    }),
  };
}

/** Documentos aguardando aprovação do usuário (coordenação/administração). */
export async function listPendingApprovals(ctx: Ctx) {
  if (!can(ctx.principal, 'espelho.aprovar')) return [];
  const db = getPool();
  const rows = await query<{ version_id: string; title: string; full_name: string; employee_id: string; sector_id: string; employee_act: string; signed_at: Date; kind: DocKind }>(
    db,
    `SELECT v.id AS version_id, d.title, d.reference_type AS kind, e.full_name, e.id AS employee_id, e.sector_id, s.act AS employee_act, s.signed_at
       FROM documents d
       JOIN LATERAL (SELECT * FROM document_versions x WHERE x.document_id = d.id ORDER BY version_number DESC LIMIT 1) v ON TRUE
       JOIN employees e ON e.id = d.owner_employee_id
       JOIN signatures s ON s.document_version_id = v.id AND s.act IN ('CIENCIA','CONTESTACAO','CONCORDANCIA')
      WHERE NOT EXISTS (SELECT 1 FROM signatures a WHERE a.document_version_id = v.id AND a.act = 'APROVACAO')
      ORDER BY s.signed_at`,
  );
  const needs = new Map<DocKind, boolean>();
  for (const k of Object.keys(DOC_KINDS) as DocKind[]) needs.set(k, await requiresApproval(db, k));
  return rows.filter(
    (r) => needs.get(r.kind) && r.employee_id !== ctx.principal.employeeId && can(ctx.principal, 'espelho.aprovar', { employeeId: r.employee_id, sectorId: r.sector_id }),
  );
}
