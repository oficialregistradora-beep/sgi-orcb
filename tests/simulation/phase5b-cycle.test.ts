import { writeFileSync, mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../src/server/db.ts';
import type { Ctx } from '../../src/server/context.ts';
import { canonicalJson, sha256Hex } from '../../src/server/crypto.ts';
import { closeSession, completePopStudy, createSession, saveTraining, selfDeclare, setQuestions, submitAttempt, validateRecord, complianceMatrix } from '../../src/server/modules/training.ts';
import {
  acknowledgeEvaluation, closeWithoutAcknowledgement, generateScheduledEvaluations, listTemplates, publishTemplate, rectify, saveAssessment, saveSchedule, saveTemplate, sendForAcknowledgement,
} from '../../src/server/modules/evaluations.ts';
import { runAutomations, saveRule } from '../../src/server/modules/automation.ts';
import { acknowledge, createDocument, decideVersion, saveDraft, submitForApproval } from '../../src/server/modules/repository.ts';
import { verifyAuditChain } from '../../src/server/audit.ts';
import { addDays, todayLocal } from '../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../helpers.ts';

// RODADA 3 (Fase 5b) — um ano de desenvolvimento de pessoas: 12 admissões ao longo do ano com programação 30/60/90 dias,
// avaliações preenchidas e manifestadas (ciência, concordância, discordância, retificação, encerramento sem ciência),
// turmas com faltas, certificados externos, duas versões de POP com novo estudo e avaliação de aprendizagem.

const metrics: Record<string, number> = {};
let seed = 777;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const ctxCache = new Map<string, Ctx>();
const ctxOf = async (userId: string) => ctxCache.get(userId) ?? ctxCache.set(userId, await ctxFor(userId)).get(userId)!;
let cSubst: Ctx;
const staff: { userId: string; employeeId: string; sector: string; admission: string }[] = [];
const today = todayLocal();
const start = addDays(today, -365);

beforeAll(async () => {
  await resetDatabase();
  const I = await ids();
  await makePerson({ name: 'Oficial', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
  cSubst = await ctxOf((await makePerson({ name: 'Substituta', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }], admission: addDays(today, -900) })).userId);
  for (const s of [I.sectors.RI, I.sectors.ATD]) {
    const c = await makePerson({ name: 'Coord', sectorId: s, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }, { roleId: I.roles.COORDENACAO_SETOR }], admission: addDays(today, -900) });
    staff.push({ ...c, sector: s, admission: addDays(today, -900) });
  }
  for (let i = 0; i < 12; i++) {
    const adm = addDays(today, -400 + i * 32);
    const s = i % 2 ? I.sectors.ATD : I.sectors.RI;
    const p = await makePerson({ name: `Pessoa ${i}`, sectorId: s, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }], admission: adm });
    staff.push({ ...p, sector: s, admission: adm });
  }
});
afterAll(async () => {
  mkdirSync('docs/test-reports', { recursive: true });
  writeFileSync('docs/test-reports/rodada3-fase5b-metricas.json', JSON.stringify({ executadoEm: new Date().toISOString(), metricas: metrics }, null, 2));
  await closePool();
});

