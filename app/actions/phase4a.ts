'use server';

import { redirect } from 'next/navigation';
import { runAction, str, optStr, int, type ActionState } from '@/server/web/action.ts';
import { AppError } from '@/server/errors.ts';
import {
  addAttachment, addChecklistItem, addComment, addDependency, createTask, escalate, removeDependency, resolveEscalation, reviewTask, setStatus,
  toggleChecklistItem, updateTask, type Priority, type TaskStatus,
} from '@/server/modules/tasks.ts';
import { addCost, addMilestone, addPhase, createProject, saveIndicator, setMember, toggleMilestone, updateProject, type ProjectStatus } from '@/server/modules/projects.ts';
import { cancelProcess, saveProcessTemplate, saveRoutine, startProcess, AREAS } from '@/server/modules/routines.ts';

const nul = (fd: FormData, k: string) => optStr(fd, k) ?? null;

/** "HH:MM" → minutos; vazio → null. */
function hhmm(fd: FormData, k: string): number | null {
  const v = str(fd, k);
  if (!v) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  if (!m) throw new AppError('Horário inválido (use HH:MM).');
  return Number(m[1]) * 60 + Number(m[2]);
}

function money(fd: FormData, k: string): number | null {
  const v = str(fd, k).replace(/\./g, '').replace(',', '.');
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new AppError('Valor inválido.');
  return n;
}

function taskFields(fd: FormData) {
  return {
    title: str(fd, 'title'), description: optStr(fd, 'description'), priority: (optStr(fd, 'priority') as Priority) ?? undefined,
    sectorId: optStr(fd, 'sectorId'), assigneeUserId: !fd.has('assigneeUserId') || str(fd, 'assigneeUserId') === '__self' ? undefined : nul(fd, 'assigneeUserId'),
    phaseId: fd.has('phaseId') ? nul(fd, 'phaseId') : undefined,
    startDate: nul(fd, 'startDate'), dueDate: nul(fd, 'dueDate'), dueTime: hhmm(fd, 'dueTime'),
    blockStart: hhmm(fd, 'blockStart'), blockEnd: hhmm(fd, 'blockEnd'),
    requiresApproval: fd.get('requiresApproval') === 'on', approverUserId: nul(fd, 'approverUserId'),
  };
}

export async function createTaskAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  let id = '';
  const r = await runAction(async (ctx) => {
    id = await createTask(ctx, { ...taskFields(fd), projectId: nul(fd, 'projectId'), parentTaskId: nul(fd, 'parentTaskId') });
    return 'Tarefa criada.';
  }, ['/tarefas', '/projetos']);
  if (r.ok && id && fd.get('open') === '1') redirect(`/tarefas/${id}`);
  return r;
}

/** Operações na página da tarefa (um formulário por operação, identificada por `op`). */
export async function taskAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'taskId');
  return runAction(async (ctx) => {
    switch (str(fd, 'op')) {
      case 'editar': await updateTask(ctx, id, taskFields(fd)); return 'Tarefa atualizada.';
      case 'situacao': {
        const s = await setStatus(ctx, id, str(fd, 'status') as TaskStatus, optStr(fd, 'reason'));
        return s === 'EM_REVISAO' ? 'Enviada para aprovação.' : 'Situação atualizada.';
      }
      case 'aprovar': await reviewTask(ctx, id, true, optStr(fd, 'notes')); return 'Conclusão aprovada.';
      case 'devolver': await reviewTask(ctx, id, false, optStr(fd, 'notes')); return 'Tarefa devolvida para ajuste.';
      case 'encaminhar': await escalate(ctx, id, str(fd, 'level') as 'SUBSTITUTA', str(fd, 'reason')); return 'Questão encaminhada.';
      case 'decidir': await resolveEscalation(ctx, id, str(fd, 'decision')); return 'Decisão registrada.';
      case 'item': await addChecklistItem(ctx, id, str(fd, 'title')); return 'Item incluído.';
      case 'marcar': await toggleChecklistItem(ctx, str(fd, 'itemId'), fd.get('done') === '1'); return 'Checklist atualizado.';
      case 'comentar': await addComment(ctx, id, str(fd, 'body')); return 'Comentário registrado.';
      case 'dependencia': await addDependency(ctx, id, str(fd, 'dependsOnId')); return 'Dependência incluída.';
      case 'remover_dependencia': await removeDependency(ctx, id, str(fd, 'dependsOnId')); return 'Dependência removida.';
      case 'anexo': {
        const f = fd.get('file');
        if (!(f instanceof File) || f.size === 0) throw new AppError('Escolha um arquivo.');
        await addAttachment(ctx, id, { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
        return 'Anexo incluído (verificado pelo antivírus quando configurado).';
      }
      default: throw new AppError('Operação desconhecida.');
    }
  }, [`/tarefas/${id}`, '/tarefas', '/projetos', '/painel']);
}

/** Mudança rápida de situação no quadro. */
export async function quickStatusAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const s = await setStatus(ctx, str(fd, 'taskId'), str(fd, 'status') as TaskStatus, optStr(fd, 'reason'));
    return s === 'EM_REVISAO' ? 'Enviada para aprovação.' : 'Atualizada.';
  }, ['/tarefas', '/projetos']);
}

