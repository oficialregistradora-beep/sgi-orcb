import type { Ctx } from '@/server/context.ts';
import { getNetworkConfig } from '@/server/modules/network.ts';
import { directory } from '@/server/modules/directory.ts';
import { fmtDateTime } from '@/ui/format.ts';
import { Empty } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { networkAction } from '../../actions/network.ts';

/** Configurações → Rede: restrição de uso à rede da serventia, exceções e bloqueios recentes. */
export async function Rede({ ctx }: { ctx: Ctx }) {
  const [c, dir] = await Promise.all([getNetworkConfig(ctx), directory(ctx)]);
  const inside = c.ips.length > 0;
  return (
    <div className="stack">
      <div className={`alert ${c.active ? 'alert-info' : 'alert-warn'} small`}>
        Restrição <strong>{c.active ? 'ATIVA' : 'desativada'}</strong>. Seu endereço de internet agora: <strong className="mono">{c.currentIp ?? 'desconhecido'}</strong>.
        {' '}A Oficial nunca é bloqueada. Têm acesso externo pela permissão: {c.external.length ? c.external.map((x) => x.display_name).join(', ') : 'ninguém'}.
      </div>
      <div className="card"><div className="card-head"><h2>Endereços da serventia</h2><p>Um por linha: o IP fixo da internet do cartório (e o da conexão reserva, se houver). Peça o IP fixo ao provedor.</p></div><div className="card-body">
        <ActionForm action={networkAction} submitLabel="Salvar">
          <input type="hidden" name="op" value="config" />
          <div className="field"><label>Endereços permitidos<textarea name="ips" className="input mono" rows={4} defaultValue={c.ips.join('\n')} placeholder={c.currentIp ?? '200.100.50.25'} /></label></div>
          <div className="form-grid">
            <label className="check"><input type="checkbox" name="active" defaultChecked={c.active} /> Restringir o uso do sistema a estes endereços</label>
            <label className="check"><input type="checkbox" name="punchInternal" defaultChecked={c.punchInternal} /> Marcação de ponto somente na rede da serventia</label>
            <div className="field"><label>Plantão: acesso externo antes e depois (minutos)<input name="oncallSlack" type="number" min={0} max={240} className="input" defaultValue={c.oncallSlack} /></label></div>
          </div>
          {!inside ? <p className="small muted">Dica: estando no cartório, use o endereço mostrado acima.</p> : null}
        </ActionForm>
      </div></div>
      <div className="grid grid-2">
        <div className="card"><div className="card-head"><h2>Liberações temporárias</h2><p>Acesso de fora por até 31 dias, com motivo. Plantonistas do RCPN são liberados automaticamente no horário do plantão.</p></div>
          <div className="card-body flush table-wrap" tabIndex={0}>{c.exceptions.length ? <table className="table"><tbody>{c.exceptions.map((x) => (
            <tr key={x.id}><td>{x.user_name}<div className="small muted">{x.reason}</div></td><td className="small nowrap">até {fmtDateTime(x.valid_until)}<div className="muted">por {x.created_by_name}</div></td>
              <td><ActionForm action={networkAction} submitLabel="Revogar" submitClass="btn btn-sm" inline><input type="hidden" name="op" value="revogar" /><input type="hidden" name="id" value={x.id} /></ActionForm></td></tr>
          ))}</tbody></table> : <Empty>Nenhuma liberação vigente.</Empty>}</div>
          <div className="card-body"><ActionForm action={networkAction} submitLabel="Liberar" resetOnSuccess>
            <input type="hidden" name="op" value="liberar" />
            <div className="form-grid">
              <div className="field"><label>Pessoa<select name="userId" className="input" required>{dir.users.filter((u) => u.id !== ctx.principal.userId).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label></div>
              <div className="field"><label>Até<input name="validUntil" type="datetime-local" className="input" required /></label></div>
            </div>
            <div className="field"><label>Motivo<input name="reason" className="input" required minLength={5} /></label></div>
          </ActionForm></div>
        </div>
        <div className="card"><div className="card-head"><h2>Acessos recusados recentes</h2></div><div className="card-body flush table-wrap" tabIndex={0}>
          {c.blocks.length ? <table className="table"><tbody>{c.blocks.map((b, i) => <tr key={i}><td className="small nowrap">{fmtDateTime(b.created_at)}</td><td className="small">{b.user_name ?? '—'}</td><td className="small">{b.summary}</td></tr>)}</tbody></table> : <Empty>Nenhum.</Empty>}
        </div></div>
      </div>
    </div>
  );
}
