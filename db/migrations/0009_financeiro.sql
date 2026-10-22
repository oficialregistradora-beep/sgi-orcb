-- SGI-ORCB — Migration 0009: financeiro gerencial (Fase 4b).
-- Controle GERENCIAL interno. Não substitui a escrituração obrigatória, o Livro Diário Auxiliar nem outros controles
-- formais das serventias; integração com essas obrigações somente após validação jurídica e contábil.
-- Valores monetários: numeric(14,2). Segregação: quem solicita não aprova; quem aprova não paga; quem solicita não paga.

CREATE TABLE cost_centers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$'),
  name        text NOT NULL UNIQUE CHECK (length(trim(name)) >= 2),
  sector_id   uuid NOT NULL REFERENCES sectors(id),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE finance_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{2,30}$'),
  name        text NOT NULL UNIQUE,
  kind        text NOT NULL CHECK (kind IN ('DESPESA_FIXA','DESPESA_VARIAVEL','PESSOAL','INVESTIMENTO','RECEITA')),
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0
);

-- Categorias gerenciais iniciais (sem plano de contas contábil presumido — ajustáveis pela administração).
INSERT INTO finance_categories (code, name, kind, sort_order) VALUES
  ('ALUGUEL',        'Aluguel e condomínio',                 'DESPESA_FIXA', 10),
  ('ENERGIA_AGUA',   'Energia, água e telefonia',            'DESPESA_FIXA', 20),
  ('SISTEMAS',       'Sistemas, internet e licenças',        'DESPESA_FIXA', 30),
  ('SERVICOS',       'Serviços de terceiros',                'DESPESA_VARIAVEL', 40),
  ('MATERIAL',       'Material de expediente e consumo',     'DESPESA_VARIAVEL', 50),
  ('MANUTENCAO',     'Manutenção e conservação',             'DESPESA_VARIAVEL', 60),
  ('TREINAMENTO',    'Treinamentos e capacitação',           'DESPESA_VARIAVEL', 70),
  ('TRIBUTOS',       'Tributos e taxas',                     'DESPESA_VARIAVEL', 80),
  ('FOLHA',          'Folha de pagamento e encargos',        'PESSOAL', 90),
  ('BENEFICIOS',     'Benefícios',                           'PESSOAL', 100),
  ('EQUIPAMENTOS',   'Equipamentos e mobiliário',            'INVESTIMENTO', 110),
  ('RECEITA_EMOL',   'Receitas (registro gerencial)',        'RECEITA', 200),
  ('RECEITA_OUTRAS', 'Outras receitas',                      'RECEITA', 210);

CREATE TABLE suppliers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL CHECK (length(trim(name)) >= 2),
  document_type   text NOT NULL CHECK (document_type IN ('CNPJ','CPF')),
  document_enc    text NOT NULL,                 -- CNPJ/CPF cifrado (CPF é dado pessoal)
  document_hmac   text NOT NULL UNIQUE,          -- busca/unicidade sem guardar em claro
  document_last4  text NOT NULL CHECK (document_last4 ~ '^\d{4}$'),
  email           text,
  phone           text,
  notes           text,
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contracts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id      uuid NOT NULL REFERENCES suppliers(id),
  object           text NOT NULL CHECK (length(trim(object)) >= 3),
  cost_center_id   uuid NOT NULL REFERENCES cost_centers(id),
  category_id      uuid NOT NULL REFERENCES finance_categories(id),
  start_date       date NOT NULL,
  end_date         date,
  monthly_amount   numeric(14,2) CHECK (monthly_amount IS NULL OR monthly_amount > 0),
  total_amount     numeric(14,2) CHECK (total_amount IS NULL OR total_amount > 0),
  due_day          integer CHECK (due_day IS NULL OR due_day BETWEEN 1 AND 31),
  readjustment     text,                         -- índice/regra de reajuste, como consta do contrato
  notice_days      integer NOT NULL DEFAULT 60 CHECK (notice_days BETWEEN 0 AND 365),
  status           text NOT NULL DEFAULT 'VIGENTE' CHECK (status IN ('VIGENTE','ENCERRADO')),
  closed_reason    text,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK ((monthly_amount IS NULL) = (due_day IS NULL)),
  CHECK (status = 'VIGENTE' OR length(trim(coalesce(closed_reason, ''))) >= 3)
);

