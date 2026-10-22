// Carga de dados FICTÍCIOS para desenvolvimento e homologação. Nenhum dado real é utilizado.
// Uso: npm run db:seed   (recusa executar em produção ou em banco que já tenha usuários)

import { getConfig } from '../src/server/config.ts';
import { closePool, getPool, query, queryOne } from '../src/server/db.ts';
import { ensureProcessedAll } from '../src/server/modules/timeclock.ts';
import { addDays, localToInstant, todayLocal, weekdayOf, formatHHMM } from '../src/domain/time.ts';

const cfg = getConfig();
if (cfg.appEnv === 'producao') throw new Error('Seed proibido em produção.');
const db = getPool();
const existing = await queryOne<{ n: number }>(db, 'SELECT count(*)::int AS n FROM users');
if (existing!.n > 0) {
  console.log('Banco já possui usuários; seed não executado.');
  await closePool();
  process.exit(0);
}

// Gerador pseudoaleatório determinístico (mulberry32) — cenários reproduzíveis.
let state = 20261022;
function rand(): number {
  state |= 0; state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const jitter = (max: number) => Math.round((rand() * 2 - 1) * max);

const id = async (sql: string, p: unknown[] = []) => (await queryOne<{ id: string }>(db, sql, p))!.id;
const sector = (code: string) => id('SELECT id FROM sectors WHERE code = $1', [code]);
const job = (name: string) => id('SELECT id FROM job_titles WHERE name = $1', [name]);
const role = (code: string) => id('SELECT id FROM roles WHERE code = $1', [code]);
const schedule = await id('SELECT id FROM work_schedules LIMIT 1');
const today = todayLocal();
const admission = addDays(today, -95);

type Person = { name: string; local: string; sector: string; job: string; roles: [string, string?][]; owner?: boolean; agreement?: boolean; profile: 'pontual' | 'extras' | 'atrasos' | 'esquecido' };
const people: Person[] = [
  { name: 'Helena Martins (fictícia)', local: 'oficial', sector: 'DIR', job: 'Oficial Registradora', roles: [['OFICIAL']], owner: true, profile: 'pontual' },
  { name: 'Beatriz Souza (fictícia)', local: 'substituta', sector: 'DIR', job: 'Substituta Legal', roles: [['SUBSTITUTA_LEGAL'], ['COLABORADOR']], agreement: true, profile: 'extras' },
  { name: 'Camila Ramos (fictícia)', local: 'camila.ramos', sector: 'RI', job: 'Escrevente Substituta', roles: [['COORDENACAO_SETOR'], ['COLABORADOR']], agreement: true, profile: 'pontual' },
  { name: 'Diego Alves (fictício)', local: 'diego.alves', sector: 'RI', job: 'Escrevente Autorizado', roles: [['COLABORADOR']], agreement: true, profile: 'extras' },
  { name: 'Eduarda Lima (fictícia)', local: 'eduarda.lima', sector: 'RCPN', job: 'Escrevente Autorizado', roles: [['COLABORADOR']], agreement: true, profile: 'pontual' },
  { name: 'Fábio Nunes (fictício)', local: 'fabio.nunes', sector: 'RTDPJ', job: 'Escrevente Autorizado', roles: [['COLABORADOR']], agreement: true, profile: 'esquecido' },
  { name: 'Gabriela Rocha (fictícia)', local: 'gabriela.rocha', sector: 'ATD', job: 'Atendente', roles: [['COLABORADOR']], agreement: true, profile: 'atrasos' },
  { name: 'Henrique Dias (fictício)', local: 'henrique.dias', sector: 'ATD', job: 'Atendente', roles: [['COLABORADOR']], agreement: false, profile: 'pontual' },
  { name: 'Isabel Costa (fictícia)', local: 'isabel.costa', sector: 'DIR', job: 'Auxiliar de Serviços Gerais', roles: [['COLABORADOR']], agreement: true, profile: 'pontual' },
];

let ownerId = '';
let seq = 0;
const holidays = new Set((await query<{ date: string }>(db, 'SELECT date FROM holidays WHERE is_day_off')).map((h) => h.date));

for (const p of people) {
  seq += 1;
  const userId = await id('INSERT INTO users (email, display_name, is_owner) VALUES ($1,$2,$3) RETURNING id', [`${p.local}@${cfg.workspaceDomain}`, p.name, !!p.owner]);
  if (p.owner) ownerId = userId;
  const employeeId = await id(
    `INSERT INTO employees (user_id, registration_code, full_name, job_title_id, sector_id, admission_date, contract_type, weekly_hours, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'CLT',40,$7) RETURNING id`,
    [userId, `F${String(seq).padStart(3, '0')}`, p.name, await job(p.job), await sector(p.sector), admission, ownerId || userId],
  );
  await query(db, `INSERT INTO job_history (employee_id, job_title_id, sector_id, start_date, reason) VALUES ($1,$2,$3,$4,'Admissão (dado fictício)')`, [
    employeeId, await job(p.job), await sector(p.sector), admission,
  ]);
  for (const [code] of p.roles) {
    await query(db, "INSERT INTO user_roles (user_id, role_id, valid_from, reason) VALUES ($1,$2,$3,'Carga inicial de homologação')", [userId, await role(code), admission]);
  }
  await query(db, 'INSERT INTO employee_schedules (employee_id, schedule_id, valid_from) VALUES ($1,$2,$3)', [employeeId, schedule, admission]);
  if (p.agreement) {
    await query(db, `INSERT INTO hour_bank_agreements (employee_id, kind, compensation_months, valid_from, document_reference)
                     VALUES ($1,'INDIVIDUAL_ESCRITO',6,$2,'Acordo individual fictício nº ${seq}/2026')`, [employeeId, admission]);
  }
  // Uma ausência abonada por pessoa (férias ou atestado) para variar o cenário.
  const absStart = addDays(admission, 20 + seq * 5);
  if (seq % 3 === 0) await query(db, "INSERT INTO absences (employee_id, type, start_date, end_date, notes) VALUES ($1,'FERIAS',$2,$3,'Férias (fictício)')", [employeeId, absStart, addDays(absStart, 9)]);
  if (seq % 4 === 1) await query(db, "INSERT INTO absences (employee_id, type, start_date, end_date, notes) VALUES ($1,'ATESTADO_MEDICO',$2,$2,'Atestado (fictício)')", [employeeId, addDays(absStart, 30)]);
  const absences = await query<{ start_date: string; end_date: string }>(db, 'SELECT start_date, end_date FROM absences WHERE employee_id = $1', [employeeId]);

  for (let d = admission; d < today; d = addDays(d, 1)) {
    const wd = weekdayOf(d);
    if (wd === 0 || wd === 6 || holidays.has(d) || absences.some((a) => a.start_date <= d && a.end_date >= d)) continue;
    let marks = [480 + jitter(4), 720 + jitter(3), 780 + jitter(3), 1020 + jitter(4)];
    const r = rand();
    if (p.profile === 'extras' && r < 0.18) marks[3] = 1020 + 30 + Math.round(rand() * 60);
    if (p.profile === 'atrasos' && r < 0.15) marks[0] = 480 + 15 + Math.round(rand() * 30);
    if (p.profile === 'esquecido' && r < 0.08) marks = marks.slice(0, 3);
    if (r > 0.985) marks[3] = 1020 + 45; // extras ocasionais para todos
    for (const m of marks) {
      await query(db, `INSERT INTO time_punches (employee_id, punched_at, local_date, kind, source, created_by) VALUES ($1,$2,$3,'ADICIONAL','IMPORTACAO',$4)`, [
        employeeId, localToInstant(d, formatHHMM(m)), d, userId,
      ]);
    }
  }
  console.log(`✓ ${p.name} (${p.local}@${cfg.workspaceDomain})`);
}

// Plantões RCPN fictícios das últimas 6 semanas (rodízio), com alguns chamados — deixados abertos para o roteiro de fechamento.
const rotation = await query<{ id: string }>(db, `SELECT e.id FROM employees e JOIN users u ON u.id = e.user_id
  WHERE split_part(u.email, '@', 1) IN ('eduarda.lima', 'diego.alves', 'fabio.nunes') ORDER BY e.full_name`);
let k = 0;
for (let d = addDays(today, -42); d < today; d = addDays(d, 1)) {
  const wd = weekdayOf(d);
  if (wd !== 0 && wd !== 6 && !holidays.has(d)) continue;
  const resp = rotation[k % rotation.length]!.id;
  const sub = rotation[(k + 1) % rotation.length]!.id;
  k++;
  const shift = await id(`INSERT INTO oncall_shifts (shift_date, starts_at, ends_at, employee_id, substitute_employee_id, created_by)
                          VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [d, localToInstant(d, '08:00'), localToInstant(d, '18:00'), resp, sub, ownerId]);
  if (rand() < 0.5) {
    const h = 9 + Math.floor(rand() * 6);
    const attended = rand() < 0.6;
    await query(db, `INSERT INTO oncall_calls (shift_id, called_at, responded_at, attended, arrival_at, departure_at, description, registered_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      shift, localToInstant(d, formatHHMM(h * 60)), localToInstant(d, formatHHMM(h * 60 + 5)), attended,
      attended ? localToInstant(d, formatHHMM(h * 60 + 30)) : null, attended ? localToInstant(d, formatHHMM(h * 60 + 90)) : null,
      attended ? 'Registro de óbito (fictício)' : 'Orientação por telefone (fictício)', ownerId,
    ]);
  }
}
console.log(`✓ ${k} plantões RCPN fictícios`);

await query(db, `INSERT INTO audit_log (actor_user_id, action, entity_type, summary, prev_hash, hash) VALUES ($1,'CARGA_HOMOLOGACAO','sistema','Carga de dados fictícios de homologação','','')`, [ownerId]);
console.log('Apurando jornadas…');
await ensureProcessedAll();
console.log('Concluído. Entre pelo login de homologação (AUTH_DEV_LOGIN=true).');
await closePool();
