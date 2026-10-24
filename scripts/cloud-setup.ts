// Preparação do banco na nuvem (job do Cloud Run), conectado como sgi_owner:
// aplica as migrations, cria/atualiza o papel sgi_app (senha em SGI_APP_DB_PASSWORD) e aplica db/roles.sql.
// Idempotente: pode ser executado a cada publicação.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { closePool, getPool } from '../src/server/db.ts';
import { runMigrations } from '../src/server/migrate.ts';

try {
  const pw = process.env.SGI_APP_DB_PASSWORD ?? '';
  if (pw.length < 24) throw new Error('SGI_APP_DB_PASSWORD ausente ou curta (mínimo 24 caracteres).');
  const db = getPool();
  const applied = await runMigrations(db, (m) => console.log(m));
  console.log(applied.length ? `${applied.length} migration(s) aplicada(s).` : 'Banco já atualizado.');
  const exists = (await db.query("SELECT 1 FROM pg_roles WHERE rolname = 'sgi_app'")).rowCount;
  const ddl = (await db.query<{ q: string }>(`SELECT format('${exists ? 'ALTER' : 'CREATE'} ROLE sgi_app LOGIN PASSWORD %L', $1::text) AS q`, [pw])).rows[0]!.q;
  await db.query(ddl);
  console.log(exists ? 'Papel sgi_app atualizado.' : 'Papel sgi_app criado.');
  await db.query(await readFile(path.resolve(import.meta.dirname, '../db/roles.sql'), 'utf8'));
  console.log('Permissões de sgi_app aplicadas (db/roles.sql).');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}