-- Orçamento (previsão) por ano, mês, centro de custo e categoria.
CREATE TABLE budget_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year            integer NOT NULL CHECK (year BETWEEN 2020 AND 2100),
  month           integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  cost_center_id  uuid NOT NULL REFERENCES cost_centers(id),
  category_id     uuid NOT NULL REFERENCES finance_categories(id),
  amount          numeric(14,2) NOT NULL CHECK (amount >= 0),
  updated_by      uuid NOT NULL REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (year, month, cost_center_id, category_id)
);

-- Despesas / contas a pagar.
CREATE TABLE expenses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('FIXA','VARIAVEL','COMPRA')),
  origin            text NOT NULL DEFAULT 'MANUAL' CHECK (origin IN ('MANUAL','CONTRATO')),
  description       text NOT NULL CHECK (length(trim(description)) >= 3),
  supplier_id       uuid REFERENCES suppliers(id),
  contract_id       uuid REFERENCES contracts(id),
  project_id        uuid REFERENCES projects(id),
  cost_center_id    uuid NOT NULL REFERENCES cost_centers(id),
  category_id       uuid NOT NULL REFERENCES finance_categories(id),
  amount            numeric(14,2) NOT NULL CHECK (amount > 0),
  competence        date NOT NULL CHECK (extract(day FROM competence) = 1),   -- mês de competência (dia 1)
  due_date          date NOT NULL,
  status            text NOT NULL DEFAULT 'SOLICITADA' CHECK (status IN ('SOLICITADA','APROVADA','REJEITADA','PAGA','CANCELADA')),
  requested_by      uuid NOT NULL REFERENCES users(id),
  requested_at      timestamptz NOT NULL DEFAULT now(),
  justification     text,
  decided_by        uuid REFERENCES users(id),
  decided_at        timestamptz,
  decision_notes    text,
  cancelled_by      uuid REFERENCES users(id),
  cancel_reason     text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK (status IN ('SOLICITADA','CANCELADA') OR decided_by IS NOT NULL),
  CHECK (status <> 'REJEITADA' OR length(trim(coalesce(decision_notes, ''))) >= 3),
  CHECK (status <> 'CANCELADA' OR length(trim(coalesce(cancel_reason, ''))) >= 3),
  CHECK (kind <> 'COMPRA' OR length(trim(coalesce(justification, ''))) >= 3)
);
CREATE UNIQUE INDEX ux_expenses_contract_month ON expenses (contract_id, competence) WHERE origin = 'CONTRATO' AND status <> 'CANCELADA';
CREATE INDEX ix_expenses_status_due ON expenses (status, due_date);
CREATE INDEX ix_expenses_competence ON expenses (competence);

-- Pagamento: um por despesa, imutável. Quem paga não solicitou nem aprovou (verificado também no banco).
CREATE TABLE expense_payments (
  expense_id     uuid PRIMARY KEY REFERENCES expenses(id),
  paid_on        date NOT NULL,
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  method         text NOT NULL CHECK (method IN ('PIX','BOLETO','TRANSFERENCIA','DEBITO_AUTOMATICO','CARTAO','DINHEIRO')),
  reference      text,
  paid_by        uuid NOT NULL REFERENCES users(id),
  registered_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_expense_payments_immutable BEFORE UPDATE OR DELETE ON expense_payments FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

CREATE FUNCTION fn_expense_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e expenses%ROWTYPE;
BEGIN
  SELECT * INTO e FROM expenses WHERE id = NEW.expense_id FOR UPDATE;
  IF e.status <> 'APROVADA' THEN
    RAISE EXCEPTION 'Somente despesa aprovada pode ser paga.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.paid_by = e.requested_by OR NEW.paid_by = e.decided_by THEN
    RAISE EXCEPTION 'Segregação de funções: quem solicitou ou aprovou não registra o pagamento.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_expense_payment_guard BEFORE INSERT ON expense_payments FOR EACH ROW EXECUTE FUNCTION fn_expense_payment_guard();

-- Despesa paga (ou decidida) não é reescrita: valores, partes e datas ficam congelados.
CREATE FUNCTION fn_expense_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Despesas não podem ser excluídas; use o cancelamento.' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status IN ('PAGA','REJEITADA','CANCELADA') THEN
    RAISE EXCEPTION 'Despesa encerrada (%) é imutável.', OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'APROVADA' AND NEW.status NOT IN ('PAGA','CANCELADA','APROVADA') THEN
    RAISE EXCEPTION 'Transição inválida.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'APROVADA' AND (NEW.amount, NEW.supplier_id, NEW.cost_center_id, NEW.category_id, NEW.competence, NEW.requested_by, NEW.decided_by)
     IS DISTINCT FROM (OLD.amount, OLD.supplier_id, OLD.cost_center_id, OLD.category_id, OLD.competence, OLD.requested_by, OLD.decided_by) THEN
    RAISE EXCEPTION 'Despesa aprovada não pode ter valor, fornecedor, classificação ou partes alterados.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'PAGA' AND NOT EXISTS (SELECT 1 FROM expense_payments p WHERE p.expense_id = NEW.id) THEN
    RAISE EXCEPTION 'Despesa só fica paga com o registro de pagamento.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_expense_guard BEFORE UPDATE OR DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION fn_expense_guard();

-- Cotações de compras (orçamentos de fornecedores).
CREATE TABLE expense_quotes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id   uuid NOT NULL REFERENCES expenses(id),
  supplier_name text NOT NULL CHECK (length(trim(supplier_name)) >= 2),
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),
  file_id      uuid REFERENCES document_files(id),
  chosen       boolean NOT NULL DEFAULT false,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_expense_quote_chosen ON expense_quotes (expense_id) WHERE chosen;

