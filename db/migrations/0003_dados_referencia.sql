-- SGI-ORCB — Migration 0003: dados de referência institucionais (sem dados pessoais).
-- Permissões, papéis-padrão, setores iniciais, cargos, jornada de referência, feriados nacionais e configurações.

INSERT INTO permissions (code, module, description, sensitive, scopable) VALUES
  ('usuarios.gerenciar',               'Administração', 'Criar, suspender e revogar usuários', true,  false),
  ('permissoes.gerenciar',             'Administração', 'Alterar papéis, permissões e atribuições', true,  false),
  ('auditoria.ver',                    'Administração', 'Consultar e verificar a trilha de auditoria', true,  false),
  ('configuracoes.gerenciar',          'Administração', 'Setores, cargos, jornadas, feriados e parâmetros', false, false),
  ('pessoas.ver',                      'Pessoas',       'Consultar cadastro funcional', false, true),
  ('pessoas.editar',                   'Pessoas',       'Incluir e alterar cadastro funcional, admissão e desligamento', false, true),
  ('pessoas.sensiveis.ver',            'Pessoas',       'Consultar dados pessoais sensíveis (CPF, endereço, saúde, banco)', true, true),
  ('pessoas.sensiveis.editar',         'Pessoas',       'Alterar dados pessoais sensíveis', true, true),
  ('pessoas.salario.ver',              'Pessoas',       'Consultar histórico salarial', true, true),
  ('pessoas.salario.editar',           'Pessoas',       'Registrar alterações salariais', true, true),
  ('jornada.registrar',                'Jornada',       'Registrar a própria marcação de jornada', false, true),
  ('jornada.ver',                      'Jornada',       'Consultar marcações, apuração e espelho', false, true),
  ('jornada.ausencias.gerenciar',      'Jornada',       'Lançar férias, afastamentos e ausências abonadas', false, true),
  ('jornada.escalas.gerenciar',        'Jornada',       'Atribuir jornada contratual a funcionários', false, true),
  ('solicitacoes.criar',               'Solicitações',  'Abrir solicitações (correção, compensação, autorização de extra)', false, true),
  ('solicitacoes.correcao.aprovar',    'Solicitações',  'Aprovar correções de marcação', false, true),
  ('solicitacoes.compensacao.aprovar', 'Solicitações',  'Aprovar compensações do banco de horas', false, true),
  ('solicitacoes.extra.aprovar',       'Solicitações',  'Autorizar previamente horas extraordinárias', false, true),
  ('banco.ver',                        'Banco de horas','Consultar saldos e extratos do banco de horas', false, true),
  ('banco.ocorrencias.tratar',         'Banco de horas','Analisar horas extras e diferenças negativas', false, true),
  ('banco.acordos.gerenciar',          'Banco de horas','Cadastrar acordos de banco de horas', true, true),
  ('banco.pagamentos.registrar',       'Banco de horas','Registrar pagamento de horas em folha', true, true),
  ('banco.periodo.fechar',             'Banco de horas','Fechar e reabrir competências', true, false),
  ('banco.custos.ver',                 'Banco de horas','Ver custo estimado dos saldos', true, true),
  ('espelho.aprovar',                  'Jornada',       'Aprovar espelhos e extratos assinados pelos funcionários', false, true);

INSERT INTO roles (code, name, description, is_system) VALUES
  ('OFICIAL',               'Oficial Registradora',  'Autoridade máxima do sistema', true),
  ('SUBSTITUTA_LEGAL',      'Substituta Legal',      'Gestão administrativa delegada', true),
  ('COORDENACAO_SETOR',     'Coordenação de setor',  'Acompanhamento da equipe do setor coordenado', true),
  ('COLABORADOR',           'Colaborador',           'Acesso pessoal básico de todo funcionário', true);

-- OFICIAL: todas as permissões, escopo TODOS.
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'TODOS' FROM roles r CROSS JOIN permissions p WHERE r.code = 'OFICIAL';

-- SUBSTITUTA_LEGAL: gestão de pessoal e jornada (TODOS), sem administração do sistema nem dados sensíveis/salário.
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'TODOS' FROM roles r, permissions p
WHERE r.code = 'SUBSTITUTA_LEGAL' AND p.code IN (
  'configuracoes.gerenciar','pessoas.ver','pessoas.editar','jornada.registrar','jornada.ver','jornada.ausencias.gerenciar',
  'jornada.escalas.gerenciar','solicitacoes.criar','solicitacoes.correcao.aprovar','solicitacoes.compensacao.aprovar',
  'solicitacoes.extra.aprovar','banco.ver','banco.ocorrencias.tratar','espelho.aprovar');

