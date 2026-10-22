import Link from 'next/link';
import { can, scopeFilter } from '@/server/authz.ts';
import { requirePageCtx } from '@/server/web/session.ts';
import { unreadCount } from '@/server/modules/notifications.ts';
import { getConfig } from '@/server/config.ts';
import { Brand } from '@/ui/Brand.tsx';
import { Nav, type NavGroup } from '@/ui/Nav.tsx';
import { initials } from '@/ui/format.ts';
import * as I from '@/ui/icons.tsx';
import { logoutAction } from '../actions/auth.ts';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePageCtx();
  const p = ctx.principal;
  const teamScope = scopeFilter(p, 'pessoas.ver');
  const groups: NavGroup[] = [
    {
      title: 'Pessoal',
      items: [
        { href: '/painel', label: 'Painel', icon: <I.IconHome /> },
        ...(p.employeeId ? [
          { href: '/jornada', label: 'Minha jornada', icon: <I.IconClock /> },
          { href: '/banco-de-horas', label: 'Banco de horas', icon: <I.IconBank /> },
          { href: '/documentos-pessoais', label: 'Meus documentos', icon: <I.IconDoc /> },
        ] : []),
        { href: '/solicitacoes', label: 'Solicitações', icon: <I.IconInbox /> },
        ...(can(p, 'documentos.ver') ? [{ href: '/documentos', label: 'Gestão documental', icon: <I.IconFolder /> }] : []),
        ...(p.employeeId || can(p, 'ferias.aprovar') ? [{ href: '/ferias', label: 'Férias', icon: <I.IconCalendar /> }] : []),
        ...(can(p, 'plantoes.ver') ? [{ href: '/plantoes', label: 'Plantões RCPN', icon: <I.IconClock /> }] : []),
      ],
    },
    {
      title: 'Gestão',
      items: [
        ...(can(p, 'banco.ocorrencias.tratar') ? [{ href: '/ocorrencias', label: 'Ocorrências', icon: <I.IconAlert /> }] : []),
        ...(teamScope && (teamScope.all || teamScope.sectorIds.length) ? [{ href: '/equipe', label: 'Equipe', icon: <I.IconUsers /> }] : []),
        ...(can(p, 'banco.ocorrencias.tratar') ? [{ href: '/relatorios', label: 'Relatórios', icon: <I.IconChart /> }] : []),
        { href: '#projetos', label: 'Tarefas e projetos', icon: <I.IconKanban />, planned: 'Fase 4' },
        { href: '#financeiro', label: 'Financeiro', icon: <I.IconWallet />, planned: 'Fase 4' },
        { href: '#qualidade', label: 'Qualidade', icon: <I.IconCheck />, planned: 'Fase 5' },
      ],
    },
    ...((can(p, 'configuracoes.gerenciar') || can(p, 'checklists.modelos.editar') || can(p, 'permissoes.gerenciar') || can(p, 'usuarios.gerenciar') || can(p, 'auditoria.ver'))
      ? [{
          title: 'Administração',
          items: [
            ...(can(p, 'configuracoes.gerenciar') ? [{ href: '/configuracoes', label: 'Configurações', icon: <I.IconSettings /> }]
              : can(p, 'checklists.modelos.editar') ? [{ href: '/configuracoes?aba=checklists', label: 'Modelos de checklist', icon: <I.IconSettings /> }] : []),
            ...(can(p, 'permissoes.gerenciar') || can(p, 'usuarios.gerenciar') ? [{ href: '/permissoes', label: 'Usuários e permissões', icon: <I.IconKey /> }] : []),
            ...(can(p, 'auditoria.ver') ? [{ href: '/auditoria', label: 'Auditoria', icon: <I.IconShield /> }] : []),
          ],
        }]
      : []),
  ];
  const unread = await unreadCount(ctx);
  const env = getConfig().appEnv;
  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand />
        <Nav groups={groups} />
        <div className="sidebar-foot">
          Uso interno e restrito.<br />Versão 0.1 · {env === 'producao' ? 'Produção' : env === 'homologacao' ? 'Homologação' : 'Desenvolvimento'}
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          {env !== 'producao' ? <span className="tag tag-warn">Ambiente de {env === 'homologacao' ? 'homologação' : 'desenvolvimento'} — somente dados fictícios</span> : null}
          <div className="spacer" />
          <Link href="/notificacoes" className="btn btn-ghost btn-sm" aria-label={`Notificações: ${unread} não lida(s)`}>
            <I.IconBell />
            {unread > 0 ? <span className="tag tag-info">{unread}</span> : null}
          </Link>
          <div className="user">
            <div className="avatar" aria-hidden="true">{initials(p.displayName)}</div>
            <div className="small">
              <div>{p.displayName}</div>
              <div className="muted">{p.isOwner ? 'Oficial Registradora' : p.email}</div>
            </div>
          </div>
          <form action={logoutAction}>
            <button type="submit" className="btn btn-ghost btn-sm" aria-label="Sair"><I.IconLogout /> Sair</button>
          </form>
        </header>
        <main className="content" id="conteudo">{children}</main>
      </div>
    </div>
  );
}
