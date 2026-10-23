'use server';

import { redirect } from 'next/navigation';
import { runAction, str, optStr, int, type ActionState } from '@/server/web/action.ts';
import { AppError } from '@/server/errors.ts';
import { localToInstant } from '@/domain/time.ts';
import type { ReqStatus } from '@/domain/quality.ts';
import {
  addAction, addAuditItem, addRequirementEvidence, cancelNc, closeRisk, concludeAudit, createAudit, createNc, evaluateAuditItem, reviewRequirement, saveRequirement, saveRisk,
  setRootCause, startAudit, submitNcForVerification, verifyNc,
} from '@/server/modules/quality.ts';
import {
  closeIncident, disposeAsset, recordBackup, recordLgpdAssessment, registerMaintenance, registerVulnerability, reportIncident, saveAsset, treatIncident, updateVulnerability,
} from '@/server/modules/security.ts';

async function fileOf(fd: FormData, k = 'file') {
  const f = fd.get(k);
  return f instanceof File && f.size > 0 ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null;
}
const optInt = (fd: FormData, k: string) => (str(fd, k) ? int(fd, k) : null);
/** "AAAA-MM-DD" + "HH:MM" (horário local) → instante. */
const instant = (fd: FormData, d: string, t: string) => (str(fd, d) ? localToInstant(str(fd, d), str(fd, t) || '00:00') : null);

export async function qualityAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'id');
  let go = '';
  const r = await runAction(async (ctx) => {
    switch (str(fd, 'op')) {
      case 'requisito':
        await saveRequirement(ctx, { id: optStr(fd, 'id'), code: str(fd, 'code'), title: str(fd, 'title'), source: str(fd, 'source'), area: str(fd, 'area'), ownerUserId: str(fd, 'ownerUserId'),
          reviewMonths: int(fd, 'reviewMonths') || 12, active: !fd.has('activeField') || fd.get('active') === 'on' });
        return 'Requisito salvo.';
      case 'avaliar_requisito': await reviewRequirement(ctx, id, str(fd, 'status') as ReqStatus, optStr(fd, 'notes')); return 'Avaliação registrada.';
      case 'evidencia': await addRequirementEvidence(ctx, id, { description: str(fd, 'description'), documentId: optStr(fd, 'documentId') ?? null }, await fileOf(fd)); return 'Evidência registrada.';
      case 'auditoria':
        go = `/qualidade/auditorias/${await createAudit(ctx, { title: str(fd, 'title'), kind: str(fd, 'kind') as 'INTERNA', scope: str(fd, 'scope'), auditedSectorId: optStr(fd, 'sectorId') ?? null,
          leadAuditorId: str(fd, 'leadAuditorId'), plannedDate: str(fd, 'plannedDate'), importArea: optStr(fd, 'importArea'),
          questions: str(fd, 'questions').split('\n').map((q) => q.trim()).filter(Boolean) })}`;
        return 'Auditoria planejada.';
      case 'item_auditoria': await addAuditItem(ctx, id, str(fd, 'question')); return 'Item incluído.';
      case 'iniciar_auditoria': await startAudit(ctx, id); return 'Auditoria iniciada.';
      case 'avaliar_item':
        await evaluateAuditItem(ctx, { itemId: str(fd, 'itemId'), result: str(fd, 'result') as 'CONFORME', evidence: optStr(fd, 'evidence'), ncSeverity: (optStr(fd, 'ncSeverity') ?? 'MENOR') as 'MENOR',
          ncResponsibleId: optStr(fd, 'ncResponsibleId') }, await fileOf(fd));
        return str(fd, 'result') === 'NAO_CONFORME' ? 'Item avaliado; não conformidade aberta.' : 'Item avaliado.';
      case 'concluir_auditoria': await concludeAudit(ctx, id, str(fd, 'conclusion')); return 'Auditoria concluída.';
      case 'nc':
        go = `/qualidade/nc/${await createNc(ctx, { origin: str(fd, 'origin') as 'OUTRA', incidentId: optStr(fd, 'incidentId'), description: str(fd, 'description'), severity: str(fd, 'severity') as 'MENOR',
          sectorId: optStr(fd, 'sectorId') ?? null, responsibleUserId: str(fd, 'responsibleUserId') })}`;
        return 'Não conformidade aberta.';
      case 'acao':
        await addAction(ctx, { kind: str(fd, 'kind') as 'CORRETIVA', ncId: optStr(fd, 'ncId'), riskId: optStr(fd, 'riskId'), incidentId: optStr(fd, 'incidentId'), title: str(fd, 'title'),
          responsibleUserId: str(fd, 'responsibleUserId'), dueDate: str(fd, 'dueDate'), requiresApproval: fd.get('requiresApproval') === 'on' });
        return 'Ação criada como tarefa do responsável.';
      case 'causa_raiz': await setRootCause(ctx, id, str(fd, 'rootCause')); return 'Causa raiz registrada.';
      case 'encaminhar_nc': await submitNcForVerification(ctx, id); return 'Encaminhada para verificação de eficácia.';
      case 'verificar_nc': await verifyNc(ctx, id, str(fd, 'effective') === 'sim', str(fd, 'notes')); return str(fd, 'effective') === 'sim' ? 'Eficácia confirmada; não conformidade encerrada.' : 'Tratamento devolvido ao responsável.';
      case 'cancelar_nc': await cancelNc(ctx, id, str(fd, 'reason')); return 'Não conformidade cancelada.';
      case 'risco':
        await saveRisk(ctx, { id: optStr(fd, 'id'), title: str(fd, 'title'), description: optStr(fd, 'description'), category: str(fd, 'category') as 'OPERACIONAL', probability: int(fd, 'probability'),
          impact: int(fd, 'impact'), treatment: str(fd, 'treatment') as 'MITIGAR', controls: optStr(fd, 'controls'), residualProbability: optInt(fd, 'residualProbability'),
          residualImpact: optInt(fd, 'residualImpact'), ownerUserId: str(fd, 'ownerUserId'), reviewMonths: int(fd, 'reviewMonths') || 6, notes: optStr(fd, 'notes') });
        return 'Risco registrado.';
      case 'encerrar_risco': await closeRisk(ctx, id, str(fd, 'notes')); return 'Risco encerrado.';
      default: throw new AppError('Operação desconhecida.');
    }
  }, ['/qualidade', `/qualidade/auditorias/${id}`, `/qualidade/nc/${id}`, '/tarefas']);
  if (r.ok && go) redirect(go);
  return r;
}

