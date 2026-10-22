import { writeFileSync, mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../src/server/db.ts';
import type { Ctx } from '../../src/server/context.ts';
import {
  acknowledge, acknowledgementReport, changeLifecycle, createDocument, decideVersion, exportVersion, getDocument, listCategories,
  listDocuments, listPendingAcknowledgements, listPendingDocApprovals, processReviewReminders, saveDraft, submitForApproval,
} from '../../src/server/modules/repository.ts';
import { verifyAuditChain } from '../../src/server/audit.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../helpers.ts';

// RODADA 3 (Fase 3) — acervo de 40 documentos nas 21 categorias, 3 ciclos de revisão, rejeições sorteadas,
// ciência por 12 pessoas em 5 setores e verificação de consistência global (acesso, hashes, ciência, trilha).

const metrics: Record<string, number> = {};
let seed = 31;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
let cOwner: Ctx, cSubst: Ctx;
const staff: { ctx: Ctx; sector: string; coord: boolean }[] = [];
const docs: { id: string; sector: string; confidential: boolean; ack: boolean; audience: 'TODOS' | 'SETORES' | 'USUARIOS'; listed: string[]; author: string }[] = [];
let I: Awaited<ReturnType<typeof ids>>;

beforeAll(async () => {
  await resetDatabase();
  I = await ids();
  const o = await makePerson({ name: 'Oficial Simulada', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
  const s = await makePerson({ name: 'Substituta Simulada', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] });
  cOwner = await ctxFor(o.userId);
  cSubst = await ctxFor(s.userId);
  const sectors = [I.sectors.RI, I.sectors.RCPN, I.sectors.RTDPJ, I.sectors.ATD, I.sectors.DIR];
  for (let i = 0; i < 10; i++) {
    const sector = sectors[i % sectors.length]!;
    const coord = i < 4; // um coordenador para RI, RCPN, RTDPJ e ATD
    const p = await makePerson({
      name: `Pessoa ${i}`, sectorId: sector, jobId: I.jobs.escrevente,
      roles: coord ? [{ roleId: I.roles.COLABORADOR }, { roleId: I.roles.COORDENACAO_SETOR }] : [{ roleId: I.roles.COLABORADOR }],
    });
    staff.push({ ctx: await ctxFor(p.userId), sector, coord });
  }
});
afterAll(async () => {
  mkdirSync('docs/test-reports', { recursive: true });
  writeFileSync('docs/test-reports/rodada3-fase3-metricas.json', JSON.stringify({ executadoEm: new Date().toISOString(), metricas: metrics }, null, 2));
  await closePool();
});

describe('Rodada 3 — acervo documental simulado', () => {
  it('cria 40 documentos em todas as categorias, com autores conforme o escopo', async () => {
    const cats = await listCategories();
    const coords = staff.filter((s) => s.coord);
    for (let i = 0; i < 40; i++) {
      const cat = cats[i % cats.length]!;
      const confidential = cat.default_confidentiality === 'CONFIDENCIAL';
      // Confidenciais elaborados pela coordenação: verifica-se adiante que a gestão (Substituta) não os alcança.
      const author = i % 3 === 0 && !confidential ? { ctx: cSubst, sector: I.sectors.DIR } : coords[i % coords.length]!;
      const audience: 'TODOS' | 'SETORES' | 'USUARIOS' = confidential ? 'USUARIOS' : cat.default_confidentiality === 'RESTRITO' || i % 4 === 1 ? 'SETORES' : 'TODOS';
      const listed = confidential ? [staff[(i + 5) % staff.length]!.ctx.principal.userId] : [];
      const id = await createDocument(author.ctx, {
        categoryId: cat.id, title: `${cat.name} — documento ${i}`, code: `SIM-${String(i).padStart(3, '0')}`, sectorId: author.sector,
        audienceType: audience, audienceSectorIds: audience === 'SETORES' ? [author.sector] : [], audienceUserIds: listed,
        requiresAcknowledgement: i % 2 === 0,
      });
      await saveDraft(author.ctx, id, { texto: `Procedimento ${i}: etapa A, etapa B, conferência e arquivamento (fictício).`, notaVersao: 'Inicial' });
      await submitForApproval(author.ctx, id);
      docs.push({ id, sector: author.sector, confidential, ack: i % 2 === 0, audience, listed, author: author.ctx.principal.userId });
    }
    metrics.documentos = docs.length;
    metrics.confidenciais = docs.filter((d) => d.confidential).length;
    expect(metrics.confidenciais).toBeGreaterThan(0);
  });

  it('três ciclos: decisão (com ~20% de rejeição), ciência e revisão', async () => {
    let approvals = 0, rejections = 0, acks = 0, revisions = 0;
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const d of docs) {
        // Aprovadores sem pendência visível nunca decidem (segregação/confidencialidade): tenta Substituta, depois Oficial.
        for (let guard = 0; guard < 10; guard++) {
          const { doc } = await getDocument(cOwner, d.id);
          if (!doc.pending_version_id) break;
          const approver = (await listPendingDocApprovals(cSubst)).some((p) => p.id === d.id) ? cSubst : cOwner;
          if (guard < 3 && rnd() < 0.2) {
            await decideVersion(approver, d.id, { versionId: doc.pending_version_id, decision: 'REJEITADA', notes: 'Ajustar redação (simulação)' });
            rejections++;
            const editor = d.sector === I.sectors.DIR ? cSubst : staff.find((s) => s.coord && s.sector === d.sector)!.ctx;
            await submitForApproval(editor, d.id);
          } else {
            await decideVersion(approver, d.id, { versionId: doc.pending_version_id, decision: 'APROVADA', confirmed: true });
            approvals++;
          }
        }
      }
      for (const s of [...staff.map((x) => x.ctx), cOwner, cSubst]) {
        for (const p of await listPendingAcknowledgements(s)) {
          if (rnd() < 0.85) { await acknowledge(s, p.id, true); acks++; }
        }
      }
      if (cycle < 2) {
        for (const d of docs.filter((_, i) => i % 2 === cycle % 2)) {
          const editor = d.sector === I.sectors.DIR ? cSubst : staff.find((s) => s.coord && s.sector === d.sector)!.ctx;
          await saveDraft(editor, d.id, { texto: `Revisão ${cycle + 1} (fictício).`, notaVersao: `Revisão ${cycle + 1}` });
          await submitForApproval(editor, d.id);
          revisions++;
        }
      }
    }
    Object.assign(metrics, { aprovacoes: approvals, rejeicoes: rejections, ciencias: acks, revisoes: revisions });
    expect(rejections).toBeGreaterThan(0);
    const pending = (await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM documents WHERE reference_type='REPOSITORIO' AND pending_version_id IS NOT NULL"))!.n;
    expect(pending).toBe(0);
  });

  it('consistência: cada documento tem exatamente uma versão vigente aprovada, as demais superadas', async () => {
    const bad = await query(getPool(), `
      SELECT d.id FROM documents d WHERE d.reference_type = 'REPOSITORIO' AND (
        d.status <> 'VIGENTE'
        OR (SELECT count(*) FROM document_version_reviews r JOIN document_versions v ON v.id = r.version_id
             WHERE v.document_id = d.id AND r.decision = 'APROVADA' AND r.superseded_at IS NULL) <> 1
        OR NOT EXISTS (SELECT 1 FROM document_version_reviews r WHERE r.version_id = d.current_version_id AND r.decision = 'APROVADA' AND r.superseded_at IS NULL))`);
    expect(bad).toEqual([]);
    metrics.versoes = (await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.reference_type='REPOSITORIO'"))!.n;
  });

  it('consistência: toda aprovação tem assinatura vinculada ao hash; nenhum aprovador decidiu versão própria', async () => {
    const r = await queryOne<{ sem_assinatura: number; hash_divergente: number; autoaprovacao: number }>(getPool(), `
      SELECT count(*) FILTER (WHERE g.id IS NULL)::int AS sem_assinatura,
             count(*) FILTER (WHERE g.content_sha256 <> v.content_sha256)::int AS hash_divergente,
             count(*) FILTER (WHERE r.decided_by = r.submitted_by OR r.decided_by::text = v.content->'elaboradoPor'->>'id')::int AS autoaprovacao
        FROM document_version_reviews r JOIN document_versions v ON v.id = r.version_id LEFT JOIN signatures g ON g.id = r.signature_id
       WHERE r.decision = 'APROVADA'`);
    expect(r).toEqual({ sem_assinatura: 0, hash_divergente: 0, autoaprovacao: 0 });
  });

  it('consistência de acesso: cada pessoa vê exatamente o que o público e a confidencialidade permitem', async () => {
    let checks = 0;
    for (const s of staff) {
      const visible = new Set((await listDocuments(s.ctx)).map((d) => d.id));
      for (const d of docs) {
        const editorScope = (s.coord && s.sector === d.sector && !d.confidential) || d.author === s.ctx.principal.userId;
        const inAudience = d.confidential ? d.listed.includes(s.ctx.principal.userId)
          : d.audience === 'TODOS' || (d.audience === 'SETORES' && s.sector === d.sector);
        expect(visible.has(d.id), `${s.ctx.principal.displayName} × ${d.id}`).toBe(inAudience || editorScope);
        checks++;
      }
    }
    metrics.verificacoes_de_acesso = checks;
    const substVisible = new Set((await listDocuments(cSubst)).map((d) => d.id));
    expect(docs.filter((d) => d.confidential).every((d) => !substVisible.has(d.id))).toBe(true);
  });

  it('cobertura de ciência confere com as assinaturas registradas', async () => {
    let total = 0, done = 0;
    for (const d of docs.filter((x) => x.ack)) {
      const rep = await acknowledgementReport(cOwner, d.id);
      total += rep!.total;
      done += rep!.done;
      const sigs = (await queryOne<{ n: number }>(getPool(), "SELECT count(*)::int AS n FROM signatures g JOIN documents x ON x.current_version_id = g.document_version_id WHERE x.id = $1 AND g.act = 'CIENCIA'", [d.id]))!.n;
      expect(rep!.done).toBe(sigs);
    }
    metrics.ciencia_publico_total = total;
    metrics.ciencia_registrada = done;
    metrics.ciencia_cobertura_pct = Math.round((done / total) * 100);
  });

  it('exportação de todas as versões vigentes verifica conteúdo íntegro', async () => {
    for (const d of docs) {
      const { doc } = await getDocument(cOwner, d.id);
      const pkg = await exportVersion(cOwner, d.id, doc.current_version_id!);
      expect(pkg.verificacao.conteudoIntegro).toBe(true);
    }
  });

  it('revisões vencidas geram aviso único; obsolescência e arquivamento em lote', async () => {
    await query(getPool(), "UPDATE documents SET next_review_on = current_date - 1 WHERE reference_type = 'REPOSITORIO' AND code LIKE 'SIM-00%'");
    metrics.avisos_de_revisao = await processReviewReminders();
    expect(metrics.avisos_de_revisao).toBe(10);
    expect(await processReviewReminders()).toBe(0);
    for (const d of docs.slice(30)) await changeLifecycle(d.confidential ? cOwner : cSubst, d.id, d.confidential ? 'ARQUIVADO' : 'OBSOLETO', 'Substituição em lote (simulação)');
    const inUse = (await listDocuments(cOwner)).length;
    const obsolete = (await listDocuments(cOwner, { status: 'OBSOLETO' })).length;
    metrics.nao_arquivados_apos_lote = inUse;
    expect(inUse + (await listDocuments(cOwner, { status: 'ARQUIVADO' })).length).toBe(40);
    expect(obsolete).toBeGreaterThan(0);
  });

  it('trilha de auditoria íntegra ao final', async () => {
    const r = await verifyAuditChain(getPool());
    metrics.eventos_auditoria = r.total;
    expect(r.ok).toBe(true);
  });
});
