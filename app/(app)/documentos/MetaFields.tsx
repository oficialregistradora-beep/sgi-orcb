import type { CategoryRow, RepoDocRow } from '@/server/modules/repository.ts';

type Dir = { users: { id: string; display_name: string; sector_name: string | null }[]; sectors: { id: string; name: string }[] };

/** Campos de metadados e de acesso do documento (criação e edição). */
export function MetaFields({ categories, dir, doc, prefix }: { categories: CategoryRow[]; dir: Dir; doc?: RepoDocRow; prefix: string }) {
  const id = (n: string) => `${prefix}-${n}`;
  return (
    <>
      <div className="form-grid">
        <div className="field"><label htmlFor={id('cat')}>Categoria</label>
          <select id={id('cat')} name="categoryId" className="input" required defaultValue={doc?.category_id ?? ''}>
            <option value="" disabled>Selecione…</option>
            {categories.filter((c) => c.active || c.id === doc?.category_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor={id('title')}>Título</label><input id={id('title')} name="title" className="input" required minLength={3} maxLength={200} defaultValue={doc?.title} /></div>
        <div className="field"><label htmlFor={id('code')}>Código (opcional)</label><input id={id('code')} name="code" className="input mono" placeholder="POP-RI-001" defaultValue={doc?.code ?? ''} /></div>
        <div className="field"><label htmlFor={id('sector')}>Setor responsável</label>
          <select id={id('sector')} name="sectorId" className="input" required defaultValue={doc?.sector_id ?? ''}>
            <option value="" disabled>Selecione…</option>
            {dir.sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor={id('resp')}>Responsável</label>
          <select id={id('resp')} name="responsibleUserId" className="input" defaultValue={doc?.responsible_user_id ?? ''}>
            {doc ? null : <option value="">Eu mesmo(a)</option>}
            {dir.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor={id('rev')}>Revisão periódica (meses)</label>
          <input id={id('rev')} name="reviewMonths" type="number" min={1} max={120} className="input" placeholder="padrão da categoria" defaultValue={doc?.review_months ?? ''} />
        </div>
      </div>
      <div className="field" style={{ marginTop: 12 }}><label htmlFor={id('sum')}>Resumo</label><input id={id('sum')} name="summary" className="input" maxLength={1000} defaultValue={doc?.summary ?? ''} /></div>
      <fieldset className="stack" style={{ marginTop: 12, gap: 8 }}>
        <legend className="label">Acesso</legend>
        <div className="form-grid">
          <div className="field"><label htmlFor={id('conf')}>Confidencialidade</label>
            <select id={id('conf')} name="confidentiality" className="input" defaultValue={doc?.confidentiality ?? ''}>
              {doc ? null : <option value="">Padrão da categoria</option>}
              <option value="INTERNO">Interno — pode ser destinado a todos</option>
              <option value="RESTRITO">Restrito — setores ou pessoas indicadas</option>
              <option value="CONFIDENCIAL">Confidencial — somente pessoas indicadas</option>
            </select>
          </div>
          <div className="field"><label htmlFor={id('aud')}>Público destinatário</label>
            <select id={id('aud')} name="audienceType" className="input" defaultValue={doc?.audience_type ?? 'TODOS'}>
              <option value="TODOS">Todos os usuários</option>
              <option value="SETORES">Setores selecionados</option>
              <option value="USUARIOS">Pessoas selecionadas</option>
            </select>
          </div>
          <label className="check" style={{ alignSelf: 'end' }}>
            <input type="checkbox" name="requiresAcknowledgement" defaultChecked={doc?.requires_acknowledgement ?? false} /> Exigir ciência do público
          </label>
        </div>
        <details className="disclosure small" open={doc?.audience_type === 'SETORES'}>
          <summary><a>Setores destinatários</a></summary>
          <div className="row">{dir.sectors.map((s) => (
            <label key={s.id} className="check"><input type="checkbox" name="audienceSectorIds" value={s.id} defaultChecked={doc?.aud_sectors.includes(s.id)} /> {s.name}</label>
          ))}</div>
        </details>
        <details className="disclosure small" open={doc?.audience_type === 'USUARIOS'}>
          <summary><a>Pessoas destinatárias</a></summary>
          <div className="row">{dir.users.map((u) => (
            <label key={u.id} className="check"><input type="checkbox" name="audienceUserIds" value={u.id} defaultChecked={doc?.aud_users.includes(u.id)} /> {u.display_name}{u.sector_name ? <span className="muted"> · {u.sector_name}</span> : null}</label>
          ))}</div>
        </details>
      </fieldset>
    </>
  );
}
