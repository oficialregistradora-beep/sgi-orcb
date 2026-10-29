import { NextResponse } from 'next/server';
import { getSessionState } from '@/server/web/session.ts';
import { buildMonthFile } from '@/server/modules/asgard.ts';
import { AppError, publicMessage } from '@/server/errors.ts';

export const dynamic = 'force-dynamic';

/** Planilha para importação no Asgard: modelo da serventia preenchido com as despesas pagas no mês. */
export async function GET(req: Request) {
  const st = await getSessionState();
  if (st.status !== 'AUTENTICADO') return new NextResponse('Não autenticado', { status: 401 });
  const mes = new URL(req.url).searchParams.get('mes') ?? '';
  try {
    const f = await buildMonthFile(st.ctx, mes);
    return new NextResponse(new Uint8Array(f.bytes), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${f.filename}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    return new NextResponse(publicMessage(err), { status: err instanceof AppError ? err.status : 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}
