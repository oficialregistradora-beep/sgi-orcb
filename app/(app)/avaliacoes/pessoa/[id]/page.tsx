import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { getPool, queryOne } from '@/server/db.ts';
import { NotFoundError } from '@/server/errors.ts';
import { developmentHistory } from '@/server/modules/evaluations.ts';
import { todayLocal } from '@/domain/time.ts';
import { fmtDateTime } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { EvalTable, PdiList } from '@/ui/development.tsx';
import { evaluationAction } from '../../../../actions/phase5b.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Histórico de desenvolvimento' };

export default async function PessoaPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageCtx();
  const { id } = await params;
  const h = await developmentHistory(ctx, id);
  const e = await queryOne<{ full_name: string }>(getPool(), 'SELECT full_name FROM employees WHERE id = $1', [id]);
  if (!e) throw new NotFoundError('Funcionário não encontrado.');
  const own = ctx.principal.employeeId === id;
  return (
    <div className="stack">
      <PageHead title={`Histórico de desenvolvimento — ${e.full_name}`} actions={<Link className="btn" href="/avaliacoes?aba=equipe">Voltar</Link>} />
      <div className="card"><div className="card-head"><h2>Avaliações</h2></div><div className="card-body flush table-wrap">
        {h.evaluations.length ? <EvalTable rows={h.evaluations} today={todayLocal()} /> : <Empty>Nenhuma avaliação.</Empty>}</div></div>
      <div className="card"><div className="card-head"><h2>PDI</h2></div><div className="card-body flush table-wrap"><PdiList items={h.pdi} action={evaluationAction} canProgress={own} canClose={!own} /></div></div>
      <div className="card"><div className="card-head"><h2>Feedbacks</h2></div><div className="card-body flush table-wrap">
        {h.feedbacks.length ? <table className="table"><tbody>{h.feedbacks.map((f) => <tr key={f.id}><td className="small nowrap">{fmtDateTime(f.created_at)}<div className="muted">{f.author_name}</div></td>
          <td style={{ whiteSpace: 'pre-wrap' }}>{f.content}{f.employee_comment ? <div className="small muted">Comentário do avaliado: {f.employee_comment}</div> : null}</td>
          <td>{f.acknowledged_at ? <span className="tag tag-ok">Ciente</span> : <span className="tag tag-warn">Ciência pendente</span>}</td></tr>)}</tbody></table> : <Empty>Nenhum feedback.</Empty>}
      </div></div>
    </div>
  );
}
