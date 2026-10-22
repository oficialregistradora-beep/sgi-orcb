-- SGI-ORCB — Migration 0002: gestão de pessoas, jornada, banco de horas, solicitações,
-- documentos/versões e assinaturas eletrônicas simples.

-- ---------------------------------------------------------------------------
-- Cadastro funcional
-- ---------------------------------------------------------------------------
CREATE TABLE employees (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid UNIQUE REFERENCES users(id),
  registration_code     text NOT NULL UNIQUE,              -- matrícula interna
  full_name             text NOT NULL CHECK (length(trim(full_name)) > 1),
  social_name           text,
  job_title_id          uuid NOT NULL REFERENCES job_titles(id),
  function_description  text,
  sector_id             uuid NOT NULL REFERENCES sectors(id),
  admission_date        date NOT NULL,
  termination_date      date,
  contract_type         text NOT NULL CHECK (contract_type IN ('CLT','ESTAGIO','APRENDIZ','TEMPORARIO','OUTRO')),
  weekly_hours          numeric(5,2) NOT NULL CHECK (weekly_hours > 0 AND weekly_hours <= 44),
  status                text NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('ATIVO','AFASTADO','DESLIGADO')),
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (termination_date IS NULL OR termination_date >= admission_date),
  CHECK ((status = 'DESLIGADO') = (termination_date IS NOT NULL))
);
CREATE INDEX ix_employees_sector ON employees (sector_id);
CREATE TRIGGER trg_employees_touch BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

-- Dados pessoais sensíveis: criptografados na aplicação (AES-256-GCM). cpf_hmac permite busca sem expor o valor.
CREATE TABLE employee_sensitive (
  employee_id             uuid PRIMARY KEY REFERENCES employees(id),
  cpf_enc                 text,
  cpf_hmac                text UNIQUE,
  rg_enc                  text,
  birth_date_enc          text,
  address_enc             text,
  phone_enc               text,
  personal_email_enc      text,
  bank_account_enc        text,
  emergency_contact_enc   text,
  health_notes_enc        text,
  updated_by              uuid REFERENCES users(id),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_history (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id           uuid NOT NULL REFERENCES employees(id),
  job_title_id          uuid NOT NULL REFERENCES job_titles(id),
  sector_id             uuid NOT NULL REFERENCES sectors(id),
  function_description  text,
  start_date            date NOT NULL,
  reason                text,
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_job_history_employee ON job_history (employee_id, start_date);

CREATE TABLE salary_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  monthly_amount  numeric(12,2) NOT NULL CHECK (monthly_amount > 0),
  effective_date  date NOT NULL,
  reason          text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, effective_date)
);
CREATE TRIGGER trg_salary_immutable BEFORE UPDATE OR DELETE ON salary_history FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- ---------------------------------------------------------------------------
-- Jornadas contratuais, calendário, ausências
-- ---------------------------------------------------------------------------
CREATE TABLE work_schedules (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        text NOT NULL UNIQUE,
  description                 text,
  tolerance_enabled           boolean NOT NULL DEFAULT true,
  tolerance_per_mark_minutes  integer NOT NULL DEFAULT 5 CHECK (tolerance_per_mark_minutes BETWEEN 0 AND 15),
  tolerance_daily_minutes     integer NOT NULL DEFAULT 10 CHECK (tolerance_daily_minutes BETWEEN 0 AND 30),
  active                      boolean NOT NULL DEFAULT true,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_work_schedules_touch BEFORE UPDATE ON work_schedules FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

-- weekday: 0 = domingo ... 6 = sábado. Ausência de linha = dia sem expediente (descanso).
CREATE TABLE work_schedule_days (
  schedule_id  uuid NOT NULL REFERENCES work_schedules(id) ON DELETE CASCADE,
  weekday      smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time   time NOT NULL,
  break_start  time,
  break_end    time,
  end_time     time NOT NULL,
  PRIMARY KEY (schedule_id, weekday),
  CHECK (end_time > start_time),
  CHECK ((break_start IS NULL) = (break_end IS NULL)),
  CHECK (break_start IS NULL OR (break_start > start_time AND break_end > break_start AND end_time > break_end))
);

CREATE TABLE employee_schedules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES employees(id),
  schedule_id  uuid NOT NULL REFERENCES work_schedules(id),
  valid_from   date NOT NULL,
  valid_until  date,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until >= valid_from),
  EXCLUDE USING gist (employee_id WITH =, daterange(valid_from, valid_until, '[]') WITH &&)
);

