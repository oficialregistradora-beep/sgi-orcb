import { type Db, query } from './db.ts';

let cache: { at: number; values: Map<string, unknown> } | null = null;
const TTL_MS = 30_000;

async function load(db: Db): Promise<Map<string, unknown>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.values;
  const rows = await query<{ key: string; value: unknown }>(db, 'SELECT key, value FROM settings');
  cache = { at: Date.now(), values: new Map(rows.map((r) => [r.key, r.value])) };
  return cache.values;
}

export async function getSetting<T>(db: Db, key: string, fallback: T): Promise<T> {
  const values = await load(db);
  return values.has(key) ? (values.get(key) as T) : fallback;
}

export async function getNumberSetting(db: Db, key: string, fallback: number): Promise<number> {
  const v = await getSetting<unknown>(db, key, fallback);
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function invalidateSettingsCache(): void {
  cache = null;
}
