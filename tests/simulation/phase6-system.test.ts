import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../src/server/db.ts';
import { canonicalJson, sha256Hex } from '../../src/server/crypto.ts';
import { verifyAuditChain } from '../../src/server/audit.ts';
import { runDailyRoutine } from '../../src/server/modules/daily.ts';
import { closePool, resetDatabase } from '../helpers.ts';

// RODADA 3 (Fase 6) — sistema inteiro: carga fictícia completa (todos os módulos), rotina diária completa executada
// várias vezes (deve ser idempotente) e verificação de integridade de TODOS os registros com hash do banco.

const metrics: Record<string, unknown> = {};
beforeAll(async () => {
  await resetDatabase();
  execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/seed.ts'], { env: { ...process.env }, stdio: 'pipe', timeout: 240_000 });
}, 300_000);
afterAll(async () => {
  mkdirSync('docs/test-reports', { recursive: true });
  writeFileSync('docs/test-reports/rodada3-fase6-sistema.json', JSON.stringify({ executadoEm: new Date().toISOString(), metricas: metrics }, null, 2));
  await closePool();
});

const counts = async () => (await queryOne<{ notificacoes: number; tarefas: number; avaliacoes: number; fila: number; automacoes: number; lembretes: number }>(getPool(), `SELECT
  (SELECT count(*)::int FROM notifications) AS notificacoes, (SELECT count(*)::int FROM tasks) AS tarefas, (SELECT count(*)::int FROM evaluations) AS avaliacoes,
  (SELECT count(*)::int FROM integration_outbox) AS fila, (SELECT count(*)::int FROM automation_runs) AS automacoes, (SELECT count(*)::int FROM reminder_log) AS lembretes`))!;

describe('Rodada 3 (Fase 6) — sistema inteiro', () => {
  it('a rotina diária completa converge: a segunda execução não gera nada novo', async () => {
    const before = await counts();
    const first = await runDailyRoutine();
    const afterFirst = await counts();
    const second = await runDailyRoutine();
    const afterSecond = await counts();
    const third = await runDailyRoutine();
    metrics.antes = before; metrics.primeiraExecucao = first; metrics.depoisDaPrimeira = afterFirst; metrics.segundaExecucao = second;
    expect(afterFirst.notificacoes).toBeGreaterThan(before.notificacoes); // a carga tem pendências que geram avisos
    expect(afterSecond).toEqual(afterFirst);
    expect(await counts()).toEqual(afterFirst);
    for (const k of ['avisosDeRevisao', 'tarefasDeRotina', 'avisosDePrazo', 'avisosDeVencimento', 'avisosDeQualidade', 'avisosDeTreinamento', 'avaliacoesGeradas', 'avisosDeAvaliacao'] as const) {
      expect(third[k], k).toBe(0);
    }
    expect(third.automacoes.fired).toBe(0);
  }, 300_000);

  it('todo conteúdo versionado confere com o hash registrado; toda assinatura aponta para o hash da versão', async () => {
    const versions = await query<{ id: string; content: unknown; content_sha256: string }>(getPool(), 'SELECT id, content, content_sha256 FROM document_versions');
    const bad = versions.filter((v) => sha256Hex(canonicalJson(v.content)) !== v.content_sha256).map((v) => v.id);
    expect(bad).toEqual([]);
    const sig = await queryOne<{ n: number; total: number }>(getPool(),
      'SELECT count(*) FILTER (WHERE s.content_sha256 <> v.content_sha256)::int AS n, count(*)::int AS total FROM signatures s JOIN document_versions v ON v.id = s.document_version_id');
    expect(sig!.n).toBe(0);
    metrics.versoes = versions.length; metrics.assinaturas = sig!.total;
  });

  it('todo arquivo armazenado no banco confere com o SHA-256 e o tamanho registrados', async () => {
    const files = await query<{ id: string; data: Buffer | null; sha256: string; size_bytes: number }>(getPool(),
      "SELECT id, data, sha256, size_bytes FROM document_files WHERE storage = 'BANCO' AND purged_at IS NULL");
    const bad = files.filter((f) => !f.data || f.data.length !== f.size_bytes || sha256Hex(f.data) !== f.sha256).map((f) => f.id);
    expect(bad).toEqual([]);
    expect(files.length).toBeGreaterThanOrEqual(3);
    metrics.arquivos = files.length;
  });

  it('nenhum registro órfão de vínculo entre módulos e trilha de auditoria íntegra', async () => {
    const db = getPool();
    // Tarefas de ações da qualidade, inscrições do PDI e documentos de avaliação existem e pertencem à mesma pessoa.
    expect((await queryOne<{ n: number }>(db, `SELECT count(*)::int AS n FROM evaluations v JOIN documents d ON d.id = v.document_id WHERE d.owner_employee_id <> v.employee_id`))!.n).toBe(0);
    expect((await queryOne<{ n: number }>(db, `SELECT count(*)::int AS n FROM training_sessions s LEFT JOIN institutional_events e ON e.id = s.event_id WHERE e.id IS NULL`))!.n).toBe(0);
    const chain = await verifyAuditChain(db);
    expect(chain.ok).toBe(true);
    metrics.registrosDeAuditoria = (await queryOne<{ n: number }>(db, 'SELECT count(*)::int AS n FROM audit_log'))!.n;
  });
});