-- COORDENACAO_SETOR: visão do setor coordenado e aprovação de correções.
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'SETOR' FROM roles r, permissions p
WHERE r.code = 'COORDENACAO_SETOR' AND p.code IN (
  'pessoas.ver','jornada.ver','banco.ver','solicitacoes.correcao.aprovar','solicitacoes.extra.aprovar','espelho.aprovar');

-- COLABORADOR: somente os próprios dados.
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'PROPRIO' FROM roles r, permissions p
WHERE r.code = 'COLABORADOR' AND p.code IN ('pessoas.ver','jornada.registrar','jornada.ver','banco.ver','solicitacoes.criar');

INSERT INTO sectors (code, name) VALUES
  ('DIR',  'Diretoria e Administração'),
  ('ATD',  'Atendimento'),
  ('RI',   'Registro de Imóveis'),
  ('RCPN', 'Registro Civil das Pessoas Naturais'),
  ('RTDPJ','Registro de Títulos e Documentos e Registro Civil das Pessoas Jurídicas');

INSERT INTO job_titles (name) VALUES
  ('Oficial Registradora'), ('Substituta Legal'), ('Escrevente Substituta'),
  ('Escrevente Autorizado'), ('Atendente'), ('Auxiliar de Serviços Gerais');

WITH s AS (
  INSERT INTO work_schedules (name, description)
  VALUES ('Padrão 40h — 08h às 17h', 'Segunda a sexta, 08h–12h e 13h–17h (referência inicial da serventia)')
  RETURNING id
)
INSERT INTO work_schedule_days (schedule_id, weekday, start_time, break_start, break_end, end_time)
SELECT s.id, d, '08:00', '12:00', '13:00', '17:00' FROM s, generate_series(1, 5) AS d;

-- Feriados nacionais (Lei 662/1949, Lei 6.802/1980, Lei 14.759/2023). Estaduais e municipais: configurar (pendência P-07).
INSERT INTO holidays (date, name, scope) VALUES
  ('2026-01-01','Confraternização Universal','NACIONAL'), ('2026-04-03','Sexta-feira Santa','NACIONAL'),
  ('2026-04-21','Tiradentes','NACIONAL'), ('2026-05-01','Dia do Trabalho','NACIONAL'),
  ('2026-09-07','Independência do Brasil','NACIONAL'), ('2026-10-12','Nossa Senhora Aparecida','NACIONAL'),
  ('2026-11-02','Finados','NACIONAL'), ('2026-11-15','Proclamação da República','NACIONAL'),
  ('2026-11-20','Dia Nacional de Zumbi e da Consciência Negra','NACIONAL'), ('2026-12-25','Natal','NACIONAL'),
  ('2027-01-01','Confraternização Universal','NACIONAL'), ('2027-03-26','Sexta-feira Santa','NACIONAL'),
  ('2027-04-21','Tiradentes','NACIONAL'), ('2027-05-01','Dia do Trabalho','NACIONAL'),
  ('2027-09-07','Independência do Brasil','NACIONAL'), ('2027-10-12','Nossa Senhora Aparecida','NACIONAL'),
  ('2027-11-02','Finados','NACIONAL'), ('2027-11-15','Proclamação da República','NACIONAL'),
  ('2027-11-20','Dia Nacional de Zumbi e da Consciência Negra','NACIONAL'), ('2027-12-25','Natal','NACIONAL');

INSERT INTO settings (key, value, description) VALUES
  ('org.nome',                    '"Ofício de Registros de Capivari de Baixo/SC"', 'Nome institucional'),
  ('sessao.inatividade_minutos',  '30',   'Bloqueio por inatividade'),
  ('sessao.duracao_maxima_horas', '12',   'Duração absoluta da sessão'),
  ('sessao.reautenticacao_minutos','10',  'Validade da reautenticação para operações críticas'),
  ('jornada.intervalo_minimo_entre_marcacoes_segundos', '60', 'Evita marcações duplicadas acidentais'),
  ('banco.alerta_vencimento_dias','30',   'Antecedência do alerta de créditos a vencer'),
  ('banco.alerta_saldo_elevado_minutos', '2400', 'Saldo considerado elevado (40h)'),
  ('banco.divisor_salario_horas', '200',  'Divisor mensal para custo-hora (jornada 40h). Dependente de validação jurídica'),
  ('banco.adicional_extra_percentual', '50', 'Adicional mínimo constitucional; CCT pode prever percentual maior. Dependente de validação jurídica');