CREATE TABLE holidays (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date        date NOT NULL UNIQUE,
  name        text NOT NULL,
  scope       text NOT NULL CHECK (scope IN ('NACIONAL','ESTADUAL','MUNICIPAL','PONTO_FACULTATIVO','INTERNO')),
  is_day_off  boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE absences (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       uuid NOT NULL REFERENCES employees(id),
  type              text NOT NULL CHECK (type IN ('FERIAS','ATESTADO_MEDICO','LICENCA_MATERNIDADE','LICENCA_PATERNIDADE',
                                                   'LICENCA_OUTRA','FALTA_JUSTIFICADA','AFASTAMENTO_INSS','OUTRO')),
  start_date        date NOT NULL,
  end_date          date NOT NULL,
  counts_as_worked  boolean NOT NULL DEFAULT true,   -- true = dia abonado (jornada esperada zerada)
  notes             text,
  status            text NOT NULL DEFAULT 'ATIVA' CHECK (status IN ('ATIVA','CANCELADA')),
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  cancelled_by      uuid REFERENCES users(id),
  cancelled_at      timestamptz,
  CHECK (end_date >= start_date)
);
CREATE INDEX ix_absences_employee ON absences (employee_id, start_date, end_date) WHERE status = 'ATIVA';

-- Acordo de banco de horas (CLT art. 59). Cada funcionário precisa de acordo vigente para gerar créditos.
CREATE TABLE hour_bank_agreements (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id                uuid NOT NULL REFERENCES employees(id),
  kind                       text NOT NULL CHECK (kind IN ('INDIVIDUAL_ESCRITO','COLETIVO')),
  compensation_months        integer NOT NULL CHECK (compensation_months BETWEEN 1 AND 12),
  valid_from                 date NOT NULL,
  valid_until                date,
  allows_negative_balance    boolean NOT NULL DEFAULT false,
  max_daily_extra_minutes    integer NOT NULL DEFAULT 120 CHECK (max_daily_extra_minutes BETWEEN 0 AND 240),
  document_reference         text,      -- identificação do instrumento assinado (arquivo/versão)
  notes                      text,
  created_by                 uuid REFERENCES users(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  revoked_at                 timestamptz,
  revoked_by                 uuid REFERENCES users(id),
  CHECK (valid_until IS NULL OR valid_until >= valid_from),
  CHECK (kind <> 'INDIVIDUAL_ESCRITO' OR compensation_months <= 6)
);
CREATE INDEX ix_agreements_employee ON hour_bank_agreements (employee_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Solicitações e aprovações (correção de ponto, compensação, autorização de horas extras)
-- ---------------------------------------------------------------------------
CREATE TABLE requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text NOT NULL CHECK (type IN ('CORRECAO_PONTO','COMPENSACAO','AUTORIZACAO_EXTRA')),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  requested_by    uuid NOT NULL REFERENCES users(id),
  reference_date  date NOT NULL,
  payload         jsonb NOT NULL,
  justification   text NOT NULL CHECK (length(trim(justification)) >= 5),
  status          text NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE','APROVADA','REJEITADA','CANCELADA')),
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  decision_notes  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('APROVADA','REJEITADA')) = (decided_by IS NOT NULL))
);
CREATE INDEX ix_requests_status ON requests (status, created_at);
CREATE INDEX ix_requests_employee ON requests (employee_id, reference_date);
CREATE TRIGGER trg_requests_touch BEFORE UPDATE ON requests FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Marcações de jornada — IMUTÁVEIS. Horário sempre do servidor (marcações WEB).
-- ---------------------------------------------------------------------------
CREATE TABLE time_punches (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id            uuid NOT NULL REFERENCES employees(id),
  punched_at             timestamptz NOT NULL,
  local_date             date NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('ENTRADA','SAIDA_INTERVALO','RETORNO_INTERVALO','SAIDA','ADICIONAL')),
  source                 text NOT NULL CHECK (source IN ('WEB','CORRECAO')),
  correction_request_id  uuid REFERENCES requests(id),
  ip                     text,
  user_agent             text,
  created_by             uuid NOT NULL REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK ((source = 'CORRECAO') = (correction_request_id IS NOT NULL))
);
CREATE INDEX ix_punches_employee_date ON time_punches (employee_id, local_date, punched_at);