describe('Rodada 3 (5b) — um ano de treinamentos e avaliações', () => {
  it('opera e mantém as invariantes', async () => {
    const db = getPool();
    const I = await ids();
    // Programação 30/60/90 dias.
    const tpl = await saveTemplate(cSubst, { name: 'Acompanhamento', kind: 'ACOMPANHAMENTO', criteria: [{ grp: 'COMPETENCIA', title: 'Técnica', weight: 2 }, { grp: 'COMPORTAMENTO', title: 'Atendimento' }] });
    await publishTemplate(cSubst, tpl);
    const fam = (await listTemplates(cSubst)).find((t) => t.id === tpl)!.family_key;
    for (const d of [30, 60, 90]) await saveSchedule(cSubst, { name: `${d} dias`, templateFamily: fam, trigger: 'DIAS_APOS_ADMISSAO', daysAfter: d, leadDays: 7 });
    let generated = 0;
    for (let day = 0; day <= 365; day++) generated += await generateScheduledEvaluations(addDays(start, day));
    // Expectativa independente: gerada se a janela [prazo − 7, prazo + 30] cruza o período simulado.
    let expected = 0;
    for (const p of staff) for (const d of [30, 60, 90]) { const due = addDays(p.admission, d); if (addDays(due, -7) <= today && addDays(due, 30) >= start) expected++; }
    expect(generated).toBe(expected);

    // Avaliações: preenchimento, envio e manifestações variadas.
    const crit = (await query<{ id: string }>(db, 'SELECT id FROM evaluation_criteria WHERE template_id = $1 ORDER BY position', [tpl])).map((r) => r.id);
    const evs = await query<{ id: string; evaluator_user_id: string; employee_user: string }>(db,
      'SELECT v.id, v.evaluator_user_id, e.user_id AS employee_user FROM evaluations v JOIN employees e ON e.id = v.employee_id ORDER BY v.due_date');
    const outcome = { ciencia: 0, concordancia: 0, discordancia: 0, retificadas: 0, semCiencia: 0, pendentes: 0 };
    for (const v of evs) {
      const evc = await ctxOf(v.evaluator_user_id);
      const me = await ctxOf(v.employee_user);
      if (rnd() < 0.08) { outcome.pendentes++; continue; }
      await saveAssessment(evc, v.id, { scores: crit.map((k) => ({ criterionId: k, score: 1 + Math.floor(rnd() * 5) })), feedback: 'Feedback do período registrado.' });
      await sendForAcknowledgement(evc, v.id);
      if (rnd() < 0.15) { await rectify(evc, v.id, 'Ajuste de nota'); await sendForAcknowledgement(evc, v.id); outcome.retificadas++; }
      const x = rnd();
      if (x < 0.55) { await acknowledgeEvaluation(me, v.id, 'CIENCIA', undefined, true); outcome.ciencia++; }
      else if (x < 0.75) { await acknowledgeEvaluation(me, v.id, 'CONCORDANCIA', undefined, true); outcome.concordancia++; }
      else if (x < 0.9) { await acknowledgeEvaluation(me, v.id, 'CONTESTACAO', 'Discordo da nota de atendimento.', true); outcome.discordancia++; }
      else { await query(db, "UPDATE evaluations SET sent_at = now() - interval '15 days' WHERE id = $1", [v.id]); await closeWithoutAcknowledgement(evc, v.id, 'Sem manifestação no prazo.'); outcome.semCiencia++; }
    }

    // Treinamento obrigatório com turmas trimestrais e faltas.
    const lgpd = await saveTraining(cSubst, { code: 'LGPD', title: 'LGPD', kind: 'CURSO_INTERNO', validityMonths: 12, mandatory: true, workloadMinutes: 120 });
    let absences = 0;
    for (let q = 0; q < 4; q++) {
      const missing = staff.filter((p) => !p.userId || true).map((p) => p.employeeId);
      const s = await createSession(cSubst, { trainingId: lgpd, sessionDate: today, employeeIds: missing });
      const enrolled = (await query<{ employee_id: string }>(db, "SELECT employee_id FROM training_records WHERE session_id = $1 AND status = 'INSCRITO'", [s])).map((r) => r.employee_id);
      const present = enrolled.filter(() => rnd() < 0.7);
      absences += enrolled.length - present.length;
      await closeSession(cSubst, s, present);
    }
    // Certificados externos validados pela coordenação do setor (ou pela Substituta, para a própria coordenação).
    const ext = await saveTraining(cSubst, { code: 'EXT', title: 'Externo', kind: 'CURSO_EXTERNO' });
    let certs = 0, refused = 0;
    for (const p of staff) {
      if (rnd() < 0.5) continue;
      await selfDeclare(await ctxOf(p.userId), { trainingId: ext, completedOn: addDays(today, -3) }, { name: 'c.pdf', bytes: new TextEncoder().encode('%PDF-1.4\n%x\n%%EOF') });
      certs++;
      const rec = (await queryOne<{ id: string }>(db, "SELECT id FROM training_records WHERE employee_id = $1 AND status = 'PENDENTE_VALIDACAO'", [p.employeeId]))!.id;
      const coord = staff.find((c) => c.sector === p.sector && c !== p && c.admission === addDays(today, -900));
      const validator = coord && coord.userId !== p.userId ? await ctxOf(coord.userId) : cSubst;
      const ok = rnd() < 0.85;
      if (!ok) refused++;
      await validateRecord(validator, rec, ok, ok ? undefined : 'Certificado sem carga horária');
    }
    // POP do RI: duas versões, estudo com avaliação de aprendizagem.
    const ri = staff.filter((p) => p.sector === I.sectors.RI);
    const popCat = (await queryOne<{ id: string }>(db, "SELECT id FROM document_categories WHERE code = 'POP'"))!.id;
    const coordRi = await ctxOf(ri[0]!.userId);
    const doc = await createDocument(coordRi, { categoryId: popCat, title: 'POP RI', sectorId: I.sectors.RI, audienceType: 'SETORES', audienceSectorIds: [I.sectors.RI], requiresAcknowledgement: true });
    const popT = await saveTraining(cSubst, { code: 'POP', title: 'Estudo POP', kind: 'ESTUDO_POP', documentId: doc, mandatory: true, audienceType: 'SETORES', sectorIds: [I.sectors.RI], hasAssessment: true, maxAttempts: 3, passScore: 60 });
    await setQuestions(cSubst, popT, [0, 1, 2, 3, 4].map((i) => ({ question: `Questão ${i}?`, options: ['a', 'b', 'c'], correctIndex: i % 3 })));
    let studies = 0, blocked = 0;
    for (const version of [1, 2]) {
      await saveDraft(coordRi, doc, { texto: `Versão ${version} do POP.`, notaVersao: `v${version}` });
      await decideVersion(cSubst, doc, { versionId: await submitForApproval(coordRi, doc), decision: 'APROVADA', confirmed: true });
      for (const p of ri) {
        const c = await ctxOf(p.userId);
        if (rnd() < 0.15) continue; // não estudou nesta versão
        await acknowledge(c, doc, true);
        let passed = false;
        for (let a = 0; a < 3 && !passed; a++) {
          const answers = [0, 1, 2, 0, 1].map((x) => (rnd() < 0.75 ? x : (x + 1) % 3));
          passed = (await submitAttempt(c, popT, answers).catch(() => ({ passed: false }))).passed;
        }
        if (passed) { await completePopStudy(c, popT, true); studies++; } else blocked++;
      }
    }
    // Automação sobre avaliações em atraso.
    await saveRule(cSubst, { name: 'Avaliações atrasadas', trigger: 'AVALIACAO_ATRASADA', days: 0, action: 'NOTIFICAR_RESPONSAVEL' });
    const auto1 = (await runAutomations()).fired;
    expect((await runAutomations()).fired).toBe(0);
    Object.assign(metrics, { avaliacoes_programadas: generated, ...outcome, turmas: 4, faltas: absences, certificados: certs, certificados_recusados: refused, estudos_pop: studies, estudos_bloqueados: blocked, automacoes: auto1 });

    // Invariantes ---------------------------------------------------------------------------------------------
    // 1. Ninguém avalia a si mesmo.
    expect((await queryOne<{ n: number }>(db, 'SELECT count(*)::int AS n FROM evaluations v JOIN employees e ON e.id = v.employee_id WHERE e.user_id = v.evaluator_user_id'))!.n).toBe(0);
    // 2. Concluída = exatamente uma manifestação do avaliado na última versão; hashes conferem.
    const concl = await query<{ id: string; document_id: string; employee_user: string }>(db,
      "SELECT v.id, v.document_id, e.user_id AS employee_user FROM evaluations v JOIN employees e ON e.id = v.employee_id WHERE v.status = 'CONCLUIDA'");
    for (const v of concl) {
      const last = (await queryOne<{ id: string; content: unknown; content_sha256: string }>(db, 'SELECT id, content, content_sha256 FROM document_versions WHERE document_id = $1 ORDER BY version_number DESC LIMIT 1', [v.document_id]))!;
      expect(sha256Hex(canonicalJson(last.content))).toBe(last.content_sha256);
      const sigs = await query<{ signer_user_id: string; content_sha256: string }>(db, 'SELECT signer_user_id, content_sha256 FROM signatures WHERE document_version_id = $1', [last.id]);
      expect(sigs).toHaveLength(1);
      expect(sigs[0]).toEqual({ signer_user_id: v.employee_user, content_sha256: last.content_sha256 });
    }
    expect(concl.length).toBe(outcome.ciencia + outcome.concordancia + outcome.discordancia);
    // 3. Conclusões de treinamento: validadas por outra pessoa (exceto estudo de POP, conferido pelo sistema).
    expect((await queryOne<{ n: number }>(db, `SELECT count(*)::int AS n FROM training_records r JOIN employees e ON e.id = r.employee_id
      WHERE r.status = 'CONCLUIDO' AND (r.source = 'ESTUDO_POP' AND r.validated_by IS NOT NULL OR r.source <> 'ESTUDO_POP' AND (r.validated_by IS NULL OR r.validated_by = e.user_id))`))!.n).toBe(0);
    // 4. Estudo de POP: ciência na versão estudada e aprovação posterior à versão.
    const pops = await query<{ employee_id: string; user_id: string; document_version_id: string; created_at: Date }>(db,
      `SELECT r.employee_id, e.user_id, r.document_version_id, v.created_at FROM training_records r JOIN employees e ON e.id = r.employee_id JOIN document_versions v ON v.id = r.document_version_id
        WHERE r.source = 'ESTUDO_POP' AND r.status = 'CONCLUIDO'`);
    expect(pops.length).toBe(studies);
    for (const p of pops) {
      expect(await queryOne(db, "SELECT 1 FROM signatures WHERE document_version_id = $1 AND signer_user_id = $2 AND act = 'CIENCIA'", [p.document_version_id, p.user_id])).toBeTruthy();
      expect(await queryOne(db, 'SELECT 1 FROM training_attempts WHERE employee_id = $1 AND training_id = $2 AND passed AND submitted_at >= $3', [p.employee_id, popT, p.created_at])).toBeTruthy();
    }
    // 5. Presença: cada inscrito de turma encerrada terminou concluído ou não concluído.
    expect((await queryOne<{ n: number }>(db, "SELECT count(*)::int AS n FROM training_records r JOIN training_sessions s ON s.id = r.session_id WHERE s.status = 'REALIZADA' AND r.status = 'INSCRITO'"))!.n).toBe(0);
    // 6. Matriz bate com uma contagem direta da última conclusão válida do LGPD.
    const m = await complianceMatrix(cSubst);
    const lgpdOk = (await queryOne<{ n: number }>(db, "SELECT count(DISTINCT employee_id)::int AS n FROM training_records WHERE training_id = $1 AND status = 'CONCLUIDO' AND expires_on > $2", [lgpd, today]))!.n;
    const col = m.trainings.findIndex((t) => t.id === lgpd);
    expect(m.rows.filter((r) => r.cells[col] === 'VALIDO' || r.cells[col] === 'A_VENCER').length).toBe(lgpdOk);
    metrics.capacitacao_pct = m.summary.pct ?? -1;
  });

  it('trilha de auditoria íntegra', async () => {
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
