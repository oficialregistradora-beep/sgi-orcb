'use server';

import { redirect } from 'next/navigation';
import { runAction, str, optStr, int, durationToMinutes, type ActionState } from '@/server/web/action.ts';
import { AppError } from '@/server/errors.ts';
import {
  annulRecord, cancelSession, closeSession, completePopStudy, createSession, enroll, registerCompletion, saveTraining, selfDeclare, setQuestions, submitAttempt, validateRecord,
} from '@/server/modules/training.ts';
import {
  acknowledgeEvaluation, acknowledgeFeedback, addFeedback, addPdiItem, cancelEvaluation, closeWithoutAcknowledgement, createEvaluation, publishTemplate, rectify, saveAssessment,
  saveSchedule, saveSelfAssessment, saveTemplate, sendForAcknowledgement, updatePdiItem,
} from '@/server/modules/evaluations.ts';
import { resetWidgets, runAutomations, saveRule, saveWidgets } from '@/server/modules/automation.ts';

async function fileOf(fd: FormData, k = 'file') {
  const f = fd.get(k);
  return f instanceof File && f.size > 0 ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null;
}
const optInt = (fd: FormData, k: string) => (str(fd, k) ? int(fd, k) : null);
const all = (fd: FormData, k: string) => fd.getAll(k).filter((v): v is string => typeof v === 'string' && v !== '');
const hhmm = (fd: FormData, k: string) => (str(fd, k) ? durationToMinutes(str(fd, k)) : null);

/** "Pergunta | alternativa | *correta | alternativa" — uma questão por linha. */
function parseQuestions(text: string) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line, i) => {
    const parts = line.split('|').map((p) => p.trim());
    const [question, ...opts] = parts;
    const correct = opts.findIndex((o) => o.startsWith('*'));
    if (!question || opts.length < 2 || correct < 0 || opts.filter((o) => o.startsWith('*')).length !== 1) {
      throw new AppError(`Linha ${i + 1}: use "Pergunta | alternativa | *correta | …" com exatamente uma alternativa marcada com *.`);
    }
    return { question, options: opts.map((o) => o.replace(/^\*/, '').trim()), correctIndex: correct };
  });
}

/** "GRUPO | Critério | peso | descrição" — um critério por linha. */
function parseCriteria(text: string) {
  const groups = ['COMPETENCIA', 'PRODUTIVIDADE', 'COMPORTAMENTO', 'CONHECIMENTO', 'OUTRO'];
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line, i) => {
    const [g, title, w, ...rest] = line.split('|').map((p) => p.trim());
    const grp = (g ?? '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (!groups.includes(grp) || !title) throw new AppError(`Linha ${i + 1}: use "GRUPO | Critério | peso | descrição" (grupos: ${groups.join(', ')}).`);
    return { grp: grp as 'OUTRO', title, weight: w ? Number(w) : 1, description: rest.join(' | ') || undefined };
  });
}

