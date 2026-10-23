export default function Forbidden() {
  return (
    <div className="card" role="alert">
      <div className="card-body stack">
        <h1>Não foi possível exibir esta página</h1>
        <p className="muted">Você não tem permissão para este conteúdo. Se precisar do acesso, fale com a administração da serventia.</p>
        <div className="row"><a className="btn btn-primary" href="/painel">Voltar ao painel</a></div>
      </div>
    </div>
  );
}
