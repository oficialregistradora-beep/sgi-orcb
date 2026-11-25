-- Ajustes do controle de caixa (pedido da Oficial, 25/11/2026):
-- (1) cada aba do caixa é uma permissão própria, que a Oficial dá ou tira na Matriz de permissões;
-- (2) sangria e fechamento do dia só para quem tem "caixa.fechar" (Bárbara, por padrão), inclusive no dia útil seguinte;
-- (3) pagamento dividido: o valor do protocolo fica registrado e cada linha guarda o que foi pago naquela forma.

INSERT INTO permissions (code, module, description, sensitive, scopable) VALUES
  ('caixa.frente',      'Financeiro', 'Caixa: Frente de caixa (lançar no caixa que opera)', false, false),
  ('caixa.troco',       'Financeiro', 'Caixa: calculadora de Troco', false, false),
  ('caixa.mes',         'Financeiro', 'Caixa: visão do Mês', true, false),
  ('caixa.ano',         'Financeiro', 'Caixa: visão do Ano', true, false),
  ('caixa.relatorios',  'Financeiro', 'Caixa: Relatórios (fluxo de caixa e DRE)', true, false),
  ('caixa.conciliacao', 'Financeiro', 'Caixa: Conciliação com extratos', true, false),
  ('caixa.fechar',      'Financeiro', 'Caixa: Sangria e fechamento do dia', true, false);
UPDATE permissions SET description = 'Caixa: Conferência (divergências, confirmar dia e aprovação do mês)' WHERE code = 'caixa.conferir';
UPDATE permissions SET description = 'Caixa: cadastro de Caixas e operadoras' WHERE code = 'caixa.gerenciar';

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'TODOS' FROM roles r, permissions p
 WHERE r.code = 'OFICIAL' AND p.code IN ('caixa.frente','caixa.troco','caixa.mes','caixa.ano','caixa.relatorios','caixa.conciliacao','caixa.fechar');
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'TODOS' FROM roles r, permissions p
 WHERE r.code = 'SUBSTITUTA_LEGAL' AND p.code IN ('caixa.frente','caixa.troco','caixa.mes','caixa.ano','caixa.relatorios','caixa.conciliacao','caixa.fechar');
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'TODOS' FROM roles r, permissions p WHERE r.code = 'COLABORADOR' AND p.code IN ('caixa.frente','caixa.troco');

-- Valor total do ato; "amount" passa a ser o valor pago nesta forma (protocolo de 1.000 = 500 em dinheiro + 500 no cartão).
ALTER TABLE cash_entries ADD COLUMN IF NOT EXISTS protocol_total numeric(14,2) CHECK (protocol_total > 0);
