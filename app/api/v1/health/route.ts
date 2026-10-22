import { NextResponse } from 'next/server';
import { getPool, queryOne } from '@/server/db.ts';

export const dynamic = 'force-dynamic';

/** Verificação de disponibilidade (usada pelo monitoramento). Não expõe dados. */
export async function GET() {
  try {
    await queryOne(getPool(), 'SELECT 1');
    return NextResponse.json({ status: 'ok', banco: 'ok', horario: new Date().toISOString() });
  } catch {
    return NextResponse.json({ status: 'degradado', banco: 'indisponivel' }, { status: 503 });
  }
}
