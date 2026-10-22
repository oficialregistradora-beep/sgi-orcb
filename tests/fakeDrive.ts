import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { exportPKCS8, exportSPKI, generateKeyPair, importSPKI, jwtVerify } from 'jose';

// Servidor que simula os pontos da API do Google usados pelo SGI (token OAuth da conta de serviço e Drive v3),
// para testar o adaptador sem credenciais reais. Confere a assinatura do JWT da conta de serviço e o Bearer token.

export type FakeFile = { id: string; name: string; parents: string[]; mime: string; data: Buffer; trashed: boolean; appProperties: Record<string, string> };

export async function startFakeDrive(sharedDriveId: string) {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const spki = await exportSPKI(publicKey);
  const saKey = Buffer.from(JSON.stringify({
    type: 'service_account', client_email: 'sgi-docs@projeto-ficticio.iam.gserviceaccount.com', private_key: await exportPKCS8(privateKey),
  })).toString('base64');
  const files = new Map<string, FakeFile>();
  const tokens = new Set<string>();
  const state = { down: false, corruptMd5: false, tokenRequests: 0, uploads: 0 };
  let base = '';

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url!, base);
      const send = (status: number, obj?: unknown, raw?: Buffer) => {
        res.writeHead(status, { 'content-type': raw ? 'application/octet-stream' : 'application/json' });
        res.end(raw ?? (obj === undefined ? '' : JSON.stringify(obj)));
      };
      if (state.down) return send(503, { error: 'indisponível (simulado)' });
      if (url.pathname === '/token') {
        state.tokenRequests++;
        const p = new URLSearchParams(body.toString());
        try {
          const { payload } = await jwtVerify(p.get('assertion') ?? '', await importSPKI(spki, 'RS256'), { audience: `${base}/token` });
          if (payload.scope !== 'https://www.googleapis.com/auth/drive') return send(400, { error: 'invalid_scope' });
        } catch {
          return send(400, { error: 'invalid_grant' });
        }
        const t = randomUUID();
        tokens.add(t);
        return send(200, { access_token: t, expires_in: 3600, token_type: 'Bearer' });
      }
      if (!tokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''))) return send(401, { error: 'unauthorized' });
      if (!url.searchParams.has('supportsAllDrives') && !url.pathname.startsWith('/drive/v3/drives/')) return send(404, { error: 'shared drive item without supportsAllDrives' });

      if (req.method === 'POST' && url.pathname === '/upload/drive/v3/files') {
        const boundary = /boundary=([^;]+)/.exec(req.headers['content-type'] ?? '')?.[1];
        const sep = Buffer.from(`--${boundary}`);
        const p1 = body.indexOf(sep), p2 = body.indexOf(sep, p1 + sep.length), end = body.indexOf(Buffer.from(`\r\n--${boundary}--`));
        const part = (a: number, b: number) => { const s = body.subarray(a + sep.length, b); const h = s.indexOf('\r\n\r\n'); return { head: s.subarray(0, h).toString(), data: s.subarray(h + 4) }; };
        const meta = JSON.parse(part(p1, p2).data.toString().trim());
        const media = part(p2, end + 2);
        if (!meta.parents?.length || !meta.parents.every((x: string) => x === sharedDriveId || files.has(x) || x.startsWith('pasta-'))) return send(404, { error: 'parent not found' });
        const id = `drv-${randomUUID()}`;
        const data = Buffer.from(media.data.subarray(0, media.data.length - 2)); // remove o \r\n antes do delimitador final
        files.set(id, { id, name: meta.name, parents: meta.parents, mime: /content-type: (.+)/i.exec(media.head)?.[1] ?? '', data, trashed: false, appProperties: meta.appProperties ?? {} });
        state.uploads++;
        const md5 = createHash('md5').update(data).digest('hex');
        return send(200, { id, size: String(data.length), md5Checksum: state.corruptMd5 ? '0'.repeat(32) : md5 });
      }
      const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const f = files.get(decodeURIComponent(m[1]!));
        if (!f) return send(404, { error: 'not found' });
        if (req.method === 'GET' && url.searchParams.get('alt') === 'media') return f.trashed ? send(404, { error: 'trashed' }) : send(200, undefined, f.data);
        if (req.method === 'PATCH') { f.trashed = JSON.parse(body.toString()).trashed === true; return send(200, { id: f.id, trashed: f.trashed }); }
      }
      const dm = /^\/drive\/v3\/drives\/([^/]+)$/.exec(url.pathname);
      if (dm) return decodeURIComponent(dm[1]!) === sharedDriveId ? send(200, { id: sharedDriveId, name: 'SGI — Documentos (simulado)' }) : send(404, { error: 'not found' });
      return send(404, { error: 'rota não simulada' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  return { base, saKey, files, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}
