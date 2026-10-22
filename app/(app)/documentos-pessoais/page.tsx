import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import {
  DOC_KINDS, getVersion, listEmployeeDocuments, listPendingApprovals, statementFor, verifyVersion, type Act,
} from '@/server/modules/documents.ts';
import { addMonths, todayLocal } from '@/domain/time.ts';
import { fmtDate, fmtDateTime, fmtMin, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { prepareDocumentAction, signAction } from '../../actions/bank.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Documentos' };

type Espelho = {
  funcionario: { nome: string; matricula: string; cargo: string; setor: string }; competencia: string; ressalva: string; jornadaContratual: string | null;
  dias: { data: string; diaSemana: string; situacao: string; feriado: string | null; ausencia: string | null; marcacoes: { hora: string; origem: string }[];
    desconsideradas: string[]; previsto: number; trabalhado: number; diferenca: number; alertas: string[]; ocorrencias: { tipo: string; minutos: number; decisao: string | null }[] }[];
  totais: { previsto: number; trabalhado: number; compensado: number; extras: number; negativas: number };
};
type Extrato = {
  funcionario: Espelho['funcionario']; competencia: string; acordo: { modalidade: string; prazoMeses: number } | null; observacao: string;
  lancamentos: { data: string; tipo: string; minutos: number; vencimento: string | null; observacao: string | null }[];
  posicaoAoFinalDaCompetencia: { saldo: number; disponivel: number; aVencerEm30Dias: number; vencidoRequerPagamento: number };
};

