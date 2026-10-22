export type Scope = 'PROPRIO' | 'SETOR' | 'TODOS';

export type Grant = { scope: Scope; sectorIds: Set<string> };

/** Usuário autenticado com as permissões efetivas na data corrente. */
export type Principal = {
  userId: string;
  email: string;
  displayName: string;
  isOwner: boolean;
  employeeId: string | null;
  employeeSectorId: string | null;
  grants: Map<string, Grant>;
};

/** Contexto de cada requisição autenticada, propagado a todos os serviços. */
export type Ctx = {
  principal: Principal;
  sessionId: string;
  authMethod: string;
  mfaVerifiedAt: Date | null;
  stepUpAt: Date | null;
  ip: string | null;
  userAgent: string | null;
};

/** Contexto de sistema (rotinas automáticas), sem sessão. */
export type AuditActor = { userId: string | null; sessionId: string | null; ip: string | null };

export function actorOf(ctx: Ctx | null): AuditActor {
  return ctx ? { userId: ctx.principal.userId, sessionId: ctx.sessionId, ip: ctx.ip } : { userId: null, sessionId: null, ip: null };
}
