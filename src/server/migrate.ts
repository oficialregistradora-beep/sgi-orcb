import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { sha256Hex } from './crypto.ts';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../db/migrations');

/**
 * Aplica as migrations SQL versionadas em ordem, cada uma em sua própria transação.
 * Uma migration já aplicada cujo conteúdo foi alterado interrompe o processo (checksum divergente).
 */
export async function runMigrations(pool: pg.Pool, log: (msg: string) => void = () => undefined): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(7311000)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = sha256Hex(sql);
      const prev = done.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`Migration ${file} foi alterada após aplicada (checksum divergente).`);
        continue;
      }
      log(`Aplicando ${file}…`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falha na migration ${file}: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(7311000)').catch(() => undefined);
    client.release();
  }
  return applied;
}
