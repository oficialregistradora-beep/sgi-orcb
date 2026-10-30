import { getConfig } from '../config.ts';
import { googleFetch, SCOPES } from '../google.ts';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/**
 * Envio imediato (sem a fila de integrações) do código de acesso, pela caixa institucional GMAIL_SENDER.
 * A mensagem não traz link: só o código, para não servir de modelo a e-mails falsos.
 */
export async function sendAccessCodeEmail(to: string, code: string, minutes: number): Promise<void> {
  const cfg = getConfig();
  const addr = to.replace(/[\r\n]+/g, '').trim();
  if (!/^[^\s@<>"]+@[^\s@<>"]+$/.test(addr)) throw new Error('destinatário inválido');
  const body = [
    `Seu código de acesso ao SGI é: ${code}`, '',
    `Ele vale ${minutes} minutos e só pode ser usado uma vez.`,
    'Se não foi você que pediu, ignore esta mensagem e avise a Oficial Registradora.', '',
    'Mensagem automática do sistema interno da serventia. Não responda.',
  ].join('\r\n');
  const raw = [
    `From: SGI <${cfg.google.gmailSender}>`, `To: <${addr}>`, `Subject: =?UTF-8?B?${b64(`[SGI] Código de acesso: ${code}`)}?=`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(body),
  ].join('\r\n');
  const res = await googleFetch(`${cfg.google.gmailApiUrl}/gmail/v1/users/me/messages/send`, SCOPES.gmailSend, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw: Buffer.from(raw, 'utf8').toString('base64url') }),
  }, cfg.google.gmailSender);
  if (!res.ok) throw new Error(`Gmail HTTP ${res.status}`);
}
