import { getPool, query, queryOne, tx, type Db } from '../db.ts';
import type { Ctx } from '../context.ts';
import { getConfig } from '../config.ts';
import { audit } from '../audit.ts';
import { AppError } from '../errors.ts';
import { sha256Hex } from '../crypto.ts';
import { scanBytes } from '../antivirus.ts';
import { driveDownload, driveTrash, driveUpload } from '../drive.ts';
import type { CheckedFile } from '../files.ts';

// Guarda dos arquivos documentais: verificação antivírus antes de aceitar, gravação no banco ou no Google Drive,
// leitura com conferência do SHA-256 e descarte. Toda leitura e escrita passa por aqui.

export type StoredFileRow = {
  id: string; filename: string; mime_type: string; size_bytes: number; sha256: string; storage: 'BANCO' | 'DRIVE';
  drive_file_id: string | null; data: Buffer | null; purged_at: Date | null; scan_status: 'LIMPO' | 'NAO_VERIFICADO';
};

async function rejectInfected(ctx: Ctx | null, filename: string, signature: string, where: string): Promise<never> {
  await tx((c) => audit(c, ctx, {
    action: 'DOC_ARQUIVO_INFECTADO', entityType: 'document_file', entityId: null,
    summary: `Arquivo "${filename}" bloqueado pelo antivírus (${signature}) — ${where}`, data: { assinatura: signature },
  }));
  throw new AppError(`Arquivo bloqueado: o antivírus identificou conteúdo malicioso (${signature}). O arquivo não foi gravado.`, 422, 'ARQUIVO_INFECTADO');
}

/**
 * Verifica e envia o arquivo ao armazenamento configurado. Deve ser chamada FORA da transação; a gravação do registro
 * ocorre depois, com `insertStoredFile`. Se a transação falhar, chame `discardUnsaved`.
 */
export async function prepareFile(ctx: Ctx, checked: CheckedFile, bytes: Uint8Array) {
  const sha256 = sha256Hex(Buffer.from(bytes));
  const scan = await scanBytes(bytes);
  if (scan.status === 'INFECTADO') await rejectInfected(ctx, checked.filename, scan.signature, 'envio');
  const cfg = getConfig();
  const driveId = cfg.storage === 'drive' ? await driveUpload({ name: `${sha256.slice(0, 12)}-${checked.filename}`, mime: checked.mime, bytes, sha256 }) : null;
  return { checked, bytes, sha256, scan, driveId };
}
export type PreparedFile = Awaited<ReturnType<typeof prepareFile>>;

export async function insertStoredFile(c: Db, ctx: Ctx, p: PreparedFile): Promise<string> {
  const clean = p.scan.status === 'LIMPO';
  const r = await queryOne<{ id: string }>(
    c,
    `INSERT INTO document_files (filename, mime_type, size_bytes, sha256, data, storage, drive_file_id, scan_status, scan_engine, scanned_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [p.checked.filename, p.checked.mime, p.checked.size, p.sha256, p.driveId ? null : Buffer.from(p.bytes), p.driveId ? 'DRIVE' : 'BANCO', p.driveId,
      clean ? 'LIMPO' : 'NAO_VERIFICADO', clean ? p.scan.engine : null, clean ? new Date() : null, ctx.principal.userId]);
  return r!.id;
}

/** Desfaz o envio ao Drive quando o registro não chegou a ser gravado. */
export async function discardUnsaved(p: PreparedFile | null): Promise<void> {
  if (p?.driveId) await driveTrash(p.driveId).catch((e) => console.error('[drive] arquivo órfão não removido', p.driveId, e));
}

export async function loadStoredFile(db: Db, id: string): Promise<StoredFileRow | null> {
  return queryOne<StoredFileRow>(
    db, 'SELECT id, filename, mime_type, size_bytes, sha256, storage, drive_file_id, data, purged_at, scan_status FROM document_files WHERE id = $1', [id]);
}

/** Lê o conteúdo e confere o SHA-256. Retorna null se o conteúdo foi descartado. */
export async function readStoredFile(f: StoredFileRow): Promise<Uint8Array | null> {
  if (f.purged_at) return null;
  const bytes = f.storage === 'DRIVE' ? await driveDownload(f.drive_file_id!) : f.data ? new Uint8Array(f.data) : null;
  if (!bytes) return null;
  if (sha256Hex(Buffer.from(bytes)) !== f.sha256) throw new AppError('Falha de integridade do arquivo. Operação bloqueada.', 500, 'INTEGRIDADE');
  return bytes;
}

/**
 * Nova verificação antivírus (assinaturas atualizadas) antes de atos relevantes: aprovação e, para arquivos ainda não
 * verificados, o download. Arquivo infectado é bloqueado; sem antivírus configurado, mantém a situação registrada.
 */
export async function rescan(ctx: Ctx | null, f: StoredFileRow, bytes: Uint8Array, where: string, force: boolean): Promise<void> {
  if (!getConfig().clamav || (!force && f.scan_status === 'LIMPO')) return;
  const scan = await scanBytes(bytes);
  if (scan.status === 'INFECTADO') await rejectInfected(ctx, f.filename, scan.signature, where);
  if (scan.status === 'LIMPO') {
    await query(getPool(), "UPDATE document_files SET scan_status='LIMPO', scan_engine=$2, scanned_at=now() WHERE id=$1", [f.id, scan.engine]);
  }
}

/** Descarta o conteúdo (no Drive, envia à lixeira do Drive compartilhado) e registra o descarte. */
export async function purgeStoredFile(c: Db, ctx: Ctx, f: { id: string; storage: string; drive_file_id: string | null }, reason: string): Promise<void> {
  if (f.storage === 'DRIVE') await driveTrash(f.drive_file_id!);
  await query(c, 'UPDATE document_files SET data=NULL, purged_at=now(), purged_by=$2, purge_reason=$3 WHERE id=$1', [f.id, ctx.principal.userId, reason]);
}
