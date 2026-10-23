import { z } from 'zod';
import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx } from '../context.ts';
import { can, requirePermission, scopeFilter, scopeSql } from '../authz.ts';
import { audit } from '../audit.ts';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors.ts';
import { checkFile } from '../files.ts';
import { getNumberSetting } from '../settings.ts';
import { addDays, todayLocal } from '../../domain/time.ts';
import { gradeAttempt, inAudience, trainingExpiry, trainingSituation, type TrainingSituation } from '../../domain/development.ts';
import { notifyEmployee, notifyUsers, usersWithPermission } from './notifications.ts';
import { discardUnsaved, insertStoredFile, loadStoredFile, prepareFile, readStoredFile, rescan } from './fileStore.ts';
import { maxFileBytes } from './repository.ts';

// Treinamentos (Fase 5b): catálogo, público obrigatório, turmas, registro e validação de conclusões, certificados,
// estudo de POP vinculado à versão vigente do documento e avaliação de aprendizagem.

type File = { name: string; bytes: Uint8Array } | null | undefined;

type Emp = { id: string; user_id: string | null; sector_id: string; job_title_id: string; full_name: string };
async function employee(c: Db, id: string): Promise<Emp> {
  const e = await queryOne<Emp>(c, "SELECT id, user_id, sector_id, job_title_id, full_name FROM employees WHERE id = $1 AND status <> 'DESLIGADO'", [z.uuid().parse(id)]);
  if (!e) throw new NotFoundError('Funcionário não encontrado.');
  return e;
}

/** Registrar/validar exige escopo sobre o funcionário e nunca alcança o próprio registro. */
function requireRegistrar(ctx: Ctx, e: Emp) {
  requirePermission(ctx, 'treinamentos.registrar', { employeeId: e.id, sectorId: e.sector_id });
  if (e.user_id === ctx.principal.userId) throw new ForbiddenError('Segregação: ninguém registra ou valida o próprio treinamento.');
}

async function loadTraining(c: Db, id: string) {
  const t = await queryOne<{ id: string; code: string; title: string; kind: string; validity_months: number | null; document_id: string | null; has_assessment: boolean;
    pass_score: number; max_attempts: number; active: boolean; workload_minutes: number | null; mandatory: boolean }>(c,
    'SELECT id, code, title, kind, validity_months, document_id, has_assessment, pass_score, max_attempts, active, workload_minutes, mandatory FROM trainings WHERE id = $1', [z.uuid().parse(id)]);
  if (!t) throw new NotFoundError('Treinamento não encontrado.');
  return t;
}

async function currentDocVersion(c: Db, documentId: string | null) {
  if (!documentId) return null;
  return queryOne<{ id: string; created_at: Date; requires_acknowledgement: boolean; title: string }>(c,
    `SELECT v.id, v.created_at, d.requires_acknowledgement, d.title FROM documents d JOIN document_versions v ON v.id = d.current_version_id
      WHERE d.id = $1 AND d.status = 'VIGENTE'`, [documentId]);
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

const trainingSchema = z.object({
  id: z.uuid().optional(),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._/-]{0,29}$/, 'Código inválido.'),
  title: z.string().trim().min(3).max(200),
  kind: z.enum(['CURSO_INTERNO', 'CURSO_EXTERNO', 'ESTUDO_POP', 'PALESTRA', 'SISTEMA', 'INTEGRACAO', 'OUTRO']),
  description: z.string().trim().max(3000).optional(),
  provider: z.string().trim().max(200).optional(),
  workloadMinutes: z.number().int().min(1).max(100000).nullable().optional(),
  documentId: z.uuid().nullable().optional(),
  validityMonths: z.number().int().min(1).max(120).nullable().optional(),
  mandatory: z.boolean().default(false),
  audienceType: z.enum(['TODOS', 'SETORES', 'CARGOS']).default('TODOS'),
  sectorIds: z.array(z.uuid()).default([]),
  jobIds: z.array(z.uuid()).default([]),
  hasAssessment: z.boolean().default(false),
  passScore: z.number().int().min(1).max(100).default(70),
  maxAttempts: z.number().int().min(1).max(20).default(3),
  active: z.boolean().default(true),
});

