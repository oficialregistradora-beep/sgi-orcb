import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query, queryOne } from '../../../src/server/db.ts';
import type { Ctx } from '../../../src/server/context.ts';
import { getConfig, resetConfigCache } from '../../../src/server/config.ts';
import { exportPKCS8, generateKeyPair } from 'jose';
import { antivirusVersion, parseScanReply, scanBytes } from '../../../src/server/antivirus.ts';
import { driveCheck, resetDriveToken } from '../../../src/server/drive.ts';
import {
  changeLifecycle, createDocument, decideVersion, exportVersion, fileForDownload, getDocument, listCategories, purgeFiles, saveCategory, saveDraft, submitForApproval,
} from '../../../src/server/modules/repository.ts';
import { closePool, ctxFor, ids, makePerson, resetDatabase } from '../../helpers.ts';
import { startFakeDrive } from '../../fakeDrive.ts';

// Rodada 2 (Fase 3b) — antivírus real (ClamAV/clamd) e armazenamento no Google Drive (API simulada).
// Requer clamd em TEST_CLAMAV_HOST:TEST_CLAMAV_PORT (padrão 127.0.0.1:3310) com assinatura que detecte o arquivo EICAR.
// SKIP_CLAMAV=1 pula somente o bloco do antivírus (e o relatório deve registrar o pulo).

const CLAM_HOST = process.env.TEST_CLAMAV_HOST ?? '127.0.0.1';
const CLAM_PORT = process.env.TEST_CLAMAV_PORT ?? '3310';
// Arquivo de teste padrão da indústria (EICAR): inofensivo, detectado por qualquer antivírus.
const EICAR = new TextEncoder().encode('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
const PDF = new TextEncoder().encode('%PDF-1.4\n%arquivo fictício\n%%EOF\n');
const ENV_KEYS = ['CLAMAV_HOST', 'CLAMAV_PORT', 'APP_ENV', 'DOCUMENT_STORAGE', 'GOOGLE_DRIVE_SHARED_DRIVE_ID', 'GOOGLE_DRIVE_FOLDER_ID', 'GOOGLE_DRIVE_SA_KEY', 'GOOGLE_DRIVE_API_URL', 'GOOGLE_OAUTH_TOKEN_URL'];

function setEnv(v: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, x] of Object.entries(v)) if (x !== undefined) process.env[k] = x;
  resetConfigCache();
  resetDriveToken();
}

let cOwner: Ctx, cSubst: Ctx, cCoord: Ctx;
let I: Awaited<ReturnType<typeof ids>>;
let catPop: string;

async function newDoc(title: string) {
  return createDocument(cCoord, { categoryId: catPop, title, sectorId: I.sectors.RI, audienceType: 'TODOS' });
}
const lastAudit = async (action: string) => queryOne<{ summary: string }>(getPool(), 'SELECT summary FROM audit_log WHERE action = $1 ORDER BY id DESC LIMIT 1', [action]);
const fileOf = async (docId: string) => queryOne<{ id: string; storage: string; drive_file_id: string | null; data: Buffer | null; scan_status: string; scan_engine: string | null }>(
  getPool(), "SELECT f.* FROM document_files f WHERE f.id = (SELECT (draft->>'arquivoId')::uuid FROM documents WHERE id = $1)", [docId]);

