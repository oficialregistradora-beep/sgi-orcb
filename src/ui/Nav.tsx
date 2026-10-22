'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

export type NavItem = { href: string; label: string; icon: ReactNode; planned?: string };
export type NavGroup = { title: string; items: NavItem[] };

export function Nav({ groups }: { groups: NavGroup[] }) {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Navegação principal">
      {groups.map((g) => (
        <div key={g.title} style={{ display: 'contents' }}>
          <div className="nav-group">{g.title}</div>
          {g.items.map((i) =>
            i.planned ? (
              <span key={i.href} className="nav-disabled" title={`Módulo planejado — ${i.planned}`}>
                {i.icon}
                {i.label}
                <span className="tag">{i.planned}</span>
              </span>
            ) : (
              <Link key={i.href} href={i.href} aria-current={path === i.href || path.startsWith(`${i.href}/`) ? 'page' : undefined}>
                {i.icon}
                {i.label}
              </Link>
            ),
          )}
        </div>
      ))}
    </nav>
  );
}
