'use server';

import { runAction, str, optStr, int, type ActionState } from '@/server/web/action.ts';
import {
  addHoliday, assignRole, createRole, createSchedule, createUser, removeHoliday, resetUserMfa, revokeUserRole, saveJobTitle,
  saveSector, setRolePermission, setUserStatus, updateNumericSetting,
} from '@/server/modules/admin.ts';
import { verifyAuditChain } from '@/server/audit.ts';
import { getPool } from '@/server/db.ts';
import { requirePermission } from '@/server/authz.ts';
import { markAllRead } from '@/server/modules/notifications.ts';

export async function createUserAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await createUser(ctx, { email: str(fd, 'email'), displayName: str(fd, 'displayName') });
    return 'Usuário criado. Atribua os papéis necessários.';
  }, '/permissoes');
}

export async function userStatusAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await setUserStatus(ctx, { userId: str(fd, 'userId'), status: str(fd, 'status') as 'ATIVO', reason: str(fd, 'reason') });
    return 'Situação do usuário alterada.';
  }, '/permissoes');
}

export async function resetMfaAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await resetUserMfa(ctx, str(fd, 'userId'), str(fd, 'reason'));
    return 'Autenticador redefinido. O usuário fará novo cadastro no próximo acesso.';
  }, '/permissoes');
}

export async function rolePermissionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const scope = str(fd, 'scope');
    await setRolePermission(ctx, { roleId: str(fd, 'roleId'), permissionCode: str(fd, 'permissionCode'), scope: scope ? (scope as 'TODOS') : null });
    return 'Permissão atualizada.';
  }, '/permissoes');
}

export async function createRoleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await createRole(ctx, { code: str(fd, 'code'), name: str(fd, 'name'), description: optStr(fd, 'description') });
    return 'Papel criado.';
  }, '/permissoes');
}

export async function assignRoleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await assignRole(ctx, {
      userId: str(fd, 'userId'), roleId: str(fd, 'roleId'), sectorId: optStr(fd, 'sectorId') ?? null,
      validFrom: str(fd, 'validFrom'), validUntil: optStr(fd, 'validUntil') ?? null, reason: str(fd, 'reason'),
    });
    return 'Papel atribuído.';
  }, '/permissoes');
}

export async function revokeRoleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await revokeUserRole(ctx, str(fd, 'userRoleId'), str(fd, 'reason'));
    return 'Atribuição revogada.';
  }, '/permissoes');
}

export async function sectorAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await saveSector(ctx, { id: optStr(fd, 'id'), code: str(fd, 'code'), name: str(fd, 'name'), parentId: optStr(fd, 'parentId') ?? null, active: fd.get('active') !== 'off' });
    return 'Setor salvo.';
  }, '/configuracoes');
}

export async function jobTitleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await saveJobTitle(ctx, { id: optStr(fd, 'id'), name: str(fd, 'name'), description: optStr(fd, 'description'), active: fd.get('active') !== 'off' });
    return 'Cargo salvo.';
  }, '/configuracoes');
}

export async function scheduleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const days = [0, 1, 2, 3, 4, 5, 6]
      .filter((d) => fd.get(`d${d}_on`) === 'on')
      .map((d) => ({
        weekday: d, start: str(fd, `d${d}_start`), end: str(fd, `d${d}_end`),
        breakStart: optStr(fd, `d${d}_bs`) ?? null, breakEnd: optStr(fd, `d${d}_be`) ?? null,
      }));
    await createSchedule(ctx, {
      name: str(fd, 'name'), description: optStr(fd, 'description'), toleranceEnabled: fd.get('toleranceEnabled') === 'on',
      tolerancePerMark: int(fd, 'tolerancePerMark'), toleranceDaily: int(fd, 'toleranceDaily'), days,
    });
    return 'Jornada criada.';
  }, '/configuracoes');
}

export async function holidayAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await addHoliday(ctx, { date: str(fd, 'date'), name: str(fd, 'name'), scope: str(fd, 'scope') as 'MUNICIPAL', isDayOff: fd.get('isDayOff') === 'on' });
    return 'Feriado incluído. Dias já apurados podem ser reprocessados se necessário.';
  }, '/configuracoes');
}

export async function removeHolidayAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await removeHoliday(ctx, str(fd, 'id'));
    return 'Feriado excluído.';
  }, '/configuracoes');
}

export async function settingAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await updateNumericSetting(ctx, str(fd, 'key'), int(fd, 'value'));
    return 'Parâmetro atualizado.';
  }, '/configuracoes');
}

export async function verifyAuditAction(_p: ActionState, _fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    requirePermission(ctx, 'auditoria.ver');
    const v = await verifyAuditChain(getPool());
    return v.ok
      ? `Cadeia íntegra: ${v.total} registro(s) verificados, nenhum sinal de adulteração.`
      : `ALERTA: inconsistência no registro nº ${v.brokenId} (${v.reason}). Acione o plano de resposta a incidentes.`;
  });
}

export async function markReadAction(_p: ActionState, _fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await markAllRead(ctx);
    return 'Notificações marcadas como lidas.';
  }, '/notificacoes');
}
