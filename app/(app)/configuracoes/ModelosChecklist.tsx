import Link from 'next/link';
import type { Ctx } from '@/server/context.ts';
import { can } from '@/server/authz.ts';
import { AUTO_CODES, getTemplate, listRoleNames, listTemplates } from '@/server/modules/checklistTemplates.ts';
import { fmtDateTime, label, statusTone } from '@/ui/format.ts';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { templateAction, templateItemAction } from '../../actions/phase2c.ts';

export async function ModelosChecklist({ ctx, modelo }: { ctx: Ctx; modelo?: string }) {
  const templates = await listTemplates(ctx);
  const selected = modelo ? await getTemplate(ctx, modelo) : null;
  const canEdit = can(ctx.principal, 'checklists.modelos.editar');
  const canPublish = can(ctx.principal, 'checklists.modelos.publicar');
  const roles = canEdit ? await listRoleNames() : [];
  const draft = selected?.template.status === 'RASCUNHO';
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h2>Modelos de checklist</h2><p>Publicar substitui a versão anterior; checklists já iniciados mantêm a versão usada</p></div>
        <div className="card-body flush table-wrap" tabIndex={0}>
          <table className="table">
            <thead><tr><th>Modelo</th><th>Tipo</th><th>Versão</th><th>Situação</th><th className="num">Itens</th><th className="num">Em uso</th><th>Publicação</th></tr></thead>
            <tbody>{templates.map((t) => (
              <tr key={t.id} className={t.status === 'INATIVO' ? 'row-muted' : undefined}>
                <td><Link href={`/configuracoes?aba=checklists&modelo=${t.id}`}>{t.name}</Link></td>
                <td>{label(t.kind)}</td><td>v{t.version}</td>
                <td><span className={statusTone(t.status)}>{label(t.status)}</span></td>
                <td className="num">{t.items}</td><td className="num">{t.in_use}</td>
                <td className="small muted">{t.published_at ? `${t.published_by_name ?? 'carga inicial'} · ${fmtDateTime(t.published_at)}` : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {canEdit ? (
          <div className="card-foot">
            <ActionForm action={templateAction} submitLabel="Criar modelo" inline resetOnSuccess>
              <input type="hidden" name="op" value="criar" />
              <select name="kind" className="input" aria-label="Tipo" style={{ width: 160 }}><option value="ADMISSAO">Admissão</option><option value="DESLIGAMENTO">Desligamento</option><option value="OUTRO">Outro</option></select>
              <input name="name" className="input" placeholder="Nome do modelo" aria-label="Nome" required minLength={3} style={{ width: 260 }} />
            </ActionForm>
          </div>
        ) : null}
      </div>

      {selected ? (
        <div className="card">
          <div className="card-head">
            <div><h2>{selected.template.name} — v{selected.template.version}</h2><p>{label(selected.template.kind)}</p></div>
            <span className={statusTone(selected.template.status)}>{label(selected.template.status)}</span>
          </div>
          <div className="card-body stack">
            <div className="row">
              {canEdit && !draft && selected.template.status !== 'INATIVO' ? (
                <ActionForm action={templateAction} submitLabel="Editar (nova versão)" submitClass="btn btn-sm" inline>
                  <input type="hidden" name="op" value="nova_versao" /><input type="hidden" name="templateId" value={selected.template.id} />
                </ActionForm>
              ) : null}
              {canEdit ? (
                <ActionForm action={templateAction} submitLabel="Duplicar" submitClass="btn btn-sm" inline>
                  <input type="hidden" name="op" value="duplicar" /><input type="hidden" name="templateId" value={selected.template.id} />
                  <input name="name" className="input" placeholder="Nome da cópia" aria-label="Nome da cópia" required minLength={3} style={{ width: 200 }} />
                </ActionForm>
              ) : null}
              {draft && canPublish ? (
                <ActionForm action={templateAction} submitLabel="Publicar" submitClass="btn btn-sm btn-primary" inline confirm="Publicar esta versão? A versão anterior será inativada para novos checklists.">
                  <input type="hidden" name="op" value="publicar" /><input type="hidden" name="templateId" value={selected.template.id} />
                </ActionForm>
              ) : null}
              {draft && canEdit ? (
                <ActionForm action={templateAction} submitLabel="Descartar rascunho" submitClass="btn btn-sm btn-danger" inline confirm="Descartar o rascunho?">
                  <input type="hidden" name="op" value="descartar" /><input type="hidden" name="templateId" value={selected.template.id} />
                </ActionForm>
              ) : null}
              {selected.template.status === 'PUBLICADO' && canPublish ? (
                <ActionForm action={templateAction} submitLabel="Inativar" submitClass="btn btn-sm btn-danger" inline confirm="Inativar este modelo? Novas admissões/desligamentos ficarão sem checklist deste tipo, se não houver outro publicado.">
                  <input type="hidden" name="op" value="inativar" /><input type="hidden" name="templateId" value={selected.template.id} />
                </ActionForm>
              ) : null}
            </div>
            {draft ? <p className="small muted">Rascunho: alterações não afetam checklists existentes até a publicação.</p> : <p className="small muted">Versão {label(selected.template.status).toLowerCase()} — somente leitura. Para alterar, crie nova versão.</p>}
            <div className="table-wrap" tabIndex={0}>
              <table className="table">
                <thead><tr><th>#</th><th>Item</th><th>Prazo</th><th>Exigências</th><th>Responsável</th>{draft ? <th></th> : null}</tr></thead>
                <tbody>{selected.items.map((it) => (
                  <tr key={it.id}>
                    <td>{it.position}</td>
                    <td className="small"><strong>{it.title}</strong>{it.description ? <div className="muted">{it.description}</div> : null}{it.auto_code ? <div className="muted">Verificação automática: {AUTO_CODES[it.auto_code as keyof typeof AUTO_CODES]}</div> : null}</td>
                    <td className="small nowrap">{it.due_offset_days >= 0 ? `+${it.due_offset_days}` : it.due_offset_days} dia(s)</td>
                    <td className="small">{it.required ? <span className="tag tag-warn">obrigatório</span> : null} {it.evidence_required ? <span className="tag tag-info">evidência</span> : null}</td>
                    <td className="small">{it.responsible_role_name ?? '—'}</td>
                    {draft ? (
                      <td style={{ minWidth: 260 }}>
                        <div className="row">
                          {(['subir', 'descer'] as const).map((op) => (
                            <ActionForm key={op} action={templateItemAction} submitLabel={op === 'subir' ? '↑' : '↓'} submitClass="btn btn-sm btn-ghost" inline>
                              <input type="hidden" name="op" value={op} /><input type="hidden" name="templateId" value={selected.template.id} /><input type="hidden" name="itemId" value={it.id} />
                            </ActionForm>
                          ))}
                          <ActionForm action={templateItemAction} submitLabel="Remover" submitClass="btn btn-sm btn-ghost" inline>
                            <input type="hidden" name="op" value="remover" /><input type="hidden" name="templateId" value={selected.template.id} /><input type="hidden" name="itemId" value={it.id} />
                          </ActionForm>
                        </div>
                        <details className="disclosure small"><summary><a>Editar</a></summary>
                          <ItemForm templateId={selected.template.id} item={it} roles={roles} />
                        </details>
                      </td>
                    ) : null}
                  </tr>
                ))}</tbody>
              </table>
            </div>
            {draft ? (
              <div className="card"><div className="card-head"><h3>Adicionar item</h3></div><div className="card-body">
                <ItemForm templateId={selected.template.id} roles={roles} />
              </div></div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ItemForm({ templateId, item, roles }: {
  templateId: string;
  item?: { id: string; title: string; description: string | null; due_offset_days: number; required: boolean; evidence_required: boolean; responsible_role_id: string | null; auto_code: string | null };
  roles: { id: string; name: string }[];
}) {
  return (
    <ActionForm action={templateItemAction} submitLabel={item ? 'Salvar item' : 'Adicionar'} resetOnSuccess={!item}>
      <input type="hidden" name="op" value="salvar" /><input type="hidden" name="templateId" value={templateId} />
      {item ? <input type="hidden" name="itemId" value={item.id} /> : null}
      <div className="form-grid">
        <div className="field"><span className="label">Título</span><input name="title" aria-label="Título" className="input" required minLength={3} defaultValue={item?.title} /></div>
        <div className="field"><span className="label">Prazo (dias após o evento)</span><input name="dueOffsetDays" type="number" className="input" defaultValue={item?.due_offset_days ?? 0} /></div>
        <div className="field"><span className="label">Responsável (papel)</span>
          <select name="responsibleRoleId" aria-label="Responsável (papel)" className="input" defaultValue={item?.responsible_role_id ?? ''}><option value="">—</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        </div>
        <div className="field"><span className="label">Verificação automática</span>
          <select name="autoCode" aria-label="Verificação automática" className="input" defaultValue={item?.auto_code ?? ''}><option value="">Nenhuma</option>{Object.entries(AUTO_CODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </div>
      </div>
      <div className="field" style={{ marginTop: 8 }}><span className="label">Descrição</span><input name="description" aria-label="Descrição" className="input" defaultValue={item?.description ?? ''} /></div>
      <div className="row" style={{ marginTop: 8 }}>
        <label className="check"><input type="checkbox" name="required" defaultChecked={item?.required} /> Obrigatório (não admite "não se aplica")</label>
        <label className="check"><input type="checkbox" name="evidenceRequired" defaultChecked={item?.evidence_required} /> Exige evidência</label>
      </div>
    </ActionForm>
  );
}
