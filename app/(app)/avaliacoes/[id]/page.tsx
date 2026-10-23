import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { EVAL_DISCLAIMER, getEvaluation } from '@/server/modules/evaluations.ts';
import { listTrainings } from '@/server/modules/training.ts';
import { addDays, todayLocal } from '@/domain/time.ts';
import { fmtDate, fmtDateTime, label } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { EVAL_STATUS, PdiList } from '@/ui/development.tsx';
import { evaluationAction } from '../../../actions/phase5b.ts';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Avaliação' };

const ACTS: Record<string, string> = { CIENCIA: 'Ciência', CONCORDANCIA: 'Concordância', CONTESTACAO: 'Discordância' };
type Snapshot = { criterios: { criterio: string; grupo: string; peso: number; nota: number; comentario: string | null; autoavaliacao: number | null }[]; resultadoPonderado: number | null;
  pontosFortes: string | null; aDesenvolver: string | null; feedback: string; pdi: { goal: string; action: string; due_date: string }[]; modelo: string; escala: string };

async function AvaliacaoPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageCtx();
  const { id } = await params;
  const { evaluation: v, role, criteria, scores, versions, signatures, pdi, ackDays } = await getEvaluation(ctx, id);
  const today = todayLocal();
  const pending = v.status === 'PENDENTE';
  const score = (cid: string, src: string) => scores.find((s) => s.criterion_id === cid && s.source === src);
  const scale = Array.from({ length: v.scale_max }, (_, i) => i + 1);
  const latest = versions[0];
  const snap = latest?.content as Snapshot | undefined;
  const lead = role.evaluator || role.manager || role.sectorLead;
  const trainings = role.evaluator && pending ? await listTrainings(ctx).catch(() => []) : [];
  const canCloseNoAck = v.status === 'AGUARDANDO_CIENCIA' && (role.evaluator || role.manager) && v.sent_at && addDays(v.sent_at.toISOString().slice(0, 10), ackDays) <= today;

  return (
    <div className="stack">
      <PageHead title={`${v.period_label} — ${v.employee_name}`} subtitle={<>{v.template_name} (v{v.template_version}) · avaliador(a) {v.evaluator_name} · prazo {fmtDate(v.due_date)}</>}
        actions={<><span className="tag">{EVAL_STATUS[v.status]}</span><Link className="btn" href="/avaliacoes">Voltar</Link></>} />
      <div className="alert alert-info small">{EVAL_DISCLAIMER}{v.instructions ? <div style={{ marginTop: 6 }}><strong>Orientações:</strong> {v.instructions}</div> : null}</div>

      {pending && role.evaluator ? (
        <div className="card"><div className="card-head"><h2>Preenchimento</h2><p>Escala de 1 a {v.scale_max}. {v.self_assessment ? (v.self_submitted_at ? 'Autoavaliação entregue (ao lado).' : 'Aguardando a autoavaliação para enviar.') : ''}</p></div><div className="card-body">
          <ActionForm action={evaluationAction} submitLabel="Confirmar">
            <input type="hidden" name="id" value={v.id} />
            <div className="table-wrap" tabIndex={0}><table className="table"><thead><tr><th>Critério</th><th>Nota</th><th>Comentário</th>{v.self_assessment ? <th>Autoavaliação</th> : null}</tr></thead>
              <tbody>{criteria.map((k) => (
                <tr key={k.id}><td>{k.title}<div className="small muted">{label(k.grp)}{k.weight > 1 ? ` · peso ${k.weight}` : ''}{k.description ? ` · ${k.description}` : ''}</div><input type="hidden" name="criterionId" value={k.id} /></td>
                  <td><select name={`score_${k.id}`} className="input" aria-label={`Nota: ${k.title}`} defaultValue={score(k.id, 'AVALIADOR')?.score ?? ''}><option value="">—</option>{scale.map((n) => <option key={n} value={n}>{n}</option>)}</select></td>
                  <td><input name={`comment_${k.id}`} className="input" aria-label={`Comentário: ${k.title}`} defaultValue={score(k.id, 'AVALIADOR')?.comment ?? ''} /></td>
                  {v.self_assessment ? <td className="num">{score(k.id, 'AUTOAVALIACAO')?.score ?? '—'}</td> : null}</tr>
              ))}</tbody></table></div>
            <div className="form-grid" style={{ marginTop: 12 }}>
              <div className="field"><label>Pontos fortes<textarea name="strengths" className="input" rows={3} defaultValue={v.strengths ?? ''} /></label></div>
              <div className="field"><label>Pontos a desenvolver<textarea name="improvements" className="input" rows={3} defaultValue={v.improvements ?? ''} /></label></div>
            </div>
            <div className="field"><label>Feedback ao avaliado (obrigatório para enviar)<textarea name="feedback" className="input" rows={4} defaultValue={v.feedback ?? ''} /></label></div>
            <div className="field"><label>Ao confirmar<select name="op" className="input"><option value="salvar">Salvar rascunho</option><option value="enviar">Enviar ao avaliado para ciência (congela o conteúdo)</option></select></label></div>
          </ActionForm>
        </div></div>
      ) : null}

      {pending && role.self && v.self_assessment ? (
        <div className="card"><div className="card-head"><h2>Minha autoavaliação</h2><p>{v.self_submitted_at ? `Entregue em ${fmtDateTime(v.self_submitted_at)}.` : 'Você pode salvar e entregar depois. Após a entrega não há alteração.'}</p></div><div className="card-body">
          {v.self_submitted_at ? <table className="table"><tbody>{criteria.map((k) => <tr key={k.id}><td>{k.title}</td><td className="num">{score(k.id, 'AUTOAVALIACAO')?.score ?? '—'}</td><td className="small">{score(k.id, 'AUTOAVALIACAO')?.comment ?? ''}</td></tr>)}</tbody></table> : (
            <ActionForm action={evaluationAction} submitLabel="Confirmar">
              <input type="hidden" name="op" value="autoavaliacao" /><input type="hidden" name="id" value={v.id} />
              <table className="table"><tbody>{criteria.map((k) => (
                <tr key={k.id}><td>{k.title}<input type="hidden" name="criterionId" value={k.id} /></td>
                  <td><select name={`score_${k.id}`} className="input" aria-label={`Nota: ${k.title}`} defaultValue={score(k.id, 'AUTOAVALIACAO')?.score ?? ''}><option value="">—</option>{scale.map((n) => <option key={n} value={n}>{n}</option>)}</select></td>
                  <td><input name={`comment_${k.id}`} className="input" aria-label={`Comentário: ${k.title}`} defaultValue={score(k.id, 'AUTOAVALIACAO')?.comment ?? ''} /></td></tr>
              ))}</tbody></table>
              <div className="field"><label>Ao confirmar<select name="submit" className="input"><option value="0">Salvar</option><option value="1">Entregar ao avaliador</option></select></label></div>
            </ActionForm>
          )}
        </div></div>
      ) : null}

      {pending && role.self && !v.self_assessment ? <div className="alert alert-info small">A avaliação está sendo preenchida pelo(a) avaliador(a). Você será avisado(a) quando estiver disponível.</div> : null}

      {snap && !pending ? (
        <div className="card"><div className="card-head"><h2>Avaliação enviada (versão {latest!.version_number})</h2><p>Enviada em {fmtDateTime(latest!.created_at)} · sha256 {latest!.content_sha256.slice(0, 16)}… · escala {snap.escala}</p></div>
          <div className="card-body flush table-wrap" tabIndex={0}><table className="table"><thead><tr><th>Critério</th><th className="num">Nota</th><th>Comentário</th><th className="num">Autoavaliação</th></tr></thead>
            <tbody>{snap.criterios.map((k, i) => <tr key={i}><td>{k.criterio}<div className="small muted">{label(k.grupo)}{k.peso > 1 ? ` · peso ${k.peso}` : ''}</div></td><td className="num">{k.nota}</td><td className="small">{k.comentario ?? ''}</td><td className="num">{k.autoavaliacao ?? '—'}</td></tr>)}
              <tr><td><strong>Resultado ponderado</strong></td><td className="num"><strong>{snap.resultadoPonderado != null ? `${snap.resultadoPonderado.toLocaleString('pt-BR')}%` : '—'}</strong></td><td colSpan={2} /></tr></tbody></table></div>
          <div className="card-body stack small">
            {snap.pontosFortes ? <div><strong>Pontos fortes:</strong> {snap.pontosFortes}</div> : null}
            {snap.aDesenvolver ? <div><strong>A desenvolver:</strong> {snap.aDesenvolver}</div> : null}
            <div style={{ whiteSpace: 'pre-wrap' }}><strong>Feedback:</strong> {snap.feedback}</div>
            {signatures.filter((s) => s.version_id === latest!.id).map((s, i) => <div key={i} className="alert alert-info"><strong>{ACTS[s.act]}</strong> de {s.signer_name} em {fmtDateTime(s.signed_at)}{s.comment ? ` — “${s.comment}”` : ''}<div className="muted">{s.statement}</div></div>)}
            {v.close_notes ? <div className="alert alert-warn">{EVAL_STATUS[v.status]}: {v.close_notes}</div> : null}
          </div>
        </div>
      ) : null}

      {v.status === 'AGUARDANDO_CIENCIA' && role.self ? (
        <div className="card"><div className="card-head"><h2>Minha manifestação</h2><p>A ciência confirma que você recebeu e leu a avaliação; não significa concordância. Você também pode concordar ou registrar discordância com seus motivos.</p></div><div className="card-body">
          <ActionForm action={evaluationAction} submitLabel="Registrar manifestação">
            <input type="hidden" name="op" value="manifestar" /><input type="hidden" name="id" value={v.id} />
            {Object.entries(ACTS).map(([k, t]) => <label key={k} className="check" style={{ display: 'block' }}><input type="radio" name="act" value={k} defaultChecked={k === 'CIENCIA'} required /> {t}</label>)}
            <div className="field"><label>Comentário (obrigatório na discordância)<textarea name="comment" className="input" rows={3} /></label></div>
            <label className="check"><input type="checkbox" name="confirmed" required /> Confirmo expressamente a manifestação selecionada sobre esta versão.</label>
          </ActionForm>
        </div></div>
      ) : null}

      {lead || role.self ? (
        <div className="card"><div className="card-head"><h2>Plano de desenvolvimento (PDI)</h2></div><div className="card-body flush table-wrap" tabIndex={0}>
          <PdiList items={pdi} action={evaluationAction} canProgress={role.self} canClose={lead && !role.self} />
        </div>
          {pending && role.evaluator ? (
            <div className="card-body"><ActionForm action={evaluationAction} submitLabel="Incluir no PDI" resetOnSuccess>
              <input type="hidden" name="op" value="pdi" /><input type="hidden" name="id" value={v.id} /><input type="hidden" name="evaluationId" value={v.id} /><input type="hidden" name="employeeId" value={v.employee_id} />
              <div className="form-grid">
                <div className="field"><label>Objetivo<input name="goal" className="input" required minLength={3} /></label></div>
                <div className="field"><label>Ação<input name="action" className="input" required minLength={3} /></label></div>
                <div className="field"><label>Treinamento recomendado<select name="trainingId" className="input"><option value="">—</option>{trainings.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.code} — {t.title}</option>)}</select></label></div>
                <div className="field"><label>Prazo<input name="dueDate" type="date" className="input" defaultValue={addDays(today, 90)} required /></label></div>
              </div>
            </ActionForm></div>
          ) : null}
        </div>
      ) : null}

      {v.status === 'AGUARDANDO_CIENCIA' && (role.evaluator || role.manager) ? (
        <div className="grid grid-2">
          <div className="card"><div className="card-head"><h2>Retificar</h2><p>Reabre o preenchimento; o próximo envio gera nova versão e esta fica no histórico.</p></div><div className="card-body">
            <ActionForm action={evaluationAction} submitLabel="Retificar"><input type="hidden" name="op" value="retificar" /><input type="hidden" name="id" value={v.id} /><input name="reason" className="input" aria-label="Motivo" placeholder="Motivo" required minLength={5} /></ActionForm>
          </div></div>
          <div className="card"><div className="card-head"><h2>Encerrar sem ciência</h2><p>Disponível {ackDays} dias após o envio, com o motivo (ex.: recusa em se manifestar).</p></div><div className="card-body">
            {canCloseNoAck ? <ActionForm action={evaluationAction} submitLabel="Encerrar sem ciência"><input type="hidden" name="op" value="sem_ciencia" /><input type="hidden" name="id" value={v.id} /><input name="notes" className="input" aria-label="Motivo" placeholder="Motivo" required minLength={5} /></ActionForm>
              : <Empty>Ainda dentro do prazo de manifestação.</Empty>}
          </div></div>
        </div>
      ) : null}

      {versions.length > 1 ? (
        <div className="card"><div className="card-head"><h2>Versões anteriores</h2></div><div className="card-body flush table-wrap" tabIndex={0}><table className="table"><tbody>
          {versions.slice(1).map((x) => <tr key={x.id}><td>Versão {x.version_number}</td><td className="small">{fmtDateTime(x.created_at)}</td><td className="small">sha256 {x.content_sha256.slice(0, 16)}…</td>
            <td className="small">{signatures.filter((s) => s.version_id === x.id).map((s) => ACTS[s.act]).join(', ') || 'sem manifestação'}</td></tr>)}
        </tbody></table></div></div>
      ) : null}

      {can(ctx.principal, 'avaliacoes.gerenciar') && !role.self && (v.status === 'PENDENTE' || v.status === 'AGUARDANDO_CIENCIA') ? (
        <details className="disclosure small"><summary><a>Cancelar avaliação</a></summary>
          <ActionForm action={evaluationAction} submitLabel="Cancelar avaliação" submitClass="btn btn-sm btn-danger"><input type="hidden" name="op" value="cancelar" /><input type="hidden" name="id" value={v.id} /><input name="notes" className="input" aria-label="Motivo" placeholder="Motivo" required minLength={5} /></ActionForm>
        </details>
      ) : null}
    </div>
  );
}

export default withGuard(AvaliacaoPage);
