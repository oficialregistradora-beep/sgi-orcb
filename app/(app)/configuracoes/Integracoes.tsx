import type { Ctx } from '@/server/context.ts';
import { can } from '@/server/authz.ts';
import { getConfig } from '@/server/config.ts';
import { antivirusVersion } from '@/server/antivirus.ts';
import { driveCheck } from '@/server/drive.ts';
import { integrationOverview } from '@/server/modules/integrations.ts';
import { fmtDateTime } from '@/ui/format.ts';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { integrationAction } from '../../actions/phase4c.ts';

const FLAG_LABELS: Record<string, string> = {
  'integracoes.calendar.ativo': 'Agenda Google: publicar eventos', 'integracoes.calendar.ferias': 'Agenda: férias', 'integracoes.calendar.plantoes': 'Agenda: plantões RCPN',
  'integracoes.calendar.marcos': 'Agenda: marcos de projetos', 'integracoes.calendar.compensacoes': 'Agenda: compensações aprovadas (dado pessoal)',
  'integracoes.calendar.eventos': 'Agenda: reuniões, prazos e eventos', 'integracoes.gmail.ativo': 'Gmail: cópia das notificações por e-mail',
  'integracoes.gmail.somente_alta': 'Gmail: somente prioridade alta', 'integracoes.chat.ativo': 'Google Chat: avisos administrativos',
};

