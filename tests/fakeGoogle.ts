import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { exportPKCS8, exportSPKI, generateKeyPair, importSPKI, jwtVerify } from 'jose';

// Simulação das APIs do Google usadas na Fase 4c: token OAuth (JWT da conta de serviço, com `sub` para delegação),
// Agenda (eventos), Gmail (envio) e webhook de entrada do Chat. Confere assinatura, escopo e Bearer token.

export type FakeEvent = { id: string; body: Record<string, unknown> };

export async function startFakeGoogle(opts: { calendarId: string; sender: string }) {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const spki = await exportSPKI(publicKey);
  const saKey = Buffer.from(JSON.stringify({ client_email: 'sgi@projeto-ficticio.iam.gserviceaccount.com', private_key: await exportPKCS8(privateKey) })).toString('base64');
  const tokens = new Map<string, { scope: string; sub: string | null }>();
  const events = new Map<string, FakeEvent>();
  const mails: { raw: string; decoded: string; sub: string | null }[] = [];
  const chats: string[] = [];
  const state = { down: false, gmailStatus: 200, chatStatus: 200, calendarStatus: 200, calls: 0 };
  let base = '';
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      state.calls++;
      const body = Buffer.concat(chunks).toString();
      const url = new URL(req.url!, base);
      const send = (status: number, obj?: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      if (state.down) return send(503, { error: 'indisponível (simulado)' });
      if (url.pathname === '/token') {
        try {
          const { payload } = await jwtVerify(new URLSearchParams(body).get('assertion') ?? '', await importSPKI(spki, 'RS256'), { audience: `${base}/token` });
          const t = randomUUID();
          tokens.set(t, { scope: String(payload.scope), sub: (payload.sub as string) ?? null });
          return send(200, { access_token: t, expires_in: 3600 });
        } catch {
          return send(400, { error: 'invalid_grant' });
        }
      }
      if (url.pathname === '/chat/webhook') {
        if (state.chatStatus !== 200) return send(state.chatStatus, { error: 'simulado' });
        chats.push(JSON.parse(body).text);
        return send(200, { name: `spaces/x/messages/${chats.length}` });
      }
      const tok = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!tok) return send(401, { error: 'unauthorized' });
      if (url.pathname === '/gmail/v1/users/me/messages/send' && req.method === 'POST') {
        if (tok.scope !== 'https://www.googleapis.com/auth/gmail.send' || tok.sub !== opts.sender) return send(403, { error: 'delegação ou escopo inválido' });
        if (state.gmailStatus !== 200) return send(state.gmailStatus, { error: 'simulado' });
        const raw = JSON.parse(body).raw as string;
        mails.push({ raw, decoded: Buffer.from(raw, 'base64url').toString('utf8'), sub: tok.sub });
        return send(200, { id: `msg-${mails.length}` });
      }
      const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
      if (m) {
        if (tok.scope !== 'https://www.googleapis.com/auth/calendar.events') return send(403, { error: 'escopo' });
        if (decodeURIComponent(m[1]!) !== opts.calendarId) return send(404, { error: 'calendar not found' });
        if (state.calendarStatus !== 200) return send(state.calendarStatus, { error: 'simulado' });
        const id = m[2] ? decodeURIComponent(m[2]) : null;
        if (req.method === 'POST' && !id) { const e = { id: `ev-${randomUUID()}`, body: JSON.parse(body) }; events.set(e.id, e); return send(200, { id: e.id }); }
        if (!id || !events.has(id)) return send(404, { error: 'not found' });
        if (req.method === 'PATCH') { events.get(id)!.body = { ...events.get(id)!.body, ...JSON.parse(body) }; return send(200, { id }); }
        if (req.method === 'DELETE') { events.delete(id); return send(204); }
      }
      return send(404, { error: 'rota não simulada' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, saKey, events, mails, chats, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}
