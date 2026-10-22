import { redirect } from 'next/navigation';
import { getConfig } from '@/server/config.ts';
import { getPool, query } from '@/server/db.ts';
import { getSessionState } from '@/server/web/session.ts';
import { BrandMark } from '@/ui/Brand.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Entrar' };

const ERRORS: Record<string, string> = {
  nao_autorizado: 'Acesso não autorizado. Sua conta precisa estar previamente cadastrada e ativa. Procure a administração da serventia.',
  dominio: 'Use sua conta do domínio institucional.',
  estado_invalido: 'A autenticação expirou ou foi interrompida. Tente novamente.',
  cancelado: 'Autenticação cancelada.',
  google_nao_configurado: 'O login Google ainda não foi configurado neste ambiente (cliente OAuth pendente).',
  falha: 'Não foi possível concluir a autenticação. Tente novamente.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ erro?: string }> }) {
  const st = await getSessionState();
  if (st.status === 'AUTENTICADO') redirect('/painel');
  if (st.status === 'MFA_PENDENTE') redirect('/mfa');
  const { erro } = await searchParams;
  const cfg = getConfig();
  const devUsers = cfg.devLogin
    ? await query<{ id: string; display_name: string; email: string; roles: string }>(
        getPool(),
        `SELECT u.id, u.display_name, u.email, coalesce(string_agg(DISTINCT r.name, ', '), '') AS roles
           FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL LEFT JOIN roles r ON r.id = ur.role_id
          WHERE u.status = 'ATIVO' GROUP BY u.id ORDER BY u.is_owner DESC, u.display_name`,
      )
    : [];
  return (
    <main className="auth-wrap">
      <div className="card auth-card">
        <div className="card-body">
          <div className="auth-brand">
            <BrandMark />
            <div>
              <h1>Sistema de Gestão Integrada</h1>
              <p className="muted small">Ofício de Registros de Capivari de Baixo/SC</p>
            </div>
          </div>
          {erro && ERRORS[erro] ? <div className="alert alert-danger" role="alert">{ERRORS[erro]}</div> : null}
          <div className="stack" style={{ marginTop: erro ? 16 : 0 }}>
            <a className="btn btn-primary btn-lg" href="/api/auth/google/start">Entrar com a conta institucional Google</a>
            <p className="muted small">
              Acesso restrito a usuários previamente autorizados. Após o login, será solicitado o código do aplicativo autenticador (segundo fator).
            </p>
          </div>
          {cfg.devLogin ? (
            <>
              <div className="divider">ambiente de homologação</div>
              <form method="post" action="/api/auth/dev" className="stack">
                <div className="alert alert-warn small">Login de teste com usuários FICTÍCIOS. Indisponível em produção.</div>
                <div className="field">
                  <label htmlFor="userId">Usuário fictício</label>
                  <select id="userId" name="userId" className="input" required>
                    {devUsers.map((u) => (
                      <option key={u.id} value={u.id}>{u.display_name}{u.roles ? ` — ${u.roles}` : ''}</option>
                    ))}
                  </select>
                </div>
                <button type="submit" className="btn">Entrar como usuário de teste</button>
              </form>
            </>
          ) : null}
        </div>
      </div>
    </main>
  );
}
