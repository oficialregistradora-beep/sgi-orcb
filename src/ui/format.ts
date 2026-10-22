import { formatDuration, toLocalParts, formatHHMM } from '../domain/time.ts';

export function fmtMin(minutes: number, signed = false): string {
  return formatDuration(minutes, signed);
}

export function fmtDate(date: string | null | undefined): string {
  if (!date) return '—';
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

const dtFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return '—';
  return dtFmt.format(typeof d === 'string' ? new Date(d) : d);
}

export function fmtTime(d: Date): string {
  return formatHHMM(toLocalParts(d).minutes);
}

export function fmtMoney(v: string | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const [int, frac = '00'] = v.split('.');
  const neg = int!.startsWith('-');
  const digits = neg ? int!.slice(1) : int!;
  const withDots = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}R$ ${withDots},${frac.padEnd(2, '0').slice(0, 2)}`;
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

export const LABELS: Record<string, string> = {
  // ocorrências e resoluções
  HORA_EXTRA: 'Hora extra', DIFERENCA_NEGATIVA: 'Diferença negativa', MARCACAO_INCOMPLETA: 'Marcação incompleta',
  BANCO_CREDITO: 'Crédito no banco', PAGAMENTO_EXTRA: 'Pagamento como extra', ABONO: 'Abono', BANCO_DEBITO: 'Compensar com banco',
  FALTA_NAO_JUSTIFICADA: 'Falta não justificada (análise da folha)', CIENTE: 'Ciente',
  PENDENTE: 'Pendente', RESOLVIDA: 'Resolvida', SUPERADA: 'Superada', APROVADA: 'Aprovada', REJEITADA: 'Rejeitada', CANCELADA: 'Cancelada',
  // razão do banco
  CREDITO: 'Crédito', DEBITO_COMPENSACAO: 'Compensação', DEBITO_FALTA: 'Cobertura de diferença', PAGAMENTO: 'Pagamento em folha', ESTORNO: 'Estorno', AJUSTE: 'Ajuste',
  DISPONIVEL: 'Disponível', A_VENCER: 'A vencer', VENCIDO: 'Vencido — requer pagamento/análise', UTILIZADO: 'Utilizado', ESTORNADO: 'Estornado',
  // dias
  UTIL: 'Dia útil', DESCANSO: 'Descanso', FERIADO: 'Feriado', AUSENCIA_ABONADA: 'Ausência abonada',
  // marcações
  ENTRADA: 'Entrada', SAIDA_INTERVALO: 'Saída intervalo', RETORNO_INTERVALO: 'Retorno intervalo', SAIDA: 'Saída', ADICIONAL: 'Adicional',
  WEB: 'Registro web', CORRECAO: 'Correção aprovada', IMPORTACAO: 'Importação',
  // ausências
  FERIAS: 'Férias', ATESTADO_MEDICO: 'Atestado médico', LICENCA_MATERNIDADE: 'Licença-maternidade', LICENCA_PATERNIDADE: 'Licença-paternidade',
  LICENCA_OUTRA: 'Outra licença', FALTA_JUSTIFICADA: 'Falta justificada', AFASTAMENTO_INSS: 'Afastamento INSS', OUTRO: 'Outro',
  // assinaturas
  CIENCIA: 'Ciência', APROVACAO: 'Aprovação', CONCORDANCIA: 'Concordância', CONTESTACAO: 'Contestação',
  // situação
  ATIVO: 'Ativo', AFASTADO: 'Afastado', DESLIGADO: 'Desligado', SUSPENSO: 'Suspenso', REVOGADO: 'Revogado',
  PROPRIO: 'Próprio', SETOR: 'Setor', TODOS: 'Todos',
  INDIVIDUAL_ESCRITO: 'Acordo individual escrito', COLETIVO: 'Acordo/convenção coletiva',
  CORRECAO_PONTO: 'Correção de marcação', COMPENSACAO: 'Compensação', AUTORIZACAO_EXTRA: 'Autorização de hora extra',
  PLANEJADO: 'Planejado', REALIZADO: 'Realizado', BANCO: 'Banco de horas',
  EM_AQUISICAO: 'Em aquisição', QUITADO: 'Quitado', VENCIDAS: 'Vencidas — pagamento em dobro (art. 137)', ABERTO: 'Aberto', CONCLUIDO: 'Concluído', NAO_APLICAVEL: 'Não se aplica',
  UNIFORME: 'Uniforme', EQUIPAMENTO: 'Equipamento', CRACHA: 'Crachá', CHAVE: 'Chave', ADMISSAO: 'Admissão', DESLIGAMENTO: 'Desligamento',
  TERMO_ENTREGA: 'Termo de entrega', ESPELHO: 'Espelho de frequência', EXTRATO_BANCO: 'Extrato do banco',
  FOLGA_INTEGRAL: 'Folga integral', COMPENSACAO_PARCIAL: 'Compensação parcial', ENTRADA_POSTERIOR: 'Entrada posterior', SAIDA_ANTECIPADA: 'Saída antecipada',
};

export function label(code: string | null | undefined): string {
  if (!code) return '—';
  return LABELS[code] ?? code.replace(/_/g, ' ').toLowerCase();
}

export function statusTone(code: string): string {
  if (['APROVADA', 'RESOLVIDA', 'ATIVO', 'DISPONIVEL', 'CIENCIA', 'APROVACAO', 'CONCORDANCIA', 'REALIZADO', 'QUITADO', 'CONCLUIDO'].includes(code)) return 'tag tag-ok';
  if (['PENDENTE', 'A_VENCER', 'AFASTADO', 'SUSPENSO', 'PLANEJADO', 'ABERTO'].includes(code)) return 'tag tag-warn';
  if (['REJEITADA', 'VENCIDO', 'VENCIDAS', 'DESLIGADO', 'REVOGADO', 'CONTESTACAO', 'CANCELADO'].includes(code)) return 'tag tag-danger';
  return 'tag';
}
