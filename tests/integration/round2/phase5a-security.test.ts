import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import {
  addAction, addRequirementEvidence, createAudit, createNc, evaluateAuditItem, getAudit, getNc, listNcs, saveRequirement, saveRisk, setRootCause, startAudit,
  submitNcForVerification, verifyNc,
} from '../../../src/server/modules/quality.ts';
import { getIncident, listIncidents, processQualityReminders, qualityFileForDownload, reportIncident, treatIncident } from '../../../src/server/modules/security.ts';
import { financeFileForDownload } from '../../../src/server/modules/finance.ts';
import { setStatus } from '../../../src/server/modules/tasks.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { addDays, todayLocal } from '../../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';

let I: Awaited<ReturnType<typeof ids>>;
let cOwner: Ctx, cSubst: Ctx, cRiAuditor: Ctx, cColab: Ctx, cColab2: Ctx, cNoRole: Ctx;
const today = todayLocal();
const PDF = { name: 'ev.pdf', bytes: new TextEncoder().encode('%PDF-1.4\n%fictício\n%%EOF') };

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  const o = await makePerson({ name: 'Oficial', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
  const s = await makePerson({ name: 'Substituta', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] });
  // Pessoa do RI com permissões de auditoria (papel de substituta) — testa a regra de independência.
  const r = await makePerson({ name: 'Auditora do RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] });
  const x = await makePerson({ name: 'Colab Um', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
  const y = await makePerson({ name: 'Colab Dois', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
  const n = await makePerson({ name: 'Sem Papel', sectorId: I.sectors.ATD, jobId: I.jobs.atendente, roles: [] });
  cOwner = await ctxFor(o.userId); cSubst = await ctxFor(s.userId); cRiAuditor = await ctxFor(r.userId); cColab = await ctxFor(x.userId); cColab2 = await ctxFor(y.userId); cNoRole = await ctxFor(n.userId);
});
afterAll(closePool);

describe('Rodada 2 (5a) — independência e segregação', () => {
  it('quem pertence ao setor auditado não lidera nem avalia, mesmo com permissão de auditoria', async () => {
    const base = { title: 'Auditoria RI', kind: 'INTERNA' as const, scope: 'Escopo', auditedSectorId: I.sectors.RI, plannedDate: today, questions: ['Pergunta um'] };
    await expect(createAudit(cRiAuditor, { ...base, leadAuditorId: cRiAuditor.principal.userId })).rejects.toThrow(/Independência/);
    const aud = await createAudit(cRiAuditor, { ...base, leadAuditorId: cSubst.principal.userId }); // pode planejar para um auditor independente
    await expect(startAudit(cRiAuditor, aud)).rejects.toThrow(/Independência/);
    await startAudit(cSubst, aud);
    const { items, canConduct } = await getAudit(cRiAuditor, aud);
    expect(canConduct).toBe(false);
    await expect(evaluateAuditItem(cRiAuditor, { itemId: items[0]!.id, result: 'CONFORME' })).rejects.toThrow(/Independência/);
    // A Oficial pode auditar qualquer setor.
    await createAudit(cOwner, { ...base, leadAuditorId: cOwner.principal.userId });
  });

  it('responsável inativo é recusado; NC verificada por outra pessoa em qualquer caminho', async () => {
    await query(getPool(), "UPDATE users SET status = 'INATIVO' WHERE id = $1", [cColab2.principal.userId]).catch(() => query(getPool(), "UPDATE users SET status = 'SUSPENSO' WHERE id = $1", [cColab2.principal.userId]));
    await expect(createNc(cSubst, { origin: 'OUTRA', description: 'Falha qualquer', severity: 'MENOR', responsibleUserId: cColab2.principal.userId })).rejects.toThrow(/inativo/);
    await query(getPool(), "UPDATE users SET status = 'ATIVO' WHERE id = $1", [cColab2.principal.userId]);
    // A Substituta é responsável: nem ela, sendo gestora da qualidade, verifica a própria eficácia.
    const nc = await createNc(cSubst, { origin: 'OUTRA', description: 'Falha qualquer', severity: 'MENOR', responsibleUserId: cSubst.principal.userId });
    await setRootCause(cSubst, nc, 'Causa');
    await addAction(cSubst, { kind: 'CORRETIVA', ncId: nc, title: 'Corrigir', responsibleUserId: cColab.principal.userId, dueDate: today });
    await setStatus(cColab, (await getNc(cSubst, nc)).actions[0]!.task_id, 'CONCLUIDA');
    await submitNcForVerification(cSubst, nc);
    await expect(verifyNc(cSubst, nc, true, 'Eficaz segundo eu mesma')).rejects.toThrow(/Segregação/);
    // Duas verificações simultâneas: exatamente uma vence.
    const r = await Promise.allSettled([verifyNc(cOwner, nc, true, 'Verificação A ok'), verifyNc(cRiAuditor, nc, true, 'Verificação B ok')]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await getNc(cOwner, nc)).nc.status).toBe('ENCERRADA');
  });

  it('aceitar risco alto/crítico é decisão exclusiva da Oficial', async () => {
    await expect(saveRisk(cSubst, { title: 'Crítico', category: 'OPERACIONAL', probability: 5, impact: 4, treatment: 'ACEITAR', ownerUserId: cSubst.principal.userId })).rejects.toThrow(/Oficial/);
    await expect(saveRisk(cColab, { title: 'Crítico', category: 'OPERACIONAL', probability: 1, impact: 1, treatment: 'MITIGAR', ownerUserId: cColab.principal.userId })).rejects.toThrow(/permissão/);
  });
});

describe('Rodada 2 (5a) — confidencialidade de incidentes', () => {
  it('colaborador vê apenas o que comunicou; sem papel não comunica', async () => {
    const a = await reportIncident(cColab, { title: 'Incidente A', description: 'Dados de terceiro expostos', category: 'DADOS_PESSOAIS', detectedAt: new Date() });
    const b = await reportIncident(cColab2, { title: 'Incidente B', description: 'Outro', category: 'OPERACIONAL', detectedAt: new Date() });
    expect((await queryOne<{ personal_data_involved: boolean }>(getPool(), 'SELECT personal_data_involved FROM incidents WHERE id = $1', [a]))!.personal_data_involved).toBe(true);
    expect((await listIncidents(cColab)).map((i) => i.id)).toEqual([a]);
    await expect(getIncident(cColab, b)).rejects.toThrow(/não encontrado/);
    await expect(getIncident(cRiAuditor, b)).resolves.toBeTruthy(); // gestora de incidentes
    await expect(reportIncident(cNoRole, { title: 'Tentativa', description: 'Sem papel', category: 'OUTRO', detectedAt: new Date() })).rejects.toThrow(/permissão/);
    await expect(treatIncident(cColab, a, { containment: 'Eu mesmo contive' })).rejects.toThrow(/permissão/);
  });

  it('o banco recusa encerramento com dados pessoais sem avaliação LGPD', async () => {
    const id = (await queryOne<{ id: string }>(getPool(), 'SELECT id FROM incidents WHERE personal_data_involved LIMIT 1'))!.id;
    await expect(query(getPool(), "UPDATE incidents SET status = 'ENCERRADO', closed_at = now(), containment = 'ok ok', root_cause = 'ok ok' WHERE id = $1", [id])).rejects.toThrow(/check/i);
  });
});

describe('Rodada 2 (5a) — integridade no banco', () => {
  it('restrições valem mesmo contornando o serviço', async () => {
    const db = getPool();
    const nc = (await queryOne<{ id: string }>(db, 'SELECT id FROM nonconformities LIMIT 1'))!.id;
    const task = (await queryOne<{ task_id: string }>(db, 'SELECT task_id FROM quality_actions LIMIT 1'))!.task_id;
    const risk = await saveRisk(cSubst, { title: 'Risco base', category: 'OPERACIONAL', probability: 2, impact: 2, treatment: 'MITIGAR', ownerUserId: cSubst.principal.userId });
    await expect(query(db, "UPDATE nonconformities SET status = 'ENCERRADA', closed_at = now() WHERE id = $1 AND status <> 'ENCERRADA'", [(await createNc(cSubst, { origin: 'OUTRA', description: 'Outra falha', severity: 'MENOR', responsibleUserId: cColab.principal.userId }))])).rejects.toThrow(/check/i);
    await expect(query(db, 'UPDATE quality_actions SET risk_id = $1', [risk])).rejects.toThrow(/imutável|não pode/i);
    await expect(query(db, "INSERT INTO quality_actions (kind, nc_id, risk_id, task_id, created_by) VALUES ('PREVENTIVA',$1,$2,$3,$4)", [nc, risk, task, cSubst.principal.userId])).rejects.toThrow(/check|unique|duplicate/i);
    await expect(query(db, "UPDATE risks SET treatment = 'ACEITAR', accepted_by = NULL WHERE id = $1", [risk])).rejects.toThrow(/check/i);
    await expect(query(db, "UPDATE vulnerabilities SET status = 'CORRIGIDA', closed_at = now()")).resolves.toBeDefined(); // nenhuma linha
    await query(db, "INSERT INTO vulnerabilities (title, source, severity, detected_on, due_on, created_by) VALUES ('Vuln','Fonte','BAIXA',$1,$1,$2)", [today, cSubst.principal.userId]);
    await expect(query(db, "UPDATE vulnerabilities SET status = 'CORRIGIDA', closed_at = now()")).rejects.toThrow(/check/i);
    await expect(query(db, "INSERT INTO vulnerabilities (title, source, severity, detected_on, due_on, created_by) VALUES ('Vuln','Fonte','BAIXA',$1,$2,$3)", [today, addDays(today, -1), cSubst.principal.userId])).rejects.toThrow(/check/i);
    await expect(query(db, "INSERT INTO backup_records (kind, system, performed_on, result, recorded_by) VALUES ('BACKUP','SGI',$1,'FALHA',$2)", [today, cSubst.principal.userId])).rejects.toThrow(/check/i);
  });

  it('códigos sequenciais únicos sob concorrência', async () => {
    const r = await Promise.all(Array.from({ length: 15 }, (_, i) => createNc(cSubst, { origin: 'OUTRA', description: `Concorrente ${i}`, severity: 'MENOR', responsibleUserId: cColab.principal.userId })));
    expect(new Set(r).size).toBe(15);
    const codes = (await listNcs(cSubst)).map((n) => n.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('entrada maliciosa: código fora do padrão, arquivo disfarçado', async () => {
    await expect(saveRequirement(cSubst, { code: "X'; DROP TABLE risks;--", title: 'Tit', source: 'Fonte', area: 'A1', ownerUserId: cSubst.principal.userId })).rejects.toThrow(/Código inválido/);
    const req = await saveRequirement(cSubst, { code: 'SEC-1', title: '<script>alert(1)</script>', source: 'Fonte', area: 'A1', ownerUserId: cSubst.principal.userId });
    const exe = { name: 'relatorio.pdf', bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3]) };
    await expect(addRequirementEvidence(cSubst, req, { description: 'Arquivo' }, exe)).rejects.toThrow();
    expect((await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM requirement_evidences WHERE requirement_id = $1', [req]))!.n).toBe(0);
  });

  it('downloads: arquivo de um módulo não é servido pela rota do outro', async () => {
    const req = (await queryOne<{ id: string }>(getPool(), "SELECT id FROM quality_requirements WHERE code = 'SEC-1'"))!.id;
    await addRequirementEvidence(cSubst, req, { description: 'Válida' }, PDF);
    const fileId = (await queryOne<{ file_id: string }>(getPool(), 'SELECT file_id FROM requirement_evidences WHERE requirement_id = $1', [req]))!.file_id;
    await expect(qualityFileForDownload(cSubst, fileId)).resolves.toMatchObject({ filename: 'ev.pdf' });
    await expect(financeFileForDownload(cOwner, fileId)).rejects.toThrow(/não encontrado/);
    await expect(qualityFileForDownload(cSubst, '00000000-0000-4000-8000-000000000000')).rejects.toThrow(/não encontrado/);
    await expect(qualityFileForDownload(cColab, fileId)).rejects.toThrow(/não encontrado/);
    expect((await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM audit_log WHERE action = 'QUALIDADE_ARQUIVO_DOWNLOAD'"))!.n).toBe(1);
  });

  it('lembretes concorrentes não duplicam avisos', async () => {
    await query(getPool(), 'UPDATE quality_requirements SET next_review_on = $1', [addDays(today, -1)]);
    const before = (await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM reminder_log'))!.n;
    const [a, b] = await Promise.all([processQualityReminders(), processQualityReminders()]);
    // Cada chave do registro de lembretes corresponde a exatamente um envio, mesmo com duas execuções simultâneas.
    expect(a + b).toBe((await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM reminder_log'))!.n - before);
    expect(a + b).toBeGreaterThanOrEqual(3); // requisito vencido, auditoria planejada para hoje, vulnerabilidade a vencer
    const dup = await query(getPool(), "SELECT user_id, title FROM notifications WHERE kind IN ('QUALIDADE','AUDITORIA','VULNERABILIDADE') GROUP BY user_id, title HAVING count(*) > 1");
    expect(dup).toHaveLength(0);
    expect(await processQualityReminders()).toBe(0);
  });

  it('trilha de auditoria íntegra', async () => {
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
