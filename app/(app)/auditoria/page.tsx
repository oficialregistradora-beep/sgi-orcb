import { requirePageCtx } from '@/server/web/session.ts';
import { listAudit } from '@/server/modules/dashboard.ts';
import { fmtDateTime } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { verifyAuditAction } from '../../actions/admin.ts';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Auditoria' };

async function AuditoriaPage({ searchParams }: { searchParams: Promise<{ q?: string; antes?: string }> }) {
  const ctx = await requirePageCtx();
  const sp = await searchParams;
  const rows = await listAudit(ctx, { q: sp.q, before: sp.antes ? Number(sp.antes) : undefined, limit: 100 });
  const last = rows.at(-1);
  return (
    <div className="stack">
      <PageHead
        title="Trilha de auditoria"
        subtitle="Registros imutáveis encadeados por hash SHA-256: qualquer alteração posterior é detectável."
        actions={<ActionForm action={verifyAuditAction} submitLabel="Verificar integridade da cadeia" submitClass="btn" inline>{null}</ActionForm>}
      />
      <form className="row" method="get">
        <input name="q" className="input" placeholder="Buscar no resumo ou identificador" defaultValue={sp.q ?? ''} style={{ maxWidth: 360 }} aria-label="Buscar" />
        <button className="btn" type="submit">Buscar</button>
      </form>
      <div className="card">
        <div className="card-body flush table-wrap" tabIndex={0}>
          {rows.length ? (
            <table className="table">
              <thead><tr><th>#</th><th>Data/hora</th><th>Autor</th><th>Ação</th><th>Resumo</th><th>IP</th><th>Hash</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.id}</td>
                  <td className="small nowrap">{fmtDateTime(r.occurred_at)}</td>
                  <td className="small">{r.actor_name ?? 'Sistema'}</td>
                  <td className="mono small">{r.action}</td>
                  <td className="small">{r.summary}</td>
                  <td className="mono small">{r.ip ?? '—'}</td>
                  <td className="mono small" title={r.hash}>{r.hash.slice(0, 10)}…</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <Empty>Nenhum registro.</Empty>}
        </div>
        {last && rows.length === 100 ? (
          <div className="card-foot"><a className="btn btn-sm" href={`/auditoria?antes=${last.id}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ''}`}>Registros anteriores</a></div>
        ) : null}
      </div>
    </div>
  );
}

export default withGuard(AuditoriaPage);
