import { apiHandler } from '@/server/web/api.ts';
import { getTodayStatus, punch } from '@/server/modules/timeclock.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return apiHandler(req, async (ctx) => {
    const s = await getTodayStatus(ctx);
    if (!s) return { hoje: null };
    return {
      hoje: s.today,
      proximaMarcacao: s.nextKind,
      marcacoes: s.day.punches.map((p) => ({ id: p.id, horario: p.punched_at, origem: p.source, desconsiderada: p.annulled })),
    };
  });
}

/** Registra a marcação do próprio usuário. O horário é sempre o do servidor. */
export async function POST(req: Request) {
  return apiHandler(req, async (ctx) => {
    const r = await punch(ctx);
    return { id: r.id, horario: r.punchedAt, tipo: r.kind };
  });
}
