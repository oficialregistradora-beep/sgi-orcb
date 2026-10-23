import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import { saveTraining, selfDeclare, setQuestions, submitAttempt, trainingFileForDownload, validateRecord } from '../../../src/server/modules/training.ts';
import {
  acknowledgeEvaluation, createEvaluation, getEvaluation, listEvaluations, publishTemplate, rectify, saveAssessment, saveTemplate, sendForAcknowledgement,
} from '../../../src/server/modules/evaluations.ts';
import { runAutomations, saveRule, saveWidgets } from '../../../src/server/modules/automation.ts';
import { qualityFileForDownload } from '../../../src/server/modules/security.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { addDays, todayLocal } from '../../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';

let I: Awaited<ReturnType<typeof ids>>;
let cSubst: Ctx, cCoord: Ctx, cColab: Ctx, cPeer: Ctx, cAtdCoord: Ctx;
const emp: Record<string, string> = {};
const today = todayLocal();
const PDF = { name: 'c.pdf', bytes: new TextEncoder().encode('%PDF-1.4\n%fictício\n%%EOF') };
let tpl: string, ev: string;

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  const mk = async (k: string, name: string, sectorId: string, roles: string[]) => {
    const p = await makePerson({ name, sectorId, jobId: I.jobs.escrevente, roles: roles.map((r) => ({ roleId: I.roles[r as keyof typeof I.roles] })) });
    emp[k] = p.employeeId;
    return p.userId;
  };
  await makePerson({ name: 'Oficial', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
  cSubst = await ctxFor(await mk('subst', 'Substituta', I.sectors.DIR, ['SUBSTITUTA_LEGAL']));
  cCoord = await ctxFor(await mk('coord', 'Coord RI', I.sectors.RI, ['COLABORADOR', 'COORDENACAO_SETOR']));
  cColab = await ctxFor(await mk('colab', 'Colab RI', I.sectors.RI, ['COLABORADOR']));
  cPeer = await ctxFor(await mk('peer', 'Colega RI', I.sectors.RI, ['COLABORADOR']));
  cAtdCoord = await ctxFor(await mk('atdcoord', 'Coord ATD', I.sectors.ATD, ['COLABORADOR', 'COORDENACAO_SETOR']));
});
afterAll(closePool);