CREATE OR REPLACE FUNCTION fn_punch_before_insert() RETURNS trigger AS $$
BEGIN
  IF NEW.source = 'WEB' THEN
    NEW.punched_at := now();               -- relógio do servidor de banco; o cliente não define o horário
  END IF;
  NEW.local_date := (NEW.punched_at AT TIME ZONE 'America/Sao_Paulo')::date;
  NEW.created_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_punch_before_insert BEFORE INSERT ON time_punches FOR EACH ROW EXECUTE FUNCTION fn_punch_before_insert();
CREATE TRIGGER trg_punch_immutable BEFORE UPDATE OR DELETE ON time_punches FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- Desconsideração de marcação (aprovada) — o original permanece intacto.
CREATE TABLE punch_annulments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  punch_id     uuid NOT NULL UNIQUE REFERENCES time_punches(id),
  request_id   uuid NOT NULL REFERENCES requests(id),
  reason       text NOT NULL,
  approved_by  uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_annulment_immutable BEFORE UPDATE OR DELETE ON punch_annulments FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- ---------------------------------------------------------------------------
-- Apuração diária (recalculável) e ocorrências que exigem análise
-- ---------------------------------------------------------------------------
CREATE TABLE daily_records (
  employee_id          uuid NOT NULL REFERENCES employees(id),
  work_date            date NOT NULL,
  expected_minutes     integer NOT NULL,
  worked_minutes       integer NOT NULL,
  compensated_minutes  integer NOT NULL DEFAULT 0,
  raw_diff_minutes     integer NOT NULL,
  diff_minutes         integer NOT NULL,       -- após tolerância (art. 58 §1º, se habilitada)
  tolerance_applied    boolean NOT NULL DEFAULT false,
  incomplete           boolean NOT NULL DEFAULT false,
  day_kind             text NOT NULL CHECK (day_kind IN ('UTIL','DESCANSO','FERIADO','AUSENCIA_ABONADA')),
  alerts               text[] NOT NULL DEFAULT '{}',
  computed_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, work_date)
);

CREATE TABLE daily_occurrences (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id               uuid NOT NULL REFERENCES employees(id),
  work_date                 date NOT NULL,
  type                      text NOT NULL CHECK (type IN ('HORA_EXTRA','DIFERENCA_NEGATIVA','MARCACAO_INCOMPLETA')),
  minutes                   integer NOT NULL CHECK (minutes >= 0),
  status                    text NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE','RESOLVIDA','SUPERADA')),
  resolution                text CHECK (resolution IN ('BANCO_CREDITO','PAGAMENTO_EXTRA','ABONO','BANCO_DEBITO',
                                                       'FALTA_NAO_JUSTIFICADA','CIENTE')),
  resolution_notes          text,
  resolved_by               uuid REFERENCES users(id),
  resolved_at               timestamptz,
  auto_resolved             boolean NOT NULL DEFAULT false,  -- ex.: extra previamente autorizada
  employee_justification    text,
  justified_at              timestamptz,
  superseded_at             timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'RESOLVIDA') = (resolution IS NOT NULL)),
  CHECK (type <> 'HORA_EXTRA' OR resolution IS NULL OR resolution IN ('BANCO_CREDITO','PAGAMENTO_EXTRA','CIENTE')),
  CHECK (type <> 'DIFERENCA_NEGATIVA' OR resolution IS NULL OR resolution IN ('ABONO','BANCO_DEBITO','FALTA_NAO_JUSTIFICADA','CIENTE'))
);
-- Apenas uma ocorrência viva (não superada) por dia e tipo.
CREATE UNIQUE INDEX ux_occurrence_alive ON daily_occurrences (employee_id, work_date, type) WHERE status <> 'SUPERADA';
CREATE INDEX ix_occurrence_pending ON daily_occurrences (status, work_date) WHERE status = 'PENDENTE';

