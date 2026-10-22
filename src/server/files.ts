import { AppError } from './errors.ts';

// Validação de arquivos anexados: lista fechada de formatos, conferida pelo conteúdo (assinatura binária)
// e pela extensão. O tipo declarado pelo navegador é ignorado. Não há verificação antivírus (pendência registrada).

export const ALLOWED_FILES = {
  pdf: { mime: 'application/pdf', label: 'PDF' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word (.docx)' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel (.xlsx)' },
  odt: { mime: 'application/vnd.oasis.opendocument.text', label: 'ODT' },
  ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet', label: 'ODS' },
  png: { mime: 'image/png', label: 'PNG' },
  jpg: { mime: 'image/jpeg', label: 'JPEG' },
  jpeg: { mime: 'image/jpeg', label: 'JPEG' },
  txt: { mime: 'text/plain; charset=utf-8', label: 'Texto' },
} as const;

export type AllowedExt = keyof typeof ALLOWED_FILES;

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);

function isZip(b: Uint8Array) {
  return startsWith(b, [0x50, 0x4b, 0x03, 0x04]);
}

/** Procura um nome de entrada no diretório central do ZIP (suficiente para distinguir OOXML e ODF). */
function zipHasEntry(b: Uint8Array, name: string): boolean {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).includes(Buffer.from(name, 'utf8'));
}

function odfMimetype(b: Uint8Array): string | null {
  // ODF: a primeira entrada é "mimetype", não comprimida, com o tipo como conteúdo (offset 38).
  const head = Buffer.from(b.buffer, b.byteOffset, Math.min(b.byteLength, 200)).toString('latin1');
  if (head.slice(30, 38) !== 'mimetype') return null;
  const m = /^application\/vnd\.oasis\.opendocument\.[a-z]+/.exec(head.slice(38));
  return m ? m[0] : null;
}

function isUtf8Text(b: Uint8Array): boolean {
  if (b.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

/** Nome seguro para exibição e para o cabeçalho de download (sem caminhos nem caracteres de controle). */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.normalize('NFC').replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_').replace(/\s+/g, ' ').trim();
  return clean.slice(-200) || 'arquivo';
}

export type CheckedFile = { filename: string; ext: AllowedExt; mime: string; size: number };

/** Confere formato e tamanho. Lança AppError com mensagem exibível quando o arquivo não é aceito. */
export function checkFile(name: string, bytes: Uint8Array, maxBytes: number): CheckedFile {
  if (bytes.byteLength === 0) throw new AppError('Arquivo vazio.');
  if (bytes.byteLength > maxBytes) throw new AppError(`Arquivo excede o limite de ${Math.floor(maxBytes / 1048576)} MB.`);
  const filename = safeFilename(name);
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(filename)?.[1] ?? '').toLowerCase();
  if (!(ext in ALLOWED_FILES)) {
    throw new AppError(`Formato não aceito. Formatos permitidos: ${[...new Set(Object.values(ALLOWED_FILES).map((f) => f.label))].join(', ')}.`);
  }
  const e = ext as AllowedExt;
  let ok: boolean;
  switch (e) {
    case 'pdf': ok = startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]); break;
    case 'png': ok = startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); break;
    case 'jpg':
    case 'jpeg': ok = startsWith(bytes, [0xff, 0xd8, 0xff]); break;
    case 'docx': ok = isZip(bytes) && zipHasEntry(bytes, '[Content_Types].xml') && zipHasEntry(bytes, 'word/'); break;
    case 'xlsx': ok = isZip(bytes) && zipHasEntry(bytes, '[Content_Types].xml') && zipHasEntry(bytes, 'xl/'); break;
    case 'odt': ok = isZip(bytes) && odfMimetype(bytes) === 'application/vnd.oasis.opendocument.text'; break;
    case 'ods': ok = isZip(bytes) && odfMimetype(bytes) === 'application/vnd.oasis.opendocument.spreadsheet'; break;
    case 'txt': ok = isUtf8Text(bytes); break;
  }
  if (!ok) throw new AppError('O conteúdo do arquivo não corresponde à extensão informada.');
  return { filename, ext: e, mime: ALLOWED_FILES[e].mime, size: bytes.byteLength };
}
