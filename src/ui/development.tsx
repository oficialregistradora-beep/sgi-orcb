import type { ActionState } from '../server/web/action.ts';
import { ActionForm } from './ActionForm.tsx';
import type { TrainingSituation } from '../domain/development.ts';

const SIT: Record<TrainingSituation, { text: string; cls: string }> = {
  VALIDO: { text: 'Válido', cls: 'tag tag-ok' }, A_VENCER: { text: 'A vencer', cls: 'tag tag-warn' }, VENCIDO: { text: 'Vencido', cls: 'tag tag-danger' },
  PENDENTE: { text: 'Pendente', cls: 'tag tag-danger' }, EM_ANDAMENTO: { text: 'Em andamento', cls: 'tag tag-info' }, NOVA_VERSAO: { text: 'Nova versão do POP', cls: 'tag tag-warn' },
};
export function Situation({ s }: { s: TrainingSituation }) { return <span className={SIT[s].cls}>{SIT[s].text}</span>; }
export const KINDS = ['CURSO_INTERNO', 'CURSO_EXTERNO', 'ESTUDO_POP', 'PALESTRA', 'SISTEMA', 'INTEGRACAO', 'OUTRO'];
export const KIND_LABEL: Record<string, string> = { CURSO_INTERNO: 'Curso interno', CURSO_EXTERNO: 'Curso externo', ESTUDO_POP: 'Estudo de POP', PALESTRA: 'Palestra', SISTEMA: 'Sistema', INTEGRACAO: 'Integração de novos', OUTRO: 'Outro' };

