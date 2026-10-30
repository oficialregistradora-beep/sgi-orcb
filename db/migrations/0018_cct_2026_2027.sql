-- CCT SC000957/2026 (SINOREG/SC × Sindicato dos Trabalhadores em Cartórios do Sul de SC), vigência 01/02/2026 a 31/01/2027.
-- Íntegra fornecida pela serventia em 30/10/2026 (Mediador MR024577/2026). As regras entram PENDENTES de validação:
-- passam a produzir efeitos somente quando a Oficial (empregadora) registra a validação em Configurações → Regras jurídicas.

-- Novos tipos de regra (cláusula 17, §§ 2º, 5º e 6º).
ALTER TABLE legal_rules DROP CONSTRAINT IF EXISTS legal_rules_code_check;
ALTER TABLE legal_rules ADD CONSTRAINT legal_rules_code_check CHECK (code IN (
  'SOBREAVISO_FRACAO','EFETIVO_DSR_FERIADO_ADICIONAL','ADICIONAL_HORA_EXTRA','DIVISOR_SALARIO_HORAS',
  'BANCO_FATOR_CONVERSAO','BANCO_PRAZO','BANCO_COMUNICACAO_MINIMA','FERIAS_VEDAR_INICIO_FDS_FERIADO',
  'BANCO_FOLGA_DIAS_INICIO','BANCO_DIAS_NAO_UTEIS'));

-- Exceção que permitiu levar ao banco o trabalho em sábado, domingo ou feriado (cl. 17, §§ 5º e 6º).
ALTER TABLE hour_bank_entries ADD COLUMN IF NOT EXISTS non_working_exception text
  CHECK (non_working_exception IN ('PLANTAO','CASAMENTO','CURSO'));

UPDATE legal_instruments
   SET title = 'CCT SINOREG/SC × Sindicato dos Trabalhadores em Cartórios do Sul de SC 2026/2027 (inclui Capivari de Baixo)',
       source_url = 'https://mediador.trabalho.gov.br/sistemas/mediador/Resumo/ResumoVisualizar?NrSolicitacao=MR024577%2F2026',
       notes = 'Registro MTE 18/05/2026, solicitação MR024577/2026. Íntegra recebida da serventia em 30/10/2026; regras cadastradas como pendentes até a validação pela Oficial.'
 WHERE code = 'SC000957/2026';

INSERT INTO legal_rules (code, value, valid_from, valid_until, status, instrument_id, legal_basis, source, notes)
SELECT x.code, x.value::jsonb, '2026-02-01', '2027-01-31', 'PENDENTE_VALIDACAO', i.id, x.basis, 'CCT SC000957/2026 (Mediador MR024577/2026)', x.notes
FROM legal_instruments i, (VALUES
  ('BANCO_FATOR_CONVERSAO', '{"minutosFolgaPorHora":90}', 'CCT 2026/2027, cl. 17, §1º — 1 hora trabalhada por 1h30 de folga compensatória', NULL),
  ('BANCO_PRAZO', '{"modo":"DIAS_APOS_MES","quantidade":90}', 'CCT 2026/2027, cl. 17, §1º — compensação nos 90 dias subsequentes ao mês da acumulação', 'Não compensadas no prazo: pagas como extras (§3º)'),
  ('BANCO_COMUNICACAO_MINIMA', '{"horas":48}', 'CCT 2026/2027, cl. 17, §2º — comunicação da data e do horário da compensação com 48 horas', NULL),
  ('BANCO_FOLGA_DIAS_INICIO', '{"dias":[1,5]}', 'CCT 2026/2027, cl. 17, §2º — as folgas iniciam sempre nas segundas ou sextas-feiras', 'Aplicado à folga integral; os dias seguintes de uma folga contínua são aceitos'),
  ('BANCO_DIAS_NAO_UTEIS', '{"excluir":true,"sabadosCursoPorAno":4}', 'CCT 2026/2027, cl. 17, §§5º e 6º — trabalho em sábado, domingo e feriado é pago como extra, exceto plantonistas, casamentos e cursos/palestras (até 4 sábados por ano)', NULL),
  ('FERIAS_VEDAR_INICIO_FDS_FERIADO', '{"ativo":true}', 'CCT 2026/2027, cl. 20 — início das férias não pode coincidir com sábado, domingo, feriado ou dia de compensação do repouso semanal', NULL),
  ('ADICIONAL_HORA_EXTRA', '{"percentual":50}', 'CCT 2026/2027, cl. 8 — acréscimo de 50% sobre a hora normal', NULL)
) AS x(code, value, basis, notes)
WHERE i.code = 'SC000957/2026';
