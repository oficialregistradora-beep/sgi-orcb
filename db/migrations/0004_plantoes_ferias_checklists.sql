-- SGI-ORCB — Migration 0004 (Fase 2b): plantões e sobreaviso do RCPN, solicitação de férias,
-- checklists de admissão/desligamento e controle de itens entregues (uniformes, equipamentos).

-- ---------------------------------------------------------------------------
-- Solicitações: novo tipo FERIAS
-- ---------------------------------------------------------------------------
ALTER TABLE requests DROP CONSTRAINT requests_type_check;
ALTER TABLE requests ADD CONSTRAINT requests_type_check
  CHECK (type IN ('CORRECAO_PONTO','COMPENSACAO','AUTORIZACAO_EXTRA','FERIAS'));

-- Ausência gerada por solicitação aprovada (férias) mantém o vínculo.
ALTER TABLE absences ADD COLUMN request_id uuid UNIQUE REFERENCES requests(id);

-- Períodos aquisitivos efetivamente usados por cada férias aprovada (permite fracionamento e saldo).
CREATE TABLE vacation_allocations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      uuid NOT NULL REFERENCES requests(id),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  period_start    date NOT NULL,              -- início do período aquisitivo
  enjoyed_days    integer NOT NULL CHECK (enjoyed_days >= 0),
  sold_days       integer NOT NULL DEFAULT 0 CHECK (sold_days BETWEEN 0 AND 10),  -- abono pecuniário (art. 143)
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  cancelled_at    timestamptz,
  cancelled_by    uuid REFERENCES users(id),
  cancel_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX ix_vacation_alloc_employee ON vacation_allocations (employee_id, period_start) WHERE cancelled_at IS NULL;

-- ---------------------------------------------------------------------------
-- Plantões do RCPN
-- Sobreaviso, trabalho efetivo e banco de horas são apurados SEPARADAMENTE (J-07).
-- ---------------------------------------------------------------------------
CREATE TABLE oncall_shifts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_date              date NOT NULL,
  starts_at               timestamptz NOT NULL,
  ends_at                 timestamptz NOT NULL,
  employee_id             uuid NOT NULL REFERENCES employees(id),     -- responsável
  substitute_employee_id  uuid REFERENCES employees(id),              -- substituto de prontidão
  status                  text NOT NULL DEFAULT 'PLANEJADO' CHECK (status IN ('PLANEJADO','REALIZADO','CANCELADO')),
  notes                   text,
  -- fechamento
  standby_minutes         integer CHECK (standby_minutes >= 0),
  effective_minutes       integer CHECK (effective_minutes >= 0),
  effective_destination   text CHECK (effective_destination IN ('BANCO','PAGAMENTO')),
  closed_by               uuid REFERENCES users(id),
  closed_at               timestamptz,
  created_by              uuid REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (substitute_employee_id IS NULL OR substitute_employee_id <> employee_id),
  CHECK ((status = 'REALIZADO') = (closed_at IS NOT NULL)),
  CHECK (status <> 'REALIZADO' OR (standby_minutes IS NOT NULL AND effective_minutes IS NOT NULL)),
  CHECK (effective_destination IS NULL OR status = 'REALIZADO')
);
CREATE UNIQUE INDEX ux_oncall_day ON oncall_shifts (shift_date) WHERE status <> 'CANCELADO';
CREATE INDEX ix_oncall_employee ON oncall_shifts (employee_id, shift_date);
CREATE TRIGGER trg_oncall_touch BEFORE UPDATE ON oncall_shifts FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

-- Chamados atendidos durante o plantão. Descrição sem dados pessoais do usuário do serviço (minimização — LGPD).
CREATE TABLE oncall_calls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id          uuid NOT NULL REFERENCES oncall_shifts(id),
  called_at         timestamptz NOT NULL,
  responded_at      timestamptz,
  attended          boolean NOT NULL DEFAULT false,      -- houve comparecimento à serventia
  arrival_at        timestamptz,
  departure_at      timestamptz,
  description       text NOT NULL CHECK (length(trim(description)) >= 3),
  registered_by     uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  voided_at         timestamptz,
  voided_by         uuid REFERENCES users(id),
  void_reason       text,
  CHECK (responded_at IS NULL OR responded_at >= called_at),
  CHECK (attended = (arrival_at IS NOT NULL AND departure_at IS NOT NULL)),
  CHECK (departure_at IS NULL OR departure_at > arrival_at),
  CHECK (arrival_at IS NULL OR arrival_at >= called_at)
);
CREATE INDEX ix_oncall_calls_shift ON oncall_calls (shift_id);

-- Trabalho efetivo destinado ao banco gera um único crédito por plantão.
ALTER TABLE hour_bank_entries ADD COLUMN oncall_shift_id uuid REFERENCES oncall_shifts(id);
CREATE UNIQUE INDEX ux_hbe_oncall ON hour_bank_entries (oncall_shift_id) WHERE oncall_shift_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Checklists (admissão, desligamento e outros) e itens entregues
-- ---------------------------------------------------------------------------
CREATE TABLE checklist_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('ADMISSAO','DESLIGAMENTO','OUTRO')),
  name        text NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE checklist_template_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id        uuid NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
  position           integer NOT NULL,
  title              text NOT NULL,
  description        text,
  due_offset_days    integer NOT NULL DEFAULT 0,   -- prazo relativo à data do evento (admissão/desligamento)
  auto_code          text,                          -- itens concluídos automaticamente pelo sistema
  UNIQUE (template_id, position)
);

