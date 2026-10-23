import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { listEmployees } from '@/server/modules/people.ts';
import { fmtDate, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Equipe' };

async function EquipePage({ searchParams }: { searchParams: Promise<{ todos?: string }> }) {
  const ctx = await requirePageCtx();
  const { todos } = await searchParams;
  const rows = await listEmployees(ctx, { includeTerminated: todos === '1' });
  return (
    <div className="stack">
      <PageHead
        title="Equipe"
        subtitle={`${rows.length} cadastro(s) visível(is) conforme suas permissões.`}
        actions={<>
          <Link className="btn btn-sm" href={todos === '1' ? '/equipe' : '/equipe?todos=1'}>{todos === '1' ? 'Ocultar desligados' : 'Incluir desligados'}</Link>
          {can(ctx.principal, 'pessoas.editar') ? <Link className="btn btn-primary btn-sm" href="/equipe/novo">Admitir funcionário</Link> : null}
        </>}
      />
      <div className="card">
        <div className="card-body flush table-wrap" tabIndex={0}>
          {rows.length ? (
            <table className="table">
              <thead><tr><th>Nome</th><th>Matrícula</th><th>Cargo</th><th>Setor</th><th>Admissão</th><th>Acesso</th><th>Situação</th></tr></thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td><Link href={`/equipe/${e.id}`}>{e.social_name || e.full_name}</Link>{e.email ? <div className="small muted">{e.email}</div> : null}</td>
                    <td className="mono">{e.registration_code}</td>
                    <td>{e.job_title}</td>
                    <td className="small">{e.sector_name}</td>
                    <td className="nowrap">{fmtDate(e.admission_date)}</td>
                    <td>{e.user_status ? <span className={statusTone(e.user_status)}>{label(e.user_status)}</span> : <span className="tag">Sem usuário</span>}</td>
                    <td><span className={statusTone(e.status)}>{label(e.status)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>Nenhum funcionário.</Empty>}
        </div>
      </div>
    </div>
  );
}

export default withGuard(EquipePage);