export async function trainingAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'id');
  let go = '';
  const r = await runAction(async (ctx) => {
    switch (str(fd, 'op')) {
      case 'treinamento': {
        const nid = await saveTraining(ctx, {
          id: optStr(fd, 'id'), code: str(fd, 'code'), title: str(fd, 'title'), kind: str(fd, 'kind') as 'OUTRO', description: optStr(fd, 'description'), provider: optStr(fd, 'provider'),
          workloadMinutes: hhmm(fd, 'workload'), documentId: optStr(fd, 'documentId') ?? null, validityMonths: optInt(fd, 'validityMonths'), mandatory: fd.get('mandatory') === 'on',
          audienceType: (optStr(fd, 'audienceType') ?? 'TODOS') as 'TODOS', sectorIds: all(fd, 'sectorIds'), jobIds: all(fd, 'jobIds'), hasAssessment: fd.get('hasAssessment') === 'on',
          passScore: optInt(fd, 'passScore') ?? 70, maxAttempts: optInt(fd, 'maxAttempts') ?? 3, active: !fd.has('activeField') || fd.get('active') === 'on',
        });
        if (!id) go = `/treinamentos/${nid}`;
        return 'Treinamento salvo.';
      }
      case 'questoes': await setQuestions(ctx, id, parseQuestions(str(fd, 'questions'))); return 'Questões salvas.';
      case 'turma':
        await createSession(ctx, { trainingId: id, sessionDate: str(fd, 'sessionDate'), startTime: hhmm(fd, 'startTime'), endTime: hhmm(fd, 'endTime'), location: optStr(fd, 'location'),
          instructor: optStr(fd, 'instructor'), employeeIds: all(fd, 'employeeIds') });
        return 'Turma criada e incluída na agenda.';
      case 'inscrever': await enroll(ctx, str(fd, 'sessionId'), all(fd, 'employeeIds')); return 'Inscrições registradas.';
      case 'encerrar_turma': {
        const o = await closeSession(ctx, str(fd, 'sessionId'), all(fd, 'present'));
        return `Turma encerrada: ${o.concluded} concluíram, ${o.awaitingAssessment} aguardam a avaliação, ${o.absent} ausente(s)${o.ownPending ? '; sua própria participação será registrada por outra pessoa' : ''}.`;
      }
      case 'cancelar_turma': await cancelSession(ctx, str(fd, 'sessionId'), str(fd, 'reason')); return 'Turma cancelada.';
      case 'conclusao':
        await registerCompletion(ctx, { trainingId: id, employeeId: str(fd, 'employeeId'), completedOn: str(fd, 'completedOn'), minutes: hhmm(fd, 'minutes'), score: optInt(fd, 'score'), notes: optStr(fd, 'notes') }, await fileOf(fd));
        return 'Conclusão registrada.';
      case 'autodeclarar':
        await selfDeclare(ctx, { trainingId: id, completedOn: str(fd, 'completedOn'), minutes: hhmm(fd, 'minutes'), notes: optStr(fd, 'notes') }, await fileOf(fd));
        return 'Certificado enviado para validação.';
      case 'validar': await validateRecord(ctx, str(fd, 'recordId'), str(fd, 'decision') === 'aprovar', optStr(fd, 'notes')); return 'Validação registrada.';
      case 'anular': await annulRecord(ctx, str(fd, 'recordId'), str(fd, 'reason')); return 'Registro anulado.';
      case 'estudo_pop': await completePopStudy(ctx, id, fd.get('confirmed') === 'on'); return 'Estudo concluído.';
      case 'responder': {
        const n = int(fd, 'count');
        const answers = Array.from({ length: n }, (_, i) => (str(fd, `q${i}`) === '' ? -1 : int(fd, `q${i}`)));
        if (answers.some((a) => a < 0)) throw new AppError('Responda todas as questões.');
        const res = await submitAttempt(ctx, id, answers);
        return res.passed
          ? `Aprovado(a) com ${res.score}%.${res.concluded ? ' Treinamento concluído.' : ''}`
          : `Resultado: ${res.score}% — abaixo do mínimo. Tentativas restantes: ${Math.max(res.remaining, 0)}.`;
      }
      default: throw new AppError('Operação desconhecida.');
    }
  }, ['/treinamentos', `/treinamentos/${id}`]);
  if (r.ok && go) redirect(go);
  return r;
}

function scoresFrom(fd: FormData) {
  return fd.getAll('criterionId').filter((v): v is string => typeof v === 'string').flatMap((cid) => {
    const s = str(fd, `score_${cid}`);
    return s ? [{ criterionId: cid, score: Number(s), comment: optStr(fd, `comment_${cid}`) }] : [];
  });
}

