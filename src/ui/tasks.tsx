import Link from 'next/link';
import type { TaskRow } from '../server/modules/tasks.ts';
import { ganttBars } from '../domain/recurrence.ts';
import { addDays, formatHHMM, todayLocal, toLocalParts, weekdayOf } from '../domain/time.ts';
import { fmtDate, label, statusTone } from './format.ts';
import { ActionForm } from './ActionForm.tsx';
import { Empty } from './Stat.tsx';
import { quickStatusAction } from '../../app/actions/phase4a.ts';

type Dir = { users: { id: string; display_name: string; sector_id: string | null }[]; sectors: { id: string; name: string }[] };

export const hm = (m: number | null) => (m == null ? '' : formatHHMM(m));

function Due({ t }: { t: Pick<TaskRow, 'due_date' | 'due_time' | 'status' | 'block_start' | 'block_end'> }) {
  if (!t.due_date) return <span className="muted">—</span>;
  const today = todayLocal();
  const passed = t.due_date < today || (t.due_date === today && t.due_time != null && toLocalParts(new Date()).minutes > t.due_time);
  const late = passed && t.status !== 'CONCLUIDA' && t.status !== 'CANCELADA';
  return (
    <span className={late ? 'neg' : undefined}>
      {fmtDate(t.due_date)}{t.due_time != null ? ` ${hm(t.due_time)}` : ''}{t.block_start != null ? ` · bloco ${hm(t.block_start)}–${hm(t.block_end)}` : ''}{late ? ' (vencida)' : ''}
    </span>
  );
}

export function TaskTable({ tasks, showProject = true }: { tasks: TaskRow[]; showProject?: boolean }) {
  if (!tasks.length) return <Empty>Nenhuma tarefa encontrada.</Empty>;
  return (
    <table className="table">
      <thead><tr><th>Tarefa</th><th>Prioridade</th><th>Situação</th><th>Responsável</th><th>Prazo</th>{showProject ? <th>Projeto / origem</th> : null}</tr></thead>
      <tbody>{tasks.map((t) => (
        <tr key={t.id}>
          <td><Link href={`/tarefas/${t.id}`}>{t.title}</Link>
            <div className="small muted">{t.sector_name}{t.checklist_total ? ` · checklist ${t.checklist_done}/${t.checklist_total}` : ''}{t.escalation_level !== 'NENHUM' ? ` · encaminhada à ${label(t.escalation_level)}` : ''}</div></td>
          <td><span className={statusTone(t.priority)}>{label(t.priority)}</span></td>
          <td><span className={statusTone(t.status)}>{label(t.status)}</span>{t.blocked_reason ? <div className="small muted">{t.blocked_reason}</div> : null}</td>
          <td className="small">{t.assignee_name ?? <span className="muted">Setor</span>}</td>
          <td className="small nowrap"><Due t={t} /></td>
          {showProject ? <td className="small">{t.project_name ?? (t.routine_id ? 'Rotina' : t.process_instance_id ? 'Processo' : '—')}</td> : null}
        </tr>
      ))}</tbody>
    </table>
  );
}

const COLUMNS: { status: TaskRow['status']; next?: { to: TaskRow['status']; label: string } }[] = [
  { status: 'A_FAZER', next: { to: 'EM_ANDAMENTO', label: 'Iniciar' } },
  { status: 'EM_ANDAMENTO', next: { to: 'CONCLUIDA', label: 'Concluir' } },
  { status: 'BLOQUEADA', next: { to: 'EM_ANDAMENTO', label: 'Retomar' } },
  { status: 'EM_REVISAO' },
  { status: 'CONCLUIDA' },
];

