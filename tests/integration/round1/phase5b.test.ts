import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import {
  annulRecord, closeSession, complianceMatrix, completePopStudy, createSession, myTrainings, pendingValidations, processTrainingReminders, questionsForTaking, registerCompletion,
  saveTraining, selfDeclare, setQuestions, submitAttempt, trainingFileForDownload, validateRecord,
} from '../../../src/server/modules/training.ts';
import {
  acknowledgeEvaluation, acknowledgeFeedback, addFeedback, addPdiItem, closeWithoutAcknowledgement, createEvaluation, developmentHistory, generateScheduledEvaluations, getEvaluation,
  listEvaluations, listTemplates, processEvaluationReminders, publishTemplate, rectify, saveAssessment, saveSchedule, saveSelfAssessment, saveTemplate, sendForAcknowledgement, updatePdiItem,
} from '../../../src/server/modules/evaluations.ts';
import { availableWidgets, myWidgets, resetWidgets, runAutomations, saveRule, saveWidgets } from '../../../src/server/modules/automation.ts';
import { acknowledge, createDocument, decideVersion, saveDraft, submitForApproval } from '../../../src/server/modules/repository.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { addDays, addMonths, todayLocal } from '../../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';

let I: Awaited<ReturnType<typeof ids>>;
let cOwner: Ctx, cSubst: Ctx, cCoord: Ctx, cColab: Ctx, cColab2: Ctx, cAtd: Ctx, cAtdCoord: Ctx;
const emp: Record<string, string> = {};
const today = todayLocal();
const PDF = (n = 'certificado.pdf') => ({ name: n, bytes: new TextEncoder().encode('%PDF-1.4\n%certificado fictício\n%%EOF') });
const notes = (userId: string, kind: string) => query<{ title: string; body: string | null }>(getPool(), 'SELECT title, body FROM notifications WHERE user_id = $1 AND kind = $2 ORDER BY created_at', [userId, kind]);
let lgpd: string, popTrn: string, popDoc: string, ext: string;

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  const mk = async (k: string, name: string, sectorId: string, roles: string[], owner = false, admission?: string) => {
    const p = await makePerson({ name, sectorId, jobId: I.jobs.escrevente, roles: roles.map((r) => ({ roleId: I.roles[r as keyof typeof I.roles] })), owner, admission });
    emp[k] = p.employeeId;
    return ctxFor(p.userId);
  };
  cOwner = await mk('owner', 'Oficial', I.sectors.DIR, ['OFICIAL'], true);
  cSubst = await mk('subst', 'Substituta', I.sectors.DIR, ['SUBSTITUTA_LEGAL']);
  cCoord = await mk('coord', 'Coord RI', I.sectors.RI, ['COLABORADOR', 'COORDENACAO_SETOR']);
  cColab = await mk('colab', 'Colab RI', I.sectors.RI, ['COLABORADOR']);
  cColab2 = await mk('colab2', 'Colab RI Dois', I.sectors.RI, ['COLABORADOR'], false, addDays(today, -25));
  cAtd = await mk('atd', 'Colab ATD', I.sectors.ATD, ['COLABORADOR']);
  cAtdCoord = await mk('atdcoord', 'Coord ATD', I.sectors.ATD, ['COLABORADOR', 'COORDENACAO_SETOR']);
  const pop = (await queryOne<{ id: string }>(getPool(), "SELECT id FROM document_categories WHERE code = 'POP'"))!.id;
  popDoc = await createDocument(cCoord, { categoryId: pop, title: 'POP — Prenotação', code: 'POP-RI-1', sectorId: I.sectors.RI, audienceType: 'SETORES', audienceSectorIds: [I.sectors.RI], requiresAcknowledgement: true });
  await saveDraft(cCoord, popDoc, { texto: '1. Conferir. 2. Protocolar.', notaVersao: 'Inicial' });
  await decideVersion(cSubst, popDoc, { versionId: await submitForApproval(cCoord, popDoc), decision: 'APROVADA', confirmed: true });
});
afterAll(closePool);

