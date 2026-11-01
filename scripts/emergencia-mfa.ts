// Procedimento de emergência do segundo fator (job sgi-emergencia, disparado por deploy/gcp-emergencia.sh no Cloud Shell).
// ALVO_EMAIL=... ACAO=EMAIL|REDEFINIR|AMBOS [EMAIL_PESSOAL=...] EXECUTADO_POR=... node --experimental-strip-types scripts/emergencia-mfa.ts
import { closePool, getPool } from '../src/server/db.ts';
import { emergencyMfa, type EmergencyAction } from '../src/server/auth/emergency.ts';

try {
  const done = await emergencyMfa(getPool(), {
    targetEmail: process.env.ALVO_EMAIL ?? '',
    action: (process.env.ACAO ?? '') as EmergencyAction,
    personalEmail: process.env.EMAIL_PESSOAL || undefined,
    executedBy: process.env.EXECUTADO_POR ?? '',
  });
  console.log(`Concluído: ${done.join('; ')}.`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}
