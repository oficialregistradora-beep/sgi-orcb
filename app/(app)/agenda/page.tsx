import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { agendaFor, type AgendaItem } from '@/server/modules/integrations.ts';
import { directory } from '@/server/modules/directory.ts';
import { getSetting } from '@/server/settings.ts';
import { getPool } from '@/server/db.ts';
import { addDays, formatHHMM, monthRange, todayLocal, weekdayOf } from '@/domain/time.ts';
import { fmtDate } from '@/ui/format.ts';
import { PageHead, Empty } from '@/ui/Stat.tsx';
import { MonthPicker } from '@/ui/MonthPicker.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { agendaAction } from '../../actions/phase4c.ts';
import { withGuard } from '@/server/web/guard.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Agenda' };

const TYPE: Record<AgendaItem['type'], [string, string]> = {
  FERIAS: ['Férias', 'tag tag-info'], PLANTAO: ['Plantão', 'tag tag-warn'], MARCO: ['Marco', 'tag tag-ok'], COMPENSACAO: ['Compensação', 'tag'], EVENTO: ['Evento', 'tag tag-danger'],
};
const hm = (m: number | null) => (m == null ? '' : formatHHMM(m));

async function AgendaPage({ searchParams }: { searchParams: Promise<{ mes?: string }> }) {
  const ctx = await requirePageCtx();
  const sp = await searchParams;
  const period = /^\d{4}-\d{2}$/.test(sp.mes ?? '') ? sp.mes! : todayLocal().slice(0, 7);
  const { from, to } = monthRange(period);
  const gridStart = addDays(from, -((weekdayOf(from) + 6) % 7));
  const items = await agendaFor(ctx, gridStart, addDays(gridStart, 41));
  const today = todayLocal();
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const canEvents = ctx.principal.isOwner || can(ctx.principal, 'agenda.eventos');
  const canChat = (ctx.principal.isOwner || can(ctx.principal, 'chat.avisos')) && (await getSetting<boolean>(getPool(), 'integracoes.chat.ativo', false));
  const dir = canEvents ? await directory(ctx) : null;
  const upcoming = items.filter((i) => i.endDate >= today).slice(0, 30);
  return (
    <div className="stack">
      <PageHead title="Agenda" subtitle="Férias, plantões, marcos, compensações e eventos institucionais que você está autorizado(a) a ver. Quando ativada, a agenda institucional do Google recebe estes eventos." />
      <div className="row">{Object.entries(TYPE).map(([k, [l, c]]) => <span key={k} className={c}>{l}</span>)}</div>
      <div className="card">
        <div className="card-head"><MonthPicker period={period} base="/agenda" /></div>
        <div className="card-body flush table-wrap" tabIndex={0}>
          <div className="cal" role="grid" aria-label="Agenda do mês">
            <div role="row" style={{ display: 'contents' }}>{['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map((d) => <div key={d} className="cal-head" role="columnheader">{d}</div>)}</div>
            {[0, 1, 2, 3, 4, 5].map((w) => <div key={w} role="row" style={{ display: 'contents' }}>{days.slice(w * 7, w * 7 + 7).map((d) => {
              const list = items.filter((i) => i.startDate <= d && i.endDate >= d);
              return (
                <div key={d} role="gridcell" className={`${d < from || d > to ? 'cal-out' : ''} ${d === today ? 'cal-today' : ''}`}>
                  <div className="muted">{Number(d.slice(8))}</div>
                  {list.slice(0, 4).map((i) => <Link key={`${i.type}${i.id}`} href={i.link ?? '/agenda'} title={i.title}><span className={TYPE[i.type][1]} style={{ padding: '0 4px', fontSize: 10 }}>{TYPE[i.type][0][0]}</span> {i.startTime != null && i.startDate === d ? `${hm(i.startTime)} ` : ''}{i.title}</Link>)}
                  {list.length > 4 ? <span className="muted">+{list.length - 4}</span> : null}
                </div>
              );
            })}</div>)}
          </div>
        </div>
      </div>
      <div className="grid grid-2">
        <div className="card"><div className="card-head"><h2>Próximos</h2></div>
          <div className="card-body flush table-wrap" tabIndex={0}>{upcoming.length ? <table className="table"><tbody>{upcoming.map((i) => (
            <tr key={`${i.type}${i.id}`}><td className="small nowrap">{fmtDate(i.startDate)}{i.endDate !== i.startDate ? ` – ${fmtDate(i.endDate)}` : ''}{i.startTime != null ? ` ${hm(i.startTime)}–${hm(i.endTime)}` : ''}</td>
              <td><span className={TYPE[i.type][1]}>{TYPE[i.type][0]}</span> {i.link ? <Link href={i.link}>{i.title}</Link> : i.title}<div className="small muted">{i.description}</div></td>
              <td>{canEvents && i.type === 'EVENTO' ? <ActionForm action={agendaAction} submitLabel="Cancelar" submitClass="btn btn-sm btn-ghost" inline confirm="Cancelar este evento?"><input type="hidden" name="op" value="cancelar" /><input type="hidden" name="id" value={i.id} /></ActionForm> : null}</td></tr>
          ))}</tbody></table> : <Empty>Nada previsto.</Empty>}</div>
        </div>
        <div className="stack">
          {canEvents && dir ? (
            <div className="card"><div className="card-head"><h2>Novo evento institucional</h2><p>Reuniões, prazos administrativos, treinamentos e datas da serventia.</p></div>
              <div className="card-body"><ActionForm action={agendaAction} submitLabel="Cadastrar" resetOnSuccess>
                <input type="hidden" name="op" value="evento" />
                <div className="form-grid">
                  <div className="field"><label>Tipo<select name="kind" className="input"><option value="REUNIAO">Reunião</option><option value="PRAZO">Prazo administrativo</option><option value="TREINAMENTO">Treinamento</option><option value="INSTITUCIONAL">Evento institucional</option></select></label></div>
                  <div className="field"><label>Título<input name="title" className="input" required minLength={3} /></label></div>
                  <div className="field"><label>Início<input name="startDate" type="date" className="input" required defaultValue={today} /></label></div>
                  <div className="field"><label>Término (opcional)<input name="endDate" type="date" className="input" /></label></div>
                  <div className="field"><label>Hora inicial<input name="startTime" type="time" className="input" /></label></div>
                  <div className="field"><label>Hora final<input name="endTime" type="time" className="input" /></label></div>
                  <div className="field"><label>Setor (opcional)<select name="sectorId" className="input"><option value="">Toda a serventia</option>{dir.sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></div>
                </div>
                <div className="field" style={{ marginTop: 10 }}><label>Descrição<textarea name="description" className="input" rows={2} /></label></div>
                {canChat ? <label className="check" style={{ marginTop: 8 }}><input type="checkbox" name="announce" /> Avisar no Google Chat</label> : null}
              </ActionForm></div>
            </div>
          ) : null}
          {canChat ? (
            <div className="card"><div className="card-head"><h2>Aviso no Google Chat</h2><p>Visível a todo o espaço: não inclua dados pessoais.</p></div>
              <div className="card-body"><ActionForm action={agendaAction} submitLabel="Publicar aviso" resetOnSuccess><input type="hidden" name="op" value="aviso" /><textarea name="text" className="input" rows={2} required minLength={5} maxLength={2000} aria-label="Texto do aviso" /></ActionForm></div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default withGuard(AgendaPage);
