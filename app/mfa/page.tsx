import { redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { getConfig } from '@/server/config.ts';
import { getPool, queryOne } from '@/server/db.ts';
import { beginEnrollment, mfaOptions, mfaStatus } from '@/server/auth/mfa.ts';
import { decryptField } from '@/server/crypto.ts';
import { totpAt } from '@/server/totp.ts';
import { getSessionState } from '@/server/web/session.ts';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { BrandMark } from '@/ui/Brand.tsx';
import { EmailCodeButton } from '@/ui/EmailCodeButton.tsx';
import { mfaAction, logoutAction } from '../actions/auth.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Segundo fator' };

export default async function MfaPage() {
  const st = await getSessionState();
  if (st.status === 'ANONIMO') redirect('/login');
  if (st.status === 'AUTENTICADO') redirect('/painel');
  if (st.status === 'REDE_BLOQUEADA') redirect('/acesso-restrito');
  const db = getPool();
  const status = await mfaStatus(db, st.session.user_id);
  const enrollment = status === 'PENDENTE_CADASTRO' ? await beginEnrollment(db, st.session.user_id) : null;
  const qr = enrollment ? await QRCode.toDataURL(enrollment.uri, { margin: 1, width: 172 }) : null;
  const alt = await mfaOptions(db, st.session.user_id);
  const codeField = (id: string, label: string, autoFocus: boolean) => (
    <div className="field" style={{ marginTop: 16 }}>
      <label htmlFor={id}>{label}</label>
      <input id={id} name="code" className="input mono" autoComplete="one-time-code" maxLength={9} required autoFocus={autoFocus} />
    </div>
  );

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
            <p className="small muted">
              Informe o código de 6 dígitos do seu aplicativo autenticador
              {alt.backupLeft ? ', ou um dos seus códigos de reserva (formato XXXX-XXXX)' : ''}
              {alt.email ? ', ou peça um código no seu e-mail pessoal' : ''}.
            </p>
          )}
          {devCode ? <div className="alert alert-warn small" style={{ marginTop: 12 }}>Homologação — código atual do usuário fictício: <strong className="mono">{devCode}</strong></div> : null}
          <ActionForm action={mfaAction} submitLabel={enrollment ? 'Ativar e entrar' : 'Verificar'} className="stack">
            <input type="hidden" name="mode" value={enrollment ? 'cadastro' : 'verificacao'} />
            {codeField('code', enrollment ? 'Código do autenticador' : 'Código', true)}
          </ActionForm>
          {!enrollment && alt.email ? <EmailCodeButton /> : null}
          {enrollment && alt.email ? (
            <div className="stack" style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <p className="small muted">Não pode usar o aplicativo? Receba um código no seu e-mail pessoal ({alt.email}).</p>
              <EmailCodeButton />
              <ActionForm action={mfaAction} submitLabel="Entrar com o código do e-mail" submitClass="btn" className="stack">
                <input type="hidden" name="mode" value="verificacao" />
                {codeField('code-email', 'Código recebido por e-mail', false)}
              </ActionForm>
            </div>
          ) : null}
          <form action={logoutAction} style={{ marginTop: 8 }}>
            <button type="submit" className="btn btn-ghost btn-sm">Cancelar e sair</button>
          </form>
        </div>
      </div>
    </main>
  );
}