beforeAll(async () => {
  setEnv({});
  await resetDatabase();
  I = await ids();
  const o = await makePerson({ name: 'Oficial Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.oficial, roles: [{ roleId: I.roles.OFICIAL }], owner: true });
  const s = await makePerson({ name: 'Substituta Ficticia', sectorId: I.sectors.DIR, jobId: I.jobs.substituta, roles: [{ roleId: I.roles.SUBSTITUTA_LEGAL }] });
  const c = await makePerson({ name: 'Coord RI', sectorId: I.sectors.RI, jobId: I.jobs.escrevente, roles: [{ roleId: I.roles.COLABORADOR }, { roleId: I.roles.COORDENACAO_SETOR }] });
  cOwner = await ctxFor(o.userId);
  cSubst = await ctxFor(s.userId);
  cCoord = await ctxFor(c.userId);
  catPop = (await listCategories()).find((x) => x.code === 'POP')!.id;
});
afterEach(() => setEnv({}));
afterAll(closePool);

describe('Antivírus — interpretação da resposta do clamd', () => {
  it('limpo, infectado e resposta inesperada', () => {
    expect(parseScanReply('stream: OK', 'ClamAV')).toEqual({ status: 'LIMPO', engine: 'ClamAV' });
    expect(parseScanReply('stream: Win.Test.EICAR_HDB-1 FOUND', 'ClamAV')).toEqual({ status: 'INFECTADO', engine: 'ClamAV', signature: 'Win.Test.EICAR_HDB-1' });
    expect(() => parseScanReply('INSTREAM size limit exceeded. ERROR', 'ClamAV')).toThrow(/inesperada/);
  });
});

describe('Antivírus — política sem antivírus configurado', () => {
  it('fora de produção: aceita e marca NAO_VERIFICADO', async () => {
    const id = await newDoc('Sem antivírus');
    await saveDraft(cCoord, id, { texto: 'x', notaVersao: '' }, { name: 'a.pdf', bytes: PDF });
    expect((await fileOf(id))!.scan_status).toBe('NAO_VERIFICADO');
  });
  it('em produção: recusa o anexo (falha fechada)', async () => {
    process.env.APP_URL = 'https://sgi.example';
    setEnv({ APP_ENV: 'producao' });
    await expect(scanBytes(PDF)).rejects.toThrow(/Antivírus não configurado/);
    process.env.APP_URL = 'http://localhost:3000';
  });
  it('antivírus configurado e inacessível: recusa e não grava nada', async () => {
    setEnv({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: '1' });
    const id = await newDoc('Antivírus fora do ar');
    const before = (await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM document_files'))!.n;
    await expect(saveDraft(cCoord, id, { texto: 'x', notaVersao: '' }, { name: 'a.pdf', bytes: PDF })).rejects.toThrow(/antivírus/);
    expect((await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM document_files'))!.n).toBe(before);
  });
});

describe.skipIf(process.env.SKIP_CLAMAV === '1')('Antivírus — ClamAV real (clamd)', () => {
  const clam = () => setEnv({ CLAMAV_HOST: CLAM_HOST, CLAMAV_PORT: CLAM_PORT });

  it('responde com versão do mecanismo', async () => {
    clam();
    expect(await antivirusVersion()).toMatch(/^ClamAV \d/);
  });

  it('arquivo limpo: aceito e registrado como LIMPO com o mecanismo', async () => {
    clam();
    const id = await newDoc('Limpo');
    await saveDraft(cCoord, id, { texto: 'x', notaVersao: '' }, { name: 'a.pdf', bytes: PDF });
    const f = (await fileOf(id))!;
    expect(f.scan_status).toBe('LIMPO');
    expect(f.scan_engine).toMatch(/^ClamAV/);
  });

  it('arquivo infectado (EICAR, com extensão .txt válida): recusado, não gravado, auditado', async () => {
    clam();
    const id = await newDoc('Infectado');
    const before = (await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM document_files'))!.n;
    await expect(saveDraft(cCoord, id, { texto: 'x', notaVersao: '' }, { name: 'leia-me.txt', bytes: EICAR })).rejects.toThrow(/conteúdo malicioso/);
    expect((await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM document_files'))!.n).toBe(before);
    expect((await lastAudit('DOC_ARQUIVO_INFECTADO'))!.summary).toMatch(/leia-me\.txt.*bloqueado/);
  });

  it('arquivo grande (vários blocos de 64 KB) é verificado integralmente', async () => {
    clam();
    const big = new Uint8Array(300 * 1024).fill(0x41);
    big.set(EICAR, big.length - EICAR.length - 10); // conteúdo malicioso no fim, após vários blocos
    expect((await scanBytes(new Uint8Array(300 * 1024).fill(0x41))).status).toBe('LIMPO');
    expect((await scanBytes(big)).status).toBe('INFECTADO');
  });

  it('arquivo não verificado é verificado no download; infectado é bloqueado na aprovação', async () => {
    const id = await newDoc('Verificação posterior');
    await saveDraft(cCoord, id, { texto: 'x', notaVersao: '' }, { name: 'a.pdf', bytes: PDF }); // sem antivírus
    const v = await submitForApproval(cCoord, id);
    clam();
    await fileForDownload(cCoord, id, v);
    expect((await queryOne<{ s: string }>(getPool(), 'SELECT scan_status AS s FROM document_files f JOIN document_version_reviews r ON r.file_id = f.id WHERE r.version_id = $1', [v]))!.s).toBe('LIMPO');

    // Arquivo malicioso que entrou sem verificação (antes da ativação do antivírus) não chega a vigorar.
    setEnv({});
    const id2 = await newDoc('Malicioso antigo');
    await saveDraft(cCoord, id2, { texto: 'x', notaVersao: '' }, { name: 'leia-me.txt', bytes: EICAR });
    const v2 = await submitForApproval(cCoord, id2);
    clam();
    await expect(decideVersion(cSubst, id2, { versionId: v2, decision: 'APROVADA', confirmed: true })).rejects.toThrow(/conteúdo malicioso/);
    expect((await getDocument(cOwner, id2)).doc.status).toBe('EM_APROVACAO');
    await expect(fileForDownload(cCoord, id2, v2)).rejects.toThrow(/conteúdo malicioso/);
  });
});

describe('Google Drive — armazenamento (API simulada)', () => {
  let fake: Awaited<ReturnType<typeof startFakeDrive>>;
  const SHARED = '0AFakeSharedDriveId';
  const drive = (extra: Record<string, string> = {}) => setEnv({
    DOCUMENT_STORAGE: 'drive', GOOGLE_DRIVE_SHARED_DRIVE_ID: SHARED, GOOGLE_DRIVE_SA_KEY: fake.saKey,
    GOOGLE_DRIVE_API_URL: fake.base, GOOGLE_OAUTH_TOKEN_URL: `${fake.base}/token`, ...extra,
  });
  beforeAll(async () => { fake = await startFakeDrive(SHARED); });
  afterAll(async () => { await fake.close(); });

  it('configuração inválida é recusada; endereços substitutos proibidos em produção', () => {
    setEnv({ DOCUMENT_STORAGE: 'drive' });
    expect(() => getConfig()).toThrow(/GOOGLE_DRIVE_SHARED_DRIVE_ID/);
    process.env.APP_URL = 'https://sgi.example';
    setEnv({ APP_ENV: 'producao', GOOGLE_DRIVE_API_URL: 'https://evil.example' });
    expect(() => getConfig()).toThrow(/não podem ser substituídos/);
    process.env.APP_URL = 'http://localhost:3000';
    setEnv({});
  });

  it('diagnóstico conecta ao Drive compartilhado com a conta de serviço', async () => {
    drive();
    expect(await driveCheck()).toEqual({ ok: true, detail: 'Conectado ao Drive compartilhado "SGI — Documentos (simulado)".' });
  });

  let docId: string, versionId: string;
  it('envio: arquivo vai ao Drive compartilhado (sem conteúdo no banco), com hash registrado', async () => {
    drive();
    docId = await newDoc('Documento no Drive');
    await saveDraft(cCoord, docId, { texto: 'Procedimento (fictício).', notaVersao: '' }, { name: 'pop.pdf', bytes: PDF });
    const f = (await fileOf(docId))!;
    expect(f.storage).toBe('DRIVE');
    expect(f.data).toBeNull();
    const remote = fake.files.get(f.drive_file_id!)!;
    expect(remote.parents).toEqual([SHARED]);
    expect(remote.data.equals(Buffer.from(PDF))).toBe(true);
    expect(remote.appProperties.sgiSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('aprovação confere o arquivo no Drive; download e exportação servem o conteúdo pela aplicação', async () => {
    drive();
    versionId = await submitForApproval(cCoord, docId);
    await decideVersion(cSubst, docId, { versionId, decision: 'APROVADA', confirmed: true });
    const dl = await fileForDownload(cCoord, docId, versionId);
    expect(dl.data.equals(Buffer.from(PDF))).toBe(true);
    expect((await exportVersion(cCoord, docId, versionId)).verificacao.arquivo).toBe('íntegro');
  });

  it('arquivo alterado diretamente no Drive é detectado (hash) e o download é bloqueado', async () => {
    drive();
    const f = (await queryOne<{ drive_file_id: string }>(getPool(), 'SELECT f.drive_file_id FROM document_files f JOIN document_version_reviews r ON r.file_id = f.id WHERE r.version_id = $1', [versionId]))!;
    const remote = fake.files.get(f.drive_file_id)!;
    const original = remote.data;
    remote.data = Buffer.from('%PDF-1.4 adulterado no Drive');
    await expect(fileForDownload(cCoord, docId, versionId)).rejects.toThrow(/integridade/);
    expect((await exportVersion(cCoord, docId, versionId)).verificacao.arquivo).toBe('DIVERGENTE');
    remote.data = original;
  });

  it('Drive indisponível: envio recusado sem registro órfão; exportação informa indisponibilidade', async () => {
    drive();
    const id = await newDoc('Drive fora do ar');
    const before = (await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM document_files'))!.n;
    fake.state.down = true;
    resetDriveToken();
    await expect(saveDraft(cCoord, id, { texto: 'x', notaVersao: '' }, { name: 'a.pdf', bytes: PDF })).rejects.toThrow(/indisponível/);
    expect((await queryOne<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM document_files'))!.n).toBe(before);
    expect((await exportVersion(cCoord, docId, versionId)).verificacao.arquivo).toMatch(/indisponível/);
    fake.state.down = false;
  });

  it('confirmação divergente do Google (MD5): envio cancelado e arquivo enviado à lixeira', async () => {
    drive();
    const id = await newDoc('MD5 divergente');
    const uploads = fake.state.uploads;
    fake.state.corruptMd5 = true;
    await expect(saveDraft(cCoord, id, { texto: 'x', notaVersao: '' }, { name: 'a.pdf', bytes: PDF })).rejects.toThrow(/não confere/);
    fake.state.corruptMd5 = false;
    expect(fake.state.uploads).toBe(uploads + 1);
    expect([...fake.files.values()].at(-1)!.trashed).toBe(true);
  });

  it('chave de conta de serviço inválida: token recusado pelo Google, envio recusado', async () => {
    // Chave bem formada, mas de outra conta (não reconhecida pelo Google).
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    drive({ GOOGLE_DRIVE_SA_KEY: Buffer.from(JSON.stringify({ client_email: 'x@y', private_key: await exportPKCS8(privateKey) })).toString('base64') });
    const id = await newDoc('Chave inválida');
    await expect(saveDraft(cCoord, id, { texto: 'x', notaVersao: '' }, { name: 'a.pdf', bytes: PDF })).rejects.toThrow(/indisponível/);
  });

  it('descarte após retenção envia o arquivo à lixeira do Drive e preserva o hash', async () => {
    drive();
    await saveCategory(cOwner, { id: catPop, code: 'POP', name: 'POPs por atribuição', reviewMonths: 12, retentionMonths: 60, retentionBasis: 'Decisão fictícia de teste nº 2', defaultConfidentiality: 'INTERNO', active: true });
    await changeLifecycle(cOwner, docId, 'ARQUIVADO', 'Arquivamento de teste');
    await query(getPool(), 'UPDATE documents SET retention_until = current_date - 1 WHERE id = $1', [docId]);
    expect(await purgeFiles(cOwner, docId, 'Prazo de retenção cumprido (teste)')).toBe(1);
    const f = (await queryOne<{ drive_file_id: string; purged_at: Date | null; sha256: string }>(getPool(), 'SELECT f.drive_file_id, f.purged_at, f.sha256 FROM document_files f JOIN document_version_reviews r ON r.file_id = f.id WHERE r.version_id = $1', [versionId]))!;
    expect(f.purged_at).not.toBeNull();
    expect(fake.files.get(f.drive_file_id)!.trashed).toBe(true);
    await expect(fileForDownload(cOwner, docId, versionId)).rejects.toThrow(/descartado/);
  });

  it('banco protege o registro do Drive (id não pode ser trocado; conteúdo não pode aparecer no banco)', async () => {
    drive();
    const id = await newDoc('Registro protegido');
    await saveDraft(cCoord, id, { texto: 'x', notaVersao: '' }, { name: 'a.pdf', bytes: PDF });
    const f = (await fileOf(id))!;
    expect(f.storage).toBe('DRIVE');
    await expect(query(getPool(), "UPDATE document_files SET drive_file_id = 'outro' WHERE id = $1", [f.id])).rejects.toThrow(/imutável/);
    await expect(query(getPool(), "UPDATE document_files SET data = 'x'::bytea WHERE id = $1", [f.id])).rejects.toThrow(/imutável/);
  });
});