CREATE TABLE checklists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     uuid REFERENCES checklist_templates(id),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  kind            text NOT NULL CHECK (kind IN ('ADMISSAO','DESLIGAMENTO','OUTRO')),
  title           text NOT NULL,
  reference_date  date NOT NULL,
  status          text NOT NULL DEFAULT 'ABERTO' CHECK (status IN ('ABERTO','CONCLUIDO')),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX ix_checklists_employee ON checklists (employee_id);

CREATE TABLE checklist_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_id  uuid NOT NULL REFERENCES checklists(id),
  position      integer NOT NULL,
  title         text NOT NULL,
  description   text,
  due_date      date,
  auto_code     text,
  status        text NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE','CONCLUIDO','NAO_APLICAVEL')),
  done_by       uuid REFERENCES users(id),
  done_at       timestamptz,
  notes         text,
  CHECK ((status = 'PENDENTE') = (done_at IS NULL))
);
CREATE INDEX ix_checklist_items ON checklist_items (checklist_id, position);

CREATE TABLE employee_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    uuid NOT NULL REFERENCES employees(id),
  kind           text NOT NULL CHECK (kind IN ('UNIFORME','EQUIPAMENTO','CRACHA','CHAVE','OUTRO')),
  description    text NOT NULL,
  quantity       integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  delivered_at   date NOT NULL,
  delivered_by   uuid REFERENCES users(id),
  returned_at    date,
  returned_by    uuid REFERENCES users(id),
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (returned_at IS NULL OR returned_at >= delivered_at)
);
CREATE INDEX ix_employee_items ON employee_items (employee_id) WHERE returned_at IS NULL;

-- ---------------------------------------------------------------------------
-- Permissões novas e atribuição aos papéis-padrão
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, module, description, sensitive, scopable) VALUES
  ('plantoes.ver',        'Plantões', 'Consultar escala e plantões', false, true),
  ('plantoes.registrar',  'Plantões', 'Registrar chamados e comparecimentos do plantão', false, true),
  ('plantoes.gerenciar',  'Plantões', 'Montar escala, designar responsáveis e substitutos', false, true),
  ('plantoes.fechar',     'Plantões', 'Fechar plantões e destinar o trabalho efetivo', false, true),
  ('ferias.aprovar',      'Férias',   'Aprovar solicitações de férias', false, true),
  ('ferias.ver',          'Férias',   'Consultar períodos aquisitivos, saldos e programação de férias', false, true);

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'TODOS' FROM roles r, permissions p
WHERE r.code = 'OFICIAL' AND p.code IN ('plantoes.ver','plantoes.registrar','plantoes.gerenciar','plantoes.fechar','ferias.aprovar','ferias.ver');

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'TODOS' FROM roles r, permissions p
WHERE r.code = 'SUBSTITUTA_LEGAL' AND p.code IN ('plantoes.ver','plantoes.registrar','plantoes.gerenciar','plantoes.fechar','ferias.aprovar','ferias.ver');

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'SETOR' FROM roles r, permissions p
WHERE r.code = 'COORDENACAO_SETOR' AND p.code IN ('plantoes.ver','ferias.ver');

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'PROPRIO' FROM roles r, permissions p
WHERE r.code = 'COLABORADOR' AND p.code IN ('plantoes.ver','plantoes.registrar','ferias.ver');

-- ---------------------------------------------------------------------------
-- Parâmetros
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value, description) VALUES
  ('plantao.horario_inicio_minutos', '480',  'Início do plantão (minutos desde 00:00; 480 = 08h)'),
  ('plantao.horario_fim_minutos',    '1080', 'Fim do plantão (1080 = 18h)'),
  ('plantao.sobreaviso_divisor',     '3',    'Hora de sobreaviso = hora normal ÷ divisor (1/3 — CLT art. 244 §2º por analogia; Súmula 428 TST). Dependente de validação jurídica'),
  ('plantao.adicional_efetivo_percentual', '100', 'Adicional estimado do trabalho efetivo em domingos/feriados. Dependente de CCT e validação jurídica'),
  ('ferias.aviso_minimo_dias',       '30',   'Antecedência da comunicação das férias (CLT art. 135)');

