import { z } from 'zod';
import { type Db, query, queryOne, tx } from '../db.ts';
import { getConfig } from '../config.ts';
import { encryptField } from '../crypto.ts';
import { audit } from '../audit.ts';
import { AppError } from '../errors.ts';
import { revokeAllUserSessions } from './session.ts';
import { maskEmail } from './mfa.ts';

export type EmergencyAction = 'EMAIL' | 'REDEFINIR' | 'AMBOS';

const schema = z.object({
  targetEmail: z.string().trim().toLowerCase().pipe(z.email()),
  action: z.enum(['EMAIL', 'REDEFINIR', 'AMBOS']),
  personalEmail: z.string().trim().toLowerCase().pipe(z.email()).optional(),
  executedBy: z.string().trim().min(3).max(200),
});

/**
 * Procedimento de emergência, executado fora do sistema (job do Cloud Run disparado do Cloud Shell por quem administra
 * o Google Cloud), para quem perdeu o segundo fator — inclusive a Oficial, que é a única a redefinir autenticadores pela tela.
 * EMAIL libera o código no e-mail pessoal; REDEFINIR apaga autenticador e códigos de reserva e encerra as sessões.
 */
export async function emergencyMfa(db: Db, input: z.input<typeof schema>): Promise<string[]> {
  const d = schema.parse(input);
  const domain = getConfig().workspaceDomain;
  const withEmail = d.action !== 'REDEFINIR';
  if (withEmail && !d.personalEmail) throw new AppError('Informe o e-mail pessoal.');
  if (withEmail && d.personalEmail!.endsWith(`@${domain}`)) throw new AppError(`O e-mail pessoal não pode ser do domínio @${domain}.`);
  return tx(async (c) => {
    const u = await queryOne<{ id: string; status: string }>(c, 'SELECT id, status FROM users WHERE email = $1 FOR UPDATE', [d.targetEmail]);
    if (!u) throw new AppError(`Não há usuário com o e-mail ${d.targetEmail} no sistema.`);
    const done: string[] = [];
    await query(c, 'UPDATE users SET mfa_failed_count = 0, mfa_locked_until = NULL, mfa_email_code_hash = NULL, mfa_email_code_expires_at = NULL, mfa_email_code_sent_at = NULL WHERE id = $1', [u.id]);
    if (withEmail) {
      await query(c, 'UPDATE users SET mfa_email_enc = $2 WHERE id = $1', [u.id, encryptField(d.personalEmail!)]);
      done.push(`código por e-mail pessoal liberado (${maskEmail(d.personalEmail!)})`);
    }
    if (d.action !== 'EMAIL') {
      await query(c, 'UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = $1', [u.id]);
      await query(c, 'DELETE FROM mfa_backup_codes WHERE user_id = $1', [u.id]);
      const n = await revokeAllUserSessions(c, u.id, 'EMERGENCIA_MFA');
      done.push(`autenticador e códigos de reserva redefinidos (${n} sessão(ões) encerrada(s))`);
    }
    await audit(c, null, {
      action: 'EMERGENCIA_MFA', entityType: 'user', entityId: u.id,
      summary: `Procedimento de emergência para ${d.targetEmail}: ${done.join('; ')} — executado no Cloud Shell por ${d.executedBy}`,
    });
    return done;
  });
}