describe('Fase 5b — catálogo e estudo de POP', () => {
  it('cadastro restrito; código único; questões validadas', async () => {
    await expect(saveTraining(cCoord, { code: 'X-1', title: 'Tentativa', kind: 'OUTRO' })).rejects.toThrow(/permissão/);
    lgpd = await saveTraining(cSubst, { code: 'lgpd-01', title: 'LGPD', kind: 'CURSO_INTERNO', workloadMinutes: 120, validityMonths: 12, mandatory: true });
    await expect(saveTraining(cSubst, { code: 'LGPD-01', title: 'Outro', kind: 'OUTRO' })).rejects.toThrow(/código/);
    await expect(saveTraining(cSubst, { code: 'POP-E', title: 'Estudo', kind: 'ESTUDO_POP' })).rejects.toThrow(/documento/);
    popTrn = await saveTraining(cSubst, { code: 'POP-E', title: 'Estudo do POP', kind: 'ESTUDO_POP', documentId: popDoc, mandatory: true, audienceType: 'SETORES', sectorIds: [I.sectors.RI], hasAssessment: true, passScore: 70, maxAttempts: 2 });
    ext = await saveTraining(cSubst, { code: 'EXT', title: 'Curso externo', kind: 'CURSO_EXTERNO' });
    await expect(setQuestions(cSubst, popTrn, [{ question: 'Pergunta?', options: ['a', 'b'], correctIndex: 2 }])).rejects.toThrow(/fora/);
    await setQuestions(cSubst, popTrn, [{ question: 'Primeiro passo?', options: ['Arquivar', 'Conferir'], correctIndex: 1 }, { question: 'Depois?', options: ['Protocolar', 'Devolver'], correctIndex: 0 }]);
  });

  it('estudo: ciência da versão vigente, aprovação na avaliação, vínculo com a versão', async () => {
    await expect(completePopStudy(cColab, popTrn, true)).rejects.toThrow(/ciência/);
    await acknowledge(cColab, popDoc, true);
    await expect(completePopStudy(cColab, popTrn, true)).rejects.toThrow(/aprovado/);
    const q = await questionsForTaking(cColab, popTrn);
    expect(JSON.stringify(q.questions)).not.toMatch(/correct/);
    expect(await submitAttempt(cColab, popTrn, [1, 1])).toMatchObject({ score: 50, passed: false, remaining: 1 });
    expect(await submitAttempt(cColab, popTrn, [1, 0])).toMatchObject({ score: 100, passed: true });
    await expect(submitAttempt(cColab, popTrn, [1, 0])).rejects.toThrow(/já foi aprovado/);
    await completePopStudy(cColab, popTrn, true);
    await expect(completePopStudy(cColab, popTrn, true)).rejects.toThrow(/já concluído/);
    expect((await myTrainings(cColab)).find((r) => r.training.id === popTrn)!.situation).toBe('VALIDO');
    // Limite de tentativas.
    await submitAttempt(cColab2, popTrn, [0, 0]);
    await submitAttempt(cColab2, popTrn, [0, 1]);
    await expect(submitAttempt(cColab2, popTrn, [1, 0])).rejects.toThrow(/Limite/);
    await expect(setQuestions(cSubst, popTrn, [{ question: 'Nova?', options: ['a', 'b'], correctIndex: 0 }])).rejects.toThrow(/respostas/);
    // Nova versão do POP pede novo estudo.
    await saveDraft(cCoord, popDoc, { texto: '1. Conferir. 2. Protocolar. 3. Comunicar.', notaVersao: 'Passo 3' });
    await decideVersion(cSubst, popDoc, { versionId: await submitForApproval(cCoord, popDoc), decision: 'APROVADA', confirmed: true });
    expect((await myTrainings(cColab)).find((r) => r.training.id === popTrn)!.situation).toBe('NOVA_VERSAO');
    // O público obrigatório é só o RI.
    expect((await myTrainings(cAtd)).map((r) => r.training.code)).toEqual(['LGPD-01']);
  });
});

