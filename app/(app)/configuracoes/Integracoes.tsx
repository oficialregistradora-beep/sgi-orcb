import { getConfig } from '@/server/config.ts';
import { antivirusVersion } from '@/server/antivirus.ts';
import { driveCheck } from '@/server/drive.ts';

/** Situação das integrações (somente leitura). A configuração é feita por variáveis de ambiente / Secret Manager. */
export async function Integracoes() {
  const cfg = getConfig();
  const av = cfg.clamav ? await antivirusVersion().then((v) => ({ ok: true, detail: v ?? '' }), (e) => ({ ok: false, detail: `Inacessível: ${String(e).slice(0, 120)}` })) : null;
  const drive = await driveCheck();
  const rows = [
    {
      name: 'Antivírus dos anexos (ClamAV)',
      ok: !!av?.ok,
      detail: av ? av.detail : cfg.appEnv === 'producao' ? 'Não configurado: o envio de arquivos está BLOQUEADO.' : 'Não configurado: anexos aceitos e marcados como "não verificado" (somente fora de produção).',
    },
    { name: 'Armazenamento dos arquivos', ok: cfg.storage === 'banco' || drive.ok, detail: cfg.storage === 'banco' ? 'Banco de dados da aplicação (incluído no backup do banco).' : `Google Drive compartilhado — ${drive.detail}` },
    { name: 'Login Google (OIDC)', ok: cfg.googleConfigured, detail: cfg.googleConfigured ? `Cliente OAuth configurado; domínio ${cfg.workspaceDomain}.` : 'Cliente OAuth não configurado (P-03).' },
  ];
  return (
    <div className="card">
      <div className="card-head"><h2>Integrações</h2><p>Situação verificada agora. Alterações são feitas pela equipe técnica nas variáveis de ambiente (ver docs/23-guia-integracoes-google-antivirus.md).</p></div>
      <div className="card-body flush table-wrap">
        <table className="table"><thead><tr><th>Integração</th><th>Situação</th><th>Detalhe</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.name}><td>{r.name}</td><td><span className={r.ok ? 'tag tag-ok' : 'tag tag-warn'}>{r.ok ? 'Ativa' : 'Atenção'}</span></td><td className="small">{r.detail}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
