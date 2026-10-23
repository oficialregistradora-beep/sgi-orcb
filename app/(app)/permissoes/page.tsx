import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { ForbiddenError } from '@/server/errors.ts';
import { getConfig } from '@/server/config.ts';
import { listPermissionsAndRoles, listSectors, listUserRoles, listUsers } from '@/server/modules/admin.ts';
import { todayLocal } from '@/domain/time.ts';
import { fmtDate, fmtDateTime, label, statusTone } from '@/ui/format.ts';
import { PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import {
  assignRoleAction, createRoleAction, createUserAction, resetMfaAction, revokeRoleAction, rolePermissionAction, userStatusAction,
} from '../../actions/admin.ts';

import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Usuários e permissões' };

async function PermissoesPage({ searchParams }: { searchParams: Promise<{ aba?: string; usuario?: string }> }) {
  const ctx = await requirePageCtx();
  if (!can(ctx.principal, 'permissoes.gerenciar') && !can(ctx.principal, 'usuarios.gerenciar')) throw new ForbiddenError();
  const sp = await searchParams;
  const tab = sp.aba === 'matriz' ? 'matriz' : 'usuarios';
  const [users, { permissions, roles }, sectors] = await Promise.all([listUsers(ctx), listPermissionsAndRoles(ctx), listSectors()]);
  const selected = sp.usuario ? users.find((u) => u.id === sp.usuario) ?? null : null;
  const userRoles = selected ? await listUserRoles(ctx, selected.id) : [];
  const canPerm = can(ctx.principal, 'permissoes.gerenciar');
  const canUsers = can(ctx.principal, 'usuarios.gerenciar');
  const modules = [...new Set(permissions.map((p) => p.module))];

  return (
    <div className="stack">
      <PageHead title="Usuários e permissões" subtitle="Controle de acesso por papel, escopo (próprio, setor, todos) e vigência. Alterações exigem reautenticação e são auditadas." />
      <nav className="tabs">
        <Link href="/permissoes" aria-current={tab === 'usuarios' ? 'page' : undefined}>Usuários</Link>
        <Link href="/permissoes?aba=matriz" aria-current={tab === 'matriz' ? 'page' : undefined}>Matriz de permissões</Link>
      </nav>

      {tab === 'usuarios' ? (
        <div className="grid grid-2">
          <div className="card">
            <div className="card-head"><h2>Usuários</h2><p>{users.length} cadastrado(s)</p></div>
            <div className="card-body flush table-wrap" tabIndex={0}>
              <table className="table"><thead><tr><th>Usuário</th><th>MFA</th><th>Último acesso</th><th>Situação</th></tr></thead>
                <tbody>{users.map((u) => (
                  <tr key={u.id} className={selected?.id === u.id ? 'row-muted' : undefined}>
                    <td><Link href={`/permissoes?usuario=${u.id}`}>{u.display_name}</Link>{u.is_owner ? <span className="tag tag-info" style={{ marginLeft: 6 }}>Oficial</span> : null}<div className="small muted">{u.email}</div></td>
                    <td>{u.mfa_enabled ? <span className="tag tag-ok">Ativo</span> : <span className="tag tag-warn">Pendente</span>}</td>
                    <td className="small">{fmtDateTime(u.last_login_at)}</td>
                    <td><span className={statusTone(u.status)}>{label(u.status)}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            {canUsers ? (
              <div className="card-foot">
                <ActionForm action={createUserAction} submitLabel="Criar usuário" resetOnSuccess>
                  <div className="form-grid">
                    <div className="field"><label htmlFor="nu-e">E-mail institucional</label><input id="nu-e" name="email" type="email" className="input" placeholder={`nome@${getConfig().workspaceDomain}`} required /></div>
                    <div className="field"><label htmlFor="nu-n">Nome de exibição</label><input id="nu-n" name="displayName" className="input" required /></div>
                  </div>
                  <p className="small muted" style={{ marginTop: 8 }}>Para funcionários, prefira a admissão em Equipe, que já vincula o cadastro funcional.</p>
                </ActionForm>
              </div>
            ) : null}
          </div>

          {selected ? (
            <div className="card">
              <div className="card-head"><div><h2>{selected.display_name}</h2><p>{selected.email}{selected.employee_name ? ` · funcionário: ${selected.employee_name}` : ''}</p></div></div>
              <div className="card-body stack">
                <div>
                  <h3>Papéis atribuídos</h3>
                  <table className="table"><thead><tr><th>Papel</th><th>Setor coordenado</th><th>Vigência</th><th></th></tr></thead>
                    <tbody>{userRoles.map((r) => (
                      <tr key={r.id} className={r.revoked_at ? 'row-muted' : undefined}>
                        <td>{r.role_name}<div className="small muted">{r.reason}</div></td>
                        <td className="small">{r.sector_name ?? 'setor de lotação'}</td>
                        <td className="small">{fmtDate(r.valid_from)} – {r.valid_until ? fmtDate(r.valid_until) : 'sem termo'}{r.revoked_at ? ` · revogado em ${fmtDateTime(r.revoked_at)}` : ''}</td>
                        <td>{!r.revoked_at && canPerm ? (
                          <ActionForm action={revokeRoleAction} submitLabel="Revogar" submitClass="btn btn-sm btn-danger" inline>
                            <input type="hidden" name="userRoleId" value={r.id} />
                            <input name="reason" className="input" placeholder="Motivo" aria-label="Motivo" required minLength={5} />
                          </ActionForm>
                        ) : null}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                {canPerm && !selected.is_owner ? (
                  <ActionForm action={assignRoleAction} submitLabel="Atribuir papel" resetOnSuccess>
                    <input type="hidden" name="userId" value={selected.id} />
                    <div className="form-grid">
                      <div className="field"><label htmlFor="ar-r">Papel</label><select id="ar-r" name="roleId" className="input">{roles.filter((r) => r.code !== 'OFICIAL').map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
                      <div className="field"><label htmlFor="ar-s">Setor coordenado</label><select id="ar-s" name="sectorId" className="input"><option value="">Setor de lotação</option>{sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
                      <div className="field"><label htmlFor="ar-f">De</label><input id="ar-f" name="validFrom" type="date" className="input" defaultValue={todayLocal()} required /></div>
                      <div className="field"><label htmlFor="ar-u">Até (substituição temporária)</label><input id="ar-u" name="validUntil" type="date" className="input" /></div>
                    </div>
                    <div className="field" style={{ marginTop: 12 }}><label htmlFor="ar-m">Motivo / fundamento</label><input id="ar-m" name="reason" className="input" required minLength={5} /></div>
                  </ActionForm>
                ) : null}
                {canUsers && !selected.is_owner && selected.id !== ctx.principal.userId ? (
                  <div className="grid grid-2">
                    <ActionForm action={userStatusAction} submitLabel="Alterar situação" submitClass="btn btn-danger" confirm="Confirma a alteração de acesso? Sessões serão encerradas imediatamente.">
                      <input type="hidden" name="userId" value={selected.id} />
                      <div className="field"><label htmlFor="us-s">Situação</label><select id="us-s" name="status" className="input" defaultValue={selected.status}><option value="ATIVO">Ativo</option><option value="SUSPENSO">Suspenso</option><option value="REVOGADO">Revogado</option></select></div>
                      <div className="field" style={{ marginTop: 8 }}><label htmlFor="us-r">Motivo</label><input id="us-r" name="reason" className="input" required minLength={5} /></div>
                    </ActionForm>
                    <ActionForm action={resetMfaAction} submitLabel="Redefinir autenticador" submitClass="btn" confirm="Redefinir o autenticador deste usuário?">
                      <input type="hidden" name="userId" value={selected.id} />
                      <div className="field"><label htmlFor="rm-r">Motivo (ex.: troca de celular)</label><input id="rm-r" name="reason" className="input" required minLength={5} /></div>
                    </ActionForm>
                  </div>
                ) : null}
              </div>
            </div>
          ) : <div className="card"><div className="card-body muted small">Selecione um usuário para ver e alterar papéis e acesso.</div></div>}
        </div>
      ) : (
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Matriz de permissões por papel</h2><p>A Oficial Registradora possui todas as permissões e seu papel não é editável</p></div>
            <div className="card-body flush table-wrap" tabIndex={0}>
              <table className="table">
                <thead><tr><th>Permissão</th>{roles.map((r) => <th key={r.id}>{r.name}</th>)}</tr></thead>
                <tbody>
                  {modules.map((m) => [
                    <tr key={m}><td colSpan={roles.length + 1} className="small" style={{ fontWeight: 600, background: 'var(--surface-2)' }}>{m}</td></tr>,
                    ...permissions.filter((p) => p.module === m).map((p) => (
                      <tr key={p.code}>
                        <td className="small">{p.description}{p.sensitive ? <span className="tag tag-warn" style={{ marginLeft: 6 }}>sensível</span> : null}<div className="mono muted">{p.code}</div></td>
                        {roles.map((r) => (
                          <td key={r.id}>
                            {canPerm && r.code !== 'OFICIAL' ? (
                              <ActionForm action={rolePermissionAction} submitLabel="OK" submitClass="btn btn-sm" inline>
                                <input type="hidden" name="roleId" value={r.id} />
                                <input type="hidden" name="permissionCode" value={p.code} />
                                <select name="scope" className="input" defaultValue={r.permissions[p.code] ?? ''} aria-label={`${r.name}: ${p.code}`} style={{ width: 96 }}>
                                  <option value="">—</option>
                                  {(p.scopable ? ['PROPRIO', 'SETOR', 'TODOS'] : ['TODOS']).map((s) => <option key={s} value={s}>{label(s)}</option>)}
                                </select>
                              </ActionForm>
                            ) : <span className="small">{r.permissions[p.code] ? label(r.permissions[p.code]) : '—'}</span>}
                          </td>
                        ))}
                      </tr>
                    )),
                  ])}
                </tbody>
              </table>
            </div>
          </div>
          {canPerm ? (
            <div className="card">
              <div className="card-head"><h2>Novo papel</h2></div>
              <div className="card-body">
                <ActionForm action={createRoleAction} submitLabel="Criar papel" resetOnSuccess>
                  <div className="form-grid">
                    <div className="field"><label htmlFor="rl-c">Código</label><input id="rl-c" name="code" className="input" placeholder="ESCREVENTE_RI" required /></div>
                    <div className="field"><label htmlFor="rl-n">Nome</label><input id="rl-n" name="name" className="input" required /></div>
                    <div className="field"><label htmlFor="rl-d">Descrição</label><input id="rl-d" name="description" className="input" /></div>
                  </div>
                </ActionForm>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default withGuard(PermissoesPage);
