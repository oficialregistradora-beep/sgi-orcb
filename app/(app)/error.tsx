'use client';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card" role="alert">
      <div className="card-body stack">
        <h1>Não foi possível exibir esta página</h1>
        <p className="muted">Você pode não ter permissão para este conteúdo, ou ocorreu uma falha temporária. A ocorrência foi registrada.</p>
        <div className="row"><button className="btn" onClick={() => reset()}>Tentar novamente</button><a className="btn btn-primary" href="/painel">Voltar ao painel</a></div>
      </div>
    </div>
  );
}
