import { NextResponse } from 'next/server';
import { getSessionState } from '@/server/web/session.ts';
import { exportVersion } from '@/server/modules/repository.ts';
import { AppError, publicMessage } from '@/server/errors.ts';

export const dynamic = 'force-dynamic';

/** Pacote de exportação (JSON) da versão: conteúdo, hashes, assinaturas e verificação de integridade. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; versao: string }> }) {
  const st = await getSessionState();
  if (st.status !== 'AUTENTICADO') return new NextResponse('Não autenticado', { status: 401 });
  const { id, versao } = await params;
  try {
    const pkg = await exportVersion(st.ctx, id, versao);
    const name = `${(pkg.documento.codigo ?? 'documento').replace(/[^A-Za-z0-9._-]/g, '_')}-v${pkg.versao.numero}.json`;
    return new NextResponse(JSON.stringify(pkg, null, 2), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'private, no-store' },
    });
  } catch (err) {
    return new NextResponse(publicMessage(err), { status: err instanceof AppError ? err.status : 500 });
  }
}
