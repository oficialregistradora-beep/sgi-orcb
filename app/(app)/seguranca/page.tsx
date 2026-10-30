import { requirePageCtx } from '@/server/web/session.ts';
import { getPool } from '@/server/db.ts';
import { BACKUP_COUNT, mfaOptions } from '@/server/auth/mfa.ts';
import { PageHead } from '@/ui/Stat.tsx';
import { BackupCodesForm } from '@/ui/BackupCodesForm.tsx';

export const metadata = { title: 'Minha segurança' };

/** Formas de confirmar a entrada (segundo fator) da própria pessoa. */
export default async function SegurancaPage() {
  const ctx = await requirePageCtx();
  const o = await mfaOptions(getPool(), ctx.principal.userId);
  return (
    <div className="stack">
      <PageHead title="Minha segurança" subtitle="Formas de confirmar a sua entrada no sistema (segundo fator)." />
      <div className="card">
        <div className="card-head"><h2>Situação</h2></div>
        <div className="card-body">
          <table className="table">
            <tbody>
              <tr><td>Aplicativo autenticador</td><td>{o.totp ? <span className="tag tag-ok">Cadastrado</span> : <span className="tag tag-warn">Não cadastrado</span>}</td></tr>
              <tr><td>Códigos de reserva</td><td>{o.backupLeft ? <span className="tag tag-ok">{o.backupLeft} de {BACKUP_COUNT} disponíveis</span> : <span className="tag tag-warn">Nenhum</span>}</td></tr>
              <tr><td>Código por e-mail pessoal</td><td>{o.email ? <span className="tag tag-ok">Liberado ({o.email})</span> : <span className="muted small">Não liberado — só a Oficial libera, quando necessário</span>}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h2>Códigos de reserva</h2><p>Para quando o celular não estiver à mão: {BACKUP_COUNT} códigos, cada um vale uma vez.</p></div>
        <div className="card-body">
          {o.backupLeft > 0 && o.backupLeft <= 3 ? <div className="alert alert-warn small" style={{ marginBottom: 12 }}>Restam poucos códigos: gere uma lista nova.</div> : null}
          <BackupCodesForm hasCodes={o.backupLeft > 0} />
        </div>
      </div>
    </div>
  );
}
