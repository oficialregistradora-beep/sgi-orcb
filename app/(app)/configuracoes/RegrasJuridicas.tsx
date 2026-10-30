import type { Ctx } from '@/server/context.ts';
import { can } from '@/server/authz.ts';
import { BINDING_RULES, describeValue, listLegalRegistry, RULE_LABELS, WEEKDAY_NAMES, type RuleCode } from '@/server/modules/legalRules.ts';
import { todayLocal } from '@/domain/time.ts';
import { fmtDate, label, statusTone } from '@/ui/format.ts';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { closeRuleAction, createRuleAction, instrumentStatusAction, validateRuleAction } from '../../actions/phase2c.ts';

export async function RegrasJuridicas({ ctx }: { ctx: Ctx }) {
  const { instruments, rules } = await listLegalRegistry(ctx);
  const canManage = can(ctx.principal, 'regras.juridicas.gerenciar');
  const today = todayLocal();
  return (
    <div className="stack">
      <div className="alert alert-info small"><div>
        Regras que alteram cálculos com efeito (conversão e prazo do banco de horas, antecedência de comunicação, dias de início da folga, trabalho em sábado/domingo/feriado, vedação de início de férias)
        só se aplicam quando <strong>validadas</strong>. Estimativas (custos, sobreaviso) podem usar regra pendente, sempre sinalizada.
        Regras <strong>históricas</strong> nunca são aplicadas. O conteúdo de uma regra é imutável: para alterar, encerre a vigência e cadastre outra.
      </div></div>

      <div className="card">
        <div className="card-head"><h2>Instrumentos normativos</h2><p>Leis, convenções coletivas e súmulas consultadas</p></div>
        <div className="card-body flush table-wrap" tabIndex={0}>
          <table className="table">
            <thead><tr><th>Código</th><th>Instrumento</th><th>Vigência</th><th>Situação</th>{canManage ? <th></th> : null}</tr></thead>
            <tbody>{instruments.map((i) => (
              <tr key={i.id}>
                <td className="mono small">{i.code}</td>
                <td className="small">{i.title}{i.notes ? <div className="muted">{i.notes}</div> : null}{i.source_url ? <div><a href={i.source_url} target="_blank" rel="noreferrer noopener">Fonte</a></div> : null}</td>
                <td className="small nowrap">{i.valid_from ? `${fmtDate(i.valid_from)} – ${i.valid_until ? fmtDate(i.valid_until) : '…'}` : '—'}</td>
                <td><span className={statusTone(i.status)}>{label(i.status)}</span></td>
                {canManage ? (
                  <td style={{ minWidth: 220 }}>
                    <details className="disclosure small"><summary><a>Alterar situação</a></summary>
                      <ActionForm action={instrumentStatusAction} submitLabel="Salvar" submitClass="btn btn-sm btn-primary">
                        <input type="hidden" name="instrumentId" value={i.id} />
                        <select name="status" className="input" defaultValue={i.status} aria-label="Situação">
                          {['VIGENTE_LEITURA_PENDENTE', 'VIGENTE_VALIDADO', 'HISTORICO'].map((s) => <option key={s} value={s}>{label(s)}</option>)}
                        </select>
                        <input name="notes" className="input" placeholder="Observação (obrigatória)" aria-label="Observação" required minLength={5} style={{ marginTop: 6 }} defaultValue={i.notes ?? ''} />
                      </ActionForm>
                    </details>
                  </td>
                ) : null}
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Regras parametrizadas</h2><p>{rules.length} regra(s)</p></div>
        <div className="card-body flush table-wrap" tabIndex={0}>
          <table className="table">
            <thead><tr><th>Regra</th><th>Valor</th><th>Vigência</th><th>Fundamento e fonte</th><th>Situação</th>{canManage ? <th></th> : null}</tr></thead>
            <tbody>{rules.map((r) => (
              <tr key={r.id} className={r.status === 'HISTORICO_NAO_APLICAR' ? 'row-muted' : undefined}>
                <td className="small">{RULE_LABELS[r.code as RuleCode]}{BINDING_RULES.includes(r.code as RuleCode) ? <div><span className="tag">altera cálculos</span></div> : null}</td>
                <td className="small">{describeValue(r.code as RuleCode, r.value)}</td>
                <td className="small nowrap">{fmtDate(r.valid_from)} – {r.valid_until ? fmtDate(r.valid_until) : '…'}</td>
                <td className="small">{r.legal_basis}<div className="muted">{r.source}{r.instrument_code ? ` · ${r.instrument_code}` : ''}</div>{r.notes ? <div className="muted">{r.notes}</div> : null}</td>
                <td><span className={statusTone(r.status)}>{label(r.status)}</span>{r.validated_by ? <div className="small muted">{r.validated_by} · {fmtDate(r.validated_at)}</div> : null}</td>
                {canManage ? (
                  <td style={{ minWidth: 240 }}>
                    {r.status === 'PENDENTE_VALIDACAO' ? (
                      <details className="disclosure small"><summary><a>Registrar validação</a></summary>
                        <ActionForm action={validateRuleAction} submitLabel="Validar" submitClass="btn btn-sm btn-primary" confirm="A regra passará a produzir efeitos nos cálculos. Confirma?">
                          <input type="hidden" name="ruleId" value={r.id} />
                          <input name="validatedBy" className="input" placeholder="Responsável (nome e cargo)" aria-label="Responsável" required minLength={5} />
                          <input name="validatedAt" type="date" className="input" defaultValue={today} aria-label="Data" style={{ marginTop: 6 }} />
                          <input name="notes" className="input" placeholder="Observação (ex.: conferida com a cláusula…)" aria-label="Observação" style={{ marginTop: 6 }} />
                        </ActionForm>
                      </details>
                    ) : null}
                    {r.status !== 'HISTORICO_NAO_APLICAR' && !r.valid_until ? (
                      <details className="disclosure small"><summary><a>Encerrar vigência</a></summary>
                        <ActionForm action={closeRuleAction} submitLabel="Encerrar" submitClass="btn btn-sm btn-danger">
                          <input type="hidden" name="ruleId" value={r.id} />
                          <input name="validUntil" type="date" className="input" defaultValue={today} aria-label="Fim da vigência" />
                          <input name="reason" className="input" placeholder="Motivo" aria-label="Motivo" required minLength={5} style={{ marginTop: 6 }} />
                        </ActionForm>
                      </details>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>

      {canManage ? (
        <div className="card">
          <div className="card-head"><h2>Cadastrar regra</h2><p>Preencha apenas os campos do tipo escolhido. Sem responsável pela validação, a regra fica pendente.</p></div>
          <div className="card-body">
            <ActionForm action={createRuleAction} submitLabel="Cadastrar regra" resetOnSuccess>
              <div className="form-grid">
                <div className="field"><label htmlFor="rj-c">Tipo</label>
                  <select id="rj-c" name="code" className="input" required>{Object.entries(RULE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                </div>
                <div className="field"><label htmlFor="rj-i">Instrumento</label>
                  <select id="rj-i" name="instrumentId" className="input"><option value="">—</option>{instruments.filter((i) => i.status !== 'HISTORICO').map((i) => <option key={i.id} value={i.id}>{i.code}</option>)}</select>
                </div>
                <div className="field"><label htmlFor="rj-f">Vigência — início</label><input id="rj-f" name="validFrom" type="date" className="input" required /></div>
                <div className="field"><label htmlFor="rj-u">Vigência — fim</label><input id="rj-u" name="validUntil" type="date" className="input" /></div>
              </div>
              <fieldset className="form-grid" style={{ marginTop: 12 }}>
                <legend className="label">Valor (conforme o tipo)</legend>
                <div className="field"><label htmlFor="rj-pc">Percentual (%)</label><input id="rj-pc" name="percentual" type="number" className="input" /></div>
                <div className="field"><label htmlFor="rj-h">Horas</label><input id="rj-h" name="horas" type="number" className="input" /></div>
                <div className="field"><label htmlFor="rj-n">Fração: numerador</label><input id="rj-n" name="numerador" type="number" className="input" /></div>
                <div className="field"><label htmlFor="rj-d">Fração: denominador</label><input id="rj-d" name="denominador" type="number" className="input" /></div>
                <div className="field"><label htmlFor="rj-m">Minutos de folga por hora</label><input id="rj-m" name="minutosFolgaPorHora" type="number" className="input" placeholder="90 = 1h30" /></div>
                <div className="field"><label htmlFor="rj-mo">Prazo: modo</label><select id="rj-mo" name="modo" className="input"><option value="MESES">Meses</option><option value="DIAS_APOS_MES">Dias após o mês</option></select></div>
                <div className="field"><label htmlFor="rj-q">Prazo: quantidade</label><input id="rj-q" name="quantidade" type="number" className="input" /></div>
                <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" name="ativo" /> Vedação ativa (férias)</label>
                <div className="field"><span className="label">Folga integral começa em</span>
                  <div>{WEEKDAY_NAMES.map((n, i) => <label key={n} className="check" style={{ marginRight: 8 }}><input type="checkbox" name="dias" value={i} /> {n}</label>)}</div>
                </div>
                <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" name="excluir" /> Sábado/domingo/feriado fora do banco</label>
                <div className="field"><label htmlFor="rj-sc">Sábados de curso/palestra por ano</label><input id="rj-sc" name="sabadosCursoPorAno" type="number" className="input" placeholder="4" /></div>
              </fieldset>
              <div className="form-grid" style={{ marginTop: 12 }}>
                <div className="field"><label htmlFor="rj-b">Fundamento (artigo, súmula, cláusula)</label><input id="rj-b" name="legalBasis" className="input" required minLength={5} /></div>
                <div className="field"><label htmlFor="rj-s">Fonte consultada</label><input id="rj-s" name="source" className="input" required minLength={3} /></div>
                <div className="field"><label htmlFor="rj-v">Validado por (nome e cargo)</label><input id="rj-v" name="validatedBy" className="input" /></div>
                <div className="field"><label htmlFor="rj-va">Data da validação</label><input id="rj-va" name="validatedAt" type="date" className="input" /></div>
              </div>
              <div className="field" style={{ marginTop: 12 }}><label htmlFor="rj-o">Observações</label><input id="rj-o" name="notes" className="input" /></div>
            </ActionForm>
          </div>
        </div>
      ) : null}
    </div>
  );
}
