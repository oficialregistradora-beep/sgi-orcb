import { getPool, query } from '../db.ts';
import type { Ctx } from '../context.ts';

/** Lista de pessoas e setores para seleção em formulários (somente nome e setor; nenhum dado pessoal). */
export async function directory(_ctx: Ctx) {
  const db = getPool();
  const [users, sectors, roles] = await Promise.all([
    query<{ id: string; display_name: string; sector_id: string | null; sector_name: string | null }>(db,
      `SELECT u.id, u.display_name, e.sector_id, s.name AS sector_name FROM users u
         LEFT JOIN employees e ON e.user_id = u.id AND e.status <> 'DESLIGADO' LEFT JOIN sectors s ON s.id = e.sector_id
        WHERE u.status = 'ATIVO' ORDER BY u.display_name`),
    query<{ id: string; name: string }>(db, 'SELECT id, name FROM sectors WHERE active ORDER BY name'),
    query<{ id: string; name: string }>(db, 'SELECT id, name FROM roles ORDER BY name'),
  ]);
  return { users, sectors, roles };
}
