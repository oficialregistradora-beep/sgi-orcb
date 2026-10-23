import Link from 'next/link';
import { requirePageCtx } from '@/server/web/session.ts';
import { can } from '@/server/authz.ts';
import { listIncidents } from '@/server/modules/security.ts';
import { todayLocal } from '@/domain/time.ts';
import { fmtDateTime, label, statusTone } from '@/ui/format.ts';
import { Empty, PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { securityAction } from '../../../actions/phase5a.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Incidentes' };

export default async function IncidentesPage() {
  const ctx = await requirePageCtx();
  const p = ctx.principal;
  const manage = can(p, 'incidentes.gerenciar');
  const report = manage || can(p, 'incidentes.registrar');
  if (!report) return <div className="stack"><PageHead title="Incidentes" /><div className="alert alert-warn">Você não tem acesso a este módulo.</div></div>;
  const rows = await listIncidents(ctx);
  const today = todayLocal();
  const nowTime = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

  return (
    <div className="stack">
      <PageHead title="Incidentes" subtitle="Comunique imediatamente qualquer incidente de segurança da informação, vazamento ou acesso indevido a dados pessoais, indisponibilidade ou dano físico. Não inclua na descrição dados pessoais além do necessário."
        actions={manage || can(p, 'qualidade.ver') ? <Link className="btn" href="/qualidade">Qualidade e segurança</Link> : undefined} />
      <div className="card"><div className="card-head"><h2>Comunicar incidente</h2><p>Os responsáveis pela gestão de incidentes são avisados na hora.</p></div><div className="card-body">
        <ActionForm action={securityAction} submitLabel="Comunicar">
          <input type="hidden" name="op" value="incidente" />
          <div className="form-grid">
            <div className="field" style={{ gridColumn: 'span 2' }}><label>Título<input name="title" className="input" required minLength={3} /></label></div>
            <div className="field"><label>Categoria<select name="category" className="input">{['SEGURANCA_INFORMACAO', 'DADOS_PESSOAIS', 'INDISPONIBILIDADE', 'FISICO', 'OPERACIONAL', 'OUTRO'].map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></label></div>
            <div className="field"><label>Gravidade percebida<select name="severity" className="input" defaultValue="MEDIA">{['BAIXA', 'MEDIA', 'ALTA', 'CRITICA'].map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></label></div>
            <div className="field"><label>Detectado em<input name="detectedDate" type="date" className="input" defaultValue={today} max={today} required /></label></div>
            <div className="field"><label>Hora<input name="detectedTime" type="time" className="input" defaultValue={nowTime} /></label></div>
            <div className="field"><label>Ocorrido em (se souber)<input name="occurredDate" type="date" className="input" max={today} /></label></div>
            <div className="field"><label>Hora<input name="occurredTime" type="time" className="input" /></label></div>
          </div>
          <div className="field" style={{ marginTop: 12 }}><label>O que aconteceu<textarea name="description" className="input" rows={4} required minLength={5} /></label></div>
          <label className="check" style={{ marginTop: 10 }}><input type="checkbox" name="personalData" /> Pode envolver dados pessoais (de usuários, partes ou colaboradores)</label>
        </ActionForm>
      </div></div>

      <div className="card"><div className="card-head"><h2>{manage ? 'Incidentes' : 'Incidentes que você comunicou'}</h2></div><div className="card-body flush table-wrap">
        {rows.length ? <table className="table"><thead><tr><th>Incidente</th><th>Categoria</th><th>Gravidade</th><th>Detectado</th><th>Comunicado por</th><th>Situação</th></tr></thead>
          <tbody>{rows.map((i) => (
            <tr key={i.id} className={i.status === 'ENCERRADO' ? 'row-muted' : undefined}>
              <td><Link href={`/qualidade/incidentes/${i.id}`}>{i.code}</Link> — {i.title}{i.personal_data_involved ? <div><span className="tag tag-danger">Dados pessoais{i.lgpd_assessment ? '' : ' — avaliação LGPD pendente'}</span></div> : null}</td>
              <td className="small">{label(i.category)}</td><td><span className={statusTone(i.severity)}>{label(i.severity)}</span></td>
              <td className="small">{fmtDateTime(i.detected_at)}</td><td className="small">{i.reporter_name}</td><td><span className={statusTone(i.status)}>{label(i.status)}</span></td>
            </tr>
          ))}</tbody></table> : <Empty>Nenhum incidente.</Empty>}
      </div></div>
    </div>
  );
}
