import { apiHandler } from '@/server/web/api.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return apiHandler(req, async (ctx) => ({
    usuarioId: ctx.principal.userId,
    email: ctx.principal.email,
    nome: ctx.principal.displayName,
    funcionarioId: ctx.principal.employeeId,
    oficial: ctx.principal.isOwner,
    permissoes: Object.fromEntries([...ctx.principal.grants].map(([k, g]) => [k, g.scope])),
  }));
}