describe('Fase 5b — turmas, conclusões e validação', () => {
  it('turma na agenda; encerramento com presença; escopo do registrador', async () => {
    await expect(createSession(cCoord, { trainingId: lgpd, sessionDate: today })).rejects.toThrow(/permissão/);
    const s = await createSession(cSubst, { trainingId: lgpd, sessionDate: today, startTime: 540, endTime: 600, employeeIds: [emp.colab!, emp.atd!, emp.coord!] });
    expect((await queryOne<{ kind: string; start_time: number }>(getPool(), 'SELECT e.kind, e.start_time FROM training_sessions s JOIN institutional_events e ON e.id = s.event_id WHERE s.id = $1', [s]))).toEqual({ kind: 'TREINAMENTO', start_time: 540 });
    expect((await notes(cAtd.principal.userId, 'TREINAMENTO')).length).toBe(1);
    await expect(closeSession(cAtdCoord, s, [emp.colab!])).rejects.toThrow(/permissão/); // pessoas do RI fora do escopo da coordenação do ATD
    const future = await createSession(cSubst, { trainingId: lgpd, sessionDate: addDays(today, 5), employeeIds: [emp.colab2!] });
    await expect(closeSession(cSubst, future, [])).rejects.toThrow(/ainda não aconteceu/);
    expect(await closeSession(cSubst, s, [emp.colab!, emp.coord!])).toEqual({ concluded: 2, awaitingAssessment: 0, absent: 1, ownPending: 0 });
    const mine = (await myTrainings(cColab)).find((r) => r.training.id === lgpd)!;
    expect(mine).toMatchObject({ situation: 'VALIDO', completedOn: today, expiresOn: addMonths(today, 12) });
    expect((await myTrainings(cAtd)).find((r) => r.training.id === lgpd)!.situation).toBe('PENDENTE');
  });

  it('autodeclaração com certificado validada por outra pessoa do escopo', async () => {
    await expect(selfDeclare(cAtd, { trainingId: ext, completedOn: today }, null)).rejects.toThrow(/certificado/);
    await selfDeclare(cAtd, { trainingId: ext, completedOn: addDays(today, -3), minutes: 240 }, PDF());
    await expect(selfDeclare(cAtd, { trainingId: ext, completedOn: today }, PDF())).rejects.toThrow(/aguardando validação/);
    expect((await notes(cAtdCoord.principal.userId, 'TREINAMENTO')).some((n) => /Certificado para validar/.test(n.title))).toBe(true);
    const pend = await pendingValidations(cAtdCoord);
    expect(pend).toHaveLength(1);
    expect(await pendingValidations(cCoord)).toHaveLength(0); // outro setor
    await expect(validateRecord(cCoord, pend[0]!.id, true)).rejects.toThrow(/permissão/);
    const file = pend[0]!.certificate_file_id!;
    await expect(trainingFileForDownload(cColab, file)).rejects.toThrow(/não encontrado/);
    await expect(trainingFileForDownload(cAtd, file)).resolves.toMatchObject({ filename: 'certificado.pdf' });
    await validateRecord(cAtdCoord, pend[0]!.id, true, 'Certificado conferido');
    expect((await myTrainings(cAtd)).find((r) => r.training.id === ext)!.situation).toBe('VALIDO');
    // A coordenação do RI envia o próprio certificado: não aparece para ela validar; a Substituta valida.
    await selfDeclare(cCoord, { trainingId: ext, completedOn: today }, PDF());
    const own = (await queryOne<{ id: string }>(getPool(), "SELECT id FROM training_records WHERE employee_id = $1 AND status = 'PENDENTE_VALIDACAO'", [emp.coord]))!.id;
    expect((await pendingValidations(cCoord)).map((r) => r.id)).not.toContain(own);
    await expect(validateRecord(cCoord, own, true)).rejects.toThrow(/Segregação|próprio/);
    await validateRecord(cSubst, own, false, 'Certificado ilegível');
    await expect(registerCompletion(cCoord, { trainingId: lgpd, employeeId: emp.coord!, completedOn: today })).rejects.toThrow(/próprio/);
  });

  it('anulação justificada; conclusões imutáveis no banco', async () => {
    const r = (await queryOne<{ id: string }>(getPool(), "SELECT id FROM training_records WHERE employee_id = $1 AND training_id = $2 AND status = 'CONCLUIDO'", [emp.colab, lgpd]))!.id;
    await expect(query(getPool(), 'UPDATE training_records SET score = 10 WHERE id = $1', [r])).rejects.toThrow(/anulada/);
    await expect(query(getPool(), 'DELETE FROM training_records WHERE id = $1', [r])).rejects.toThrow(/excluídos/);
    await expect(annulRecord(cCoord, r, 'Registro indevido')).rejects.toThrow(/permissão/);
    await annulRecord(cSubst, r, 'Lista de presença trocada');
    expect((await myTrainings(cColab)).find((x) => x.training.id === lgpd)!.situation).toBe('PENDENTE');
    await expect(query(getPool(), "UPDATE training_records SET status = 'CONCLUIDO' WHERE id = $1", [r])).rejects.toThrow(/imutável/);
  });

  it('matriz de capacitação no escopo; lembretes uma única vez', async () => {
    const m = await complianceMatrix(cAtdCoord);
    expect(m.rows.map((r) => r.person.full_name).sort()).toEqual(['Colab ATD', 'Coord ATD']);
    expect(m.trainings.map((t) => t.code)).toEqual(['LGPD-01', 'POP-E']);
    expect(m.rows.every((r) => r.cells[1] === null)).toBe(true); // POP do RI não se aplica ao ATD
    await expect(complianceMatrix(cColab)).rejects.toThrow(/permissão/);
    const first = await processTrainingReminders();
    expect(first).toBeGreaterThan(0);
    expect(await processTrainingReminders()).toBe(0);
  });
});

