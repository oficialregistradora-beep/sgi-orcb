-- (1) Sessão (pedido da Oficial, 24/11/2026): sem queda por inatividade; a sessão vale até a meia-noite ou até fechar o
--     navegador (o cookie já é de sessão). Os parâmetros continuam ajustáveis em Configurações → Parâmetros.
UPDATE settings SET value = '0', description = 'Bloqueio por inatividade em minutos (0 = desligado)' WHERE key = 'sessao.inatividade_minutos';
INSERT INTO settings (key, value, description) VALUES
  ('sessao.expira_fim_do_dia', 'true', 'A sessão termina à meia-noite (horário de Brasília) ou ao fechar o navegador')
ON CONFLICT (key) DO NOTHING;

-- (2) Controle de caixa (atendimento e administrativo), no modelo das planilhas anuais da serventia:
--     caixa individual por funcionária ou compartilhado (Apoio, com o usuário de cada lançamento), dia de caixa com abertura
--     (fundo de troco), lançamentos imutáveis (correção por estorno), fechamento com dinheiro contado, conferência da
--     Bárbara no dia seguinte por um único botão, OK final do mês, relatórios e conciliação com extratos.
INSERT INTO permissions (code, module, description, sensitive, scopable) VALUES
  ('caixa.conferir',  'Financeiro', 'Conferir dias de caixa, marcar divergências e aprovar o mês', true, false),
  ('caixa.gerenciar', 'Financeiro', 'Cadastrar caixas, operadores e importar extratos para conciliação', true, false);
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'TODOS' FROM roles r, permissions p WHERE r.code = 'OFICIAL' AND p.code IN ('caixa.conferir', 'caixa.gerenciar');
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'caixa.conferir', 'TODOS' FROM roles r WHERE r.code = 'SUBSTITUTA_LEGAL';

CREATE TABLE cash_registers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{2,20}$'),
  name           text NOT NULL CHECK (length(trim(name)) >= 2),
  sector_id      uuid NOT NULL REFERENCES sectors(id),
  shared         boolean NOT NULL DEFAULT false,         -- compartilhado (Apoio): cada lançamento grava o usuário
  default_float  numeric(14,2) NOT NULL DEFAULT 0 CHECK (default_float >= 0),
  active         boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cash_register_operators (
  register_id  uuid NOT NULL REFERENCES cash_registers(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (register_id, user_id)
);

-- Dia de caixa: aberto pela operadora; fechado com a contagem; conferido pela Bárbara (um botão para o dia todo).
CREATE TABLE cash_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  register_id     uuid NOT NULL REFERENCES cash_registers(id),
  work_date       date NOT NULL,
  status          text NOT NULL DEFAULT 'ABERTO' CHECK (status IN ('ABERTO', 'FECHADO', 'CONFERIDO')),
  opening_float   numeric(14,2) NOT NULL DEFAULT 0 CHECK (opening_float >= 0),
  opened_by       uuid NOT NULL REFERENCES users(id),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  expected_cash   numeric(14,2),
  counted_cash    numeric(14,2) CHECK (counted_cash >= 0),
  sent_to_deposit numeric(14,2) CHECK (sent_to_deposit >= 0),
  difference      numeric(14,2),
  close_notes     text,
  closed_by       uuid REFERENCES users(id),
  closed_at       timestamptz,
  checked_by      uuid REFERENCES users(id),
  checked_at      timestamptz,
  check_notes     text,
  UNIQUE (register_id, work_date),
  CHECK (status = 'ABERTO' OR (counted_cash IS NOT NULL AND closed_at IS NOT NULL)),
  CHECK (status <> 'CONFERIDO' OR checked_at IS NOT NULL),
  CHECK (sent_to_deposit IS NULL OR sent_to_deposit <= counted_cash)
);

