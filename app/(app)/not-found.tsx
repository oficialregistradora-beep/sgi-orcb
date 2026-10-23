export default function NotFound() {
  return (
    <div className="card" role="alert">
      <div className="card-body stack">
        <h1>Não foi possível exibir esta página</h1>
        <p className="muted">O registro não existe ou não está disponível para você.</p>
        <div className="row"><a className="btn btn-primary" href="/painel">Voltar ao painel</a></div>
      </div>
    </div>
  );
}