describe('Fase 5b — avaliações de desempenho', () => {
  let tpl: string, tplSelf: string, ev: string;
  const crit = async (t: string) => (await query<{ id: string }>(getPool(), 'SELECT id FROM evaluation_criteria WHERE template_id = $1 ORDER BY position', [t])).map((r) => r.id);

  it('modelos versionados; publicado é imutável', async () => {
    const base = { name: 'Experiência', kind: 'EXPERIENCIA' as const, criteria: [{ grp: 'COMPETENCIA' as const, title: 'Técnica', weight: 2 }, { grp: 'COMPORTAMENTO' as const, title: 'Atendimento' }] };
    await expect(saveTemplate(cCoord, base)).rejects.toThrow(/permissão/);
    tpl = await saveTemplate(cSubst, base);
    await publishTemplate(cSubst, tpl);
    await expect(query(getPool(), "UPDATE evaluation_criteria SET weight = 9 WHERE template_id = $1", [tpl])).rejects.toThrow(/imutável/);
    const v2 = await saveTemplate(cSubst, { ...base, id: tpl, name: 'Experiência (rev.)' });
    expect(v2).not.toBe(tpl);
    const all = await listTemplates(cSubst);
    expect(all.find((t) => t.id === v2)).toMatchObject({ version: 2, status: 'RASCUNHO' });
    tplSelf = await saveTemplate(cSubst, { ...base, name: 'Anual', kind: 'ANUAL', selfAssessment: true });
    await publishTemplate(cSubst, tplSelf);
  });

  it('quem pode avaliar quem', async () => {
    const base = { templateId: tpl, periodLabel: '90 dias', dueDate: addDays(today, 5) };
    await expect(createEvaluation(cCoord, { ...base, employeeId: emp.atd! })).rejects.toThrow(/permissão/);
    await expect(createEvaluation(cSubst, { ...base, employeeId: emp.colab!, evaluatorUserId: cColab2.principal.userId })).rejects.toThrow(/não tem permissão/);
    await expect(createEvaluation(cSubst, { ...base, employeeId: emp.coord!, evaluatorUserId: cCoord.principal.userId })).rejects.toThrow(/próprio avaliado/);
    await expect(query(getPool(), 'INSERT INTO evaluations (template_id, employee_id, evaluator_user_id, period_label, due_date, created_by) VALUES ($1,$2,$3,$4,$5,$3)',
      [tpl, emp.coord, cCoord.principal.userId, 'x x', today])).rejects.toThrow(/próprio avaliado/);
    ev = await createEvaluation(cCoord, { ...base, employeeId: emp.colab! });
  });

  it('preenchimento oculto ao avaliado até o envio; conteúdo congelado; ciência sem concordância', async () => {
    const [k1, k2] = await crit(tpl);
    await expect(saveAssessment(cColab, ev, { scores: [] })).rejects.toThrow(/avaliador designado/);
    await saveAssessment(cCoord, ev, { scores: [{ criterionId: k1!, score: 4 }], feedback: 'Rascunho ainda' });
    await expect(getEvaluation(cColab, ev)).rejects.toThrow(/não encontrada/);
    expect(await listEvaluations(cColab, { scope: 'minhas' })).toHaveLength(0);
    await expect(sendForAcknowledgement(cCoord, ev)).rejects.toThrow(/todos os critérios/);
    await expect(saveAssessment(cCoord, ev, { scores: [{ criterionId: k2!, score: 9 }] })).rejects.toThrow(/1 a 5/);
    await saveAssessment(cCoord, ev, { scores: [{ criterionId: k1!, score: 4 }, { criterionId: k2!, score: 3 }], strengths: 'Atenção', improvements: 'Prazos', feedback: 'Bom começo; foco nos prazos.' });
    await addPdiItem(cCoord, { evaluationId: ev, employeeId: emp.colab!, goal: 'Prazos', action: 'Usar o quadro', trainingId: popTrn, dueDate: addDays(today, 60) });
    await sendForAcknowledgement(cCoord, ev);
    const g = await getEvaluation(cColab, ev);
    expect(g.evaluation.overall_score).toBe('66.67'); // (4×2 + 3×1)/3 → 66,67%
    expect(g.versions).toHaveLength(1);
    expect((g.versions[0]!.content as { pdi: unknown[] }).pdi).toHaveLength(1);
    await expect(query(getPool(), 'UPDATE evaluation_scores SET score = 5 WHERE evaluation_id = $1', [ev])).rejects.toThrow(/congeladas/);
    await expect(saveAssessment(cCoord, ev, { scores: [] })).rejects.toThrow(/já enviada/);
    await expect(acknowledgeEvaluation(cColab, ev, 'CONTESTACAO', '', true)).rejects.toThrow(/motivos/);
    await expect(acknowledgeEvaluation(cCoord, ev, 'CIENCIA', undefined, true)).rejects.toThrow(/avaliado/);
    await acknowledgeEvaluation(cColab, ev, 'CIENCIA', 'Recebi; vou conversar sobre os prazos.', true);
    const done = await getEvaluation(cCoord, ev);
    expect(done.evaluation.status).toBe('CONCLUIDA');
    expect(done.signatures[0]).toMatchObject({ act: 'CIENCIA', comment: 'Recebi; vou conversar sobre os prazos.' });
    expect(done.signatures[0]!.statement).toMatch(/não implica concordância/);
    await expect(query(getPool(), "UPDATE evaluations SET feedback = 'alterado' WHERE id = $1", [ev])).rejects.toThrow(/imutável/);
    // PDI com treinamento recomendado gera a inscrição.
    expect((await queryOne<{ status: string }>(getPool(), 'SELECT status FROM training_records WHERE employee_id = $1 AND training_id = $2 AND status = $3', [emp.colab, popTrn, 'INSCRITO']))).toBeTruthy();
  });

  it('autoavaliação: entregue antes do envio, visível ao avaliador só depois de entregue', async () => {
    const id = await createEvaluation(cCoord, { templateId: tplSelf, employeeId: emp.colab!, periodLabel: 'Anual', dueDate: addDays(today, 10) });
    const [k1, k2] = await crit(tplSelf);
    await saveAssessment(cCoord, id, { scores: [{ criterionId: k1!, score: 3 }, { criterionId: k2!, score: 3 }], feedback: 'Feedback anual registrado.' });
    expect((await getEvaluation(cColab, id)).evaluation.feedback).toBeNull(); // rascunho do avaliador oculto
    await saveSelfAssessment(cColab, id, [{ criterionId: k1!, score: 5 }], false);
    expect((await getEvaluation(cCoord, id)).scores.filter((s) => s.source === 'AUTOAVALIACAO')).toHaveLength(0);
    await expect(sendForAcknowledgement(cCoord, id)).rejects.toThrow(/autoavaliação/);
    await expect(saveSelfAssessment(cColab, id, [], true)).rejects.toThrow(/Faltam 1/);
    await saveSelfAssessment(cColab, id, [{ criterionId: k2!, score: 4 }], true);
    await expect(saveSelfAssessment(cColab, id, [{ criterionId: k2!, score: 1 }], false)).rejects.toThrow(/entregue/);
    expect((await getEvaluation(cCoord, id)).scores.filter((s) => s.source === 'AUTOAVALIACAO')).toHaveLength(2);
    await sendForAcknowledgement(cCoord, id);
    // Retificação: nova versão; a anterior fica no histórico.
    await rectify(cCoord, id, 'Ajuste no feedback');
    await saveAssessment(cCoord, id, { scores: [{ criterionId: k1!, score: 4 }, { criterionId: k2!, score: 3 }], feedback: 'Feedback anual revisado.' });
    await sendForAcknowledgement(cCoord, id);
    expect((await getEvaluation(cColab, id)).versions.map((v) => v.version_number)).toEqual([2, 1]);
    // Sem manifestação no prazo, o avaliador encerra com motivo.
    await expect(closeWithoutAcknowledgement(cCoord, id, 'Sem resposta')).rejects.toThrow(/Aguarde/);
    await query(getPool(), "UPDATE evaluations SET sent_at = now() - interval '11 days' WHERE id = $1", [id]);
    await closeWithoutAcknowledgement(cCoord, id, 'Avaliado não se manifestou no prazo.');
    expect((await getEvaluation(cColab, id)).evaluation.status).toBe('CONCLUIDA_SEM_CIENCIA');
  });

  it('PDI, feedback documentado e histórico', async () => {
    const it1 = (await developmentHistory(cColab, emp.colab!)).pdi[0]!;
    await updatePdiItem(cColab, it1.id, 'EM_ANDAMENTO');
    await expect(updatePdiItem(cColab, it1.id, 'CONCLUIDO', 'Feito')).rejects.toThrow(/permissão/);
    await updatePdiItem(cCoord, it1.id, 'CONCLUIDO', 'Prazos em dia há 30 dias');
    const fb = await addFeedback(cCoord, emp.colab!, 'RECONHECIMENTO', 'Excelente atendimento na semana.');
    await expect(addFeedback(cColab, emp.colab!, 'RECONHECIMENTO', 'Eu mesmo')).rejects.toThrow(/permissão/);
    await acknowledgeFeedback(cColab, fb, 'Obrigado!');
    await expect(acknowledgeFeedback(cColab, fb)).rejects.toThrow(/já registrada/);
    await expect(query(getPool(), "UPDATE feedback_notes SET content = 'alterado' WHERE id = $1", [fb])).rejects.toThrow(/imutável/);
    const h = await developmentHistory(cCoord, emp.colab!);
    expect(h.evaluations).toHaveLength(2);
    await expect(developmentHistory(cAtdCoord, emp.colab!)).rejects.toThrow(/permissão/);
    await expect(developmentHistory(cColab, emp.colab2!)).rejects.toThrow(/permissão/);
  });

  it('programação automática idempotente com avaliador da coordenação do setor', async () => {
    const fam = (await listTemplates(cSubst)).find((t) => t.id === tpl)!.family_key;
    await saveSchedule(cSubst, { name: 'Acompanhamento 30 dias', templateFamily: fam, trigger: 'DIAS_APOS_ADMISSAO', daysAfter: 30, leadDays: 7 });
    expect(await generateScheduledEvaluations(today)).toBe(1); // somente quem foi admitido há 25 dias
    expect(await generateScheduledEvaluations(today)).toBe(0);
    const g = (await listEvaluations(cCoord, { scope: 'avaliar' })).find((v) => v.employee_id === emp.colab2)!;
    expect(g).toMatchObject({ due_date: addDays(today, 5), status: 'PENDENTE' });
    expect(await processEvaluationReminders()).toBe(0); // prazo em 5 dias: fora da janela de aviso (3 dias)
    await query(getPool(), 'UPDATE evaluations SET due_date = $2 WHERE id = $1', [g.id, addDays(today, -1)]);
    expect(await processEvaluationReminders()).toBe(1);
    expect((await notes(cCoord.principal.userId, 'AVALIACAO')).some((n) => /em atraso/.test(n.title))).toBe(true);
    expect(await processEvaluationReminders()).toBe(0);
  });
});

