import { redirect } from 'next/navigation';
import { getSessionState } from '@/server/web/session.ts';
import { BrandMark } from '@/ui/Brand.tsx';
import { logoutAction } from '../actions/auth.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Acesso restrito à rede da serventia' };

export default async function AcessoRestrito() {
  const st = await getSessionState();
  if (st.status === 'ANONIMO') redirect('/login');
  if (st.status === 'MFA_PENDENTE') redirect('/mfa');
  if (st.status === 'AUTENTICADO') redirect('/painel');
  return (
    <main className="auth-wrap">
      <div className="card auth-card" role="alert"><div className="card-body stack">
        <BrandMark />
        <h1>Acesso permitido apenas na rede da serventia</h1>
        <p className="muted">O sistema só pode ser usado a partir da rede do cartório. Seu endereço de internet atual ({st.ip ?? 'desconhecido'}) não está autorizado.</p>
        <p className="muted">Se precisar trabalhar de fora, peça à administração uma liberação temporária. A tentativa foi registrada.</p>
        <form action={logoutAction}><button className="btn" type="submit">Sair</button></form>
      </div></div>
    </main>
  );
}
