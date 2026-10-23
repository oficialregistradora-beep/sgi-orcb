import { writeFileSync, mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../src/server/db.ts';
import type { Ctx } from '../../src/server/context.ts';
import {
  addAction, concludeAudit, createAudit, evaluateAuditItem, getAudit, getNc, listNcs, listRequirements, reviewRequirement, addRequirementEvidence, saveRequirement, saveRisk,
  setRootCause, startAudit, submitNcForVerification, verifyNc,
} from '../../src/server/modules/quality.ts';
import {
  closeIncident, getIncident, processQualityReminders, qualityOverview, recordBackup, recordLgpdAssessment, registerVulnerability, reportIncident, treatIncident, updateVulnerability,
} from '../../src/server/modules/security.ts';
import { setStatus } from '../../src/server/modules/tasks.ts';
import { verifyAuditChain } from '../../src/server/audit.ts';
import { complianceIndex, type ReqStatus } from '../../src/domain/quality.ts';
import { addDays, todayLocal } from '../../src/domain/time.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../helpers.ts';

// RODADA 3 (Fase 5a) — 12 ciclos mensais de operação da qualidade: auditorias com não conformidades aleatórias,
// ações concluídas com atrasos, verificações de eficácia por vezes ineficazes, incidentes (parte com dados pessoais),
// backups com falhas ocasionais, vulnerabilidades e reavaliação de riscos. Ao final, as invariantes devem valer.

const metrics: Record<string, number> = {};
let seed = 5101;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
let cOwner: Ctx, cSubst: Ctx;
const coords: Ctx[] = [];
const staff: Ctx[] = [];

beforeAll(async () => {
  await resetDatabase();
  const I = await ids();
  cOwner = await ctxFor((await makePerson({ name: 'Oficial Sim', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true })).userId);
  cSubst = await ctxFor((await makePerson({ name: 'Substituta Sim', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] })).userId);
  for (const s of [I.sectors.RI, I.sectors.RCPN, I.sectors.ATD]) {
    coords.push(await ctxFor((await makePerson({ name: 'Coord', sectorId: s, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }, { roleId: I.roles.COORDENACAO_SETOR }] })).userId));
    for (let k = 0; k < 2; k++) staff.push(await ctxFor((await makePerson({ name: `Colab ${k}`, sectorId: s, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }] })).userId));
  }
});
afterAll(async () => {
  mkdirSync('docs/test-reports', { recursive: true });
  writeFileSync('docs/test-reports/rodada3-fase5a-metricas.json', JSON.stringify({ executadoEm: new Date().toISOString(), metricas: metrics }, null, 2));
  await closePool();
});

