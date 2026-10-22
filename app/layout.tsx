import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'SGI · Ofício de Registros', template: '%s · SGI Registros' },
  description: 'Sistema de Gestão Integrada — Ofício de Registros de Capivari de Baixo/SC (uso interno)',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
