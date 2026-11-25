import type { Ctx } from '@/server/context.ts';
import { listCategories, listDelegations } from '@/server/modules/repository.ts';
import { fmtDate, fmtDateTime } from '@/ui/format.ts';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { todayLocal } from '@/domain/time.ts';
import { delegationAction } from '../../actions/phase3.ts';

/** Configurações → Gestão documental: autorização temporária da Substituta Legal para aprovar (só a Oficial edita). */
export async function GestaoDocumental({ ctx }: { ctx: Ctx }) {
  const [rows, categories] = await Promise.all([listDelegations(), listCategories()]);
  const owner = ctx.principal.isOwner;
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  return (
    <div className="stack">
      <div className="alert alert-info small"><div>
        Aprovar documentos e projetos é exclusivo da <strong>Oficial Registradora</strong>, inclusive o que ela mesma elaborou (registrado como autoaprovação).
        A <strong>Substituta Legal</strong> aprova somente enquanto houver autorização vigente abaixo — por exemplo, nas férias ou afastamentos da Oficial.
        Ao fim do prazo, ou ao revogar, a permissão volta a “—” sozinha. A Substituta não aprova o que ela mesma elaborou.
      </div></div>
      <div className="card">
        <div className="card-head"><h2>Autorizações da Substituta Legal</h2><p>Cada concessão e revogação fica na Auditoria.</p></div>
        <div className="card-body flush table-wrap" tabIndex={0}>
          <table className="table"><thead><tr><th>Período</th><th>Alcance</th><th>Motivo</th><th>Situação</th><th></th></tr></thead>
            <tbody>{rows.map((d) => (
              <tr key={d.id}>
                <td className="small nowrap">{fmtDate(d.starts_on)} a {d.ends_on ? fmtDate(d.ends_on) : 'revogação'}</td>
                <td className="small">{[d.documents && 'Documentos', d.projects && 'Projetos'].filter(Boolean).join(' e ')}
                  {d.documents ? <div className="muted">{d.category_ids ? d.category_ids.map((c) => catName.get(c) ?? '—').join(', ') : 'todas as categorias'}</div> : null}</td>
                <td className="small">{d.reason}</td>
                <td>{d.revoked_at ? <span className="tag">Revogada {fmtDateTime(d.revoked_at)}</span> : d.active ? <span className="tag tag-ok">Vigente</span> : <span className="tag">Fora do prazo</span>}</td>
                <td>{owner && !d.revoked_at ? (
                  <ActionForm action={delegationAction} submitLabel="Revogar" submitClass="btn btn-sm btn-danger" inline confirm="Revogar a autorização agora?">
                    <input type="hidden" name="op" value="revogar" /><input type="hidden" name="id" value={d.id} />
                  </ActionForm>) : null}</td>
              </tr>
            ))}</tbody>
          </table>
          {rows.length ? null : <p className="small muted" style={{ padding: 12 }}>Nenhuma autorização concedida: somente a Oficial aprova.</p>}
        </div>
      </div>
      {owner ? (
        <div className="card">
          <div className="card-head"><h2>Autorizar a Substituta Legal a aprovar</h2></div>
          <div className="card-body">
            <ActionForm action={delegationAction} submitLabel="Autorizar" resetOnSuccess confirm="A Substituta Legal poderá aprovar no período indicado. Confirma?">
              <input type="hidden" name="op" value="conceder" />
              <div className="form-grid">
                <div className="field"><label htmlFor="dl-s">Início</label><input id="dl-s" name="startsOn" type="date" className="input" required defaultValue={todayLocal()} /></div>
                <div className="field"><label htmlFor="dl-e">Fim (opcional)</label><input id="dl-e" name="endsOn" type="date" className="input" /></div>
                <div className="field"><label htmlFor="dl-r">Motivo</label><input id="dl-r" name="reason" className="input" required minLength={5} placeholder="ex.: férias da Oficial" /></div>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <label className="check"><input type="checkbox" name="documents" defaultChecked /> Documentos</label>
                <label className="check"><input type="checkbox" name="projects" defaultChecked /> Projetos</label>
              </div>
              <details className="disclosure small" style={{ marginTop: 8 }}>
                <summary><a>Só algumas categorias de documento (em branco = todas)</a></summary>
                <div className="row">{categories.filter((c) => c.active).map((c) => (
                  <label key={c.id} className="check"><input type="checkbox" name="categoryIds" value={c.id} /> {c.name}</label>
                ))}</div>
              </details>
            </ActionForm>
          </div>
        </div>
      ) : <p className="small muted">Somente a Oficial concede ou revoga a autorização.</p>}
    </div>
  );
}
