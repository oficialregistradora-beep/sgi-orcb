import pg from 'pg';
import { getConfig } from './config.ts';

// DATE do PostgreSQL é devolvido como texto 'YYYY-MM-DD' (competência local), nunca convertido para Date.
pg.types.setTypeParser(pg.types.builtins.DATE, (v: string) => v);
// NUMERIC permanece texto para preservar a precisão decimal de valores monetários.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v: string) => v);
// BIGINT (ex.: ids da auditoria, contagens) como número — os valores ficam muito abaixo de 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

export type Db = pg.Pool | pg.PoolClient;

const globalForPool = globalThis as unknown as { __sgiPool?: pg.Pool };

export function getPool(): pg.Pool {
  if (!globalForPool.__sgiPool) {
    const cfg = getConfig();
    globalForPool.__sgiPool = new pg.Pool({
      connectionString: cfg.databaseUrl,
      ssl: cfg.databaseSsl === 'verify' ? { rejectUnauthorized: true } : cfg.databaseSsl === 'require' ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
      application_name: 'sgi-orcb',
      options: '-c TimeZone=America/Sao_Paulo', // fuso da sessão definido já na conexão
    });
  }
  return globalForPool.__sgiPool;
}

export async function closePool(): Promise<void> {
  if (globalForPool.__sgiPool) {
    await globalForPool.__sgiPool.end();
    globalForPool.__sgiPool = undefined;
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  db: Db,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await db.query<T>(text, params);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  db: Db,
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(db, text, params);
  return rows[0] ?? null;
}

/** Executa `fn` em uma transação; desfaz tudo em caso de erro. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