describe('Rodada 3 (5a) — um ano de gestão da qualidade', () => {
  it('opera 12 ciclos e mantém as invariantes', async () => {
    const today = todayLocal();
    const db = getPool();
    // 18 requisitos em 3 áreas, cada um sob responsabilidade de uma coordenação.
    const areas = ['Documentação', 'Atendimento', 'Segurança'];
    for (let i = 0; i < 18; i++) await saveRequirement(cSubst, { code: `SIM-${i + 1}`, title: `Requisito simulado ${i + 1}`, source: 'Fonte fictícia', area: areas[i % 3]!, ownerUserId: coords[i % 3]!.principal.userId });
    for (const r of await listRequirements(cSubst)) if (rnd() < 0.5) { await addRequirementEvidence(cSubst, r.id, { description: 'Evidência inicial' }); await reviewRequirement(cSubst, r.id, 'ATENDIDO'); }
    for (let i = 0; i < 6; i++) await saveRisk(cSubst, { title: `Risco ${i}`, category: pick(['OPERACIONAL', 'CONTINUIDADE', 'DADOS_PESSOAIS'] as const), probability: 1 + Math.floor(rnd() * 5), impact: 1 + Math.floor(rnd() * 3), treatment: 'MITIGAR', ownerUserId: cSubst.principal.userId });

    let audits = 0, ncsOpened = 0, ineffective = 0, incidents = 0, personal = 0, backupFailures = 0, vulns = 0, lateActions = 0, reminders = 0;
    for (let month = 0; month < 12; month++) {
      // Auditoria do mês sobre uma área, conduzida pela Substituta (independente dos setores).
      const area = areas[month % 3]!;
      const aud = await createAudit(cSubst, { title: `Auditoria ${month + 1}`, kind: 'INTERNA', scope: area, leadAuditorId: cSubst.principal.userId, plannedDate: today, importArea: area });
      await startAudit(cSubst, aud);
      for (const it of (await getAudit(cSubst, aud)).items) {
        const x = rnd();
        if (x < 0.2) { await evaluateAuditItem(cSubst, { itemId: it.id, result: 'NAO_CONFORME', evidence: 'Falha constatada na amostra', ncResponsibleId: pick(coords).principal.userId }); ncsOpened++; }
        else if (x < 0.3) await evaluateAuditItem(cSubst, { itemId: it.id, result: 'OBSERVACAO', evidence: 'Oportunidade de melhoria' });
        else await evaluateAuditItem(cSubst, { itemId: it.id, result: 'CONFORME', evidence: 'Conforme na amostra' });
      }
      await concludeAudit(cSubst, aud, `Auditoria do mês ${month + 1} concluída`);
      audits++;

      // Tratamento das NCs abertas: causa, ação, conclusão (às vezes atrasada), verificação (às vezes ineficaz).
      for (const n of (await listNcs(cSubst)).filter((x) => x.status === 'ABERTA' || x.status === 'EM_TRATAMENTO')) {
        const resp = [...coords].find((c) => c.principal.userId === n.responsible_user_id)!;
        if (rnd() < 0.25) continue; // fica para o próximo ciclo
        await setRootCause(resp, n.id, 'Análise dos 5 porquês');
        const doer = staff.find((s) => s.principal.employeeSectorId === resp.principal.employeeSectorId)!;
        const late = rnd() < 0.3;
        await addAction(resp, { kind: 'CORRETIVA', ncId: n.id, title: `Corrigir ${n.code}`, responsibleUserId: doer.principal.userId, dueDate: late ? addDays(today, -3) : addDays(today, 10) });
        if (late) lateActions++;
        for (const a of (await getNc(resp, n.id)).actions.filter((a) => a.status !== 'CONCLUIDA' && a.status !== 'CANCELADA')) await setStatus(doer, a.task_id, 'CONCLUIDA');
        await submitNcForVerification(resp, n.id);
        const ok = rnd() >= 0.2;
        await verifyNc(cSubst, n.id, ok, ok ? 'Reamostragem sem falhas' : 'Falha voltou a ocorrer');
        if (!ok) ineffective++;
      }

      // Incidentes comunicados por colaboradores; tratados e encerrados no mesmo ciclo em 70% dos casos.
      for (let k = 0; k < 2; k++) {
        if (rnd() < 0.5) continue;
        const pd = rnd() < 0.4;
        const inc = await reportIncident(pick(staff), { title: `Incidente ${month}-${k}`, description: 'Descrição fictícia', category: pd ? 'DADOS_PESSOAIS' : 'OPERACIONAL', detectedAt: new Date() });
        incidents++; if (pd) personal++;
        if (rnd() < 0.7) {
          await treatIncident(cSubst, inc, { containment: 'Contido', rootCause: 'Causa identificada' });
          if (pd) await recordLgpdAssessment(cSubst, inc, 'Avaliação registrada com o encarregado (fictício)');
          await closeIncident(cSubst, inc);
        }
      }

      // Backups semanais (falha ocasional) e teste de restauração trimestral.
      for (let w = 0; w < 4; w++) {
        const fail = rnd() < 0.08;
        await recordBackup(cSubst, { kind: 'BACKUP', system: pick(['SGI', 'Arquivos']), performedOn: addDays(today, -(11 - month) * 30 - w * 7), result: fail ? 'FALHA' : 'SUCESSO', notes: fail ? 'Falha de mídia' : undefined });
        if (fail) backupFailures++;
      }
      if (month % 3 === 2) for (const s of ['SGI', 'Arquivos']) await recordBackup(cSubst, { kind: 'TESTE_RESTAURACAO', system: s, performedOn: addDays(today, -(11 - month) * 30), result: 'SUCESSO' });

      // Vulnerabilidades: registradas e, em geral, corrigidas.
      if (rnd() < 0.6) {
        const v = await registerVulnerability(cSubst, { title: `Vulnerabilidade ${month}`, source: 'Boletim', severity: pick(['BAIXA', 'MEDIA', 'ALTA', 'CRITICA'] as const), detectedOn: today });
        vulns++;
        if (rnd() < 0.8) await updateVulnerability(cSubst, v, 'CORRIGIDA', 'Correção aplicada');
      }
      reminders += await processQualityReminders();
    }
    Object.assign(metrics, { auditorias: audits, ncs_abertas_em_auditoria: ncsOpened, verificacoes_ineficazes: ineffective, acoes_atrasadas: lateActions, incidentes: incidents,
      incidentes_dados_pessoais: personal, falhas_de_backup: backupFailures, vulnerabilidades: vulns, lembretes: reminders });

    // Invariantes ---------------------------------------------------------------------------------------------
    // 1. NC encerrada: causa raiz, verificador ≠ responsável, nenhuma ação em aberto; toda NC de auditoria tem item NAO_CONFORME.
    const bad = await query(db, `SELECT n.code FROM nonconformities n WHERE n.status = 'ENCERRADA' AND (n.root_cause IS NULL OR n.verified_by = n.responsible_user_id
      OR EXISTS (SELECT 1 FROM quality_actions a JOIN tasks t ON t.id = a.task_id WHERE a.nc_id = n.id AND t.status NOT IN ('CONCLUIDA','CANCELADA')))`);
    expect(bad).toHaveLength(0);
    expect((await queryOne<{ n: number }>(db, "SELECT count(*)::int AS n FROM nonconformities n JOIN audit_items i ON i.id = n.audit_item_id WHERE i.result <> 'NAO_CONFORME'"))!.n).toBe(0);
    expect((await queryOne<{ n: number }>(db, "SELECT count(*)::int AS n FROM nonconformities WHERE origin = 'AUDITORIA'"))!.n).toBe(ncsOpened);
    // 2. Auditorias concluídas sem itens pendentes.
    expect((await queryOne<{ n: number }>(db, "SELECT count(*)::int AS n FROM audits a JOIN audit_items i ON i.audit_id = a.id WHERE a.status = 'CONCLUIDA' AND i.result = 'PENDENTE'"))!.n).toBe(0);
    // 3. Incidentes com dados pessoais só encerrados com avaliação LGPD.
    expect((await queryOne<{ n: number }>(db, "SELECT count(*)::int AS n FROM incidents WHERE status = 'ENCERRADO' AND personal_data_involved AND lgpd_assessment IS NULL"))!.n).toBe(0);
    // 4. Códigos sem lacunas nem repetições por prefixo.
    for (const [table, prefix] of [['nonconformities', 'NC'], ['incidents', 'INC'], ['audits', 'AUD']] as const) {
      const codes = (await query<{ code: string }>(db, `SELECT code FROM ${table} ORDER BY code`)).map((r) => Number(r.code.split('-')[2]));
      expect(codes).toEqual(codes.map((_, i) => i + 1));
    }
    // 5. Índice do painel = cálculo independente sobre os requisitos.
    const statuses = (await query<{ status: ReqStatus }>(db, 'SELECT status FROM quality_requirements WHERE active')).map((r) => r.status);
    const o = await qualityOverview(cOwner);
    expect(o.compliance!.pct).toBe(complianceIndex(statuses).pct);
    expect(statuses.filter((s) => s === 'NAO_AVALIADO')).toHaveLength(0); // todas as áreas auditadas 4 vezes
    // 6. Histórico do requisito = 1 avaliação inicial (se houve) + 1 por auditoria da área.
    const hist = await query<{ n: number; initial: number }>(db, `SELECT count(*)::int AS n, count(*) FILTER (WHERE notes IS NULL)::int AS initial FROM requirement_reviews GROUP BY requirement_id`);
    for (const h of hist) expect(h.n - h.initial).toBe(4);
    // 7. Lembretes: um por chave.
    expect(await processQualityReminders()).toBe(0);
    // 8. Incidentes em aberto aparecem no painel.
    expect(o.incidents!.open).toBe((await queryOne<{ n: number }>(db, "SELECT count(*)::int AS n FROM incidents WHERE status <> 'ENCERRADO'"))!.n);
    metrics.ncs_encerradas = (await queryOne<{ n: number }>(db, "SELECT count(*)::int AS n FROM nonconformities WHERE status = 'ENCERRADA'"))!.n;
    metrics.indice_atendimento = o.compliance!.pct ?? -1;
    void getIncident;
  });

  it('trilha de auditoria íntegra', async () => {
    expect((await verifyAuditChain(getPool())).ok).toBe(true);
  });
});
