import { describe, expect, it } from 'vitest';
import { checkFile, safeFilename } from '../../src/server/files.ts';
import { accessFor } from '../../src/server/modules/repository.ts';
import type { Principal, Scope } from '../../src/server/context.ts';

const MB = 1048576;
const enc = (s: string) => new TextEncoder().encode(s);

function zip(entries: string[], first = ''): Uint8Array {
  // Estrutura mínima para os testes: assinatura local + nomes de entradas no corpo.
  return enc(`PK\u0003\u0004${first}${entries.join('|')}`);
}

function odf(mime: string): Uint8Array {
  const head = new Uint8Array(30).fill(0);
  head.set([0x50, 0x4b, 0x03, 0x04]);
  return new Uint8Array([...head, ...enc('mimetype'), ...enc(mime), 0x50, 0x4b, 0x03, 0x04, ...enc('content.xml')]);
}

describe('checkFile — formatos conferidos pelo conteúdo', () => {
  it('aceita PDF, PNG, JPEG e texto UTF-8 válidos', () => {
    expect(checkFile('a.pdf', enc('%PDF-1.7 ...'), MB).mime).toBe('application/pdf');
    expect(checkFile('a.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), MB).ext).toBe('png');
    expect(checkFile('foto.JPG', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), MB).ext).toBe('jpg');
    expect(checkFile('ata.txt', enc('Ata — reunião'), MB).mime).toBe('text/plain; charset=utf-8');
  });

  it('aceita DOCX/XLSX/ODT/ODS somente com a estrutura correspondente', () => {
    expect(checkFile('a.docx', zip(['[Content_Types].xml', 'word/document.xml']), MB).ext).toBe('docx');
    expect(checkFile('a.xlsx', zip(['[Content_Types].xml', 'xl/workbook.xml']), MB).ext).toBe('xlsx');
    expect(() => checkFile('a.docx', zip(['[Content_Types].xml', 'xl/workbook.xml']), MB)).toThrow(/não corresponde/);
    expect(checkFile('a.odt', odf('application/vnd.oasis.opendocument.text'), MB).ext).toBe('odt');
    expect(() => checkFile('a.odt', odf('application/vnd.oasis.opendocument.spreadsheet'), MB)).toThrow(/não corresponde/);
    expect(checkFile('a.ods', odf('application/vnd.oasis.opendocument.spreadsheet'), MB).ext).toBe('ods');
  });

  it('recusa extensão fora da lista, conteúdo divergente, vazio e acima do limite', () => {
    expect(() => checkFile('a.html', enc('<html>'), MB)).toThrow(/Formato não aceito/);
    expect(() => checkFile('a.svg', enc('<svg/>'), MB)).toThrow(/Formato não aceito/);
    expect(() => checkFile('sem-extensao', enc('%PDF-'), MB)).toThrow(/Formato não aceito/);
    expect(() => checkFile('a.pdf', enc('<script>alert(1)</script>'), MB)).toThrow(/não corresponde/);
    expect(() => checkFile('a.png', enc('%PDF-1.4'), MB)).toThrow(/não corresponde/);
    expect(() => checkFile('a.txt', new Uint8Array([0x61, 0x00, 0x62]), MB)).toThrow(/não corresponde/);
    expect(() => checkFile('a.txt', new Uint8Array([0xc3, 0x28]), MB)).toThrow(/não corresponde/);
    expect(() => checkFile('a.pdf', new Uint8Array(0), MB)).toThrow(/vazio/);
    expect(() => checkFile('a.pdf', new Uint8Array(MB + 1).fill(0x25), MB)).toThrow(/limite de 1 MB/);
  });

  it('nome seguro: sem caminho, sem caracteres de controle ou reservados', () => {
    expect(safeFilename('../../etc/passwd.txt')).toBe('passwd.txt');
    expect(safeFilename('C:\\Users\\x\\rel"at<o>rio.pdf')).toBe('rel_at_o_rio.pdf');
    expect(safeFilename('a\u0000b\nc.pdf')).toBe('a_b_c.pdf');
    expect(safeFilename('')).toBe('arquivo');
    expect(checkFile('../segredo.pdf', enc('%PDF-1.4'), MB).filename).toBe('segredo.pdf');
  });
});

const S = { DIR: 'sector-dir', RI: 'sector-ri', ATD: 'sector-atd' };

function principal(userId: string, opts: { owner?: boolean; sector?: string; grants?: Record<string, Scope> } = {}): Principal {
  const grants = new Map(Object.entries(opts.grants ?? {}).map(([k, scope]) => [k, { scope, sectorIds: new Set(scope === 'SETOR' && opts.sector ? [opts.sector] : []) }]));
  return { userId, email: `${userId}@x`, displayName: userId, isOwner: !!opts.owner, employeeId: `e-${userId}`, employeeSectorId: opts.sector ?? null, grants };
}

const baseDoc = {
  status: 'VIGENTE' as const, confidentiality: 'INTERNO' as const, sector_id: S.RI, responsible_user_id: 'resp', created_by: 'autor',
  audience_type: 'TODOS' as const, aud_sectors: [] as string[], aud_users: [] as string[],
};
const colab = (id: string, sector: string) => principal(id, { sector, grants: { 'documentos.ver': 'TODOS' } });

describe('accessFor — regras de acesso do repositório', () => {
  it('público lê somente a versão vigente; rascunho é invisível ao público', () => {
    const p = colab('u1', S.ATD);
    expect(accessFor(p, baseDoc)).toMatchObject({ read: true, history: false, edit: false, audience: true });
    expect(accessFor(p, { ...baseDoc, status: 'RASCUNHO' }).read).toBe(false);
    expect(accessFor(p, { ...baseDoc, status: 'OBSOLETO' }).read).toBe(false);
  });

  it('sem documentos.ver não há leitura pelo público', () => {
    expect(accessFor(principal('u1', { sector: S.RI }), baseDoc).read).toBe(false);
  });

  it('público por setores e por pessoas', () => {
    const d = { ...baseDoc, audience_type: 'SETORES' as const, aud_sectors: [S.RI] };
    expect(accessFor(colab('u1', S.RI), d).read).toBe(true);
    expect(accessFor(colab('u2', S.ATD), d).read).toBe(false);
    const d2 = { ...baseDoc, audience_type: 'USUARIOS' as const, aud_users: ['u2'] };
    expect(accessFor(colab('u2', S.ATD), d2).audience).toBe(true);
    expect(accessFor(colab('u1', S.RI), d2).read).toBe(false);
  });

  it('edição por setor: coordenação edita documento do próprio setor, não de outro; obsoleto não é editável', () => {
    const coord = principal('c', { sector: S.RI, grants: { 'documentos.ver': 'TODOS', 'documentos.editar': 'SETOR' } });
    expect(accessFor(coord, { ...baseDoc, status: 'RASCUNHO' })).toMatchObject({ read: true, history: true, edit: true });
    expect(accessFor(coord, { ...baseDoc, status: 'RASCUNHO', sector_id: S.ATD }).read).toBe(false);
    expect(accessFor(coord, { ...baseDoc, status: 'OBSOLETO' }).edit).toBe(false);
  });

  it('confidencial: gestão e aprovação sem inclusão na lista não alcançam; Oficial e listados sim', () => {
    const d = { ...baseDoc, confidentiality: 'CONFIDENCIAL' as const, audience_type: 'USUARIOS' as const, aud_users: ['listado'] };
    const gestor = principal('g', { sector: S.DIR, grants: { 'documentos.ver': 'TODOS', 'documentos.gerenciar': 'TODOS', 'documentos.aprovar': 'TODOS', 'documentos.editar': 'TODOS' } });
    expect(accessFor(gestor, d)).toMatchObject({ read: false, history: false, manage: false, approve: false, edit: false });
    expect(accessFor(principal('of', { owner: true }), d)).toMatchObject({ read: true, history: true, manage: true, approve: true });
    expect(accessFor(colab('listado', S.ATD), d)).toMatchObject({ read: true, history: false, audience: true });
    expect(accessFor({ ...gestor, userId: 'listado' }, d)).toMatchObject({ manage: true, approve: true });
    // Confidencial destinado a "todos" (estado impedido pelo serviço) não amplia o público.
    expect(accessFor(colab('x', S.RI), { ...d, audience_type: 'TODOS' }).read).toBe(false);
  });

  it('responsável e autor acessam o histórico mesmo sem permissão de edição', () => {
    expect(accessFor(colab('resp', S.ATD), { ...baseDoc, status: 'RASCUNHO' }).history).toBe(true);
    expect(accessFor(colab('autor', S.ATD), { ...baseDoc, status: 'ARQUIVADO' }).read).toBe(true);
  });
});
