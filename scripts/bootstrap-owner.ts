// Produção: cadastra a Oficial Registradora (única conta com is_owner) no banco vazio, uma única vez.
// Uso (job do Cloud Run): OWNER_EMAIL=... OWNER_NAME=... node --experimental-strip-types scripts/bootstrap-owner.ts
// Os demais cadastros (equipe, papéis) são feitos pela interface, por ela. Se já houver usuários, nada é alterado.
import { getConfig } from '../src/server/config.ts';
import { closePool, getPool, queryOne } from '../src/server/db.ts';
import { audit } from '../src/server/audit.ts';

try {
  const cfg = getConfig();
  const email = (process.env.OWNER_EMAIL ?? '').trim().toLowerCase();
  const name = (process.env.OWNER_NAME ?? '').trim();
  if (!email.endsWith(`@${cfg.workspaceDomain}`)) throw new Error(`OWNER_EMAIL deve ser uma conta @${cfg.workspaceDomain}.`);
  if (name.length < 3) throw new Error('OWNER_NAME ausente.');
  const db = getPool();
  const n = (await queryOne<{ n: number }>(db, 'SELECT count(*)::int AS n FROM users'))!.n;
  if (n > 0) {
    const owner = await queryOne<{ email: string }>(db, 'SELECT email FROM users WHERE is_owner');
    console.log(`Banco já possui usuários (Oficial: ${owner?.email ?? 'não definida'}); nada alterado.`);
  } else {
    const u = (await queryOne<{ id: string }>(db, 'INSERT INTO users (email, display_name, is_owner) VALUES ($1,$2,true) RETURNING id', [email, name]))!;
    await queryOne(db, "INSERT INTO user_roles (user_id, role_id, valid_from, reason) SELECT $1, id, current_date, 'Implantação — Oficial Registradora' FROM roles WHERE code = 'OFICIAL' RETURNING user_id", [u.id]);
    await audit(db, null, { action: 'IMPLANTACAO_OFICIAL', entityType: 'user', entityId: u.id, summary: `Implantação: Oficial Registradora cadastrada (${email})` });
    console.log(`Oficial cadastrada: ${name} <${email}>. Os demais cadastros são feitos pela interface.`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}
