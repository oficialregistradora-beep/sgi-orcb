import { closePool, getPool } from '../src/server/db.ts';
import { runMigrations } from '../src/server/migrate.ts';

try {
  const applied = await runMigrations(getPool(), (m) => console.log(m));
  console.log(applied.length ? `${applied.length} migration(s) aplicada(s).` : 'Banco já atualizado.');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}
