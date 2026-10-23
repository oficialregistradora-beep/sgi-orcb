import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import { invalidateSettingsCache } from '../../../src/server/settings.ts';
import { addNetworkException, getNetworkConfig, networkDecision, revokeNetworkException, saveNetworkConfig } from '../../../src/server/modules/network.ts';
import { punch } from '../../../src/server/modules/timeclock.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';

// Restrição de acesso à rede da serventia: decisões, exceções, ponto e regras de administração.
const OFFICE = '200.10.20.30';
const HOME = '177.1.1.1';
let cOwner: Ctx, cSubst: Ctx, cColab: Ctx, cPlantao: Ctx;
let colabEmp: string, plantaoEmp: string;
const at = (c: Ctx, ip: string | null): Ctx => ({ ...c, ip });

beforeAll(async () => {
  await resetDatabase();
  const I = await ids();
  cOwner = await ctxFor((await makePerson({ name: 'Oficial', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true })).userId);
  cSubst = await ctxFor((await makePerson({ name: 'Substituta', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] })).userId);
  const x = await makePerson({ name: 'Colab', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }], scheduleId: I.schedule });
  const y = await makePerson({ name: 'Plantonista', sectorId: I.sectors.RCPN, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
  cColab = await ctxFor(x.userId); cPlantao = await ctxFor(y.userId);
  colabEmp = x.employeeId; plantaoEmp = y.employeeId;
});
afterAll(closePool);

describe('Restrição de rede — configuração', () => {
  it('desativada por padrão: ninguém é bloqueado', async () => {
    expect(await networkDecision(getPool(), cColab.principal, HOME)).toEqual({ allowed: true, reason: 'DESATIVADA' });
  });
  it('ativação exige endereços válidos, reautenticação e não tranca quem está fora', async () => {
    await expect(saveNetworkConfig(at(cColab, OFFICE), { active: true, ipsText: OFFICE, punchInternal: true, oncallSlack: 60 })).rejects.toThrow(/permissão/);
    await expect(saveNetworkConfig(at(cOwner, OFFICE), { active: true, ipsText: '', punchInternal: true, oncallSlack: 60 })).rejects.toThrow(/ao menos um endereço/);
    await expect(saveNetworkConfig(at(cOwner, OFFICE), { active: true, ipsText: '0.0.0.0/0', punchInternal: true, oncallSlack: 60 })).rejects.toThrow(/ampla/);
    await expect(saveNetworkConfig(at(cOwner, OFFICE), { active: true, ipsText: '999.1.1.1', punchInternal: true, oncallSlack: 60 })).rejects.toThrow(/inválido/);
    const noStep = { ...(await ctxFor(cOwner.principal.userId, { stepUp: false })), ip: OFFICE };
    await expect(saveNetworkConfig(noStep, { active: true, ipsText: OFFICE, punchInternal: true, oncallSlack: 60 })).rejects.toThrow(/reautentica|código/i);
    // Fora da rede, a Oficial pode ativar (nunca é bloqueada) e é avisada de que está fora.
    expect(await saveNetworkConfig(at(cOwner, HOME), { active: true, ipsText: `${OFFICE}\n2804:14c::/48`, punchInternal: true, oncallSlack: 60 })).toEqual({ currentIpInside: false });
    const cfg = await getNetworkConfig(at(cOwner, HOME));
    expect(cfg).toMatchObject({ active: true, ips: [OFFICE, '2804:14c::/48'], punchInternal: true, currentIp: HOME });
    expect(cfg.external.map((x) => x.display_name)).toEqual(['Substituta']);
  });
});