-- ---------------------------------------------------------------------------
-- Modelos iniciais de checklist (editáveis futuramente)
-- ---------------------------------------------------------------------------
WITH t AS (INSERT INTO checklist_templates (kind, name) VALUES ('ADMISSAO', 'Admissão — padrão') RETURNING id)
INSERT INTO checklist_template_items (template_id, position, title, description, due_offset_days, auto_code)
SELECT t.id, x.pos, x.title, x.descr, x.due, x.auto FROM t, (VALUES
  (1,  'Contrato de trabalho assinado', NULL, 0, NULL),
  (2,  'Documentos admissionais conferidos', 'Identificação, CPF, comprovante de residência, dados bancários, dependentes', 0, NULL),
  (3,  'Exame médico admissional (ASO)', NULL, 0, NULL),
  (4,  'Envio à contabilidade para registro no eSocial', 'Evento de admissão — prazo conforme legislação vigente', 0, NULL),
  (5,  'Ciência do Código de Ética e do Regimento Interno', NULL, 7, NULL),
  (6,  'Ciência da Política de Segurança da Informação e da Política de Privacidade', NULL, 7, NULL),
  (7,  'Termo de confidencialidade assinado', NULL, 0, NULL),
  (8,  'Acordo de banco de horas (se aplicável)', 'Cadastrar o acordo na ficha do funcionário', 0, 'ACORDO_BANCO'),
  (9,  'Jornada contratual definida no sistema', NULL, 0, 'JORNADA'),
  (10, 'Acesso ao sistema e autenticador configurados', NULL, 1, 'ACESSO'),
  (11, 'Entrega de uniforme e crachá (termo de entrega)', 'Registrar em "Itens entregues"', 7, NULL),
  (12, 'Treinamento inicial (POPs do setor e atendimento)', NULL, 30, NULL),
  (13, 'Avaliação do período de experiência — 30 dias', NULL, 30, NULL),
  (14, 'Avaliação do período de experiência — 60 dias', NULL, 60, NULL),
  (15, 'Avaliação do período de experiência — 90 dias', NULL, 89, NULL)
) AS x(pos, title, descr, due, auto);

WITH t AS (INSERT INTO checklist_templates (kind, name) VALUES ('DESLIGAMENTO', 'Desligamento — padrão') RETURNING id)
INSERT INTO checklist_template_items (template_id, position, title, description, due_offset_days, auto_code)
SELECT t.id, x.pos, x.title, x.descr, x.due, x.auto FROM t, (VALUES
  (1, 'Acessos ao sistema revogados', 'Feito automaticamente no registro do desligamento', 0, 'ACESSO_REVOGADO'),
  (2, 'Revogar acessos externos (e-mail, centrais, certificados digitais, chaves)', NULL, 0, NULL),
  (3, 'Devolução de equipamentos, uniformes, crachá e chaves', 'Conferir em "Itens entregues"', 0, 'ITENS_DEVOLVIDOS'),
  (4, 'Conferência e arquivamento de documentos sob responsabilidade do funcionário', NULL, 3, NULL),
  (5, 'Apuração do banco de horas para a rescisão', 'Saldo e créditos vencidos no extrato do banco', 0, NULL),
  (6, 'Exame médico demissional', NULL, 10, NULL),
  (7, 'Envio à contabilidade (rescisão e eSocial)', 'Prazo de pagamento das verbas: CLT art. 477 §6º', 10, NULL),
  (8, 'Arquivamento dos registros conforme prazos de retenção', 'Prazos dependentes de validação jurídica (J-09)', 30, NULL)
) AS x(pos, title, descr, due, auto);

-- Dupla conferência configurável por tipo documental (segunda etapa de aprovação).
INSERT INTO settings (key, value, description) VALUES
  ('documentos.aprovacao.ESPELHO',       'true',  'Espelho mensal exige aprovação após a manifestação do funcionário'),
  ('documentos.aprovacao.EXTRATO_BANCO', 'true',  'Extrato do banco de horas exige aprovação após a manifestação do funcionário'),
  ('documentos.aprovacao.TERMO_ENTREGA', 'false', 'Termo de entrega exige aprovação após a ciência do funcionário');

-- Proteções de integridade: plantões não são apagados (cancela-se); plantão fechado é imutável;
-- chamados não são apagados nem reescritos (somente anulação registrada).
CREATE OR REPLACE FUNCTION fn_oncall_shift_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Plantões não podem ser excluídos (use o cancelamento)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'REALIZADO' THEN
    RAISE EXCEPTION 'Plantão fechado é imutável' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_oncall_shift_guard BEFORE UPDATE OR DELETE ON oncall_shifts FOR EACH ROW EXECUTE FUNCTION fn_oncall_shift_guard();

CREATE OR REPLACE FUNCTION fn_oncall_call_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Chamados não podem ser excluídos (use a anulação)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL
     OR NEW.called_at IS DISTINCT FROM OLD.called_at OR NEW.responded_at IS DISTINCT FROM OLD.responded_at
     OR NEW.attended IS DISTINCT FROM OLD.attended OR NEW.arrival_at IS DISTINCT FROM OLD.arrival_at
     OR NEW.departure_at IS DISTINCT FROM OLD.departure_at OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.shift_id IS DISTINCT FROM OLD.shift_id OR NEW.registered_by IS DISTINCT FROM OLD.registered_by THEN
    RAISE EXCEPTION 'Registro de chamado é imutável (somente anulação)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_oncall_call_guard BEFORE UPDATE OR DELETE ON oncall_calls FOR EACH ROW EXECUTE FUNCTION fn_oncall_call_guard();

CREATE TRIGGER trg_vacation_alloc_no_delete BEFORE DELETE ON vacation_allocations FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();
