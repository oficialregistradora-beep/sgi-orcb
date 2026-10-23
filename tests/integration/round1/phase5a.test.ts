import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import {
  addAction, addAuditItem, addRequirementEvidence, closeRisk, concludeAudit, createAudit, createNc, evaluateAuditItem, getAudit, getNc, getRequirement, listNcs, listRequirements,
  listRisks, reviewRequirement, riskHistory, saveRequirement, saveRisk, setRootCause, startAudit, submitNcForVerification, verifyNc,
} from '../../../src/server/modules/quality.ts';
import {
  closeIncident, disposeAsset, getIncident, listAssets, listBackups, listIncidents, listVulnerabilities, processQualityReminders, qualityFileForDownload, qualityOverview, recordBackup,
  recordLgpdAssessment, registerVulnerability, reportIncident, saveAsset, treatIncident, updateVulnerability, assetEvents,
} from '../../../src/server/modules/security.ts';
import { setStatus } from '../../../src/server/modules/tasks.ts';
import { verifyAuditChain } from '../../../src/server/audit.ts';
import { addDays, addMonths, todayLocal } from '../../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';

let I: Awaited<ReturnType<typeof ids>>;
let cOwner: Ctx, cSubst: Ctx, cCoord: Ctx, cColab: Ctx, cAtd: Ctx;
const today = todayLocal();
const year = today.slice(0, 4);
const PDF = { name: 'evidencia.pdf', bytes: new TextEncoder().encode('%PDF-1.4\n%evidência fictícia\n%%EOF') };
const notes = async (userId: string, kind: string) => query<{ title: string; body: string | null }>(getPool(), 'SELECT title, body FROM notifications WHERE user_id = $1 AND kind = $2', [userId, kind]);
let reqA: string, reqB: string, audId: string, ncId: string;

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  const o = await makePerson({ name: 'Oficial Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
  const s = await makePerson({ name: 'Substituta Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] });
  const c = await makePerson({ name: 'Coord RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }, { roleId: I.roles.COORDENACAO_SETOR }] });
  const x = await makePerson({ name: 'Colab RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] });
  const a = await makePerson({ name: 'Coord ATD', sectorId: I.sectors.ATD, jobId: I.jobs.atendente, roles: [{ roleId: I.roles.COLABORADOR }, { roleId: I.roles.COORDENACAO_SETOR }] });
  cOwner = await ctxFor(o.userId); cSubst = await ctxFor(s.userId); cCoord = await ctxFor(c.userId); cColab = await ctxFor(x.userId); cAtd = await ctxFor(a.userId);
});
afterAll(closePool);

describe('Fase 5a — requisitos e evidências', () => {
  it('cadastro restrito; nenhum requisito pré-carregado; código único', async () => {
    expect(await listRequirements(cSubst)).toHaveLength(0);
    const base = { title: 'POPs documentados (exemplo)', source: 'Fonte fictícia de teste', area: 'Documentação', ownerUserId: cCoord.principal.userId };
    await expect(saveRequirement(cCoord, { ...base, code: 'T-01' })).rejects.toThrow(/permissão/);
    reqA = await saveRequirement(cSubst, { ...base, code: 't-01' });
    reqB = await saveRequirement(cSubst, { ...base, code: 'T-02', title: 'Ciência registrada (exemplo)' });
    await expect(saveRequirement(cSubst, { ...base, code: 'T-01' })).rejects.toThrow(/código/);
    expect((await listRequirements(cCoord)).map((r) => r.code)).toEqual(['T-01', 'T-02']);
    await expect(listRequirements(cColab)).rejects.toThrow(/permissão/);
  });

  it('avaliação: atendido exige evidência; demais exigem justificativa; histórico imutável', async () => {
    await expect(reviewRequirement(cCoord, reqA, 'ATENDIDO')).rejects.toThrow(/evidência/);
    await expect(reviewRequirement(cCoord, reqA, 'PARCIAL')).rejects.toThrow(/Justifique/);
    await expect(reviewRequirement(cColab, reqA, 'PARCIAL', 'x x x')).rejects.toThrow(/permissão/);
    await expect(addRequirementEvidence(cColab, reqA, { description: 'tentativa' })).rejects.toThrow(/permissão/);
    await addRequirementEvidence(cCoord, reqA, { description: 'Relatório de verificação' }, PDF);
    await reviewRequirement(cCoord, reqA, 'ATENDIDO');
    const r = (await listRequirements(cSubst)).find((x) => x.id === reqA)!;
    expect(r.status).toBe('ATENDIDO');
    expect(r.next_review_on).toBe(addMonths(today, 12));
    const { evidences, reviews } = await getRequirement(cSubst, reqA);
    expect(evidences).toHaveLength(1);
    expect(reviews).toHaveLength(1);
    // Download da evidência: quem vê a qualidade baixa; colaborador sem acesso não.
    const f = await qualityFileForDownload(cCoord, evidences[0]!.file_id!);
    expect(f.filename).toBe('evidencia.pdf');
    await expect(qualityFileForDownload(cColab, evidences[0]!.file_id!)).rejects.toThrow(/não encontrado/);
    await expect(query(getPool(), "UPDATE requirement_reviews SET status = 'NAO_ATENDIDO'")).rejects.toThrow(/imutável|não pode/i);
  });
});

describe('Fase 5a — auditoria interna', () => {
  it('independência do auditor e checklist importado da área', async () => {
    const base = { title: 'Auditoria documental RI', kind: 'DOCUMENTAL' as const, scope: 'POPs do RI', auditedSectorId: I.sectors.RI, plannedDate: today };
    await expect(createAudit(cCoord, { ...base, leadAuditorId: cCoord.principal.userId })).rejects.toThrow(/permissão/);
    await expect(createAudit(cSubst, { ...base, leadAuditorId: cCoord.principal.userId })).rejects.toThrow(/Independência/);
    audId = await createAudit(cSubst, { ...base, leadAuditorId: cSubst.principal.userId, importArea: 'Documentação', questions: ['Protocolo conferido?'] });
    const { audit: a, items } = await getAudit(cCoord, audId);
    expect(a.code).toBe(`AUD-${year}-001`);
    expect(items.map((i) => i.question)).toEqual(['T-01 — POPs documentados (exemplo)', 'T-02 — Ciência registrada (exemplo)', 'Protocolo conferido?']);
  });

  it('execução: somente auditores independentes avaliam; não conforme abre NC automaticamente', async () => {
    const { items } = await getAudit(cSubst, audId);
    await expect(evaluateAuditItem(cSubst, { itemId: items[0]!.id, result: 'CONFORME' })).rejects.toThrow(/Inicie/);
    await expect(startAudit(cCoord, audId)).rejects.toThrow(/permissão/);
    await startAudit(cSubst, audId);
    await expect(evaluateAuditItem(cCoord, { itemId: items[0]!.id, result: 'CONFORME' })).rejects.toThrow(/permissão|Independência/);
    await expect(evaluateAuditItem(cSubst, { itemId: items[1]!.id, result: 'NAO_CONFORME' })).rejects.toThrow(/evidência/);
    await evaluateAuditItem(cSubst, { itemId: items[0]!.id, result: 'CONFORME', evidence: 'POP vigente' }, PDF);
    await evaluateAuditItem(cSubst, { itemId: items[1]!.id, result: 'NAO_CONFORME', evidence: '2 de 3 sem ciência', ncSeverity: 'MAIOR', ncResponsibleId: cCoord.principal.userId });
    await expect(evaluateAuditItem(cSubst, { itemId: items[1]!.id, result: 'CONFORME' })).rejects.toThrow(/já registrado/);
    const ncs = await listNcs(cSubst);
    expect(ncs).toHaveLength(1);
    ncId = ncs[0]!.id;
    expect(ncs[0]!).toMatchObject({ code: `NC-${year}-001`, origin: 'AUDITORIA', severity: 'MAIOR', status: 'ABERTA', responsible_user_id: cCoord.principal.userId, sector_id: I.sectors.RI });
    expect((await notes(cCoord.principal.userId, 'NC'))[0]!.title).toMatch(/NC-/);
  });

  it('conclusão: itens pendentes impedem; atualiza requisitos; depois fica imutável', async () => {
    await addAuditItem(cSubst, audId, 'Item extra');
    await expect(concludeAudit(cSubst, audId, 'Conclusão da auditoria')).rejects.toThrow(/sem avaliação/);
    const { items } = await getAudit(cSubst, audId);
    for (const it of items.filter((i) => i.result === 'PENDENTE')) await evaluateAuditItem(cSubst, { itemId: it.id, result: 'OBSERVACAO', evidence: 'Oportunidade de melhoria' });
    await expect(concludeAudit(cCoord, audId, 'Conclusão da auditoria')).rejects.toThrow(/auditor líder/);
    await concludeAudit(cSubst, audId, 'Conclusão da auditoria');
    const reqs = await listRequirements(cSubst);
    expect(reqs.find((r) => r.id === reqA)!.status).toBe('ATENDIDO');
    expect(reqs.find((r) => r.id === reqB)!.status).toBe('NAO_ATENDIDO');
    expect((await getRequirement(cSubst, reqA)).reviews).toHaveLength(2);
    await expect(addAuditItem(cSubst, audId, 'Depois')).rejects.toThrow(/imutável/);
    await expect(query(getPool(), "UPDATE audit_items SET evidence = 'adulterada' WHERE audit_id = $1", [audId])).rejects.toThrow(/imutável/);
    await expect(query(getPool(), "UPDATE audits SET conclusion = 'adulterada' WHERE id = $1", [audId])).rejects.toThrow(/imutável/);
  });
});

describe('Fase 5a — tratamento da não conformidade', () => {
  it('causa raiz, ações como tarefas, verificação de eficácia segregada', async () => {
    await expect(submitNcForVerification(cCoord, ncId)).rejects.toThrow(/causa raiz/);
    await setRootCause(cCoord, ncId, 'Falta de acompanhamento da ciência');
    await expect(submitNcForVerification(cCoord, ncId)).rejects.toThrow(/ao menos uma ação/);
    await expect(addAction(cColab, { kind: 'CORRETIVA', ncId, title: 'Ação do colaborador', responsibleUserId: cColab.principal.userId, dueDate: today })).rejects.toThrow(/permissão/);
    await expect(addAction(cSubst, { kind: 'CORRETIVA', riskId: undefined, title: 'Sem vínculo', responsibleUserId: cColab.principal.userId, dueDate: today })).rejects.toThrow(/Vincule/);
    await addAction(cCoord, { kind: 'CORRETIVA', ncId, title: 'Cobrar ciência pendente', responsibleUserId: cColab.principal.userId, dueDate: addDays(today, 5) });
    const { nc, actions } = await getNc(cCoord, ncId);
    expect(nc.status).toBe('EM_TRATAMENTO');
    expect(actions).toHaveLength(1);
    expect(actions[0]!.title).toMatch(/^\[NC-\d{4}-001\] Ação corretiva: Cobrar ciência/);
    await expect(submitNcForVerification(cCoord, ncId)).rejects.toThrow(/ao menos uma ação/);
    await setStatus(cColab, actions[0]!.task_id, 'CONCLUIDA');
    await submitNcForVerification(cCoord, ncId);
    await expect(verifyNc(cCoord, ncId, true, 'Verificado por mim')).rejects.toThrow(/permissão|Segregação/);
    await verifyNc(cSubst, ncId, false, 'Ainda há ciência pendente');
    expect((await getNc(cCoord, ncId)).nc.status).toBe('EM_TRATAMENTO');
    expect((await notes(cCoord.principal.userId, 'NC')).some((n) => /ineficaz/.test(n.title))).toBe(true);
    await submitNcForVerification(cCoord, ncId);
    await verifyNc(cSubst, ncId, true, 'Todas as ciências registradas na reamostragem');
    const done = (await getNc(cSubst, ncId)).nc;
    expect(done.status).toBe('ENCERRADA');
    expect(done.verified_by_name).toBe('Substituta Ficticia');
    // A regra de segregação também está no banco.
    await expect(query(getPool(), 'UPDATE nonconformities SET verified_by = responsible_user_id WHERE id = $1', [ncId])).rejects.toThrow(/check/i);
    await expect(query(getPool(), 'DELETE FROM nonconformities WHERE id = $1', [ncId])).rejects.toThrow(/excluído/);
  });

  it('visibilidade por setor: coordenação de outro setor não vê a NC do RI', async () => {
    expect((await listNcs(cAtd)).map((n) => n.id)).not.toContain(ncId);
    expect((await listNcs(cCoord)).map((n) => n.id)).toContain(ncId);
    await createNc(cSubst, { origin: 'AUTOAVALIACAO', description: 'Fila do atendimento sem triagem', severity: 'MENOR', sectorId: I.sectors.ATD, responsibleUserId: cAtd.principal.userId });
    expect((await listNcs(cAtd)).map((n) => n.description)).toEqual(['Fila do atendimento sem triagem']);
  });
});

describe('Fase 5a — riscos', () => {
  it('avaliação com histórico; aceitar risco alto é da Oficial; ações preventivas', async () => {
    const base = { title: 'Perda de dados', category: 'CONTINUIDADE' as const, probability: 3, impact: 5, controls: 'Backup diário', ownerUserId: cSubst.principal.userId };
    await expect(saveRisk(cCoord, { ...base, treatment: 'MITIGAR' })).rejects.toThrow(/permissão/);
    await expect(saveRisk(cSubst, { ...base, treatment: 'ACEITAR' })).rejects.toThrow(/Oficial/);
    await expect(saveRisk(cSubst, { ...base, treatment: 'MITIGAR', residualProbability: 1 })).rejects.toThrow(/residuais/);
    const r = await saveRisk(cSubst, { ...base, treatment: 'MITIGAR' });
    await saveRisk(cSubst, { ...base, id: r, treatment: 'MITIGAR', residualProbability: 1, residualImpact: 5, notes: 'Teste de restauração implantado' });
    const risk = (await listRisks(cCoord)).find((x) => x.id === r)!;
    expect(risk).toMatchObject({ code: `RSC-${year}-001`, level: 15, residual_probability: 1, next_review_on: risk.next_review_on });
    expect(await riskHistory(cSubst, r)).toHaveLength(2);
    const low = await saveRisk(cSubst, { ...base, title: 'Fila longa', probability: 2, impact: 2, treatment: 'ACEITAR' });
    expect((await queryOne<{ accepted_by: string }>(getPool(), 'SELECT accepted_by FROM risks WHERE id = $1', [low]))!.accepted_by).toBe(cSubst.principal.userId);
    await saveRisk(cOwner, { ...base, title: 'Risco alto aceito pela Oficial', treatment: 'ACEITAR' });
    await addAction(cSubst, { kind: 'PREVENTIVA', riskId: r, title: 'Teste de restauração trimestral', responsibleUserId: cSubst.principal.userId, dueDate: addDays(today, 30) });
    await expect(addAction(cSubst, { kind: 'CORRETIVA', riskId: r, title: 'Corretiva sem NC', responsibleUserId: cSubst.principal.userId, dueDate: today })).rejects.toThrow(/exige não conformidade/);
    expect((await listRisks(cSubst)).find((x) => x.id === r)!.actions).toBe(1);
    await closeRisk(cSubst, low, 'Atendimento reorganizado');
    await expect(saveRisk(cSubst, { ...base, id: low, treatment: 'MITIGAR' })).rejects.toThrow(/encerrado/);
    expect(await riskHistory(cSubst, low)).toHaveLength(2);
  });
});

describe('Fase 5a — incidentes', () => {
  let inc: string;
  it('qualquer colaborador comunica; gestores são avisados sem a descrição', async () => {
    await expect(reportIncident(cColab, { title: 'X', description: 'teste', category: 'OUTRO', detectedAt: new Date(Date.now() + 3600_000) })).rejects.toThrow();
    inc = await reportIncident(cColab, { title: 'Pen drive perdido', description: 'Pen drive com certidões digitalizadas de Fulano perdido', category: 'SEGURANCA_INFORMACAO', severity: 'ALTA',
      detectedAt: new Date(), personalDataInvolved: true });
    for (const u of [cOwner, cSubst]) {
      const n = await notes(u.principal.userId, 'INCIDENTE');
      expect(n).toHaveLength(1);
      expect(n[0]!.title).toMatch(new RegExp(`INC-${year}-001`));
      expect(JSON.stringify(n)).not.toContain('Fulano');
    }
    expect(await notes(cCoord.principal.userId, 'INCIDENTE')).toHaveLength(0);
    expect((await listIncidents(cColab)).map((i) => i.id)).toEqual([inc]);
    expect(await listIncidents(cAtd)).toHaveLength(0);
    await expect(getIncident(cAtd, inc)).rejects.toThrow(/não encontrado/);
    expect((await getIncident(cColab, inc)).canManage).toBe(false);
  });

  it('tratamento: contenção, causa raiz, avaliação LGPD e ações antes do encerramento', async () => {
    await expect(treatIncident(cColab, inc, { containment: 'x x x' })).rejects.toThrow(/permissão/);
    await expect(treatIncident(cSubst, inc, { personalDataInvolved: false })).rejects.toThrow(/não é removido/);
    await treatIncident(cSubst, inc, { containment: 'Senhas trocadas e arquivos revogados' });
    expect((await getIncident(cSubst, inc)).incident.status).toBe('CONTIDO');
    await expect(closeIncident(cSubst, inc)).rejects.toThrow(/causa raiz/);
    await treatIncident(cSubst, inc, { rootCause: 'Uso de mídia removível sem criptografia' });
    await expect(closeIncident(cSubst, inc)).rejects.toThrow(/LGPD/);
    await recordLgpdAssessment(cSubst, inc, 'Avaliado com o encarregado: risco relevante; decisão registrada pela Oficial (fictício).');
    await addAction(cSubst, { kind: 'PREVENTIVA', incidentId: inc, title: 'Bloquear mídias removíveis', responsibleUserId: cSubst.principal.userId, dueDate: addDays(today, 7) });
    await expect(closeIncident(cSubst, inc)).rejects.toThrow(/em aberto/);
    const { actions } = await getIncident(cSubst, inc);
    await setStatus(cSubst, actions[0]!.task_id, 'CONCLUIDA');
    await closeIncident(cSubst, inc, 'Política de mídias atualizada');
    const done = await getIncident(cSubst, inc);
    expect(done.incident.status).toBe('ENCERRADO');
    expect(done.events.map((e) => e.event)).toEqual(['COMUNICADO', 'CONTIDO', 'TRATAMENTO', 'AVALIACAO_LGPD', 'ENCERRADO']);
    await expect(treatIncident(cSubst, inc, { notes: 'depois' })).rejects.toThrow(/encerrado/);
    await expect(query(getPool(), 'DELETE FROM incidents WHERE id = $1', [inc])).rejects.toThrow(/excluído/);
    await expect(query(getPool(), "UPDATE incident_events SET notes = 'x'")).rejects.toThrow(/imutável|não pode/i);
  });
});

describe('Fase 5a — ativos, backups e vulnerabilidades', () => {
  it('inventário com movimentação; baixa bloqueada por vulnerabilidade aberta', async () => {
    await expect(saveAsset(cCoord, { tag: 'PAT-1', name: 'Servidor', kind: 'SERVIDOR' })).rejects.toThrow(/permissão/);
    const srv = await saveAsset(cSubst, { tag: 'PAT-1', name: 'Servidor', kind: 'SERVIDOR', location: 'Sala técnica', criticality: 'ALTA' });
    await expect(saveAsset(cSubst, { tag: 'PAT-1', name: 'Outro', kind: 'OUTRO' })).rejects.toThrow(/identificação/);
    await saveAsset(cSubst, { id: srv, tag: 'PAT-1', name: 'Servidor', kind: 'SERVIDOR', location: 'Sala nova', criticality: 'ALTA' });
    expect((await assetEvents(cSubst, srv)).map((e) => e.event)).toEqual(['MOVIMENTACAO', 'CADASTRO']);
    const v = await registerVulnerability(cSubst, { title: 'Patch pendente', source: 'Boletim', assetId: srv, severity: 'ALTA', detectedOn: addDays(today, -2) });
    expect((await listVulnerabilities(cSubst)).find((x) => x.id === v)!.due_on).toBe(addDays(today, 28));
    await expect(disposeAsset(cSubst, srv, 'Substituído')).rejects.toThrow(/vulnerabilidades em aberto/);
    await expect(updateVulnerability(cSubst, v, 'RISCO_ACEITO', 'Sem correção disponível')).rejects.toThrow(/Oficial/);
    await expect(updateVulnerability(cSubst, v, 'CORRIGIDA')).rejects.toThrow(/Descreva/);
    await updateVulnerability(cSubst, v, 'CORRIGIDA', 'Atualização aplicada em janela de manutenção');
    await expect(updateVulnerability(cSubst, v, 'EM_TRATAMENTO')).rejects.toThrow(/encerrada/);
    await disposeAsset(cSubst, srv, 'Substituído; discos sanitizados');
    expect((await listAssets(cCoord)).find((a) => a.id === srv)!.status).toBe('BAIXADO');
    await expect(saveAsset(cSubst, { id: srv, tag: 'PAT-1', name: 'Servidor', kind: 'SERVIDOR' })).rejects.toThrow(/baixado/);
    await expect(listAssets(cColab)).rejects.toThrow(/permissão/);
  });

  it('backups: registros imutáveis; falha avisa; teste de restauração vencido aparece', async () => {
    await expect(recordBackup(cSubst, { kind: 'BACKUP', system: 'SGI', performedOn: addDays(today, 1), result: 'SUCESSO' })).rejects.toThrow(/futuro/);
    await expect(recordBackup(cSubst, { kind: 'BACKUP', system: 'SGI', performedOn: today, result: 'FALHA' })).rejects.toThrow(/Descreva/);
    await recordBackup(cSubst, { kind: 'BACKUP', system: 'SGI', performedOn: today, result: 'FALHA', notes: 'Disco cheio' });
    expect((await notes(cOwner.principal.userId, 'BACKUP'))[0]!.title).toMatch(/falha/);
    await recordBackup(cSubst, { kind: 'TESTE_RESTAURACAO', system: 'SGI', performedOn: addDays(today, -100), result: 'SUCESSO' }, PDF);
    const { status, rows } = await listBackups(cSubst);
    expect(status[0]).toMatchObject({ system: 'SGI', lastBackupResult: 'FALHA', restoreOverdue: true, daysSinceRestore: 100 });
    expect(rows).toHaveLength(2);
    await expect(query(getPool(), "UPDATE backup_records SET result = 'SUCESSO'")).rejects.toThrow(/imutável|não pode/i);
  });
});

describe('Fase 5a — painel e lembretes', () => {
  it('painel por perfil: incidentes apenas para gestores', async () => {
    const s = await qualityOverview(cSubst);
    expect(s.compliance!.pct).toBe(50);
    expect(s.ncs!.open).toBe(1); // a do RI foi encerrada; a do atendimento segue aberta
    expect(s.ncs!.closed_12m).toBe(1);
    expect(s.incidents).toBeDefined();
    expect(s.backups![0]!.restoreOverdue).toBe(true);
    const c = await qualityOverview(cCoord);
    expect(c.compliance).toBeDefined();
    expect(c.incidents).toBeUndefined();
    await expect(qualityOverview(cColab)).rejects.toThrow(/permissão/);
  });

  it('lembretes enviados uma única vez', async () => {
    await query(getPool(), 'UPDATE quality_requirements SET next_review_on = $1 WHERE id = $2', [addDays(today, -1), reqB]);
    await query(getPool(), "INSERT INTO audits (code, title, kind, scope, lead_auditor_id, planned_date, created_by) VALUES ('AUD-X','Próxima','INTERNA','Escopo',$1,$2,$1)", [cSubst.principal.userId, addDays(today, 3)]);
    const first = await processQualityReminders();
    expect(first).toBeGreaterThanOrEqual(3); // requisito, auditoria próxima, restauração em atraso
    expect(await processQualityReminders()).toBe(0);
    expect((await notes(cCoord.principal.userId, 'QUALIDADE')).some((n) => /T-02/.test(n.title))).toBe(true);
    expect((await notes(cOwner.principal.userId, 'BACKUP')).some((n) => /restauração de SGI em atraso/.test(n.title))).toBe(true);
  });

  it('trilha de auditoria íntegra', async () => {
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