export async function evaluationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'id');
  let go = '';
  const r = await runAction(async (ctx) => {
    switch (str(fd, 'op')) {
      case 'modelo': {
        const tid = await saveTemplate(ctx, { id: optStr(fd, 'id'), name: str(fd, 'name'), kind: str(fd, 'kind') as 'OUTRA', instructions: optStr(fd, 'instructions'),
          scaleMax: optInt(fd, 'scaleMax') ?? 5, selfAssessment: fd.get('selfAssessment') === 'on', criteria: parseCriteria(str(fd, 'criteria')) });
        return tid === id ? 'Rascunho atualizado.' : 'Rascunho salvo (nova versão quando o modelo já estava publicado).';
      }
      case 'publicar_modelo': await publishTemplate(ctx, id); return 'Modelo publicado.';
      case 'programacao':
        await saveSchedule(ctx, { id: optStr(fd, 'id'), name: str(fd, 'name'), templateFamily: str(fd, 'templateFamily'), trigger: str(fd, 'trigger') as 'ANUAL', daysAfter: optInt(fd, 'daysAfter'),
          annualMonth: optInt(fd, 'annualMonth'), annualDay: optInt(fd, 'annualDay'), leadDays: optInt(fd, 'leadDays') ?? 7, sectorId: optStr(fd, 'sectorId') ?? null, active: !fd.has('activeField') || fd.get('active') === 'on' });
        return 'Programação salva.';
      case 'criar':
        go = `/avaliacoes/${await createEvaluation(ctx, { templateId: str(fd, 'templateId'), employeeId: str(fd, 'employeeId'), evaluatorUserId: optStr(fd, 'evaluatorUserId'), periodLabel: str(fd, 'periodLabel'), dueDate: str(fd, 'dueDate') })}`;
        return 'Avaliação criada.';
      case 'salvar': await saveAssessment(ctx, id, { scores: scoresFrom(fd), strengths: optStr(fd, 'strengths'), improvements: optStr(fd, 'improvements'), feedback: optStr(fd, 'feedback') }); return 'Rascunho salvo.';
      case 'enviar':
        await saveAssessment(ctx, id, { scores: scoresFrom(fd), strengths: optStr(fd, 'strengths'), improvements: optStr(fd, 'improvements'), feedback: optStr(fd, 'feedback') });
        await sendForAcknowledgement(ctx, id);
        return 'Avaliação enviada ao avaliado para ciência.';
      case 'autoavaliacao': await saveSelfAssessment(ctx, id, scoresFrom(fd), str(fd, 'submit') === '1'); return str(fd, 'submit') === '1' ? 'Autoavaliação entregue.' : 'Autoavaliação salva.';
      case 'manifestar': await acknowledgeEvaluation(ctx, id, str(fd, 'act') as 'CIENCIA', optStr(fd, 'comment'), fd.get('confirmed') === 'on'); return 'Manifestação registrada.';
      case 'retificar': await rectify(ctx, id, str(fd, 'reason')); return 'Avaliação reaberta para retificação.';
      case 'sem_ciencia': await closeWithoutAcknowledgement(ctx, id, str(fd, 'notes')); return 'Avaliação encerrada sem ciência (motivo registrado).';
      case 'cancelar': await cancelEvaluation(ctx, id, str(fd, 'notes')); return 'Avaliação cancelada.';
      case 'pdi':
        await addPdiItem(ctx, { evaluationId: optStr(fd, 'evaluationId'), employeeId: str(fd, 'employeeId'), goal: str(fd, 'goal'), action: str(fd, 'action'), trainingId: optStr(fd, 'trainingId'), dueDate: str(fd, 'dueDate') });
        return 'Item incluído no PDI.';
      case 'pdi_status': await updatePdiItem(ctx, str(fd, 'pdiId'), str(fd, 'status') as 'CONCLUIDO', optStr(fd, 'notes')); return 'PDI atualizado.';
      case 'feedback': await addFeedback(ctx, str(fd, 'employeeId'), str(fd, 'kind') as 'ORIENTACAO', str(fd, 'content')); return 'Feedback registrado.';
      case 'ciencia_feedback': await acknowledgeFeedback(ctx, str(fd, 'feedbackId'), optStr(fd, 'comment')); return 'Ciência registrada.';
      default: throw new AppError('Operação desconhecida.');
    }
  }, ['/avaliacoes', `/avaliacoes/${id}`]);
  if (r.ok && go) redirect(go);
  return r;
}

export async function panelAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    if (str(fd, 'op') === 'padrao') { await resetWidgets(ctx); return 'Painel restaurado ao padrão.'; }
    // Ordem: número informado em cada bloco marcado.
    const chosen = all(fd, 'widget').map((w) => ({ w, pos: Number(str(fd, `pos_${w}`)) || 99 })).sort((a, b) => a.pos - b.pos).map((x) => x.w);
    await saveWidgets(ctx, chosen);
    return 'Painel personalizado.';
  }, '/painel');
}

export async function automationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    switch (str(fd, 'op')) {
      case 'regra':
        await saveRule(ctx, { id: optStr(fd, 'id'), name: str(fd, 'name'), trigger: str(fd, 'trigger'), days: optInt(fd, 'days') ?? 0, sectorId: optStr(fd, 'sectorId') ?? null,
          action: str(fd, 'action') as 'NOTIFICAR_RESPONSAVEL', targetRoleId: optStr(fd, 'targetRoleId') ?? null, targetUserId: optStr(fd, 'targetUserId') ?? null,
          message: optStr(fd, 'message'), active: !fd.has('activeField') || fd.get('active') === 'on' });
        return 'Regra salva.';
      case 'executar': {
        if (!ctx.principal.isOwner && !ctx.principal.grants.has('automacoes.gerenciar')) throw new AppError('Sem permissão.', 403);
        const o = await runAutomations(undefined, optStr(fd, 'id'));
        return `Executado: ${o.fired} disparo(s) em ${o.rules} regra(s).`;
      }
      default: throw new AppError('Operação desconhecida.');
    }
  }, '/automacoes');
}