export async function securityAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd, 'id');
  let go = '';
  const r = await runAction(async (ctx) => {
    switch (str(fd, 'op')) {
      case 'incidente':
        go = `/qualidade/incidentes/${await reportIncident(ctx, { title: str(fd, 'title'), description: str(fd, 'description'), category: str(fd, 'category') as 'OUTRO',
          severity: (optStr(fd, 'severity') ?? 'MEDIA') as 'MEDIA', occurredAt: instant(fd, 'occurredDate', 'occurredTime'), detectedAt: instant(fd, 'detectedDate', 'detectedTime') ?? new Date(),
          personalDataInvolved: fd.get('personalData') === 'on' })}`;
        return 'Incidente comunicado aos responsáveis.';
      case 'tratar_incidente':
        await treatIncident(ctx, id, { severity: optStr(fd, 'severity') as 'MEDIA' | undefined, personalDataInvolved: fd.get('personalData') === 'on' ? true : undefined,
          containment: optStr(fd, 'containment'), rootCause: optStr(fd, 'rootCause'), notes: optStr(fd, 'notes') });
        return 'Tratamento registrado.';
      case 'lgpd': await recordLgpdAssessment(ctx, id, str(fd, 'assessment')); return 'Avaliação LGPD registrada.';
      case 'encerrar_incidente': await closeIncident(ctx, id, optStr(fd, 'notes')); return 'Incidente encerrado.';
      case 'ativo':
        await saveAsset(ctx, { id: optStr(fd, 'id'), tag: str(fd, 'tag'), name: str(fd, 'name'), kind: str(fd, 'kind') as 'OUTRO', serial: optStr(fd, 'serial'), location: optStr(fd, 'location'),
          sectorId: optStr(fd, 'sectorId') ?? null, responsibleUserId: optStr(fd, 'responsibleUserId') ?? null, criticality: (optStr(fd, 'criticality') ?? 'MEDIA') as 'MEDIA',
          acquiredOn: optStr(fd, 'acquiredOn') ?? null, warrantyUntil: optStr(fd, 'warrantyUntil') ?? null, expiresOn: optStr(fd, 'expiresOn') ?? null,
          status: (optStr(fd, 'status') ?? 'EM_USO') as 'EM_USO', notes: optStr(fd, 'notes') });
        return 'Ativo salvo.';
      case 'manutencao': await registerMaintenance(ctx, id, str(fd, 'notes')); return 'Manutenção registrada.';
      case 'baixa': await disposeAsset(ctx, id, str(fd, 'reason')); return 'Ativo baixado.';
      case 'backup':
        await recordBackup(ctx, { kind: str(fd, 'kind') as 'BACKUP', system: str(fd, 'system'), performedOn: str(fd, 'performedOn'), result: str(fd, 'result') as 'SUCESSO', notes: optStr(fd, 'notes') }, await fileOf(fd));
        return 'Registro incluído.';
      case 'vulnerabilidade':
        await registerVulnerability(ctx, { title: str(fd, 'title'), source: str(fd, 'source'), assetId: optStr(fd, 'assetId') ?? null, severity: str(fd, 'severity') as 'MEDIA', detectedOn: str(fd, 'detectedOn') });
        return 'Vulnerabilidade registrada com prazo pela política.';
      case 'vuln_status': await updateVulnerability(ctx, id, str(fd, 'status') as 'CORRIGIDA', optStr(fd, 'resolution')); return 'Situação atualizada.';
      default: throw new AppError('Operação desconhecida.');
    }
  }, ['/qualidade', '/qualidade/incidentes', `/qualidade/incidentes/${id}`]);
  if (r.ok && go) redirect(go);
  return r;
}