function EspelhoView({ c }: { c: Espelho }) {
  return (
    <div className="doc">
      <header className="stack" style={{ gap: 4 }}>
        <strong>{c.funcionario.nome}</strong>
        <span className="small muted">Matrícula {c.funcionario.matricula} · {c.funcionario.cargo} · {c.funcionario.setor} · Jornada: {c.jornadaContratual ?? '—'}</span>
        <span className="small">{c.ressalva}</span>
      </header>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Data</th><th>Situação</th><th>Marcações</th><th className="num">Previsto</th><th className="num">Trabalhado</th><th className="num">Diferença</th><th>Ocorrências / alertas</th></tr></thead>
          <tbody>
            {c.dias.map((d) => (
              <tr key={d.data}>
                <td className="nowrap">{fmtDate(d.data)} <span className="muted small">{d.diaSemana.slice(0, 3)}</span></td>
                <td className="small">{d.feriado ? `Feriado: ${d.feriado}` : d.ausencia ? label(d.ausencia) : label(d.situacao)}</td>
                <td className="small">{d.marcacoes.map((m) => `${m.hora}${m.origem !== 'Registro web' ? '*' : ''}`).join(' · ')}{d.desconsideradas.length ? <span className="muted"> (desconsideradas: {d.desconsideradas.join(', ')})</span> : null}</td>
                <td className="num">{d.previsto ? fmtMin(d.previsto) : '—'}</td>
                <td className="num">{d.trabalhado ? fmtMin(d.trabalhado) : '—'}</td>
                <td className="num">{d.diferenca ? fmtMin(d.diferenca, true) : '—'}</td>
                <td className="small">
                  {d.ocorrencias.map((o, i) => <div key={i}>{label(o.tipo)} {o.minutos ? fmtMin(o.minutos) : ''} → {label(o.decisao)}</div>)}
                  {d.alertas.map((a) => <div key={a} className="muted">{a}</div>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small" style={{ marginTop: 8 }}>
        Totais — previsto {fmtMin(c.totais.previsto)} · trabalhado {fmtMin(c.totais.trabalhado)} · compensado {fmtMin(c.totais.compensado)} · excedente {fmtMin(c.totais.extras)} · faltante {fmtMin(c.totais.negativas)}.
        <span className="muted"> * correção aprovada ou importação.</span>
      </p>
    </div>
  );
}

function ExtratoView({ c }: { c: Extrato }) {
  const p = c.posicaoAoFinalDaCompetencia;
  return (
    <div className="doc">
      <header className="stack" style={{ gap: 4 }}>
        <strong>{c.funcionario.nome}</strong>
        <span className="small muted">Matrícula {c.funcionario.matricula} · {c.acordo ? `${label(c.acordo.modalidade)} (${c.acordo.prazoMeses} meses)` : 'Sem acordo vigente'}</span>
      </header>
      <table className="table">
        <thead><tr><th>Data</th><th>Lançamento</th><th className="num">Minutos</th><th>Vencimento</th><th>Observação</th></tr></thead>
        <tbody>
          {c.lancamentos.length ? c.lancamentos.map((l, i) => (
            <tr key={i}><td>{fmtDate(l.data)}</td><td>{label(l.tipo)}</td><td className="num">{fmtMin(l.minutos, true)}</td><td>{l.vencimento ? fmtDate(l.vencimento) : '—'}</td><td className="small">{l.observacao}</td></tr>
          )) : <tr><td colSpan={5} className="muted">Sem lançamentos na competência.</td></tr>}
        </tbody>
      </table>
      <p className="small" style={{ marginTop: 8 }}>
        Posição ao final da competência: saldo {fmtMin(p.saldo, true)} · disponível {fmtMin(p.disponivel)} · a vencer em 30 dias {fmtMin(p.aVencerEm30Dias)} · vencido {fmtMin(p.vencidoRequerPagamento)}. {c.observacao}
      </p>
    </div>
  );
}

const OWNER_ACTS: Act[] = ['CIENCIA', 'CONCORDANCIA', 'CONTESTACAO'];

export default async function DocumentosPage({ searchParams }: { searchParams: Promise<{ doc?: string; aba?: string }> }) {
  const ctx = await requirePageCtx();
  const sp = await searchParams;
  const isApprover = can(ctx.principal, 'espelho.aprovar');
  const tab = sp.aba === 'aprovar' && isApprover ? 'aprovar' : 'meus';
  const version = sp.doc ? await getVersion(ctx, sp.doc) : null;
  const integrity = version ? await verifyVersion(ctx, version.versionId) : null;
  const mine = ctx.principal.employeeId && tab === 'meus' ? await listEmployeeDocuments(ctx, ctx.principal.employeeId) : [];
  const pending = tab === 'aprovar' ? await listPendingApprovals(ctx) : [];
  const lastMonth = addMonths(`${todayLocal().slice(0, 7)}-01`, -1).slice(0, 7);
  const isOwnerOfDoc = version && version.ownerEmployeeId === ctx.principal.employeeId;
  const ownerAck = version?.signatures.find((s) => s.act !== 'APROVACAO');
  const approved = version?.signatures.some((s) => s.act === 'APROVACAO');

  return (
    <div className="stack">
      <PageHead title="Documentos pessoais" subtitle="Espelhos de frequência e extratos do banco de horas com assinatura eletrônica simples vinculada ao conteúdo (hash SHA-256)." />
      <nav className="tabs">
        <Link href="/documentos-pessoais" aria-current={tab === 'meus' ? 'page' : undefined}>Meus documentos</Link>
        {isApprover ? <Link href="/documentos-pessoais?aba=aprovar" aria-current={tab === 'aprovar' ? 'page' : undefined}>Aguardando aprovação</Link> : null}
      </nav>

      {version ? (
        <div className="card">
          <div className="card-head">
            <div>
              <h2>{version.title}</h2>
              <p>Versão {version.versionNumber}{version.isLatest ? '' : ' (substituída por versão posterior)'} · gerada em {fmtDateTime(version.createdAt)}</p>
            </div>
            <span className={integrity?.contentOk ? 'tag tag-ok' : 'tag tag-danger'}>{integrity?.contentOk ? 'Integridade verificada' : 'FALHA DE INTEGRIDADE'}</span>
          </div>
          <div className="card-body stack">
            {version.kind === 'ESPELHO' ? <EspelhoView c={version.content as unknown as Espelho} /> : <ExtratoView c={version.content as unknown as Extrato} />}
            <div className="small muted">SHA-256: <span className="mono hash">{version.contentSha256}</span></div>
            <div>
              <h3>Manifestações</h3>
              {version.signatures.length ? (
                <ul className="small">
                  {version.signatures.map((s) => (
                    <li key={s.id}>
                      <span className={statusTone(s.act)}>{label(s.act)}</span> {s.signer_name} — {fmtDateTime(s.signed_at)}
                      {integrity?.signatures.find((x) => x.id === s.id)?.ok ? ' · evidências íntegras' : ' · EVIDÊNCIA DIVERGENTE'}
                      {s.comment ? <div className="muted">“{s.comment}”</div> : null}
                    </li>
                  ))}
                </ul>
              ) : <p className="small muted">Nenhuma manifestação registrada.</p>}
            </div>
            {version.isLatest && isOwnerOfDoc && !ownerAck ? (
              <div className="card"><div className="card-body">
                <ActionForm action={signAction} submitLabel="Registrar manifestação">
                  <input type="hidden" name="versionId" value={version.versionId} />
                  <fieldset className="stack" style={{ gap: 8 }}>
                    <legend className="label">Escolha sua manifestação (ciência não implica concordância)</legend>
                    {OWNER_ACTS.map((a, i) => (
                      <label key={a} className="check"><input type="radio" name="act" value={a} defaultChecked={i === 0} required /> <span><strong>{label(a)}</strong> — {statementFor(a, version.contentSha256)}</span></label>
                    ))}
                  </fieldset>
                  <div className="field" style={{ marginTop: 12 }}><label htmlFor="sg-c">Comentário (obrigatório para contestação)</label><textarea id="sg-c" name="comment" className="input" /></div>
                  <label className="check" style={{ marginTop: 12 }}><input type="checkbox" name="confirmed" required /> Confirmo expressamente a manifestação selecionada sobre esta versão do documento.</label>
                </ActionForm>
              </div></div>
            ) : null}
            {version.isLatest && !isOwnerOfDoc && ownerAck && !approved && can(ctx.principal, 'espelho.aprovar', { employeeId: version.ownerEmployeeId, sectorId: version.sectorId }) ? (
              <div className="card"><div className="card-body">
                <ActionForm action={signAction} submitLabel="Aprovar conferência">
                  <input type="hidden" name="versionId" value={version.versionId} />
                  <input type="hidden" name="act" value="APROVACAO" />
                  <p className="small">{statementFor('APROVACAO', version.contentSha256)}</p>
                  <div className="field" style={{ marginTop: 8 }}><label htmlFor="ap-c">Análise {ownerAck.act === 'CONTESTACAO' ? '(obrigatória: documento contestado)' : '(opcional)'}</label><textarea id="ap-c" name="comment" className="input" /></div>
                  <label className="check" style={{ marginTop: 8 }}><input type="checkbox" name="confirmed" required /> Confirmo a aprovação desta versão.</label>
                </ActionForm>
              </div></div>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === 'meus' ? (
        <div className="grid grid-2">
          <div className="card">
            <div className="card-head"><h2>Meus documentos</h2></div>
            <div className="card-body flush table-wrap">
              {mine.length ? (
                <table className="table">
                  <thead><tr><th>Documento</th><th>Versão</th><th>Minha manifestação</th><th>Aprovação</th></tr></thead>
                  <tbody>
                    {mine.map((d) => (
                      <tr key={d.document_id}>
                        <td><Link href={`/documentos-pessoais?doc=${d.version_id}`}>{d.title}</Link></td>
                        <td>v{d.version_number}</td>
                        <td>{d.employee_ack ? <span className={statusTone(d.employee_ack)}>{label(d.employee_ack)}</span> : <span className="tag tag-warn">Pendente</span>}</td>
                        <td>{d.approved ? <span className="tag tag-ok">Aprovado</span> : <span className="tag">Aguardando</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <Empty>Nenhum documento gerado.</Empty>}
            </div>
          </div>
          {ctx.principal.employeeId ? (
            <div className="card">
              <div className="card-head"><h2>Gerar documento mensal</h2><p>Somente competências encerradas e sem pendências</p></div>
              <div className="card-body">
                <ActionForm action={prepareDocumentAction} submitLabel="Gerar">
                  <div className="form-grid">
                    <div className="field"><label htmlFor="pd-k">Tipo</label>
                      <select id="pd-k" name="kind" className="input">{Object.entries(DOC_KINDS).map(([k, v]) => <option key={k} value={k}>{v.title}</option>)}</select>
                    </div>
                    <div className="field"><label htmlFor="pd-p">Competência</label><input id="pd-p" name="period" type="month" className="input" defaultValue={lastMonth} max={lastMonth} required /></div>
                  </div>
                </ActionForm>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="card">
          <div className="card-body flush table-wrap">
            {pending.length ? (
              <table className="table">
                <thead><tr><th>Documento</th><th>Funcionário</th><th>Manifestação</th><th>Em</th></tr></thead>
                <tbody>
                  {pending.map((p) => (
                    <tr key={p.version_id}>
                      <td><Link href={`/documentos-pessoais?aba=aprovar&doc=${p.version_id}`}>{p.title}</Link></td>
                      <td>{p.full_name}</td>
                      <td><span className={statusTone(p.employee_act)}>{label(p.employee_act)}</span></td>
                      <td className="small">{fmtDateTime(p.signed_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty>Nenhum documento aguardando aprovação.</Empty>}
          </div>
        </div>
      )}
    </div>
  );
}