-- Lançamentos: uma linha por pagamento e por forma de pagamento. Imutáveis; erro se corrige por estorno.
CREATE TABLE cash_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        uuid NOT NULL REFERENCES cash_sessions(id),
  kind              text NOT NULL CHECK (kind IN ('ENTRADA', 'SAIDA_REPASSE', 'SAIDA_DESPESA', 'SAIDA_DEVOLUCAO', 'SUPRIMENTO', 'SANGRIA', 'ESTORNO')),
  method            text NOT NULL CHECK (method IN ('DINHEIRO', 'PIX', 'CARTAO_DEBITO', 'CARTAO_CREDITO', 'DEPOSITO')),
  protocol          text,                                  -- nº do protocolo/ato (entrada, repasse, devolução)
  payee             text,                                  -- favorecido (despesa: ex. "CASAN – água")
  amount            numeric(14,2) NOT NULL CHECK (amount > 0),       -- valor do protocolo / da saída
  received          numeric(14,2) CHECK (received >= amount),        -- total entregue pelo cliente (dinheiro)
  change_given      numeric(14,2) NOT NULL DEFAULT 0 CHECK (change_given >= 0),
  description       text,
  reference         text,                                  -- comprovante / NSU (opcional)
  reverses_entry_id uuid UNIQUE REFERENCES cash_entries(id),
  operator_id       uuid NOT NULL REFERENCES users(id),     -- quem lançou (no Apoio, o "usuário")
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'ESTORNO') = (reverses_entry_id IS NOT NULL)),
  CHECK (kind NOT IN ('ENTRADA', 'SAIDA_REPASSE', 'SAIDA_DEVOLUCAO') OR length(trim(coalesce(protocol, ''))) > 0),
  CHECK (kind <> 'SAIDA_DESPESA' OR length(trim(coalesce(payee, ''))) > 0),
  CHECK (method = 'DINHEIRO' OR received IS NULL OR received = amount)
);
CREATE INDEX ix_cash_entries_session ON cash_entries (session_id, created_at);
CREATE INDEX ix_cash_entries_protocol ON cash_entries (protocol) WHERE protocol IS NOT NULL;
CREATE TRIGGER trg_cash_entries_immutable BEFORE UPDATE OR DELETE ON cash_entries FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- Divergência apontada pela conferente numa linha (antes de confirmar o dia).
CREATE TABLE cash_entry_divergences (
  entry_id    uuid PRIMARY KEY REFERENCES cash_entries(id),
  note        text NOT NULL CHECK (length(trim(note)) >= 3),
  marked_by   uuid NOT NULL REFERENCES users(id),
  marked_at   timestamptz NOT NULL DEFAULT now()
);

-- OK final do mês, por caixa.
CREATE TABLE cash_month_approvals (
  register_id  uuid NOT NULL REFERENCES cash_registers(id),
  month        date NOT NULL CHECK (extract(day FROM month) = 1),
  approved_by  uuid NOT NULL REFERENCES users(id),
  approved_at  timestamptz NOT NULL DEFAULT now(),
  notes        text,
  PRIMARY KEY (register_id, month)
);

-- Conciliação: extratos do banco, da máquina de cartão e o livro de depósito prévio.
CREATE TABLE cash_statements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL CHECK (source IN ('BANCO', 'CARTAO', 'DEPOSITO_PREVIO')),
  month        date NOT NULL CHECK (extract(day FROM month) = 1),
  label        text,
  filename     text NOT NULL,
  file_sha256  text NOT NULL,
  imported_by  uuid NOT NULL REFERENCES users(id),
  imported_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, file_sha256)
);
CREATE TABLE cash_statement_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id  uuid NOT NULL REFERENCES cash_statements(id) ON DELETE CASCADE,
  line_date     date NOT NULL,
  amount        numeric(14,2) NOT NULL,                   -- crédito positivo; débito negativo
  description   text,
  document      text,                                     -- NSU, autorização, documento, identificador
  protocol      text,                                     -- livro de depósito prévio
  matched_entry_id uuid REFERENCES cash_entries(id),
  matched_by    uuid REFERENCES users(id),                -- NULL = automático
  matched_at    timestamptz
);
CREATE INDEX ix_cash_statement_lines ON cash_statement_lines (statement_id);
CREATE UNIQUE INDEX ux_cash_statement_lines_entry ON cash_statement_lines (statement_id, matched_entry_id) WHERE matched_entry_id IS NOT NULL;