-- ---------------------------------------------------------------------------
-- Banco de horas — razão contábil IMUTÁVEL (correções por estorno)
-- ---------------------------------------------------------------------------
CREATE TABLE hour_bank_entries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id        uuid NOT NULL REFERENCES employees(id),
  agreement_id       uuid REFERENCES hour_bank_agreements(id),
  entry_date         date NOT NULL,          -- competência (data do fato)
  kind               text NOT NULL CHECK (kind IN ('CREDITO','DEBITO_COMPENSACAO','DEBITO_FALTA','PAGAMENTO','ESTORNO','AJUSTE')),
  minutes            integer NOT NULL CHECK (minutes <> 0),
  expires_on         date,                   -- créditos: limite de compensação
  occurrence_id      uuid REFERENCES daily_occurrences(id),
  request_id         uuid REFERENCES requests(id),
  reverses_entry_id  uuid UNIQUE REFERENCES hour_bank_entries(id),
  notes              text,
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'CREDITO' OR (minutes > 0 AND expires_on IS NOT NULL)),
  CHECK (kind NOT IN ('DEBITO_COMPENSACAO','DEBITO_FALTA','PAGAMENTO') OR minutes < 0),
  CHECK ((kind = 'ESTORNO') = (reverses_entry_id IS NOT NULL))
);
CREATE INDEX ix_hbe_employee ON hour_bank_entries (employee_id, entry_date);
-- Impede crédito/débito em duplicidade para a mesma ocorrência.
CREATE UNIQUE INDEX ux_hbe_occurrence ON hour_bank_entries (occurrence_id) WHERE occurrence_id IS NOT NULL;
CREATE UNIQUE INDEX ux_hbe_request ON hour_bank_entries (request_id) WHERE request_id IS NOT NULL;
CREATE TRIGGER trg_hbe_immutable BEFORE UPDATE OR DELETE ON hour_bank_entries FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- Consumo PEPS (primeiro a vencer, primeiro a sair) dos créditos por débitos/pagamentos.
CREATE TABLE hour_bank_allocations (
  debit_entry_id   uuid NOT NULL REFERENCES hour_bank_entries(id),
  credit_entry_id  uuid NOT NULL REFERENCES hour_bank_entries(id),
  minutes          integer NOT NULL CHECK (minutes > 0),
  PRIMARY KEY (debit_entry_id, credit_entry_id)
);
CREATE TRIGGER trg_hba_immutable BEFORE UPDATE OR DELETE ON hour_bank_allocations FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- Fechamento de período (competência mensal). Reabertura é registrada, nunca apagada.
CREATE TABLE period_closings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period           text NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  closed_by        uuid NOT NULL REFERENCES users(id),
  closed_at        timestamptz NOT NULL DEFAULT now(),
  reopened_by      uuid REFERENCES users(id),
  reopened_at      timestamptz,
  reopen_reason    text
);
CREATE UNIQUE INDEX ux_period_closed ON period_closings (period) WHERE reopened_at IS NULL;

-- ---------------------------------------------------------------------------
-- Documentos, versões e assinaturas eletrônicas simples
-- ---------------------------------------------------------------------------
CREATE TABLE documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category           text NOT NULL,
  title              text NOT NULL,
  confidentiality    text NOT NULL DEFAULT 'RESTRITO' CHECK (confidentiality IN ('INTERNO','RESTRITO','CONFIDENCIAL')),
  owner_employee_id  uuid REFERENCES employees(id),
  sector_id          uuid REFERENCES sectors(id),
  reference_type     text,
  reference_key      text,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reference_type, reference_key)
);

CREATE TABLE document_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      uuid NOT NULL REFERENCES documents(id),
  version_number   integer NOT NULL CHECK (version_number > 0),
  content          jsonb NOT NULL,                 -- conteúdo canônico (texto/estrutura) da versão
  content_sha256   text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_number)
);
CREATE TRIGGER trg_docver_immutable BEFORE UPDATE OR DELETE ON document_versions FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

CREATE TABLE signatures (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_id  uuid NOT NULL REFERENCES document_versions(id),
  signer_user_id       uuid NOT NULL REFERENCES users(id),
  act                  text NOT NULL CHECK (act IN ('CIENCIA','APROVACAO','CONCORDANCIA','CONTESTACAO')),
  statement            text NOT NULL,       -- texto exato da manifestação apresentada ao usuário
  comment              text,                -- obrigatório em contestação
  content_sha256       text NOT NULL,
  signed_at            timestamptz NOT NULL DEFAULT now(),
  session_id           uuid NOT NULL REFERENCES sessions(id),
  auth_method          text NOT NULL,
  mfa_verified_at      timestamptz,
  step_up_at           timestamptz,
  ip                   text,
  user_agent           text,
  evidence_sha256      text NOT NULL,
  UNIQUE (document_version_id, signer_user_id, act),
  CHECK (act <> 'CONTESTACAO' OR length(trim(coalesce(comment, ''))) >= 5)
);
CREATE TRIGGER trg_signatures_immutable BEFORE UPDATE OR DELETE ON signatures FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();
