import { requirePageCtx } from '@/server/web/session.ts';
import { requirePermission } from '@/server/authz.ts';
import { getConfig } from '@/server/config.ts';
import { listJobTitles, listSchedules, listSectors } from '@/server/modules/admin.ts';
import { todayLocal } from '@/domain/time.ts';
import { PageHead } from '@/ui/Stat.tsx';
import { ActionForm } from '@/ui/ActionForm.tsx';
import { createEmployeeAction } from '../../../actions/people.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admissão' };

export default async function NovoFuncionario() {
  const ctx = await requirePageCtx();
  requirePermission(ctx, 'pessoas.editar');
  const [sectors, jobs, schedules] = await Promise.all([listSectors(), listJobTitles(), listSchedules()]);
  const domain = getConfig().workspaceDomain;
  return (
    <div className="stack">
      <PageHead title="Admissão de funcionário" subtitle="Cria o cadastro funcional, a jornada contratual e (opcionalmente) o acesso com papel básico de colaborador." />
      <div className="card"><div className="card-body">
        <ActionForm action={createEmployeeAction} submitLabel="Admitir">
          <div className="form-grid">
            <div className="field"><label htmlFor="f-rc">Matrícula</label><input id="f-rc" name="registrationCode" className="input" required maxLength={20} /></div>
            <div className="field"><label htmlFor="f-fn">Nome completo</label><input id="f-fn" name="fullName" className="input" required /></div>
            <div className="field"><label htmlFor="f-sn">Nome social (opcional)</label><input id="f-sn" name="socialName" className="input" /></div>
            <div className="field"><label htmlFor="f-jt">Cargo</label><select id="f-jt" name="jobTitleId" className="input" required>{jobs.filter((j) => j.active).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}</select></div>
            <div className="field"><label htmlFor="f-fd">Função</label><input id="f-fd" name="functionDescription" className="input" /></div>
            <div className="field"><label htmlFor="f-se">Setor</label><select id="f-se" name="sectorId" className="input" required>{sectors.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
            <div className="field"><label htmlFor="f-ad">Data de admissão</label><input id="f-ad" name="admissionDate" type="date" className="input" defaultValue={todayLocal()} required /></div>
            <div className="field"><label htmlFor="f-ct">Tipo de contrato</label><select id="f-ct" name="contractType" className="input">{['CLT', 'ESTAGIO', 'APRENDIZ', 'TEMPORARIO', 'OUTRO'].map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
            <div className="field"><label htmlFor="f-wh">Horas semanais</label><input id="f-wh" name="weeklyHours" type="number" step="0.5" min="1" max="44" defaultValue="40" className="input" required /></div>
            <div className="field"><label htmlFor="f-sc">Jornada contratual</label><select id="f-sc" name="scheduleId" className="input"><option value="">Definir depois</option>{schedules.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
            <div className="field"><label htmlFor="f-em">E-mail institucional</label><input id="f-em" name="email" type="email" className="input" placeholder={`nome@${domain}`} /><span className="hint">Cria o acesso (papel Colaborador). Deixe vazio se não houver acesso.</span></div>
          </div>
        </ActionForm>
      </div></div>
    </div>
  );
}
