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
  PERDIDO: 'Direito perdido (art. 133 / faltas)', VALIDADO: 'Validado', PENDENTE_VALIDACAO: 'Pendente de validação', HISTORICO_NAO_APLICAR: 'Histórico — não aplicar',
  VIGENTE_LEITURA_PENDENTE: 'Vigente — leitura das cláusulas pendente', VIGENTE_VALIDADO: 'Vigente — validado', HISTORICO: 'Histórico',
  RASCUNHO: 'Rascunho', PUBLICADO: 'Publicado', INATIVO: 'Inativo',
  EM_AQUISICAO: 'Em aquisição', QUITADO: 'Quitado', VENCIDAS: 'Vencidas — pagamento em dobro (art. 137)', ABERTO: 'Aberto', CONCLUIDO: 'Concluído', NAO_APLICAVEL: 'Não se aplica',
  UNIFORME: 'Uniforme', EQUIPAMENTO: 'Equipamento', CRACHA: 'Crachá', CHAVE: 'Chave', ADMISSAO: 'Admissão', DESLIGAMENTO: 'Desligamento',
  TERMO_ENTREGA: 'Termo de entrega', ESPELHO: 'Espelho de frequência', EXTRATO_BANCO: 'Extrato do banco',
  A_FAZER: 'A fazer', EM_ANDAMENTO: 'Em andamento', EM_REVISAO: 'Aguardando aprovação', BLOQUEADA: 'Bloqueada', CONCLUIDA: 'Concluída',
  IMEDIATA: 'Imediata', URGENTE: 'Urgente', ALTA: 'Alta', MEDIA: 'Média', BAIXA: 'Baixa',
  PAUSADO: 'Pausado', CANCELADO: 'Cancelado', ENCERRADO: 'Encerrado', GESTOR: 'Gestor(a)', MEMBRO: 'Membro', LEITOR: 'Leitor(a)',
  DIARIA: 'Diária', SEMANAL: 'Semanal', MENSAL: 'Mensal', ANUAL: 'Anual',
  ATENDIMENTO: 'Atendimento', RI: 'RI', RCPN: 'RCPN', RTD: 'RTD', RCPJ: 'RCPJ', ADMINISTRACAO: 'Administração', DIRETORIA: 'Diretoria', PESSOAL: 'Gestão de pessoal',
  SUBSTITUTA: 'Substituta Legal', OFICIAL: 'Oficial',
  FIXA: 'Despesa fixa', VARIAVEL: 'Despesa variável', COMPRA: 'Compra', NOTA_FISCAL: 'Nota fiscal', COMPROVANTE: 'Comprovante', CONTRATO: 'Contrato', ORCAMENTO: 'Orçamento',
  PIX: 'PIX', BOLETO: 'Boleto', TRANSFERENCIA: 'Transferência', DEBITO_AUTOMATICO: 'Débito automático', CARTAO: 'Cartão', DINHEIRO: 'Dinheiro',
  VIGENTE: 'Vigente', EM_APROVACAO: 'Em aprovação', OBSOLETO: 'Obsoleto', ARQUIVADO: 'Arquivado',
  INTERNO: 'Interno', RESTRITO: 'Restrito', CONFIDENCIAL: 'Confidencial',
  FOLGA_INTEGRAL: 'Folga integral', COMPENSACAO_PARCIAL: 'Compensação parcial', ENTRADA_POSTERIOR: 'Entrada posterior', SAIDA_ANTECIPADA: 'Saída antecipada',
};

export function label(code: string | null | undefined): string {
  if (!code) return '—';
  return LABELS[code] ?? code.replace(/_/g, ' ').toLowerCase();
}

export function statusTone(code: string): string {
  if (['APROVADA', 'RESOLVIDA', 'ATIVO', 'DISPONIVEL', 'CIENCIA', 'APROVACAO', 'CONCORDANCIA', 'REALIZADO', 'QUITADO', 'CONCLUIDO', 'VALIDADO', 'VIGENTE_VALIDADO', 'PUBLICADO', 'VIGENTE', 'CONCLUIDA', 'ENCERRADO'].includes(code)) return 'tag tag-ok';
  if (['PENDENTE', 'A_VENCER', 'AFASTADO', 'SUSPENSO', 'PLANEJADO', 'ABERTO', 'PENDENTE_VALIDACAO', 'VIGENTE_LEITURA_PENDENTE', 'RASCUNHO', 'EM_APROVACAO', 'EM_REVISAO', 'PAUSADO', 'URGENTE'].includes(code)) return 'tag tag-warn';
  if (['REJEITADA', 'VENCIDO', 'VENCIDAS', 'DESLIGADO', 'REVOGADO', 'CONTESTACAO', 'CANCELADO', 'PERDIDO', 'HISTORICO_NAO_APLICAR', 'BLOQUEADA', 'IMEDIATA'].includes(code)) return 'tag tag-danger';
  if (['EM_ANDAMENTO'].includes(code)) return 'tag tag-info';
  return 'tag';
}
