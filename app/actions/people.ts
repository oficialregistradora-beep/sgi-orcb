'use server';

import { redirect } from 'next/navigation';
import { runAction, str, optStr, int, type ActionState } from '@/server/web/action.ts';
import {
  addAbsence, addSalary, assignSchedule, cancelAbsence, createAgreement, createEmployee, revokeAgreement,
  setControlStart, terminateEmployee, updateEmployee, updateSensitiveData,
} from '@/server/modules/people.ts';

export async function createEmployeeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  let createdId: string | null = null;
  const r = await runAction(async (ctx) => {
    createdId = await createEmployee(ctx, {
      registrationCode: str(fd, 'registrationCode'), fullName: str(fd, 'fullName'), socialName: optStr(fd, 'socialName'),
      jobTitleId: str(fd, 'jobTitleId'), functionDescription: optStr(fd, 'functionDescription'), sectorId: str(fd, 'sectorId'),
      admissionDate: str(fd, 'admissionDate'), contractType: str(fd, 'contractType') as 'CLT', weeklyHours: Number(str(fd, 'weeklyHours')),
      email: optStr(fd, 'email'), scheduleId: optStr(fd, 'scheduleId'), controlStartDate: optStr(fd, 'controlStartDate'),
    });
    return 'Funcionário admitido.';
  }, ['/equipe']);
  if (r.ok && createdId) redirect(`/equipe/${createdId}`);
  return r;
}

export async function updateEmployeeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'employeeId');
  return runAction(async (ctx) => {
    await updateEmployee(ctx, id, {
      fullName: str(fd, 'fullName'), socialName: optStr(fd, 'socialName'), jobTitleId: str(fd, 'jobTitleId'),
      functionDescription: optStr(fd, 'functionDescription'), sectorId: str(fd, 'sectorId'), contractType: str(fd, 'contractType') as 'CLT',
      weeklyHours: Number(str(fd, 'weeklyHours')), changeDate: optStr(fd, 'changeDate'), changeReason: optStr(fd, 'changeReason'),
    });
    return 'Cadastro atualizado.';
  }, [`/equipe/${id}`, '/equipe']);
}

export async function controlStartAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'employeeId');
  return runAction(async (ctx) => {
    await setControlStart(ctx, id, { date: str(fd, 'date'), reason: str(fd, 'reason') });
    return 'Início do controle no sistema atualizado.';
  }, [`/equipe/${id}`, '/ferias', '/ocorrencias']);
}

export async function sensitiveAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'employeeId');
  return runAction(async (ctx) => {
    await updateSensitiveData(ctx, id, {
      cpf: optStr(fd, 'cpf'), rg: optStr(fd, 'rg'), birthDate: optStr(fd, 'birthDate'), address: optStr(fd, 'address'), phone: optStr(fd, 'phone'),
      personalEmail: optStr(fd, 'personalEmail'), bankAccount: optStr(fd, 'bankAccount'), emergencyContact: optStr(fd, 'emergencyContact'),
      healthNotes: optStr(fd, 'healthNotes'),
    });
    return 'Dados sensíveis atualizados (armazenados criptografados).';
  }, [`/equipe/${id}`]);
}

export async function salaryAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'employeeId');
  return runAction(async (ctx) => {
    await addSalary(ctx, id, { monthlyAmount: str(fd, 'monthlyAmount').replace(/\./g, '').replace(',', '.'), effectiveDate: str(fd, 'effectiveDate'), reason: str(fd, 'reason') });
    return 'Registro salarial incluído.';
  }, [`/equipe/${id}`]);
}

export async function assignScheduleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'employeeId');
  return runAction(async (ctx) => {
    await assignSchedule(ctx, id, str(fd, 'scheduleId'), str(fd, 'validFrom'));
    return 'Jornada contratual atribuída.';
  }, [`/equipe/${id}`]);
}

export async function agreementAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'employeeId');
  return runAction(async (ctx) => {
    await createAgreement(ctx, id, {
      kind: str(fd, 'kind') as 'INDIVIDUAL_ESCRITO', compensationMonths: int(fd, 'compensationMonths'), validFrom: str(fd, 'validFrom'),
      validUntil: optStr(fd, 'validUntil') ?? null, allowsNegativeBalance: fd.get('allowsNegativeBalance') === 'on',
      maxDailyExtraMinutes: int(fd, 'maxDailyExtraMinutes'), documentReference: str(fd, 'documentReference'), notes: optStr(fd, 'notes'),
    });
    return 'Acordo de banco de horas cadastrado.';
  }, [`/equipe/${id}`]);
}

export async function revokeAgreementAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'employeeId');
  return runAction(async (ctx) => {
    await revokeAgreement(ctx, str(fd, 'agreementId'), str(fd, 'endDate'));
    return 'Acordo encerrado.';
  }, [`/equipe/${id}`]);
}

export async function absenceAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'employeeId');
  return runAction(async (ctx) => {
    await addAbsence(ctx, id, {
      type: str(fd, 'type') as 'FERIAS', startDate: str(fd, 'startDate'), endDate: str(fd, 'endDate'),
      countsAsWorked: fd.get('countsAsWorked') === 'on', notes: optStr(fd, 'notes'),
    });
    return 'Ausência lançada e apuração recalculada.';
  }, [`/equipe/${id}`]);
}

export async function cancelAbsenceAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'employeeId');
  return runAction(async (ctx) => {
    await cancelAbsence(ctx, str(fd, 'absenceId'), str(fd, 'reason'));
    return 'Ausência cancelada.';
  }, [`/equipe/${id}`]);
}

export async function terminateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'employeeId');
  return runAction(async (ctx) => {
    await terminateEmployee(ctx, id, { terminationDate: str(fd, 'terminationDate'), reason: str(fd, 'reason') });
    return 'Desligamento registrado. Acessos revogados e saldo sinalizado para apuração rescisória.';
  }, [`/equipe/${id}`, '/equipe']);
}
