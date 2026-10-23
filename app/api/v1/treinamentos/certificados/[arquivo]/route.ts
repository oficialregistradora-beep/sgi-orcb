import { NextResponse } from 'next/server';
import { getSessionState } from '@/server/web/session.ts';
import { trainingFileForDownload } from '@/server/modules/training.ts';
import { AppError, publicMessage } from '@/server/errors.ts';
import { rateLimit } from '@/server/ratelimit.ts';

export const dynamic = 'force-dynamic';

/** Download autorizado de certificado de treinamento (acesso, hash e antivírus conferidos). */
export async function GET(_req: Request, { params }: { params: Promise<{ arquivo: string }> }) {
  const st = await getSessionState();
  if (st.status !== 'AUTENTICADO') return new NextResponse('Não autenticado', { status: 401 });
  if (!rateLimit(`download:${st.ctx.principal.userId}`, 60, 60_000)) return new NextResponse('Muitas requisições. Aguarde um minuto.', { status: 429 });
  const { arquivo } = await params;
  try {
    const f = await trainingFileForDownload(st.ctx, arquivo);
    const ascii = f.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return new NextResponse(new Uint8Array(f.data), {
      headers: {
        'content-type': f.mime_type, 'content-length': String(f.data.byteLength),
        'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
        'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, no-store', 'x-sha256': f.sha256,
      },
    });
  } catch (err) {
    return new NextResponse(publicMessage(err), { status: err instanceof AppError ? err.status : 500 });
  }
}