describe('Fase 5b — painel configurável e automações', () => {
  it('blocos limitados ao perfil; ordem preservada', async () => {
    expect(availableWidgets(cColab.principal)).not.toContain('administracao');
    await expect(saveWidgets(cColab, ['administracao'])).rejects.toThrow(/indisponível/);
    await saveWidgets(cColab, ['treinamentos', 'tarefas']);
    expect(await myWidgets(cColab)).toEqual(['treinamentos', 'tarefas']);
    await resetWidgets(cColab);
    expect(await myWidgets(cColab)).toEqual(availableWidgets(cColab.principal));
  });

  it('regras disparam uma vez por item; avisos a terceiros sem detalhes; tarefa criada', async () => {
    await expect(saveRule(cCoord, { name: 'X x x', trigger: 'TAREFA_ATRASADA', action: 'NOTIFICAR_RESPONSAVEL' })).rejects.toThrow(/permissão/);
    await expect(saveRule(cSubst, { name: 'Sem alvo', trigger: 'TAREFA_ATRASADA', action: 'NOTIFICAR_USUARIO' })).rejects.toThrow(/pessoa/);
    await expect(saveRule(cSubst, { name: 'Gatilho', trigger: 'APAGAR_TUDO', action: 'NOTIFICAR_RESPONSAVEL' })).rejects.toThrow(/desconhecido/);
    await query(getPool(), `INSERT INTO tasks (title, sector_id, assignee_user_id, due_date, created_by) VALUES ('Conferir matrícula 123 de Fulano', $1, $2, $3, $2)`,
      [I.sectors.RI, cColab.principal.userId, addDays(today, -3)]);
    await saveRule(cSubst, { name: 'Atrasadas', trigger: 'TAREFA_ATRASADA', days: 2, action: 'NOTIFICAR_RESPONSAVEL' });
    const role = (await queryOne<{ id: string }>(getPool(), "SELECT id FROM roles WHERE code = 'COORDENACAO_SETOR'"))!.id;
    await saveRule(cSubst, { name: 'Coordenação', trigger: 'TAREFA_ATRASADA', days: 2, sectorId: I.sectors.RI, action: 'NOTIFICAR_PAPEL', targetRoleId: role });
    await saveRule(cSubst, { name: 'Cobrar', trigger: 'TAREFA_ATRASADA', days: 2, action: 'CRIAR_TAREFA', targetUserId: cCoord.principal.userId, message: 'Verificar atrasos' });
    await saveRule(cSubst, { name: 'Muito atrasadas', trigger: 'TAREFA_ATRASADA', days: 10, action: 'NOTIFICAR_RESPONSAVEL' });
    const r = await runAutomations();
    expect(r.fired).toBe(3);
    expect((await runAutomations()).fired).toBe(0);
    expect((await notes(cColab.principal.userId, 'AUTOMACAO'))[0]!.body).toMatch(/Fulano/); // o responsável vê o item
    const toRole = await notes(cAtdCoord.principal.userId, 'AUTOMACAO');
    expect(toRole).toHaveLength(1);
    expect(JSON.stringify(toRole)).not.toMatch(/Fulano/);
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM tasks WHERE title = '[Automação] Cobrar' AND assignee_user_id = $1", [cCoord.principal.userId]))!.n).toBe(1);
  });

  it('trilha de auditoria íntegra', async () => {
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