/** Situação das integrações. Credenciais ficam nas variáveis de ambiente / Secret Manager; ativação e envio, aqui. */
export async function Integracoes({ ctx }: { ctx: Ctx }) {
  const cfg = getConfig();
  const manage = ctx.principal.isOwner || can(ctx.principal, 'integracoes.gerenciar');
  const av = cfg.clamav ? await antivirusVersion().then((v) => ({ ok: true, detail: v ?? '' }), (e) => ({ ok: false, detail: `Inacessível: ${String(e).slice(0, 120)}` })) : null;
  const drive = await driveCheck();
  const o = await integrationOverview();
  const count = (ch: string, st: string) => o.outbox.find((x) => x.channel === ch && x.status === st)?.n ?? 0;
  const rows = [
    { name: 'Antivírus dos anexos (ClamAV)', ok: !!av?.ok, detail: av ? av.detail : cfg.appEnv === 'producao' ? 'Não configurado: o envio de arquivos está BLOQUEADO.' : 'Não configurado: anexos aceitos e marcados como "não verificado" (somente fora de produção).' },
    { name: 'Armazenamento dos arquivos', ok: cfg.storage === 'banco' || drive.ok, detail: cfg.storage === 'banco' ? 'Banco de dados da aplicação (incluído no backup do banco).' : `Google Drive compartilhado — ${drive.detail}` },
    { name: 'Login Google (OIDC)', ok: cfg.googleConfigured, detail: cfg.googleConfigured ? `Cliente OAuth configurado; domínio ${cfg.workspaceDomain}.` : 'Cliente OAuth não configurado (P-03).' },
    { name: 'Agenda Google', ok: o.configured.calendar && o.flags['integracoes.calendar.ativo']!, detail: `${o.configured.calendar ? 'Agenda configurada' : 'GOOGLE_CALENDAR_ID não configurado'} · ${o.flags['integracoes.calendar.ativo'] ? 'ativa' : 'desativada'} · ${o.links} evento(s) vinculado(s)${o.lastSync ? ` · última sincronização ${fmtDateTime(o.lastSync.started_at)} (${o.lastSync.created}+ ${o.lastSync.updated}~ ${o.lastSync.deleted}− ${o.lastSync.failed} falha[s])` : ''}` },
    { name: 'Gmail (e-mail institucional)', ok: o.configured.gmail && o.flags['integracoes.gmail.ativo']!, detail: `${o.configured.gmail ? `Remetente ${cfg.google.gmailSender}` : 'GMAIL_SENDER não configurado'} · ${o.flags['integracoes.gmail.ativo'] ? 'ativo' : 'desativado'} · 30 dias: ${count('GMAIL', 'ENVIADO')} enviado(s), ${count('GMAIL', 'PENDENTE')} pendente(s), ${count('GMAIL', 'FALHA')} falha(s)` },
    { name: 'Google Chat', ok: o.configured.chat && o.flags['integracoes.chat.ativo']!, detail: `${o.configured.chat ? 'Webhook configurado' : 'GOOGLE_CHAT_WEBHOOK_URL não configurado'} · ${o.flags['integracoes.chat.ativo'] ? 'ativo' : 'desativado'} · 30 dias: ${count('CHAT', 'ENVIADO')} enviado(s), ${count('CHAT', 'PENDENTE')} pendente(s), ${count('CHAT', 'FALHA')} falha(s)` },
  ];
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h2>Integrações</h2><p>Situação verificada agora. Credenciais: variáveis de ambiente / Secret Manager (ver docs/23-guia-integracoes-google-antivirus.md).</p></div>
        <div className="card-body flush table-wrap" tabIndex={0}><table className="table"><thead><tr><th>Integração</th><th>Situação</th><th>Detalhe</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.name}><td>{r.name}</td><td><span className={r.ok ? 'tag tag-ok' : 'tag tag-warn'}>{r.ok ? 'Ativa' : 'Atenção'}</span></td><td className="small">{r.detail}</td></tr>)}</tbody></table></div>
      </div>
      {manage ? (
        <div className="grid grid-2">
          <div className="card"><div className="card-head"><h2>Ativação</h2><p>Tudo começa desligado. Ative depois de configurar.</p></div>
            <div className="card-body stack" style={{ gap: 6 }}>{Object.entries(o.flags).map(([k, v]) => (
              <div key={k} className="row-between small"><span>{FLAG_LABELS[k] ?? k}</span>
                <ActionForm action={integrationAction} submitLabel={v ? 'Desativar' : 'Ativar'} submitClass={v ? 'btn btn-sm' : 'btn btn-sm btn-primary'} inline>
                  <input type="hidden" name="op" value="flag" /><input type="hidden" name="key" value={k} /><input type="hidden" name="value" value={v ? 'false' : 'true'} />
                </ActionForm>
                <span className={v ? 'tag tag-ok' : 'tag'}>{v ? 'Ligado' : 'Desligado'}</span>
              </div>
            ))}</div>
          </div>
          <div className="card"><div className="card-head"><h2>Operações</h2><p>A rotina diária também executa estas ações.</p></div>
            <div className="card-body stack">
              <ActionForm action={integrationAction} submitLabel="Sincronizar agenda agora" inline><input type="hidden" name="op" value="sincronizar" /></ActionForm>
              <ActionForm action={integrationAction} submitLabel="Enviar mensagens pendentes" inline><input type="hidden" name="op" value="enviar" /></ActionForm>
              <ActionForm action={integrationAction} submitLabel="Reenviar mensagens com falha" inline><input type="hidden" name="op" value="reenviar" /></ActionForm>
              {o.failures.length ? <div className="small"><strong>Últimos erros:</strong>{o.failures.map((f, i) => <div key={i} className="muted">{fmtDateTime(f.created_at)} · {f.channel} · {f.last_error} ({f.attempts} tentativa[s])</div>)}</div> : null}
            </div>
          </div>
        </div>
      ) : null}
      <div className="card"><div className="card-head"><h2>Escopos de acesso solicitados ao Google</h2><p>Somente o estritamente necessário. Nenhuma senha Google é armazenada.</p></div>
        <div className="card-body flush table-wrap" tabIndex={0}><table className="table"><thead><tr><th>API</th><th>Escopo</th><th>Uso</th></tr></thead>
          <tbody>{o.scopes.map((s) => <tr key={s.api}><td>{s.api}</td><td className="mono small">{s.scope}</td><td className="small">{s.uso}</td></tr>)}</tbody></table></div>
      </div>
    </div>
  );
}
