import { redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { getConfig } from '@/server/config.ts';
import { getPool, queryOne } from '@/server/db.ts';
import { beginEnrollment, mfaStatus } from '@/server/auth/mfa.ts';
import { decryptField } from '@/server/crypto.ts';
import { totpAt } from '@/server/totp.ts';
import { getSessionState } from '@/server/web/session.ts';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { BrandMark } from '@/ui/Brand.tsx';
import { mfaAction, logoutAction } from '../actions/auth.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Segundo fator' };

export default async function MfaPage() {
  const st = await getSessionState();
  if (st.status === 'ANONIMO') redirect('/login');
  if (st.status === 'AUTENTICADO') redirect('/painel');
  const db = getPool();
  const status = await mfaStatus(db, st.session.user_id);
  const enrollment = status === 'PENDENTE_CADASTRO' ? await beginEnrollment(db, st.session.user_id) : null;
  const qr = enrollment ? await QRCode.toDataURL(enrollment.uri, { margin: 1, width: 172 }) : null;

  // Somente em homologação, para sessões de login de teste: exibe o código atual (usuários fictícios).
  let devCode: string | null = null;
  if (getConfig().devLogin && st.session.auth_method === 'DEV') {
    const u = await queryOne<{ totp_secret_enc: string | null }>(db, 'SELECT totp_secret_enc FROM users WHERE id = $1', [st.session.user_id]);
    const secret = decryptField(u?.totp_secret_enc);
    if (secret) devCode = totpAt(secret);
  }

  return (
    <main className="auth-wrap">
      <div className="card auth-card">
        <div className="card-body">
          <div className="auth-brand">
            <BrandMark />
            <h1>{enrollment ? 'Cadastre seu autenticador' : 'Verificação em duas etapas'}</h1>
          </div>
          {enrollment ? (
            <div className="stack">
              <p className="small muted">
                No primeiro acesso, leia o QR Code com um aplicativo autenticador (Google Authenticator, Microsoft Authenticator ou similar)
                e informe o código de 6 dígitos gerado.
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="qr" src={qr!} alt="QR Code para cadastro do autenticador" />
              <details className="disclosure small">
                <summary className="muted">Não consegue ler o QR Code? Digite a chave</summary>
                <code className="mono hash">{enrollment.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
              </details>
            </div>
          ) : (
            <p className="small muted">Informe o código de 6 dígitos do seu aplicativo autenticador.</p>
          )}
          {devCode ? <div className="alert alert-warn small" style={{ marginTop: 12 }}>Homologação — código atual do usuário fictício: <strong className="mono">{devCode}</strong></div> : null}
          <ActionForm action={mfaAction} submitLabel={enrollment ? 'Ativar e entrar' : 'Verificar'} className="stack">
            <input type="hidden" name="mode" value={enrollment ? 'cadastro' : 'verificacao'} />
            <div className="field" style={{ marginTop: 16 }}>
              <label htmlFor="code">Código do autenticador</label>
              <input id="code" name="code" className="input mono" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus />
            </div>
          </ActionForm>
          <form action={logoutAction} style={{ marginTop: 8 }}>
            <button type="submit" className="btn btn-ghost btn-sm">Cancelar e sair</button>
          </form>
        </div>
      </div>
    </main>
  );
}
