/** Monograma institucional: selo com duas linhas (livro de registro) e as iniciais OR. Identidade própria. */
export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="37" height="37" rx="9" stroke="currentColor" strokeWidth="1.5" />
      <rect x="6" y="6" width="28" height="28" rx="6" stroke="currentColor" strokeWidth="0.75" opacity="0.45" />
      <path d="M11 27.5h18M11 30.5h18" stroke="currentColor" strokeWidth="1" opacity="0.6" strokeLinecap="round" />
      <text x="20" y="22.5" textAnchor="middle" fontFamily="Georgia, 'Times New Roman', serif" fontSize="12.5" fontWeight="600" fill="currentColor" letterSpacing="0.5">OR</text>
    </svg>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <BrandMark />
      <div>
        <div className="brand-name">SGI · Registros</div>
        <div className="brand-sub">Capivari de Baixo/SC</div>
      </div>
    </div>
  );
}