/** Quadro (Kanban). Mudanças de situação por botão; bloqueio e cancelamento pela página da tarefa (exigem motivo). */
export function TaskBoard({ tasks, userId }: { tasks: TaskRow[]; userId: string }) {
  return (
    <div className="board" role="list" aria-label="Quadro de tarefas">
      {COLUMNS.map((c) => {
        const items = tasks.filter((t) => t.status === c.status);
        return (
          <section key={c.status} className="board-col" role="listitem" aria-label={label(c.status)}>
            <h3><span>{label(c.status)}</span><span>{items.length}</span></h3>
            {items.slice(0, 60).map((t) => (
              <article key={t.id} className={`task-card prio-${t.priority}`}>
                <Link href={`/tarefas/${t.id}`}>{t.title}</Link>
                <div className="meta">
                  <span className={statusTone(t.priority)}>{label(t.priority)}</span>
                  <span>{t.assignee_name ?? 'Setor'}</span>
                  {t.due_date ? <Due t={t} /> : null}
                </div>
                {c.next && (t.assignee_user_id === userId || t.created_by === userId || t.member_role === 'GESTOR') ? (
                  <ActionForm action={quickStatusAction} submitLabel={t.requires_approval && c.next.to === 'CONCLUIDA' ? 'Enviar p/ aprovação' : c.next.label} submitClass="btn btn-sm" inline>
                    <input type="hidden" name="taskId" value={t.id} /><input type="hidden" name="status" value={c.next.to} />
                  </ActionForm>
                ) : null}
              </article>
            ))}
            {items.length > 60 ? <span className="small muted">+{items.length - 60} — use a lista</span> : null}
          </section>
        );
      })}
    </div>
  );
}