function projectFields(fd: FormData) {
  return {
    name: str(fd, 'name'), code: optStr(fd, 'code'), description: optStr(fd, 'description'), sectorId: str(fd, 'sectorId'),
    ownerUserId: optStr(fd, 'ownerUserId'), startDate: nul(fd, 'startDate'), dueDate: nul(fd, 'dueDate'), estimatedCost: money(fd, 'estimatedCost'),
  };
}

export async function createProjectAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  let id = '';
  const r = await runAction(async (ctx) => {
    id = await createProject(ctx, projectFields(fd));
    return 'Projeto criado.';
  }, '/projetos');
  if (r.ok && id) redirect(`/projetos/${id}`);
  return r;
}

export async function projectAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'projectId');
  return runAction(async (ctx) => {
    switch (str(fd, 'op')) {
      case 'editar': await updateProject(ctx, id, { ...projectFields(fd), status: str(fd, 'status') as ProjectStatus, reason: optStr(fd, 'reason') }); return 'Projeto atualizado.';
      case 'membro': await setMember(ctx, id, str(fd, 'userId'), (optStr(fd, 'role') as 'MEMBRO') ?? null); return 'Participação atualizada.';
      case 'fase': await addPhase(ctx, id, { name: str(fd, 'name'), startDate: nul(fd, 'startDate'), dueDate: nul(fd, 'dueDate') }); return 'Fase incluída.';
      case 'marco': await addMilestone(ctx, id, { title: str(fd, 'title'), dueDate: str(fd, 'dueDate') }); return 'Marco incluído.';
      case 'marco_feito': await toggleMilestone(ctx, str(fd, 'milestoneId'), fd.get('done') === '1'); return 'Marco atualizado.';
      case 'custo': {
        const amount = money(fd, 'amount');
        if (amount === null) throw new AppError('Informe o valor.');
        await addCost(ctx, id, { description: str(fd, 'description'), amount, spentOn: str(fd, 'spentOn') });
        return 'Custo lançado.';
      }
      case 'indicador': await saveIndicator(ctx, id, { id: optStr(fd, 'indicatorId'), name: str(fd, 'name'), unit: optStr(fd, 'unit'), target: Number(str(fd, 'target').replace(',', '.')), current: Number(str(fd, 'current').replace(',', '.')) }); return 'Indicador salvo.';
      default: throw new AppError('Operação desconhecida.');
    }
  }, [`/projetos/${id}`, '/projetos']);
}

export async function routineAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const times = str(fd, 'times').split(/[,;\s]+/).filter(Boolean).map((t) => {
      const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(t);
      if (!m) throw new AppError(`Horário inválido: ${t}`);
      return Number(m[1]) * 60 + Number(m[2]);
    });
    const area = str(fd, 'area');
    if (!(AREAS as readonly string[]).includes(area)) throw new AppError('Escolha a área.');
    await saveRoutine(ctx, {
      id: optStr(fd, 'id'), name: str(fd, 'name'), description: optStr(fd, 'description'), area: area as 'RI', sectorId: str(fd, 'sectorId'),
      assigneeUserId: nul(fd, 'assigneeUserId'), frequency: str(fd, 'frequency') as 'DIARIA', times,
      weekdays: fd.getAll('weekdays').map((w) => Number(w)), monthDay: optStr(fd, 'monthDay') ? int(fd, 'monthDay') : null,
      month: optStr(fd, 'month') ? int(fd, 'month') : null, businessDaysOnly: fd.get('businessDaysOnly') === 'on',
      priority: str(fd, 'priority') as 'MEDIA', blockStart: hhmm(fd, 'blockStart'), blockEnd: hhmm(fd, 'blockEnd'),
      startsOn: optStr(fd, 'startsOn'), endsOn: nul(fd, 'endsOn'), active: fd.get('active') === 'on',
    });
    return 'Rotina salva. As tarefas são geradas automaticamente a cada dia.';
  }, ['/rotinas', '/tarefas']);
}

export async function processTemplateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    // Etapas: uma por linha no formato "Título | prazo em dias | papel responsável (opcional) | aprovação (s/n) | documentos exigidos"
    const roles = fd.getAll('roleOptions').map(String);
    const steps = str(fd, 'steps').split('\n').map((l) => l.trim()).filter(Boolean).map((line, i) => {
      const [title, sla, role, approval, docs] = line.split('|').map((x) => x.trim());
      const roleId = role ? roles.find((r) => r.split('::')[1]?.toLowerCase() === role.toLowerCase())?.split('::')[0] : undefined;
      if (role && !roleId) throw new AppError(`Etapa ${i + 1}: papel "${role}" não encontrado.`);
      return { title: title ?? '', slaDays: sla ? Number(sla) : 1, responsibleRoleId: roleId ?? null, requiresApproval: /^s/i.test(approval ?? ''), requiredDocuments: docs || undefined };
    });
    await saveProcessTemplate(ctx, { id: optStr(fd, 'id'), name: str(fd, 'name'), description: optStr(fd, 'description'), sectorId: str(fd, 'sectorId'), active: fd.get('active') === 'on', steps });
    return 'Modelo de processo salvo.';
  }, '/rotinas');
}

export async function processInstanceAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    if (str(fd, 'op') === 'cancelar') {
      await cancelProcess(ctx, str(fd, 'instanceId'), str(fd, 'reason'));
      return 'Processo cancelado.';
    }
    await startProcess(ctx, str(fd, 'templateId'), str(fd, 'title'));
    return 'Processo iniciado: as etapas foram criadas como tarefas.';
  }, ['/rotinas', '/tarefas']);
}