describe('Rodada 2 (5b) — treinamentos sob ataque e concorrência', () => {
  it('tentativas simultâneas respeitam o limite; respostas inválidas recusadas', async () => {
    const t = await saveTraining(cSubst, { code: 'T1', title: 'Treino', kind: 'CURSO_INTERNO', hasAssessment: true, maxAttempts: 2 });
    await setQuestions(cSubst, t, [{ question: 'Q1?', options: ['a', 'b'], correctIndex: 1 }, { question: 'Q2?', options: ['a', 'b', 'c'], correctIndex: 2 }]);
    await expect(submitAttempt(cColab, t, [1])).rejects.toThrow(/todas/);
    await expect(submitAttempt(cColab, t, [1, 9])).rejects.toThrow();
    const r = await Promise.allSettled(Array.from({ length: 6 }, () => submitAttempt(cColab, t, [0, 0])));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(2);
    expect((await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM training_attempts WHERE training_id = $1', [t]))!.n).toBe(2);
    await expect(query(getPool(), 'UPDATE training_attempts SET score = 100, passed = true')).rejects.toThrow(/imutável|não pode/i);
  });

  it('certificados: duplicidade e validação simultânea; isolamento das rotas de download', async () => {
    const ext = await saveTraining(cSubst, { code: 'EXT', title: 'Externo', kind: 'CURSO_EXTERNO' });
    const r = await Promise.allSettled([1, 2, 3].map(() => selfDeclare(cColab, { trainingId: ext, completedOn: today }, PDF)));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rec = (await queryOne<{ id: string; certificate_file_id: string }>(getPool(), "SELECT id, certificate_file_id FROM training_records WHERE status = 'PENDENTE_VALIDACAO'"))!;
    const v = await Promise.allSettled([validateRecord(cCoord, rec.id, true), validateRecord(cSubst, rec.id, true)]);
    expect(v.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    await expect(trainingFileForDownload(cPeer, rec.certificate_file_id)).rejects.toThrow(/não encontrado/);
    await expect(qualityFileForDownload(cSubst, rec.certificate_file_id)).rejects.toThrow(/não encontrado/);
    // Autodeclaração validada pela própria pessoa: o banco recusa mesmo contornando o serviço.
    await expect(query(getPool(), `INSERT INTO training_records (training_id, employee_id, status, source, completed_on, submitted_by, validated_by)
      VALUES ($1,$2,'CONCLUIDO','AUTODECLARADO',$3,$4,$4)`, [ext, emp.colab, today, cColab.principal.userId])).rejects.toThrow(/check/i);
  });
});

describe('Rodada 2 (5b) — confidencialidade e integridade das avaliações', () => {
  it('colegas e outras coordenações não veem; o avaliado não vê o rascunho', async () => {
    tpl = await saveTemplate(cSubst, { name: 'Modelo', kind: 'ANUAL', criteria: [{ grp: 'COMPETENCIA', title: 'Técnica' }] });
    await publishTemplate(cSubst, tpl);
    ev = await createEvaluation(cCoord, { templateId: tpl, employeeId: emp.colab!, periodLabel: 'Anual', dueDate: addDays(today, 5) });
    const k = (await queryOne<{ id: string }>(getPool(), 'SELECT id FROM evaluation_criteria WHERE template_id = $1', [tpl]))!.id;
    await saveAssessment(cCoord, ev, { scores: [{ criterionId: k, score: 2 }], feedback: 'Comentário reservado do avaliador.' });
    for (const c of [cPeer, cAtdCoord, cColab]) await expect(getEvaluation(c, ev)).rejects.toThrow(/não encontrada/);
    for (const c of [cPeer, cAtdCoord, cColab]) expect((await listEvaluations(c)).map((v) => v.id)).not.toContain(ev);
    expect((await getEvaluation(cSubst, ev)).evaluation.feedback).toMatch(/reservado/);
  });

  it('manifestação exige reautenticação, só na versão vigente e uma única vez', async () => {
    await sendForAcknowledgement(cCoord, ev);
    const noStep = await ctxFor(cColab.principal.userId, { stepUp: false });
    await expect(acknowledgeEvaluation(noStep, ev, 'CIENCIA', undefined, true)).rejects.toThrow(/reautentica|código/i);
    await expect(acknowledgeEvaluation(cColab, ev, 'CIENCIA', undefined, false)).rejects.toThrow(/confirmar/);
    await rectify(cCoord, ev, 'Correção de nota');
    await expect(acknowledgeEvaluation(cColab, ev, 'CIENCIA', undefined, true)).rejects.toThrow(/não aguarda/);
    await sendForAcknowledgement(cCoord, ev);
    const r = await Promise.allSettled([acknowledgeEvaluation(cColab, ev, 'CIENCIA', undefined, true), acknowledgeEvaluation(cColab, ev, 'CONCORDANCIA', undefined, true)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const g = await getEvaluation(cColab, ev);
    expect(g.signatures).toHaveLength(1);
    expect(g.signatures[0]!.version_id).toBe(g.versions[0]!.id); // versão 2
    await expect(query(getPool(), "UPDATE document_versions SET content = '{}'::jsonb WHERE id = $1", [g.versions[0]!.id])).rejects.toThrow(/imutável|não pode/i);
    await expect(query(getPool(), 'DELETE FROM evaluations WHERE id = $1', [ev])).rejects.toThrow(/excluído/);
  });

  it('documento da avaliação não aparece nos documentos pessoais de jornada', async () => {
    const n = await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM documents WHERE reference_type = 'AVALIACAO' AND owner_employee_id = $1", [emp.colab]);
    expect(n!.n).toBe(1);
    const { listEmployeeDocuments } = await import('../../../src/server/modules/documents.ts');
    expect((await listEmployeeDocuments(cColab, emp.colab!)).filter((d) => (d.reference_type as string) === 'AVALIACAO')).toHaveLength(0);
  });
});

describe('Rodada 2 (5b) — automações e painel', () => {
  it('volume limitado por execução; execuções simultâneas não duplicam', async () => {
    for (let i = 0; i < 60; i++) {
      await query(getPool(), 'INSERT INTO tasks (title, sector_id, assignee_user_id, due_date, created_by) VALUES ($1,$2,$3,$4,$3)', [`Tarefa ${i}`, I.sectors.RI, cColab.principal.userId, addDays(today, -5)]);
    }
    await saveRule(cSubst, { name: 'Atrasadas', trigger: 'TAREFA_ATRASADA', days: 1, action: 'NOTIFICAR_RESPONSAVEL' });
    const [a, b] = await Promise.all([runAutomations(), runAutomations()]);
    expect(a.fired + b.fired).toBeLessThanOrEqual(100);
    const third = await runAutomations();
    const total = (await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM automation_runs'))!.n;
    expect(total).toBe(60);
    expect(a.fired + b.fired + third.fired).toBe(60);
    const dup = await query(getPool(), "SELECT body FROM notifications WHERE kind = 'AUTOMACAO' GROUP BY body HAVING count(*) > 1");
    expect(dup).toHaveLength(0);
  });

  it('ações perigosas inexistentes; alvo inativo recusado; preferências validadas', async () => {
    await expect(saveRule(cSubst, { name: 'Excluir', trigger: 'TAREFA_ATRASADA', action: 'EXCLUIR' as 'CRIAR_TAREFA', targetUserId: cColab.principal.userId })).rejects.toThrow();
    await query(getPool(), "UPDATE users SET status = 'SUSPENSO' WHERE id = $1", [cPeer.principal.userId]);
    await expect(saveRule(cSubst, { name: 'Para suspenso', trigger: 'TAREFA_ATRASADA', action: 'CRIAR_TAREFA', targetUserId: cPeer.principal.userId })).rejects.toThrow(/inativa/);
    await query(getPool(), "UPDATE users SET status = 'ATIVO' WHERE id = $1", [cPeer.principal.userId]);
    await expect(saveWidgets(cColab, ['tarefas', '<script>'])).rejects.toThrow(/indisponível/);
    await expect(saveWidgets(cColab, Array.from({ length: 31 }, () => 'tarefas'))).rejects.toThrow();
  });

  it('trilha de auditoria íntegra', async () => {
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
