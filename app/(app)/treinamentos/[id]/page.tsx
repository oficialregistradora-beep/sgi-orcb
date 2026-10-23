import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { getPool, query, queryOne } from '@/server/db.ts';
import { getTraining, myTrainings, questionsForTaking, trainablePeople } from '@/server/modules/training.ts';
import { listDocuments } from '@/server/modules/repository.ts';
import { directory } from '@/server/modules/directory.ts';
import { addDays, todayLocal } from '@/domain/time.ts';
import { fmtDate, fmtMin, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { KIND_LABEL, Situation, TrainingFields } from '@/ui/development.tsx';
import { trainingAction } from '../../../actions/phase5b.ts';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Treinamento' };

const hm = (m: number | null) => (m == null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
const REC_LABEL: Record<string, string> = { INSCRITO: 'Inscrito', PENDENTE_VALIDACAO: 'Aguardando validação', CONCLUIDO: 'Concluído', NAO_CONCLUIDO: 'Não concluído', RECUSADO: 'Recusado', CANCELADO: 'Cancelado', ANULADO: 'Anulado' };

async function TreinamentoPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageCtx();
  const p = ctx.principal;
  const { id } = await params;
  const { training: t, sessions, records, questions, manage, attemptsExist } = await getTraining(ctx, id);
  const registrar = can(p, 'treinamentos.registrar');
  const mine = p.employeeId ? (await myTrainings(ctx)).find((x) => x.training.id === t.id) : undefined;
  const taking = p.employeeId && t.has_assessment && t.questions ? await questionsForTaking(ctx, t.id) : null;
  const passed = taking?.attempts.some((a) => a.passed) ?? false;
  const remaining = taking ? t.max_attempts - taking.attempts.length : 0;
  const doc = t.document_id ? await queryOne<{ title: string; status: string; current_version_id: string | null; requires_acknowledgement: boolean }>(getPool(),
    'SELECT title, status, current_version_id, requires_acknowledgement FROM documents WHERE id = $1', [t.document_id]) : null;
  const acked = doc?.current_version_id ? !!(await queryOne(getPool(), "SELECT 1 FROM signatures WHERE document_version_id = $1 AND signer_user_id = $2 AND act = 'CIENCIA'", [doc.current_version_id, p.userId])) : false;
  const people = registrar || manage ? await trainablePeople(ctx) : [];
  const today = todayLocal();
  const peopleOpts = people.filter((x) => x.user_id !== p.userId).map((x) => <option key={x.id} value={x.id}>{x.full_name} ({x.sector_name})</option>);

  return (
    <div className="stack">
      <PageHead title={`${t.code} — ${t.title}`} subtitle={<>{KIND_LABEL[t.kind]}{t.provider ? ` · ${t.provider}` : ''}{t.workload_minutes ? ` · ${fmtMin(t.workload_minutes)}` : ''}
        {t.validity_months ? ` · reciclagem a cada ${t.validity_months} meses` : ''}{t.mandatory ? ' · obrigatório' : ''}</>} actions={<Link className="btn" href="/treinamentos">Voltar</Link>} />
      {t.description ? <div className="card"><div className="card-body small" style={{ whiteSpace: 'pre-wrap' }}>{t.description}</div></div> : null}

      {mine ? (
        <div className="card"><div className="card-head"><h2>Minha situação</h2><Situation s={mine.situation} /></div><div className="card-body stack">
          {mine.completedOn ? <div className="small">Concluído em {fmtDate(mine.completedOn)}{mine.expiresOn ? ` · válido até ${fmtDate(mine.expiresOn)}` : ''}</div> : null}
          {t.kind === 'ESTUDO_POP' && doc ? (
            <div className="stack">
              <div className="small">Documento: <Link href={`/documentos/${t.document_id}`}>{doc.title}</Link> {doc.status === 'VIGENTE' ? '' : <span className="tag tag-danger">não vigente</span>}
                {doc.requires_acknowledgement ? (acked ? <span className="tag tag-ok" style={{ marginLeft: 6 }}>Ciência registrada</span> : <span className="tag tag-warn" style={{ marginLeft: 6 }}>Ciência pendente — registre em Gestão documental</span>) : null}</div>
              {mine.situation !== 'VALIDO' && mine.situation !== 'A_VENCER' ? (
                <ActionForm action={trainingAction} submitLabel="Concluir estudo">
                  <input type="hidden" name="op" value="estudo_pop" /><input type="hidden" name="id" value={t.id} />
                  <label className="check"><input type="checkbox" name="confirmed" required /> Declaro que li e estudei a versão vigente deste documento.</label>
                </ActionForm>
              ) : null}
            </div>
          ) : null}
          {t.kind !== 'ESTUDO_POP' && !mine.records.some((r) => r.status === 'PENDENTE_VALIDACAO') ? (
            <details className="disclosure"><summary><a>Enviar certificado de curso concluído</a></summary>
              <ActionForm action={trainingAction} submitLabel="Enviar para validação" resetOnSuccess>
                <input type="hidden" name="op" value="autodeclarar" /><input type="hidden" name="id" value={t.id} />
                <div className="form-grid">
                  <div className="field"><label>Concluído em<input name="completedOn" type="date" className="input" max={today} required /></label></div>
                  <div className="field"><label>Carga horária (HH:MM)<input name="minutes" className="input" placeholder={hm(t.workload_minutes) || '02:00'} /></label></div>
                  <div className="field"><label>Certificado<input name="file" type="file" className="input" required /></label></div>
                </div>
                <div className="field"><label>Observação<input name="notes" className="input" /></label></div>
              </ActionForm>
            </details>
          ) : null}
          <div className="small muted">Histórico: {mine.records.length ? mine.records.map((r) => `${REC_LABEL[r.status]}${r.completed_on ? ` em ${fmtDate(r.completed_on)}` : ''}${r.decision_notes ? ` (${r.decision_notes})` : ''}`).join(' · ') : 'nenhum registro'}</div>
        </div></div>
      ) : null}

      {taking && !passed ? (
        <div className="card"><div className="card-head"><h2>Avaliação de aprendizagem</h2><p>Nota mínima {t.pass_score}% · tentativas restantes: {Math.max(remaining, 0)}{taking.attempts.length ? ` · última nota ${taking.attempts.at(-1)!.score}%` : ''}</p></div><div className="card-body">
          {remaining > 0 ? (
            <ActionForm action={trainingAction} submitLabel="Enviar respostas" confirm="Enviar as respostas? Cada envio conta como uma tentativa.">
              <input type="hidden" name="op" value="responder" /><input type="hidden" name="id" value={t.id} /><input type="hidden" name="count" value={taking.questions.length} />
              <ol className="stack" style={{ paddingLeft: 18 }}>{taking.questions.map((q, i) => (
                <li key={q.id}><fieldset style={{ border: 0, padding: 0 }}><legend>{q.question}</legend>
                  {q.options.map((o, j) => <label key={j} className="check" style={{ display: 'block' }}><input type="radio" name={`q${i}`} value={j} required /> {o}</label>)}
                </fieldset></li>
              ))}</ol>
            </ActionForm>
          ) : <div className="alert alert-warn small">Limite de tentativas atingido. Procure a coordenação para nova inscrição.</div>}
        </div></div>
      ) : taking && passed ? <div className="alert alert-info small">Você foi aprovado(a) na avaliação de aprendizagem ({Math.max(...taking.attempts.filter((a) => a.passed).map((a) => a.score))}%).</div> : null}

      {(manage || registrar) ? (
        <div className="card"><div className="card-head"><h2>Turmas</h2><p>Cada turma aparece na agenda institucional.</p></div><div className="card-body flush table-wrap" tabIndex={0}>
          {sessions.length ? <table className="table"><thead><tr><th>Data</th><th>Local / instrutor</th><th className="num">Inscritos</th><th>Situação</th><th></th></tr></thead>
            <tbody>{sessions.map((s) => {
              const enrolled = records.filter((r) => r.session_id === s.id && r.status === 'INSCRITO');
              return (
                <tr key={s.id}>
                  <td className="nowrap">{fmtDate(s.session_date)}{s.start_time != null ? ` ${hm(s.start_time)}–${hm(s.end_time)}` : ''}</td>
                  <td className="small">{s.location ?? '—'}{s.instructor ? <div className="muted">{s.instructor}</div> : null}</td>
                  <td className="num">{s.enrolled}</td><td><span className={statusTone(s.status)}>{label(s.status)}</span></td>
                  <td>{s.status === 'PLANEJADA' ? (
                    <details className="disclosure small"><summary><a>Gerir turma</a></summary><div className="stack" style={{ minWidth: 300 }}>
                      {manage ? <ActionForm action={trainingAction} submitLabel="Inscrever" submitClass="btn btn-sm"><input type="hidden" name="op" value="inscrever" /><input type="hidden" name="id" value={t.id} /><input type="hidden" name="sessionId" value={s.id} />
                        <select name="employeeIds" className="input" multiple size={5} aria-label="Pessoas">{peopleOpts}</select></ActionForm> : null}
                      {enrolled.length && s.session_date <= today ? (
                        <ActionForm action={trainingAction} submitLabel="Encerrar com a presença marcada" submitClass="btn btn-sm btn-primary">
                          <input type="hidden" name="op" value="encerrar_turma" /><input type="hidden" name="id" value={t.id} /><input type="hidden" name="sessionId" value={s.id} />
                          {enrolled.map((r) => <label key={r.id} className="check" style={{ display: 'block' }}><input type="checkbox" name="present" value={r.employee_id} defaultChecked /> {r.full_name}</label>)}
                        </ActionForm>
                      ) : <span className="muted">Presença registrada a partir da data da turma.</span>}
                      {manage ? <ActionForm action={trainingAction} submitLabel="Cancelar turma" submitClass="btn btn-sm btn-danger"><input type="hidden" name="op" value="cancelar_turma" /><input type="hidden" name="id" value={t.id} /><input type="hidden" name="sessionId" value={s.id} />
                        <input name="reason" className="input" placeholder="Motivo" aria-label="Motivo" required minLength={3} /></ActionForm> : null}
                    </div></details>) : null}</td>
                </tr>
              );
            })}</tbody></table> : <Empty>Nenhuma turma.</Empty>}
        </div></div>
      ) : null}

      {manage ? (
        <div className="grid grid-2">
          <div className="card"><div className="card-head"><h2>Nova turma</h2></div><div className="card-body">
            <ActionForm action={trainingAction} submitLabel="Criar turma" resetOnSuccess>
              <input type="hidden" name="op" value="turma" /><input type="hidden" name="id" value={t.id} />
              <div className="form-grid">
                <div className="field"><label>Data<input name="sessionDate" type="date" className="input" defaultValue={addDays(today, 7)} required /></label></div>
                <div className="field"><label>Início<input name="startTime" type="time" className="input" /></label></div>
                <div className="field"><label>Fim<input name="endTime" type="time" className="input" /></label></div>
                <div className="field"><label>Local ou link<input name="location" className="input" /></label></div>
                <div className="field"><label>Instrutor(a)<input name="instructor" className="input" /></label></div>
              </div>
              <div className="field"><label>Inscritos<select name="employeeIds" className="input" multiple size={6}>{peopleOpts}{people.filter((x) => x.user_id === p.userId).map((x) => <option key={x.id} value={x.id}>{x.full_name} (você)</option>)}</select></label></div>
            </ActionForm>
          </div></div>
          {t.has_assessment ? (
            <div className="card"><div className="card-head"><h2>Questões da avaliação</h2><p>Uma por linha: <code>Pergunta | alternativa | *correta | alternativa</code>. {attemptsExist ? 'Já há respostas: as questões estão bloqueadas.' : ''}</p></div><div className="card-body">
              <ActionForm action={trainingAction} submitLabel="Salvar questões">
                <input type="hidden" name="op" value="questoes" /><input type="hidden" name="id" value={t.id} />
                <textarea name="questions" className="input" rows={8} aria-label="Questões" disabled={attemptsExist}
                  defaultValue={questions.map((q) => [q.question, ...q.options.map((o, i) => (i === q.correct_index ? `*${o}` : o))].join(' | ')).join('\n')} />
              </ActionForm>
            </div></div>
          ) : null}
        </div>
      ) : null}

      {registrar ? (
        <div className="card"><div className="card-head"><h2>Registros</h2></div><div className="card-body flush table-wrap" tabIndex={0}>
          {records.length ? <table className="table"><thead><tr><th>Pessoa</th><th>Situação</th><th>Conclusão</th><th>Validade</th><th>Origem</th><th>Validado por</th><th></th></tr></thead>
            <tbody>{records.map((r) => (
              <tr key={r.id} className={['CANCELADO', 'ANULADO', 'RECUSADO'].includes(r.status) ? 'row-muted' : undefined}>
                <td>{r.full_name}<div className="small muted">{r.sector_name}</div></td>
                <td><span className={statusTone(r.status === 'CONCLUIDO' ? 'CONCLUIDA' : r.status === 'PENDENTE_VALIDACAO' ? 'PENDENTE' : r.status)}>{REC_LABEL[r.status]}</span>{r.decision_notes ? <div className="small muted">{r.decision_notes}</div> : null}</td>
                <td className="small">{fmtDate(r.completed_on)}{r.score != null ? ` · ${r.score}%` : ''}</td><td className="small">{fmtDate(r.expires_on)}</td>
                <td className="small">{label(r.source)}{r.certificate_file_id ? <> · <a href={`/api/v1/treinamentos/certificados/${r.certificate_file_id}`}>certificado</a></> : null}</td>
                <td className="small">{r.validated_by_name ?? '—'}</td>
                <td>{manage && r.status === 'CONCLUIDO' ? <details className="disclosure small"><summary><a>Anular</a></summary><ActionForm action={trainingAction} submitLabel="Anular" submitClass="btn btn-sm btn-danger">
                  <input type="hidden" name="op" value="anular" /><input type="hidden" name="id" value={t.id} /><input type="hidden" name="recordId" value={r.id} /><input name="reason" className="input" placeholder="Justificativa" aria-label="Justificativa" required minLength={5} /></ActionForm></details> : null}</td>
              </tr>
            ))}</tbody></table> : <Empty>Nenhum registro no seu escopo.</Empty>}
        </div>
          {t.kind !== 'ESTUDO_POP' ? (
            <div className="card-body"><details className="disclosure"><summary><a>Registrar conclusão (curso realizado)</a></summary>
              <ActionForm action={trainingAction} submitLabel="Registrar conclusão" resetOnSuccess>
                <input type="hidden" name="op" value="conclusao" /><input type="hidden" name="id" value={t.id} />
                <div className="form-grid">
                  <div className="field"><label>Pessoa<select name="employeeId" className="input" required>{peopleOpts}</select></label></div>
                  <div className="field"><label>Concluído em<input name="completedOn" type="date" className="input" max={today} defaultValue={today} required /></label></div>
                  <div className="field"><label>Carga (HH:MM)<input name="minutes" className="input" placeholder={hm(t.workload_minutes)} /></label></div>
                  <div className="field"><label>Nota (%)<input name="score" type="number" min={0} max={100} className="input" /></label></div>
                  <div className="field"><label>Certificado<input name="file" type="file" className="input" /></label></div>
                </div>
                <div className="field"><label>Observação<input name="notes" className="input" /></label></div>
              </ActionForm>
            </details></div>
          ) : null}
        </div>
      ) : null}

      {manage ? await (async () => {
        const dir = await directory(ctx);
        const jobs = await query<{ id: string; name: string }>(getPool(), 'SELECT id, name FROM job_titles ORDER BY name');
        const docs = can(p, 'documentos.ver') ? (await listDocuments(ctx, {})).filter((d) => d.status === 'VIGENTE' || d.id === t.document_id) : [];
        return (
          <details className="card disclosure"><summary className="card-head"><h2>Editar treinamento</h2></summary><div className="card-body">
            <ActionForm action={trainingAction} submitLabel="Salvar"><input type="hidden" name="op" value="treinamento" />
              <TrainingFields t={t} sectors={dir.sectors} jobs={jobs} docs={docs.map((d) => ({ id: d.id, title: `${d.code ? `${d.code} — ` : ''}${d.title}` }))} /></ActionForm>
          </div></details>
        );
      })() : null}
    </div>
  );
}

export default withGuard(TreinamentoPage);