/** Calendário mensal pelos prazos. */
export function TaskCalendar({ tasks, period }: { tasks: TaskRow[]; period: string }) {
  const first = `${period}-01`;
  const start = addDays(first, -((weekdayOf(first) + 6) % 7)); // segunda-feira
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const today = todayLocal();
  return (
    <div className="cal" role="grid" aria-label="Calendário de prazos">
      {['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map((d) => <div key={d} className="cal-head" role="columnheader">{d}</div>)}
      {days.map((d) => {
        const list = tasks.filter((t) => t.due_date === d);
        return (
          <div key={d} role="gridcell" className={`${d.slice(0, 7) !== period ? 'cal-out' : ''} ${d === today ? 'cal-today' : ''}`}>
            <div className="muted">{Number(d.slice(8))}</div>
            {list.slice(0, 4).map((t) => <Link key={t.id} href={`/tarefas/${t.id}`} title={t.title} className={t.status === 'CONCLUIDA' ? 'muted' : t.priority === 'IMEDIATA' || t.priority === 'URGENTE' ? 'neg' : undefined}>{t.due_time != null ? `${hm(t.due_time)} ` : ''}{t.title}</Link>)}
            {list.length > 4 ? <span className="muted">+{list.length - 4}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

export type GanttItem = { id: string; label: string; start: string | null; end: string | null; kind: 'task' | 'phase' | 'milestone'; done?: boolean; href?: string };

/** Gantt simples renderizado no servidor (sem bibliotecas externas). */
export function Gantt({ items, from, to }: { items: GanttItem[]; from: string; to: string }) {
  const bars = new Map(ganttBars(items, from, to).map((b) => [b.id, b]));
  const today = todayLocal();
  const todayBar = ganttBars([{ id: 'hoje', start: today, end: today }], from, to)[0];
  if (!items.some((i) => bars.has(i.id))) return <Empty>Inclua datas de início e prazo nas tarefas e fases para ver o cronograma.</Empty>;
  return (
    <div className="gantt" role="table" aria-label="Cronograma">
      <div className="small muted">Item</div>
      <div className="g-scale"><span>{fmtDate(from)}</span><span>{fmtDate(addDays(from, Math.round((Date.parse(to) - Date.parse(from)) / 172800000)))}</span><span>{fmtDate(to)}</span></div>
      {items.filter((i) => bars.has(i.id)).map((i) => {
        const b = bars.get(i.id)!;
        const late = i.kind === 'task' && !i.done && !!i.end && i.end < today;
        return (
          <div key={i.id} style={{ display: 'contents' }} role="row">
            <div className="small" role="cell">{i.href ? <Link href={i.href}>{i.label}</Link> : <strong>{i.label}</strong>}</div>
            <div className="g-track" role="cell" aria-label={`${i.label}: ${i.start ? fmtDate(i.start) : ''} a ${i.end ? fmtDate(i.end) : ''}`}>
              {todayBar ? <span className="g-today" style={{ left: `${todayBar.left}%` }} /> : null}
              {i.kind === 'milestone'
                ? <span className="g-ms" style={{ left: `${b.left + b.width / 2}%`, background: i.done ? 'var(--ok)' : undefined }} title={i.label} />
                : <span className={`g-bar ${i.kind === 'phase' ? 'phase' : i.done ? 'done' : late ? 'late' : ''}`} style={{ left: `${b.left}%`, width: `${Math.max(b.width, 0.8)}%` }} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Campos do formulário de tarefa (criação e edição). */
export function TaskFields({ dir, t, canAssign, phases, prefix = 'tf' }: {
  dir: Dir; t?: Partial<TaskRow>; canAssign: boolean; phases?: { id: string; name: string }[]; prefix?: string;
}) {
  const id = (n: string) => `${prefix}-${n}`;
  return (
    <>
      <div className="form-grid">
        <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor={id('title')}>Título</label><input id={id('title')} name="title" className="input" required minLength={2} maxLength={200} defaultValue={t?.title} /></div>
        <div className="field"><label htmlFor={id('prio')}>Prioridade</label>
          <select id={id('prio')} name="priority" className="input" defaultValue={t?.priority ?? 'MEDIA'}>
            {['IMEDIATA', 'URGENTE', 'ALTA', 'MEDIA', 'BAIXA'].map((p) => <option key={p} value={p}>{label(p)}{p === 'IMEDIATA' ? ' (execução imediata)' : ''}</option>)}
          </select>
        </div>
        {canAssign ? (
          <div className="field"><label htmlFor={id('as')}>Responsável</label>
            <select id={id('as')} name="assigneeUserId" className="input" defaultValue={t ? t.assignee_user_id ?? '' : undefined}>
              {t ? null : <option value="__self">Eu mesmo(a)</option>}
              <option value="">Setor (a assumir)</option>
              {dir.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
            </select>
          </div>
        ) : null}
        <div className="field"><label htmlFor={id('sec')}>Setor</label>
          <select id={id('sec')} name="sectorId" className="input" defaultValue={t?.sector_id ?? ''}>
            {t ? null : <option value="">Meu setor / do projeto</option>}
            {dir.sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        {phases?.length ? (
          <div className="field"><label htmlFor={id('ph')}>Fase</label>
            <select id={id('ph')} name="phaseId" className="input" defaultValue={t?.phase_id ?? ''}><option value="">—</option>{phases.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </div>
        ) : null}
        <div className="field"><label htmlFor={id('sd')}>Início</label><input id={id('sd')} name="startDate" type="date" className="input" defaultValue={t?.start_date ?? ''} /></div>
        <div className="field"><label htmlFor={id('dd')}>Prazo</label><input id={id('dd')} name="dueDate" type="date" className="input" defaultValue={t?.due_date ?? ''} /></div>
        <div className="field"><label htmlFor={id('dt')}>Horário-limite</label><input id={id('dt')} name="dueTime" type="time" className="input" defaultValue={hm(t?.due_time ?? null)} /></div>
        <div className="field"><label htmlFor={id('bs')}>Bloco de prioridade — início</label><input id={id('bs')} name="blockStart" type="time" className="input" defaultValue={hm(t?.block_start ?? null)} /></div>
        <div className="field"><label htmlFor={id('be')}>Bloco — fim</label><input id={id('be')} name="blockEnd" type="time" className="input" defaultValue={hm(t?.block_end ?? null)} /></div>
      </div>
      <div className="field" style={{ marginTop: 12 }}><label htmlFor={id('desc')}>Descrição</label><textarea id={id('desc')} name="description" className="input" rows={3} maxLength={10000} defaultValue={t?.description ?? ''} /></div>
      <div className="form-grid" style={{ marginTop: 12 }}>
        <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" name="requiresApproval" defaultChecked={t?.requires_approval} /> Conclusão exige aprovação</label>
        <div className="field"><label htmlFor={id('ap')}>Aprovador(a)</label>
          <select id={id('ap')} name="approverUserId" className="input" defaultValue={t?.approver_user_id ?? ''}><option value="">—</option>{dir.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select>
        </div>
      </div>
    </>
  );
}