-- Anexos: nota fiscal, comprovante, contrato, orçamento (arquivos verificados pelo antivírus).
CREATE TABLE finance_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id   uuid REFERENCES expenses(id),
  contract_id  uuid REFERENCES contracts(id),
  kind         text NOT NULL CHECK (kind IN ('NOTA_FISCAL','COMPROVANTE','CONTRATO','ORCAMENTO','OUTRO')),
  file_id      uuid NOT NULL REFERENCES document_files(id),
  added_by     uuid NOT NULL REFERENCES users(id),
  added_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((expense_id IS NULL) <> (contract_id IS NULL))
);
CREATE TRIGGER trg_finance_attachments_immutable BEFORE UPDATE OR DELETE ON finance_attachments FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- Receitas gerenciais (lançamento manual por competência; não substitui livros nem a escrituração).
CREATE TABLE revenue_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competence   date NOT NULL CHECK (extract(day FROM competence) = 1),
  received_on  date NOT NULL,
  category_id  uuid NOT NULL REFERENCES finance_categories(id),
  description  text NOT NULL CHECK (length(trim(description)) >= 3),
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  reverses_id  uuid UNIQUE REFERENCES revenue_entries(id)   -- estorno = novo lançamento que anula outro
);
CREATE TRIGGER trg_revenue_immutable BEFORE UPDATE OR DELETE ON revenue_entries FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

CREATE TABLE expense_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id  uuid NOT NULL REFERENCES expenses(id),
  user_id     uuid REFERENCES users(id),
  event       text NOT NULL,
  details     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_expense_events_immutable BEFORE UPDATE OR DELETE ON expense_events FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- ---------------------------------------------------------------------------
-- Permissões e parâmetros
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, module, description, sensitive, scopable) VALUES
  ('financeiro.ver',        'Financeiro', 'Consultar despesas, contratos e relatórios (setor: centros de custo do setor)', true, true),
  ('financeiro.solicitar',  'Financeiro', 'Solicitar despesas e compras', false, true),
  ('financeiro.aprovar',    'Financeiro', 'Aprovar ou rejeitar despesas (nunca as próprias)', true, false),
  ('financeiro.pagar',      'Financeiro', 'Registrar pagamentos (nunca de despesa que solicitou ou aprovou)', true, false),
  ('financeiro.cadastros',  'Financeiro', 'Fornecedores, contratos, centros de custo, categorias e orçamento', true, false),
  ('financeiro.receitas',   'Financeiro', 'Lançar receitas gerenciais', true, false);

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'TODOS' FROM roles r, permissions p WHERE r.code = 'OFICIAL' AND p.code LIKE 'financeiro.%';

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'TODOS' FROM roles r, permissions p
WHERE r.code = 'SUBSTITUTA_LEGAL' AND p.code IN ('financeiro.ver','financeiro.solicitar','financeiro.aprovar','financeiro.pagar','financeiro.cadastros');

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'SETOR' FROM roles r, permissions p
WHERE r.code = 'COORDENACAO_SETOR' AND p.code IN ('financeiro.ver','financeiro.solicitar');

INSERT INTO settings (key, value, description) VALUES
  ('financeiro.limite_aprovacao_delegada', '0', 'Acima deste valor (R$), somente a Oficial aprova. 0 = sem limite (definir pela administração)'),
  ('financeiro.comprovante_obrigatorio',   'true', 'Exigir comprovante anexado para registrar pagamento'),
  ('financeiro.aviso_vencimento_dias',     '5', 'Antecedência do aviso de contas a vencer (dias)');
