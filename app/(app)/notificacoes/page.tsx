import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { listMyNotifications } from '@/server/modules/notifications.ts';
import { fmtDateTime } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { markReadAction } from '../../actions/admin.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Notificações' };

export default async function NotificacoesPage() {
  const ctx = await requirePageCtx();
  const rows = await listMyNotifications(ctx, 100);
  return (
    <div className="stack">
      <PageHead title="Notificações" subtitle="Avisos internos. Envio por Google Chat e Gmail previsto na Fase 4." actions={<ActionForm action={markReadAction} submitLabel="Marcar todas como lidas" submitClass="btn btn-sm" inline>{null}</ActionForm>} />
      <div className="card">
        <div className="card-body flush">
          {rows.length ? (
            <table className="table"><tbody>{rows.map((n) => (
              <tr key={n.id} className={n.read_at ? 'row-muted' : undefined}>
                <td style={{ width: 8 }}>{n.read_at ? null : <span className="tag tag-info">nova</span>}</td>
                <td>{n.link ? <Link href={n.link}><strong>{n.title}</strong></Link> : <strong>{n.title}</strong>}{n.body ? <div className="small muted">{n.body}</div> : null}</td>
                <td className="small muted nowrap">{fmtDateTime(n.created_at)}</td>
              </tr>
            ))}</tbody></table>
          ) : <Empty>Nenhuma notificação.</Empty>}
        </div>
      </div>
    </div>
  );
}