export function TrainingFields({ sectors, jobs, docs, t }: { sectors: { id: string; name: string }[]; jobs: { id: string; name: string }[]; docs: { id: string; title: string }[];
  t?: { id: string; code: string; title: string; kind: string; description: string | null; provider: string | null; workload_minutes: number | null; document_id: string | null; validity_months: number | null;
    mandatory: boolean; audience_type: string; sectors: string[]; jobs: string[]; has_assessment: boolean; pass_score: number; max_attempts: number; active: boolean } }) {
  const hm = (m: number | null) => (m ? `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` : '');
  return (
    <>
      {t ? <><input type="hidden" name="id" value={t.id} /><input type="hidden" name="activeField" value="1" /></> : null}
      <div className="form-grid">
        <div className="field"><label>Código<input name="code" className="input" required defaultValue={t?.code} placeholder="EX.: LGPD-01" /></label></div>
        <div className="field" style={{ gridColumn: 'span 2' }}><label>Título<input name="title" className="input" required minLength={3} defaultValue={t?.title} /></label></div>
        <div className="field"><label>Tipo<select name="kind" className="input" defaultValue={t?.kind}>{KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label></div>
        <div className="field"><label>Instituição/instrutor<input name="provider" className="input" defaultValue={t?.provider ?? ''} /></label></div>
        <div className="field"><label>Carga horária (HH:MM)<input name="workload" className="input" placeholder="02:00" defaultValue={hm(t?.workload_minutes ?? null)} /></label></div>
        <div className="field"><label>Documento a estudar (POP)<select name="documentId" className="input" defaultValue={t?.document_id ?? ''}><option value="">—</option>{docs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label></div>
        <div className="field"><label>Reciclagem a cada (meses)<input name="validityMonths" type="number" min={1} max={120} className="input" defaultValue={t?.validity_months ?? ''} /></label></div>
        <div className="field"><label>Público<select name="audienceType" className="input" defaultValue={t?.audience_type ?? 'TODOS'}><option value="TODOS">Todos</option><option value="SETORES">Setores</option><option value="CARGOS">Cargos</option></select></label></div>
        <div className="field"><label>Setores (se público = setores)<select name="sectorIds" className="input" multiple size={4} defaultValue={t?.sectors ?? []}>{sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></div>
        <div className="field"><label>Cargos (se público = cargos)<select name="jobIds" className="input" multiple size={4} defaultValue={t?.jobs ?? []}>{jobs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></div>
        <div className="field"><label>Nota mínima (%)<input name="passScore" type="number" min={1} max={100} className="input" defaultValue={t?.pass_score ?? 70} /></label></div>
        <div className="field"><label>Tentativas<input name="maxAttempts" type="number" min={1} max={20} className="input" defaultValue={t?.max_attempts ?? 3} /></label></div>
      </div>
      <div className="field" style={{ marginTop: 12 }}><label>Descrição / conteúdo programático<textarea name="description" className="input" rows={2} defaultValue={t?.description ?? ''} /></label></div>
      <div className="row" style={{ marginTop: 10 }}>
        <label className="check"><input type="checkbox" name="mandatory" defaultChecked={t?.mandatory} /> Obrigatório para o público</label>
        <label className="check"><input type="checkbox" name="hasAssessment" defaultChecked={t?.has_assessment} /> Com avaliação de aprendizagem</label>
        {t ? <label className="check"><input type="checkbox" name="active" defaultChecked={t.active} /> Ativo</label> : null}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Avaliações
// ---------------------------------------------------------------------------

export const EVAL_STATUS: Record<string, string> = {
  PENDENTE: 'Em preenchimento', AGUARDANDO_CIENCIA: 'Aguardando ciência', CONCLUIDA: 'Concluída', CONCLUIDA_SEM_CIENCIA: 'Concluída sem ciência', CANCELADA: 'Cancelada',
};
const evalTone = (s: string) => (s === 'CONCLUIDA' ? 'tag tag-ok' : s === 'AGUARDANDO_CIENCIA' ? 'tag tag-warn' : s === 'PENDENTE' ? 'tag tag-info' : 'tag');

type EvalLite = { id: string; employee_name: string; sector_name: string; period_label: string; template_name: string; evaluator_name: string; due_date: string; status: string;
  overall_score: string | null; self_assessment: boolean; self_submitted_at: Date | null };

export function EvalTable({ rows, today, showEmployee }: { rows: EvalLite[]; today: string; showEmployee?: boolean }) {
  return (
    <table className="table">
      <thead><tr>{showEmployee ? <th>Avaliado(a)</th> : null}<th>Avaliação</th><th>Avaliador(a)</th><th>Prazo</th><th>Situação</th><th className="num">Resultado</th></tr></thead>
      <tbody>{rows.map((v) => (
        <tr key={v.id} className={v.status === 'CANCELADA' ? 'row-muted' : undefined}>
          {showEmployee ? <td>{v.employee_name}<div className="small muted">{v.sector_name}</div></td> : null}
          <td><a href={`/avaliacoes/${v.id}`}>{v.period_label}</a><div className="small muted">{v.template_name}{v.self_assessment && !v.self_submitted_at && v.status === 'PENDENTE' ? ' · autoavaliação pendente' : ''}</div></td>
          <td className="small">{v.evaluator_name}</td>
          <td className={`small nowrap ${v.status === 'PENDENTE' && v.due_date < today ? 'neg' : ''}`}>{v.due_date.split('-').reverse().join('/')}</td>
          <td><span className={evalTone(v.status)}>{EVAL_STATUS[v.status]}</span></td>
          <td className="num">{v.overall_score != null ? `${Number(v.overall_score).toLocaleString('pt-BR')}%` : '—'}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

type PdiLite = { id: string; goal: string; action: string; training_title: string | null; due_date: string; status: string; result_notes: string | null };

export function PdiList({ items, action, canProgress, canClose }: { items: PdiLite[]; action: (p: ActionState, fd: FormData) => Promise<ActionState>; canProgress: boolean; canClose: boolean }) {
  if (!items.length) return <div className="empty">Nenhum item.</div>;
  const st: Record<string, string> = { ABERTO: 'Aberto', EM_ANDAMENTO: 'Em andamento', CONCLUIDO: 'Concluído', CANCELADO: 'Cancelado' };
  return (
    <table className="table"><thead><tr><th>Objetivo</th><th>Ação</th><th>Prazo</th><th>Situação</th>{canProgress || canClose ? <th></th> : null}</tr></thead>
      <tbody>{items.map((i) => {
        const open = i.status === 'ABERTO' || i.status === 'EM_ANDAMENTO';
        return (
          <tr key={i.id} className={open ? undefined : 'row-muted'}>
            <td>{i.goal}</td><td className="small">{i.action}{i.training_title ? <div className="muted">Treinamento: {i.training_title}</div> : null}</td>
            <td className="small nowrap">{i.due_date.split('-').reverse().join('/')}</td>
            <td><span className="tag">{st[i.status]}</span>{i.result_notes ? <div className="small muted">{i.result_notes}</div> : null}</td>
            {canProgress || canClose ? <td>{open ? <div className="stack">
              {canProgress && i.status === 'ABERTO' ? <ActionForm action={action} submitLabel="Iniciar" submitClass="btn btn-sm" inline><input type="hidden" name="op" value="pdi_status" /><input type="hidden" name="pdiId" value={i.id} /><input type="hidden" name="status" value="EM_ANDAMENTO" /></ActionForm> : null}
              {canClose ? <details className="disclosure small"><summary><a>Encerrar</a></summary><ActionForm action={action} submitLabel="Registrar" submitClass="btn btn-sm">
                <input type="hidden" name="op" value="pdi_status" /><input type="hidden" name="pdiId" value={i.id} />
                <select name="status" className="input" aria-label="Resultado"><option value="CONCLUIDO">Concluído</option><option value="CANCELADO">Cancelado</option></select>
                <input name="notes" className="input" placeholder="Resultado" aria-label="Resultado" required minLength={3} /></ActionForm></details> : null}
            </div> : null}</td> : null}
          </tr>
        );
      })}</tbody></table>
  );
}