describe('Restrição de rede — decisões', () => {
  it('rede interna libera; fora bloqueia o colaborador; Oficial e Substituta (permissão) passam', async () => {
    const db = getPool();
    expect((await networkDecision(db, cColab.principal, OFFICE)).reason).toBe('REDE_INTERNA');
    expect((await networkDecision(db, cColab.principal, '2804:14c:0:99::1')).reason).toBe('REDE_INTERNA');
    expect(await networkDecision(db, cColab.principal, HOME)).toEqual({ allowed: false, reason: 'BLOQUEADO' });
    expect(await networkDecision(db, cColab.principal, null)).toEqual({ allowed: false, reason: 'BLOQUEADO' });
    expect((await networkDecision(db, cOwner.principal, HOME)).reason).toBe('OFICIAL');
    expect((await networkDecision(db, cSubst.principal, HOME)).reason).toBe('PERMISSAO');
  });

  it('liberação temporária: com prazo, motivo, nunca para si; revogação imediata', async () => {
    const db = getPool();
    await expect(addNetworkException(cOwner, { userId: cOwner.principal.userId, validUntil: new Date(Date.now() + 3600_000), reason: 'Teste próprio' })).rejects.toThrow(/próprio/);
    await expect(addNetworkException(cOwner, { userId: cColab.principal.userId, validUntil: new Date(Date.now() + 40 * 86400_000), reason: 'Prazo longo' })).rejects.toThrow(/31 dias/);
    await expect(addNetworkException(cOwner, { userId: cColab.principal.userId, validUntil: new Date(Date.now() - 1000), reason: 'No passado' })).rejects.toThrow(/futuro/);
    const id = await addNetworkException(cOwner, { userId: cColab.principal.userId, validUntil: new Date(Date.now() + 2 * 3600_000), reason: 'Atendimento externo autorizado' });
    expect((await networkDecision(db, cColab.principal, HOME)).reason).toBe('LIBERACAO');
    await revokeNetworkException(cOwner, id);
    expect((await networkDecision(db, cColab.principal, HOME)).allowed).toBe(false);
    await expect(query(db, 'DELETE FROM network_exceptions WHERE id = $1', [id])).rejects.toThrow(/excluído/);
  });

  it('plantão do RCPN libera somente na janela do plantão', async () => {
    const db = getPool();
    const ins = (start: string, end: string) => queryOne<{ id: string }>(db,
      `INSERT INTO oncall_shifts (shift_date, starts_at, ends_at, employee_id, created_by) VALUES (current_date, now() + $1::interval, now() + $2::interval, $3, $4) RETURNING id`,
      [start, end, plantaoEmp, cOwner.principal.userId]);
    const future = await ins('3 hours', '8 hours');
    expect((await networkDecision(db, cPlantao.principal, HOME)).allowed).toBe(false); // começa daqui a 3 h (folga de 60 min)
    await query(db, "UPDATE oncall_shifts SET starts_at = now() + interval '30 minutes' WHERE id = $1", [future!.id]);
    expect((await networkDecision(db, cPlantao.principal, HOME)).reason).toBe('PLANTAO'); // dentro da folga anterior
    await query(db, "UPDATE oncall_shifts SET status = 'CANCELADO' WHERE id = $1", [future!.id]);
    expect((await networkDecision(db, cPlantao.principal, HOME)).allowed).toBe(false);
  });

  it('ponto só na rede da serventia, para todos (inclusive quem tem acesso externo)', async () => {
    await expect(punch(at(cColab, HOME))).rejects.toThrow(/rede da serventia/);
    const p = await punch(at(cColab, OFFICE));
    expect(p.kind).toBe('ENTRADA');
    // Desligando a regra do ponto, a marcação volta a ser aceita de qualquer lugar permitido.
    await saveNetworkConfig(at(cOwner, OFFICE), { active: true, ipsText: OFFICE, punchInternal: false, oncallSlack: 60 });
    invalidateSettingsCache();
    expect((await queryOne<{ value: boolean }>(getPool(), "SELECT value FROM settings WHERE key = 'rede.ponto_somente_interno'"))!.value).toBe(false);
    void colabEmp;
  });

  it('desativar devolve o acesso a todos; trilha íntegra', async () => {
    await saveNetworkConfig(at(cOwner, OFFICE), { active: false, ipsText: OFFICE, punchInternal: true, oncallSlack: 60 });
    expect((await networkDecision(getPool(), cColab.principal, HOME)).allowed).toBe(true);
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