export async function saveTraining(ctx: Ctx, input: z.input<typeof trainingSchema>): Promise<string> {
  requirePermission(ctx, 'treinamentos.gerenciar');
  const d = trainingSchema.parse(input);
  if (d.kind === 'ESTUDO_POP' && !d.documentId) throw new AppError('Estudo de POP exige o documento do repositório.');
  if (d.audienceType === 'SETORES' && !d.sectorIds.length) throw new AppError('Selecione ao menos um setor.');
  if (d.audienceType === 'CARGOS' && !d.jobIds.length) throw new AppError('Selecione ao menos um cargo.');
  return tx(async (c) => {
    if (d.documentId && !(await queryOne(c, "SELECT 1 FROM documents WHERE id = $1 AND reference_type = 'REPOSITORIO'", [d.documentId]))) throw new AppError('Documento do repositório inexistente.');
    const vals = [d.code, d.title, d.kind, d.description || null, d.provider || null, d.workloadMinutes ?? null, d.documentId ?? null, d.validityMonths ?? null, d.mandatory,
      d.audienceType, d.hasAssessment, d.passScore, d.maxAttempts, d.active];
    const dup = (e: { code?: string }) => { if (e.code === '23505') throw new ConflictError('Já existe treinamento com este código.'); throw e; };
    let id = d.id;
    if (id) {
      const r = await query(c, `UPDATE trainings SET code=$1, title=$2, kind=$3, description=$4, provider=$5, workload_minutes=$6, document_id=$7, validity_months=$8, mandatory=$9,
        audience_type=$10, has_assessment=$11, pass_score=$12, max_attempts=$13, active=$14, updated_at=now() WHERE id=$15 RETURNING id`, [...vals, id]).catch(dup);
      if (!r.length) throw new NotFoundError('Treinamento não encontrado.');
      await query(c, 'DELETE FROM training_audience WHERE training_id = $1', [id]);
    } else {
      id = (await queryOne<{ id: string }>(c, `INSERT INTO trainings (code, title, kind, description, provider, workload_minutes, document_id, validity_months, mandatory, audience_type,
        has_assessment, pass_score, max_attempts, active, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, [...vals, ctx.principal.userId]).catch(dup))!.id;
    }
    if (d.audienceType === 'SETORES') for (const s of new Set(d.sectorIds)) await query(c, 'INSERT INTO training_audience (training_id, sector_id) VALUES ($1,$2)', [id, s]);
    if (d.audienceType === 'CARGOS') for (const j of new Set(d.jobIds)) await query(c, 'INSERT INTO training_audience (training_id, job_title_id) VALUES ($1,$2)', [id, j]);
    await audit(c, ctx, { action: d.id ? 'TREINAMENTO_ALTERADO' : 'TREINAMENTO_CRIADO', entityType: 'training', entityId: id, summary: `${d.code} — ${d.title}${d.mandatory ? ' (obrigatório)' : ''}` });
    return id;
  });
}

const questionSchema = z.array(z.object({
  question: z.string().trim().min(3).max(1000),
  options: z.array(z.string().trim().min(1).max(300)).min(2).max(6),
  correctIndex: z.number().int().min(0),
})).max(50);

/** Questões da avaliação de aprendizagem: substituíveis enquanto ninguém tiver respondido. */
export async function setQuestions(ctx: Ctx, trainingId: string, input: z.input<typeof questionSchema>): Promise<void> {
  requirePermission(ctx, 'treinamentos.gerenciar');
  const qs = questionSchema.parse(input);
  for (const q of qs) if (q.correctIndex >= q.options.length) throw new AppError('Resposta correta fora das alternativas.');
  await tx(async (c) => {
    const t = await loadTraining(c, trainingId);
    await query(c, 'SELECT id FROM trainings WHERE id = $1 FOR UPDATE', [t.id]);
    if (await queryOne(c, 'SELECT 1 FROM training_attempts WHERE training_id = $1', [t.id])) throw new AppError('Já há respostas registradas: crie um novo treinamento (ou nova versão) para alterar as questões.');
    await query(c, 'DELETE FROM training_questions WHERE training_id = $1', [t.id]);
    let pos = 0;
    for (const q of qs) await query(c, 'INSERT INTO training_questions (training_id, position, question, options, correct_index) VALUES ($1,$2,$3,$4,$5)', [t.id, ++pos, q.question, JSON.stringify(q.options), q.correctIndex]);
    await audit(c, ctx, { action: 'TREINAMENTO_QUESTOES', entityType: 'training', entityId: t.id, summary: `${t.code}: ${qs.length} questão(ões)` });
  });
}

// ---------------------------------------------------------------------------
// Turmas
// ---------------------------------------------------------------------------

const sessionSchema = z.object({
  trainingId: z.uuid(), sessionDate: z.iso.date(), startTime: z.number().int().min(0).max(1439).nullable().optional(), endTime: z.number().int().min(1).max(1440).nullable().optional(),
  location: z.string().trim().max(200).optional(), instructor: z.string().trim().max(200).optional(), employeeIds: z.array(z.uuid()).max(100).default([]),
});

/** Turma com inscritos; aparece na agenda institucional como treinamento. */
export async function createSession(ctx: Ctx, input: z.input<typeof sessionSchema>): Promise<string> {
  requirePermission(ctx, 'treinamentos.gerenciar');
  const d = sessionSchema.parse(input);
  if ((d.startTime == null) !== (d.endTime == null) || (d.startTime != null && d.endTime! <= d.startTime)) throw new AppError('Horário inválido.');
  return tx(async (c) => {
    const t = await loadTraining(c, d.trainingId);
    if (!t.active) throw new AppError('Treinamento inativo.');
    const ev = await queryOne<{ id: string }>(c, `INSERT INTO institutional_events (kind, title, description, start_date, end_date, start_time, end_time, created_by)
      VALUES ('TREINAMENTO',$1,$2,$3,$3,$4,$5,$6) RETURNING id`, [`Treinamento: ${t.title}`.slice(0, 200), d.location || null, d.sessionDate, d.startTime ?? null, d.endTime ?? null, ctx.principal.userId]);
    const s = await queryOne<{ id: string }>(c, `INSERT INTO training_sessions (training_id, session_date, start_time, end_time, location, instructor, event_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [t.id, d.sessionDate, d.startTime ?? null, d.endTime ?? null, d.location || null, d.instructor || null, ev!.id, ctx.principal.userId]);
    await audit(c, ctx, { action: 'TREINAMENTO_TURMA', entityType: 'training_session', entityId: s!.id, summary: `${t.code}: turma em ${d.sessionDate}` });
    await enrollIn(c, ctx, t, s!.id, d.sessionDate, d.employeeIds);
    return s!.id;
  });
}

async function enrollIn(c: Db, ctx: Ctx, t: { id: string; title: string }, sessionId: string, date: string, employeeIds: string[]) {
  for (const id of new Set(employeeIds)) {
    await employee(c, id);
    const r = await queryOne(c, `INSERT INTO training_records (training_id, employee_id, session_id, status, source, submitted_by) VALUES ($1,$2,$3,'INSCRITO','INSCRICAO',$4)
      ON CONFLICT (training_id, employee_id) WHERE status IN ('INSCRITO','PENDENTE_VALIDACAO') DO NOTHING RETURNING id`, [t.id, id, sessionId, ctx.principal.userId]);
    if (r) await notifyEmployee(c, id, { kind: 'TREINAMENTO', title: `Inscrição: ${t.title} em ${date}`, link: '/treinamentos' });
  }
}

export async function enroll(ctx: Ctx, sessionId: string, employeeIds: string[]): Promise<void> {
  requirePermission(ctx, 'treinamentos.gerenciar');
  await tx(async (c) => {
    const s = await queryOne<{ training_id: string; session_date: string; status: string }>(c, 'SELECT training_id, session_date, status FROM training_sessions WHERE id = $1 FOR UPDATE', [z.uuid().parse(sessionId)]);
    if (!s) throw new NotFoundError('Turma não encontrada.');
    if (s.status !== 'PLANEJADA') throw new AppError('Turma encerrada.');
    await enrollIn(c, ctx, await loadTraining(c, s.training_id), sessionId, s.session_date, employeeIds);
  });
}

/**
 * Encerramento da turma com a lista de presença. Presentes concluem — ou, havendo avaliação de aprendizagem,
 * concluem ao serem aprovados nela; ausentes ficam como não concluído.
 */
export async function closeSession(ctx: Ctx, sessionId: string, attendees: string[]): Promise<{ concluded: number; awaitingAssessment: number; absent: number; ownPending: number }> {
  requirePermission(ctx, 'treinamentos.registrar');
  return tx(async (c) => {
    const s = await queryOne<{ id: string; training_id: string; session_date: string; status: string }>(c, 'SELECT id, training_id, session_date, status FROM training_sessions WHERE id = $1 FOR UPDATE', [z.uuid().parse(sessionId)]);
    if (!s) throw new NotFoundError('Turma não encontrada.');
    if (s.status !== 'PLANEJADA') throw new AppError('Turma já encerrada.');
    if (s.session_date > todayLocal()) throw new AppError('A turma ainda não aconteceu.');
    const t = await loadTraining(c, s.training_id);
    const recs = await query<{ id: string; employee_id: string }>(c, "SELECT id, employee_id FROM training_records WHERE session_id = $1 AND status = 'INSCRITO' FOR UPDATE", [s.id]);
    const present = new Set(attendees);
    const out = { concluded: 0, awaitingAssessment: 0, absent: 0, ownPending: 0 };
    for (const r of recs) {
      const e = await employee(c, r.employee_id);
      // A própria participação de quem encerra fica para outra pessoa registrar (segregação).
      if (e.user_id === ctx.principal.userId) { out.ownPending++; continue; }
      requireRegistrar(ctx, e);
      if (!present.has(r.employee_id)) {
        await query(c, "UPDATE training_records SET status = 'NAO_CONCLUIDO', decision_notes = 'Ausente na turma', validated_by = $2, validated_at = now() WHERE id = $1", [r.id, ctx.principal.userId]);
        out.absent++;
      } else if (t.has_assessment) {
        // Presença confirmada; a conclusão virá com a aprovação na avaliação de aprendizagem.
        await query(c, "UPDATE training_records SET validated_by = $2, validated_at = now(), notes = 'Presença confirmada' WHERE id = $1", [r.id, ctx.principal.userId]);
        out.awaitingAssessment++;
      } else {
        await query(c, "UPDATE training_records SET status = 'CONCLUIDO', completed_on = $2, expires_on = $3, minutes = $4, validated_by = $5, validated_at = now() WHERE id = $1",
          [r.id, s.session_date, trainingExpiry(s.session_date, t.validity_months), t.workload_minutes, ctx.principal.userId]);
        out.concluded++;
      }
    }
    if (!out.ownPending) await query(c, "UPDATE training_sessions SET status = 'REALIZADA' WHERE id = $1", [s.id]);
    await audit(c, ctx, { action: 'TREINAMENTO_TURMA_ENCERRADA', entityType: 'training_session', entityId: s.id, summary: `${t.code}: ${out.concluded} concluíram, ${out.awaitingAssessment} aguardam avaliação, ${out.absent} ausentes` });
    return out;
  });
}

export async function cancelSession(ctx: Ctx, sessionId: string, reason: string): Promise<void> {
  requirePermission(ctx, 'treinamentos.gerenciar');
  const why = z.string().trim().min(3).max(500).parse(reason);
  await tx(async (c) => {
    const s = await queryOne<{ id: string; status: string; event_id: string | null }>(c, 'SELECT id, status, event_id FROM training_sessions WHERE id = $1 FOR UPDATE', [z.uuid().parse(sessionId)]);
    if (!s || s.status !== 'PLANEJADA') throw new AppError('Turma não pode ser cancelada.');
    await query(c, "UPDATE training_sessions SET status = 'CANCELADA' WHERE id = $1", [s.id]);
    await query(c, "UPDATE training_records SET status = 'CANCELADO', decision_notes = $2 WHERE session_id = $1 AND status = 'INSCRITO'", [s.id, `Turma cancelada: ${why}`]);
    if (s.event_id) await query(c, 'UPDATE institutional_events SET cancelled_at = now(), cancelled_by = $2 WHERE id = $1 AND cancelled_at IS NULL', [s.event_id, ctx.principal.userId]);
    await audit(c, ctx, { action: 'TREINAMENTO_TURMA_CANCELADA', entityType: 'training_session', entityId: s.id, summary: why });
  });
}

// ---------------------------------------------------------------------------
// Conclusões: registro pela gestão, autodeclaração com validação, anulação
// ---------------------------------------------------------------------------

const completionSchema = z.object({
  trainingId: z.uuid(), employeeId: z.uuid(), completedOn: z.iso.date(), minutes: z.number().int().min(1).max(100000).nullable().optional(),
  score: z.number().int().min(0).max(100).nullable().optional(), notes: z.string().trim().max(2000).optional(),
});

export async function registerCompletion(ctx: Ctx, input: z.input<typeof completionSchema>, file?: File): Promise<string> {
  const d = completionSchema.parse(input);
  if (d.completedOn > todayLocal()) throw new AppError('A data de conclusão não pode estar no futuro.');
  const t = await loadTraining(getPool(), d.trainingId);
  if (t.kind === 'ESTUDO_POP') throw new AppError('Estudo de POP é concluído pelo próprio funcionário, vinculado à versão vigente.');
  requireRegistrar(ctx, await employee(getPool(), d.employeeId));
  const prepared = file && file.bytes.byteLength ? await prepareFile(ctx, checkFile(file.name, file.bytes, await maxFileBytes()), file.bytes) : null;
  return tx(async (c) => {
    const fileId = prepared ? await insertStoredFile(c, ctx, prepared) : null;
    // Inscrição em aberto é absorvida pela conclusão.
    await query(c, "UPDATE training_records SET status = 'CANCELADO', decision_notes = 'Substituída pelo registro de conclusão' WHERE training_id = $1 AND employee_id = $2 AND status = 'INSCRITO'", [t.id, d.employeeId]);
    const r = await queryOne<{ id: string }>(c, `INSERT INTO training_records (training_id, employee_id, status, source, completed_on, expires_on, minutes, score, certificate_file_id, notes, submitted_by, validated_by, validated_at)
      VALUES ($1,$2,'CONCLUIDO','REGISTRO_GESTOR',$3,$4,$5,$6,$7,$8,$9,$9,now()) RETURNING id`,
      [t.id, d.employeeId, d.completedOn, trainingExpiry(d.completedOn, t.validity_months), d.minutes ?? t.workload_minutes, d.score ?? null, fileId, d.notes || null, ctx.principal.userId]);
    await audit(c, ctx, { action: 'TREINAMENTO_CONCLUSAO', entityType: 'training_record', entityId: r!.id, summary: `${t.code}: conclusão registrada em ${d.completedOn}` });
    await notifyEmployee(c, d.employeeId, { kind: 'TREINAMENTO', title: `Conclusão registrada: ${t.title}`, link: '/treinamentos' });
    return r!.id;
  }).catch(async (e) => { await discardUnsaved(prepared); throw e; });
}

/** O funcionário informa um curso concluído com o certificado; outra pessoa valida. */
export async function selfDeclare(ctx: Ctx, input: { trainingId: string; completedOn: string; minutes?: number | null; notes?: string }, file: File): Promise<string> {
  const d = completionSchema.omit({ employeeId: true, score: true }).parse(input);
  const empId = ctx.principal.employeeId;
  if (!empId) throw new AppError('Seu usuário não está vinculado a um cadastro funcional.');
  if (d.completedOn > todayLocal()) throw new AppError('A data de conclusão não pode estar no futuro.');
  if (!file || !file.bytes.byteLength) throw new AppError('Anexe o certificado ou comprovante.');
  const t = await loadTraining(getPool(), d.trainingId);
  if (t.kind === 'ESTUDO_POP') throw new AppError('Use “Concluir estudo” para POPs.');
  const e = await employee(getPool(), empId);
  const prepared = await prepareFile(ctx, checkFile(file.name, file.bytes, await maxFileBytes()), file.bytes);
  return tx(async (c) => {
    const fileId = await insertStoredFile(c, ctx, prepared);
    const r = await queryOne<{ id: string }>(c, `INSERT INTO training_records (training_id, employee_id, status, source, completed_on, minutes, certificate_file_id, notes, submitted_by)
      VALUES ($1,$2,'PENDENTE_VALIDACAO','AUTODECLARADO',$3,$4,$5,$6,$7) RETURNING id`, [t.id, empId, d.completedOn, d.minutes ?? t.workload_minutes, fileId, d.notes || null, ctx.principal.userId])
      .catch((er: { code?: string }) => { if (er.code === '23505') throw new ConflictError('Já há inscrição ou certificado aguardando validação neste treinamento.'); throw er; });
    await audit(c, ctx, { action: 'TREINAMENTO_AUTODECLARADO', entityType: 'training_record', entityId: r!.id, summary: `${t.code}: certificado enviado para validação` });
    await notifyUsers(c, await usersWithPermission(c, 'treinamentos.registrar', e.sector_id, ctx.principal.userId), { kind: 'TREINAMENTO', title: `Certificado para validar: ${t.title}`, link: '/treinamentos?aba=validacoes' });
    return r!.id;
  }).catch(async (er) => { await discardUnsaved(prepared); throw er; });
}

export async function validateRecord(ctx: Ctx, recordId: string, approve: boolean, notes?: string): Promise<void> {
  await tx(async (c) => {
    const r = await queryOne<{ id: string; training_id: string; employee_id: string; status: string; completed_on: string; submitted_by: string }>(c,
      'SELECT id, training_id, employee_id, status, completed_on, submitted_by FROM training_records WHERE id = $1 FOR UPDATE', [z.uuid().parse(recordId)]);
    if (!r) throw new NotFoundError('Registro não encontrado.');
    if (r.status !== 'PENDENTE_VALIDACAO') throw new AppError('Registro não aguarda validação.');
    requireRegistrar(ctx, await employee(c, r.employee_id));
    if (r.submitted_by === ctx.principal.userId) throw new ForbiddenError('Segregação: quem enviou não valida.');
    const t = await loadTraining(c, r.training_id);
    if (approve) {
      await query(c, "UPDATE training_records SET status = 'CONCLUIDO', expires_on = $2, validated_by = $3, validated_at = now(), decision_notes = $4 WHERE id = $1",
        [r.id, trainingExpiry(r.completed_on, t.validity_months), ctx.principal.userId, notes?.trim() || null]);
    } else {
      if (!notes || notes.trim().length < 3) throw new AppError('Informe o motivo da recusa.');
      await query(c, "UPDATE training_records SET status = 'RECUSADO', validated_by = $2, validated_at = now(), decision_notes = $3 WHERE id = $1", [r.id, ctx.principal.userId, notes.trim()]);
    }
    await audit(c, ctx, { action: approve ? 'TREINAMENTO_VALIDADO' : 'TREINAMENTO_RECUSADO', entityType: 'training_record', entityId: r.id, summary: `${t.code}: ${approve ? 'validado' : 'recusado'}` });
    await notifyEmployee(c, r.employee_id, { kind: 'TREINAMENTO', title: `${t.title}: certificado ${approve ? 'validado' : 'recusado'}`, body: notes?.trim() || undefined, link: '/treinamentos' });
  });
}

export async function annulRecord(ctx: Ctx, recordId: string, reason: string): Promise<void> {
  requirePermission(ctx, 'treinamentos.gerenciar');
  const why = z.string().trim().min(5, 'Justifique a anulação.').max(1000).parse(reason);
  await tx(async (c) => {
    const r = await queryOne<{ id: string; status: string; employee_id: string }>(c, 'SELECT id, status, employee_id FROM training_records WHERE id = $1 FOR UPDATE', [z.uuid().parse(recordId)]);
    if (!r || r.status !== 'CONCLUIDO') throw new AppError('Somente conclusões podem ser anuladas.');
    if ((await employee(c, r.employee_id)).user_id === ctx.principal.userId) throw new ForbiddenError('Segregação: ninguém anula o próprio registro.');
    await query(c, "UPDATE training_records SET status = 'ANULADO', decision_notes = $2 WHERE id = $1", [r.id, why]);
    await audit(c, ctx, { action: 'TREINAMENTO_ANULADO', entityType: 'training_record', entityId: r.id, summary: why });
  });
}

// ---------------------------------------------------------------------------
// Avaliação de aprendizagem e estudo de POP
// ---------------------------------------------------------------------------

/** Questões para responder — sem a alternativa correta. */
export async function questionsForTaking(ctx: Ctx, trainingId: string) {
  if (!ctx.principal.employeeId) throw new AppError('Seu usuário não está vinculado a um cadastro funcional.');
  const t = await loadTraining(getPool(), trainingId);
  if (!t.has_assessment) throw new AppError('Este treinamento não tem avaliação de aprendizagem.');
  const qs = await query<{ id: string; position: number; question: string; options: string[] }>(getPool(),
    'SELECT id, position, question, options FROM training_questions WHERE training_id = $1 ORDER BY position', [t.id]);
  return { training: t, questions: qs, attempts: await attemptsSinceCompletion(getPool(), t.id, ctx.principal.employeeId) };
}

async function attemptsSinceCompletion(c: Db, trainingId: string, employeeId: string) {
  return query<{ score: number; passed: boolean; submitted_at: Date }>(c,
    `SELECT score, passed, submitted_at FROM training_attempts WHERE training_id = $1 AND employee_id = $2
       AND submitted_at > coalesce((SELECT max(validated_at) FROM training_records WHERE training_id = $1 AND employee_id = $2 AND status = 'CONCLUIDO'), '-infinity')
     ORDER BY submitted_at`, [trainingId, employeeId]);
}

export async function submitAttempt(ctx: Ctx, trainingId: string, answers: number[]): Promise<{ score: number; passed: boolean; remaining: number; concluded: boolean }> {
  const empId = ctx.principal.employeeId;
  if (!empId) throw new AppError('Seu usuário não está vinculado a um cadastro funcional.');
  const ans = z.array(z.number().int().min(0).max(5)).max(50).parse(answers);
  return tx(async (c) => {
    const t = await loadTraining(c, trainingId);
    if (!t.has_assessment || !t.active) throw new AppError('Avaliação indisponível.');
    await query(c, "SELECT pg_advisory_xact_lock(hashtext('attempt:' || $1 || $2))", [t.id, empId]);
    const qs = await query<{ correct_index: number }>(c, 'SELECT correct_index FROM training_questions WHERE training_id = $1 ORDER BY position', [t.id]);
    if (!qs.length) throw new AppError('Avaliação sem questões cadastradas.');
    const prev = await attemptsSinceCompletion(c, t.id, empId);
    if (prev.some((a) => a.passed)) throw new AppError('Você já foi aprovado(a) nesta avaliação.');
    if (prev.length >= t.max_attempts) throw new AppError('Limite de tentativas atingido. Procure a coordenação para nova inscrição.');
    let g: { score: number };
    try { g = gradeAttempt(qs.map((q) => q.correct_index), ans); } catch (e) { throw new AppError((e as Error).message); }
    const passed = g.score >= t.pass_score;
    await query(c, 'INSERT INTO training_attempts (training_id, employee_id, answers, score, passed) VALUES ($1,$2,$3,$4,$5)', [t.id, empId, JSON.stringify(ans), g.score, passed]);
    let concluded = false;
    if (passed) {
      // Turma com presença confirmada: a aprovação conclui.
      const open = await queryOne<{ id: string; session_date: string | null }>(c,
        `SELECT r.id, s.session_date FROM training_records r LEFT JOIN training_sessions s ON s.id = r.session_id
          WHERE r.training_id = $1 AND r.employee_id = $2 AND r.status = 'INSCRITO' AND r.validated_by IS NOT NULL FOR UPDATE OF r`, [t.id, empId]);
      if (open) {
        const on = open.session_date ?? todayLocal();
        await query(c, "UPDATE training_records SET status = 'CONCLUIDO', completed_on = $2, expires_on = $3, score = $4, minutes = $5 WHERE id = $1",
          [open.id, on, trainingExpiry(on, t.validity_months), g.score, t.workload_minutes]);
        concluded = true;
      }
    }
    await audit(c, ctx, { action: 'TREINAMENTO_AVALIACAO', entityType: 'training', entityId: t.id, summary: `${t.code}: ${g.score}% (${passed ? 'aprovado' : 'não aprovado'})` });
    return { score: g.score, passed, remaining: t.max_attempts - prev.length - 1, concluded };
  });
}

/**
 * Conclusão do estudo de POP pelo próprio funcionário: exige a ciência na versão vigente (quando o documento pede ciência)
 * ou declaração expressa, e a aprovação na avaliação de aprendizagem posterior à versão, quando houver.
 */
export async function completePopStudy(ctx: Ctx, trainingId: string, confirmed: boolean): Promise<string> {
  const empId = ctx.principal.employeeId;
  if (!empId) throw new AppError('Seu usuário não está vinculado a um cadastro funcional.');
  if (!confirmed) throw new AppError('Confirme que estudou o documento.');
  return tx(async (c) => {
    const t = await loadTraining(c, trainingId);
    if (t.kind !== 'ESTUDO_POP') throw new AppError('Treinamento não é estudo de POP.');
    const v = await currentDocVersion(c, t.document_id);
    if (!v) throw new AppError('O documento não está vigente.');
    if (await queryOne(c, "SELECT 1 FROM training_records WHERE training_id = $1 AND employee_id = $2 AND status = 'CONCLUIDO' AND document_version_id = $3", [t.id, empId, v.id])) {
      throw new AppError('Estudo desta versão já concluído.');
    }
    if (v.requires_acknowledgement && !(await queryOne(c, "SELECT 1 FROM signatures WHERE document_version_id = $1 AND signer_user_id = $2 AND act = 'CIENCIA'", [v.id, ctx.principal.userId]))) {
      throw new AppError('Registre antes a ciência da versão vigente do documento (Gestão documental).');
    }
    if (t.has_assessment && !(await queryOne(c, 'SELECT 1 FROM training_attempts WHERE training_id = $1 AND employee_id = $2 AND passed AND submitted_at >= $3', [t.id, empId, v.created_at]))) {
      throw new AppError('Seja aprovado(a) na avaliação de aprendizagem desta versão antes de concluir.');
    }
    const score = (await queryOne<{ score: number }>(c, 'SELECT max(score) AS score FROM training_attempts WHERE training_id = $1 AND employee_id = $2 AND passed AND submitted_at >= $3', [t.id, empId, v.created_at]))?.score ?? null;
    const today = todayLocal();
    await query(c, "UPDATE training_records SET status = 'CANCELADO', decision_notes = 'Substituída pela conclusão do estudo' WHERE training_id = $1 AND employee_id = $2 AND status = 'INSCRITO'", [t.id, empId]);
    const r = await queryOne<{ id: string }>(c, `INSERT INTO training_records (training_id, employee_id, status, source, completed_on, expires_on, minutes, score, document_version_id, submitted_by)
      VALUES ($1,$2,'CONCLUIDO','ESTUDO_POP',$3,$4,$5,$6,$7,$8) RETURNING id`,
      [t.id, empId, today, trainingExpiry(today, t.validity_months), t.workload_minutes, score, v.id, ctx.principal.userId]);
    await audit(c, ctx, { action: 'TREINAMENTO_ESTUDO_POP', entityType: 'training_record', entityId: r!.id, summary: `${t.code}: estudo de "${v.title}" concluído` });
    return r!.id;
  });
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

type TrainingRow = { id: string; code: string; title: string; kind: string; provider: string | null; workload_minutes: number | null; validity_months: number | null; mandatory: boolean;
  audience_type: string; has_assessment: boolean; pass_score: number; max_attempts: number; active: boolean; document_id: string | null; document_title: string | null; description: string | null;
  sectors: string[]; jobs: string[]; current_version_id: string | null; questions: number };

async function allTrainings(db: Db): Promise<TrainingRow[]> {
  return query<TrainingRow>(db, `SELECT t.id, t.code, t.title, t.kind, t.provider, t.workload_minutes, t.validity_months, t.mandatory, t.audience_type, t.has_assessment, t.pass_score,
      t.max_attempts, t.active, t.document_id, d.title AS document_title, t.description,
      coalesce((SELECT array_agg(a.sector_id) FROM training_audience a WHERE a.training_id = t.id AND a.sector_id IS NOT NULL), '{}') AS sectors,
      coalesce((SELECT array_agg(a.job_title_id) FROM training_audience a WHERE a.training_id = t.id AND a.job_title_id IS NOT NULL), '{}') AS jobs,
      CASE WHEN d.status = 'VIGENTE' THEN d.current_version_id END AS current_version_id,
      (SELECT count(*)::int FROM training_questions q WHERE q.training_id = t.id) AS questions
    FROM trainings t LEFT JOIN documents d ON d.id = t.document_id ORDER BY t.active DESC, t.code`);
}

export async function listTrainings(ctx: Ctx) {
  if (!can(ctx.principal, 'treinamentos.ver') && !can(ctx.principal, 'treinamentos.gerenciar')) throw new ForbiddenError();
  return allTrainings(getPool());
}

type RecordRow = { id: string; training_id: string; employee_id: string; status: string; source: string; completed_on: string | null; expires_on: string | null; minutes: number | null;
  score: number | null; document_version_id: string | null; certificate_file_id: string | null; notes: string | null; decision_notes: string | null; session_id: string | null;
  validated_by: string | null; submitted_at: Date };
const recordCols = 'r.id, r.training_id, r.employee_id, r.status, r.source, r.completed_on, r.expires_on, r.minutes, r.score, r.document_version_id, r.certificate_file_id, r.notes, r.decision_notes, r.session_id, r.validated_by, r.submitted_at';

/** Meus treinamentos: obrigatórios do meu público + os que tenho registro, com a situação de cada um. */
export async function myTrainings(ctx: Ctx) {
  const empId = ctx.principal.employeeId;
  if (!empId) return [];
  const db = getPool();
  const e = await employee(db, empId);
  const notice = await getNumberSetting(db, 'treinamentos.aviso_vencimento_dias', 30);
  const today = todayLocal();
  const recs = await query<RecordRow & { training_title: string }>(db, `SELECT ${recordCols} FROM training_records r WHERE r.employee_id = $1 ORDER BY r.submitted_at DESC`, [empId]);
  const out = [];
  for (const t of await allTrainings(db)) {
    const mine = recs.filter((r) => r.training_id === t.id);
    const required = t.active && t.mandatory && inAudience(t, e);
    if (!required && !mine.length) continue;
    const s = trainingSituation(mine, today, notice, t.kind === 'ESTUDO_POP' ? t.current_version_id : null);
    out.push({ training: t, required, records: mine, ...s, attempts: t.has_assessment ? await attemptsSinceCompletion(db, t.id, empId) : [] });
  }
  const order: Record<TrainingSituation, number> = { VENCIDO: 0, NOVA_VERSAO: 1, PENDENTE: 2, A_VENCER: 3, EM_ANDAMENTO: 4, VALIDO: 5 };
  return out.sort((a, b) => order[a.situation] - order[b.situation] || a.training.code.localeCompare(b.training.code));
}

/** Matriz de capacitação: obrigatórios × pessoas no escopo de quem consulta. */
export async function complianceMatrix(ctx: Ctx) {
  const f = scopeFilter(ctx.principal, 'treinamentos.ver');
  if (!f || (!f.all && !f.sectorIds.length)) throw new ForbiddenError();
  const db = getPool();
  const params: unknown[] = [];
  const people = await query<Emp & { sector_name: string }>(db,
    `SELECT e.id, e.user_id, e.sector_id, e.job_title_id, e.full_name, s.name AS sector_name FROM employees e JOIN sectors s ON s.id = e.sector_id
      WHERE e.status <> 'DESLIGADO' AND ${scopeSql(f, 'e', params)} ORDER BY s.name, e.full_name`, params);
  const trainings = (await allTrainings(db)).filter((t) => t.active && t.mandatory);
  const recs = await query<RecordRow>(db, `SELECT ${recordCols} FROM training_records r WHERE r.employee_id = ANY($1::uuid[])`, [people.map((p) => p.id)]);
  const notice = await getNumberSetting(db, 'treinamentos.aviso_vencimento_dias', 30);
  const today = todayLocal();
  const rows = people.map((p) => ({
    person: p,
    cells: trainings.map((t) => inAudience(t, p)
      ? trainingSituation(recs.filter((r) => r.employee_id === p.id && r.training_id === t.id), today, notice, t.kind === 'ESTUDO_POP' ? t.current_version_id : null).situation
      : null),
  }));
  const cells = rows.flatMap((r) => r.cells).filter((x): x is TrainingSituation => x !== null);
  const ok = cells.filter((x) => x === 'VALIDO' || x === 'A_VENCER').length;
  return { trainings, rows, summary: { required: cells.length, ok, pct: cells.length ? Math.round((ok / cells.length) * 1000) / 10 : null, expired: cells.filter((x) => x === 'VENCIDO').length } };
}

export async function getTraining(ctx: Ctx, id: string) {
  const db = getPool();
  const p = ctx.principal;
  if (!can(p, 'treinamentos.ver') && !can(p, 'treinamentos.gerenciar')) throw new ForbiddenError();
  const t = (await allTrainings(db)).find((x) => x.id === z.uuid().parse(id));
  if (!t) throw new NotFoundError('Treinamento não encontrado.');
  const manage = can(p, 'treinamentos.gerenciar');
  const sessions = await query<{ id: string; session_date: string; start_time: number | null; end_time: number | null; location: string | null; instructor: string | null; status: string; enrolled: number }>(db,
    `SELECT s.id, s.session_date, s.start_time, s.end_time, s.location, s.instructor, s.status, (SELECT count(*)::int FROM training_records r WHERE r.session_id = s.id) AS enrolled
       FROM training_sessions s WHERE s.training_id = $1 ORDER BY s.session_date DESC`, [t.id]);
  const f = scopeFilter(p, 'treinamentos.registrar') ?? scopeFilter(p, 'treinamentos.ver');
  const params: unknown[] = [t.id];
  const records = f && (f.all || f.sectorIds.length) ? await query<RecordRow & { full_name: string; sector_name: string; validated_by_name: string | null }>(db,
    `SELECT ${recordCols}, e.full_name, s.name AS sector_name, v.display_name AS validated_by_name FROM training_records r JOIN employees e ON e.id = r.employee_id
       JOIN sectors s ON s.id = e.sector_id LEFT JOIN users v ON v.id = r.validated_by
      WHERE r.training_id = $1 AND ${scopeSql(f, 'e', params)} ORDER BY r.submitted_at DESC`, params) : [];
  const questions = manage ? await query<{ position: number; question: string; options: string[]; correct_index: number }>(db,
    'SELECT position, question, options, correct_index FROM training_questions WHERE training_id = $1 ORDER BY position', [t.id]) : [];
  const attemptsExist = !!(await queryOne(db, 'SELECT 1 FROM training_attempts WHERE training_id = $1', [t.id]));
  return { training: t, sessions, records, questions, manage, attemptsExist };
}

export async function pendingValidations(ctx: Ctx) {
  const f = scopeFilter(ctx.principal, 'treinamentos.registrar');
  if (!f || (!f.all && !f.sectorIds.length)) return [];
  const params: unknown[] = [ctx.principal.userId];
  return query<RecordRow & { full_name: string; training_title: string; training_code: string }>(getPool(),
    `SELECT ${recordCols}, e.full_name, t.title AS training_title, t.code AS training_code FROM training_records r JOIN employees e ON e.id = r.employee_id JOIN trainings t ON t.id = r.training_id
      WHERE r.status = 'PENDENTE_VALIDACAO' AND r.submitted_by <> $1 AND e.user_id IS DISTINCT FROM $1 AND ${scopeSql(f, 'e', params)} ORDER BY r.submitted_at`, params);
}

export async function trainingFileForDownload(ctx: Ctx, fileId: string) {
  const db = getPool();
  const r = await queryOne<{ employee_id: string; sector_id: string }>(db,
    'SELECT r.employee_id, e.sector_id FROM training_records r JOIN employees e ON e.id = r.employee_id WHERE r.certificate_file_id = $1 LIMIT 1', [z.uuid().parse(fileId)]);
  const p = ctx.principal;
  if (!r || !(r.employee_id === p.employeeId || can(p, 'treinamentos.registrar', { sectorId: r.sector_id, employeeId: r.employee_id }) || can(p, 'treinamentos.gerenciar'))) {
    throw new NotFoundError('Arquivo não encontrado.');
  }
  const f = (await loadStoredFile(db, fileId))!;
  const bytes = await readStoredFile(f);
  if (!bytes) throw new AppError('Conteúdo descartado.', 410, 'DESCARTADO');
  await rescan(ctx, f, bytes, 'download', false);
  await audit(db, ctx, { action: 'TREINAMENTO_CERTIFICADO_DOWNLOAD', entityType: 'document_file', entityId: f.id, summary: `Download de "${f.filename}"` });
  return { filename: f.filename, mime_type: f.mime_type, sha256: f.sha256, data: Buffer.from(bytes) };
}

/** Pessoas ativas com cargo e setor, para inscrição e registro. */
export async function trainablePeople(ctx: Ctx) {
  const f = scopeFilter(ctx.principal, 'treinamentos.registrar') ?? scopeFilter(ctx.principal, 'treinamentos.gerenciar');
  if (!f) return [];
  const params: unknown[] = [];
  return query<{ id: string; full_name: string; sector_name: string; user_id: string | null }>(getPool(),
    `SELECT e.id, e.full_name, s.name AS sector_name, e.user_id FROM employees e JOIN sectors s ON s.id = e.sector_id WHERE e.status <> 'DESLIGADO' AND ${scopeSql(f, 'e', params)} ORDER BY e.full_name`, params);
}

// ---------------------------------------------------------------------------
// Lembretes (rotina diária): vencimentos, pendências obrigatórias e nova versão de POP — uma vez por chave.
// ---------------------------------------------------------------------------

export async function processTrainingReminders(db: Db = getPool()): Promise<number> {
  const today = todayLocal();
  const notice = await getNumberSetting(db, 'treinamentos.aviso_vencimento_dias', 30);
  const people = await query<Emp>(db, "SELECT id, user_id, sector_id, job_title_id, full_name FROM employees WHERE status <> 'DESLIGADO' AND user_id IS NOT NULL");
  const trainings = (await allTrainings(db)).filter((t) => t.active && t.mandatory);
  const recs = await query<RecordRow>(db, `SELECT ${recordCols} FROM training_records r`);
  let sent = 0;
  for (const p of people) {
    for (const t of trainings) {
      if (!inAudience(t, p)) continue;
      const s = trainingSituation(recs.filter((r) => r.employee_id === p.id && r.training_id === t.id), today, notice, t.kind === 'ESTUDO_POP' ? t.current_version_id : null);
      let key: string | null = null, title = '';
      if (s.situation === 'PENDENTE') { key = `trn:${t.id}:${p.id}:pendente`; title = `Treinamento obrigatório pendente: ${t.title}`; }
      if (s.situation === 'NOVA_VERSAO') { key = `trn:${t.id}:${p.id}:versao:${t.current_version_id}`; title = `Nova versão para estudo: ${t.title}`; }
      if (s.situation === 'A_VENCER') { key = `trn:${t.id}:${p.id}:avencer:${s.expiresOn}`; title = `Reciclagem a vencer em ${s.expiresOn}: ${t.title}`; }
      if (s.situation === 'VENCIDO') { key = `trn:${t.id}:${p.id}:vencido:${s.expiresOn}`; title = `Treinamento vencido: ${t.title}`; }
      if (!key) continue;
      const k = key;
      await tx(async (c) => {
        if (!(await queryOne(c, 'INSERT INTO reminder_log (key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING key', [k]))) return;
        await notifyUsers(c, [p.user_id!], { kind: 'TREINAMENTO', title, link: '/treinamentos', priority: s.situation === 'VENCIDO' ? 'ALTA' : 'NORMAL' });
        if (s.situation === 'VENCIDO') {
          await notifyUsers(c, await usersWithPermission(c, 'treinamentos.registrar', p.sector_id, p.user_id), { kind: 'TREINAMENTO', title: `Treinamento vencido na equipe: ${t.title}`, body: p.full_name, link: '/treinamentos?aba=equipe' });
        }
        sent++;
      });
    }
  }
  return sent;
}

export const upcomingSessionsFrom = (from = todayLocal()) =>
  query<{ id: string; training_id: string; title: string; session_date: string }>(getPool(),
    "SELECT s.id, s.training_id, t.title, s.session_date FROM training_sessions s JOIN trainings t ON t.id = s.training_id WHERE s.status = 'PLANEJADA' AND s.session_date BETWEEN $1 AND $2 ORDER BY s.session_date",
    [from, addDays(from, 30)]);
