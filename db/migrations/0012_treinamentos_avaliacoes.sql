-- SGI-ORCB — Migration 0012: treinamentos, avaliações de desempenho, painéis configuráveis e automações (Fase 5b).
-- Avaliações são instrumento de gestão e desenvolvimento: o sistema não decide efetivação, rescisão, promoção nem
-- descontos — nenhuma consequência é aplicada automaticamente a partir de uma nota.

-- ---------------------------------------------------------------------------
-- Treinamentos
-- ---------------------------------------------------------------------------
CREATE TABLE trainings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9._/-]{0,29}$'),
  title             text NOT NULL CHECK (length(trim(title)) >= 3),
  kind              text NOT NULL CHECK (kind IN ('CURSO_INTERNO','CURSO_EXTERNO','ESTUDO_POP','PALESTRA','SISTEMA','INTEGRACAO','OUTRO')),
  description       text,
  provider          text,
  workload_minutes  integer CHECK (workload_minutes IS NULL OR workload_minutes BETWEEN 1 AND 100000),
  document_id       uuid REFERENCES documents(id),                 -- POP/documento do repositório a estudar
  validity_months   integer CHECK (validity_months IS NULL OR validity_months BETWEEN 1 AND 120),  -- nulo = sem reciclagem
  mandatory         boolean NOT NULL DEFAULT false,
  audience_type     text NOT NULL DEFAULT 'TODOS' CHECK (audience_type IN ('TODOS','SETORES','CARGOS')),
  has_assessment    boolean NOT NULL DEFAULT false,
  pass_score        integer NOT NULL DEFAULT 70 CHECK (pass_score BETWEEN 1 AND 100),
  max_attempts      integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  active            boolean NOT NULL DEFAULT true,
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'ESTUDO_POP' OR document_id IS NOT NULL)
);
CREATE TABLE training_audience (
  training_id   uuid NOT NULL REFERENCES trainings(id),
  sector_id     uuid REFERENCES sectors(id),
  job_title_id  uuid REFERENCES job_titles(id),
  CHECK (num_nonnulls(sector_id, job_title_id) = 1)
);
CREATE UNIQUE INDEX ux_training_audience ON training_audience (training_id, coalesce(sector_id, job_title_id));

-- Questões da avaliação de aprendizagem (múltipla escolha). A resposta correta nunca é enviada à tela do participante.
CREATE TABLE training_questions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  training_id    uuid NOT NULL REFERENCES trainings(id),
  position       integer NOT NULL,
  question       text NOT NULL CHECK (length(trim(question)) >= 3),
  options        jsonb NOT NULL CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) BETWEEN 2 AND 6),
  correct_index  integer NOT NULL CHECK (correct_index >= 0),
  UNIQUE (training_id, position),
  CHECK (correct_index < jsonb_array_length(options))
);

-- Turmas (presenciais ou on-line), refletidas na agenda institucional.
CREATE TABLE training_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  training_id   uuid NOT NULL REFERENCES trainings(id),
  session_date  date NOT NULL,
  start_time    integer CHECK (start_time IS NULL OR start_time BETWEEN 0 AND 1439),
  end_time      integer CHECK (end_time IS NULL OR end_time BETWEEN 1 AND 1440),
  location      text,
  instructor    text,
  status        text NOT NULL DEFAULT 'PLANEJADA' CHECK (status IN ('PLANEJADA','REALIZADA','CANCELADA')),
  event_id      uuid REFERENCES institutional_events(id),
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((start_time IS NULL) = (end_time IS NULL)),
  CHECK (start_time IS NULL OR end_time > start_time)
);

-- Participações e conclusões. Autodeclaração (certificado externo) exige validação por outra pessoa.
CREATE TABLE training_records (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  training_id          uuid NOT NULL REFERENCES trainings(id),
  employee_id          uuid NOT NULL REFERENCES employees(id),
  session_id           uuid REFERENCES training_sessions(id),
  status               text NOT NULL CHECK (status IN ('INSCRITO','PENDENTE_VALIDACAO','CONCLUIDO','NAO_CONCLUIDO','RECUSADO','CANCELADO','ANULADO')),
  source               text NOT NULL CHECK (source IN ('REGISTRO_GESTOR','AUTODECLARADO','ESTUDO_POP','INSCRICAO')),
  completed_on         date,
  expires_on           date,
  minutes              integer CHECK (minutes IS NULL OR minutes > 0),
  score                integer CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  document_version_id  uuid REFERENCES document_versions(id),     -- versão do POP estudada
  certificate_file_id  uuid REFERENCES document_files(id),
  notes                text,
  submitted_by         uuid NOT NULL REFERENCES users(id),
  submitted_at         timestamptz NOT NULL DEFAULT now(),
  validated_by         uuid REFERENCES users(id),
  validated_at         timestamptz,
  decision_notes       text,
  CHECK (status <> 'CONCLUIDO' OR completed_on IS NOT NULL),
  CHECK (status <> 'CONCLUIDO' OR source = 'ESTUDO_POP' OR validated_by IS NOT NULL),
  CHECK (source <> 'AUTODECLARADO' OR validated_by IS NULL OR validated_by <> submitted_by),
  CHECK (status NOT IN ('RECUSADO','ANULADO','CANCELADO') OR length(trim(coalesce(decision_notes, ''))) >= 3),
  CHECK (expires_on IS NULL OR completed_on IS NULL OR expires_on > completed_on)
);
CREATE INDEX ix_training_records_emp ON training_records (employee_id, training_id);
CREATE UNIQUE INDEX ux_training_records_open ON training_records (training_id, employee_id) WHERE status IN ('INSCRITO','PENDENTE_VALIDACAO');

-- Registros encerrados não mudam; somente a anulação justificada de uma conclusão.
CREATE FUNCTION fn_training_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Registros de treinamento não podem ser excluídos.' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status IN ('NAO_CONCLUIDO','RECUSADO','CANCELADO','ANULADO') THEN
    RAISE EXCEPTION 'Registro de treinamento encerrado é imutável.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'CONCLUIDO' AND NOT (NEW.status = 'ANULADO' AND NEW.training_id = OLD.training_id AND NEW.employee_id = OLD.employee_id
      AND NEW.completed_on IS NOT DISTINCT FROM OLD.completed_on AND NEW.score IS NOT DISTINCT FROM OLD.score
      AND NEW.certificate_file_id IS NOT DISTINCT FROM OLD.certificate_file_id) THEN
    RAISE EXCEPTION 'Conclusão registrada só pode ser anulada (com justificativa).' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_training_records_guard BEFORE UPDATE OR DELETE ON training_records FOR EACH ROW EXECUTE FUNCTION fn_training_record_guard();

CREATE TABLE training_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  training_id   uuid NOT NULL REFERENCES trainings(id),
  employee_id   uuid NOT NULL REFERENCES employees(id),
  answers       jsonb NOT NULL,
  score         integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  passed        boolean NOT NULL,
  submitted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_training_attempts_immutable BEFORE UPDATE OR DELETE ON training_attempts FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- ---------------------------------------------------------------------------
-- Avaliações de desempenho
-- ---------------------------------------------------------------------------
-- Modelos versionados: publicado é imutável; alterações geram nova versão.
CREATE TABLE evaluation_templates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_key     uuid NOT NULL,                  -- agrupa as versões do mesmo modelo
  version        integer NOT NULL CHECK (version > 0),
  name           text NOT NULL CHECK (length(trim(name)) >= 3),
  kind           text NOT NULL CHECK (kind IN ('EXPERIENCIA','ACOMPANHAMENTO','ANUAL','COMPETENCIAS','PRODUTIVIDADE','OUTRA')),
  instructions   text,
  scale_max      integer NOT NULL DEFAULT 5 CHECK (scale_max BETWEEN 2 AND 10),
  self_assessment boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'RASCUNHO' CHECK (status IN ('RASCUNHO','PUBLICADO','INATIVO')),
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  UNIQUE (family_key, version),
  CHECK ((status = 'RASCUNHO') = (published_at IS NULL))
);
CREATE TABLE evaluation_criteria (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  uuid NOT NULL REFERENCES evaluation_templates(id),
  position     integer NOT NULL,
  grp          text NOT NULL CHECK (grp IN ('COMPETENCIA','PRODUTIVIDADE','COMPORTAMENTO','CONHECIMENTO','OUTRO')),
  title        text NOT NULL CHECK (length(trim(title)) >= 2),
  description  text,
  weight       integer NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 10),
  UNIQUE (template_id, position)
);
CREATE FUNCTION fn_eval_template_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  IF TG_TABLE_NAME = 'evaluation_templates' THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Modelos não podem ser excluídos.' USING ERRCODE = 'P0001'; END IF;
    -- Publicado: só pode ser inativado.
    IF OLD.status <> 'RASCUNHO' AND NOT (NEW.status = 'INATIVO' AND NEW.name = OLD.name AND NEW.scale_max = OLD.scale_max
        AND NEW.self_assessment = OLD.self_assessment AND NEW.instructions IS NOT DISTINCT FROM OLD.instructions AND NEW.kind = OLD.kind) THEN
      RAISE EXCEPTION 'Modelo publicado é imutável: crie nova versão.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO st FROM evaluation_templates WHERE id = coalesce(NEW.template_id, OLD.template_id);
  IF st <> 'RASCUNHO' THEN RAISE EXCEPTION 'Modelo publicado é imutável: crie nova versão.' USING ERRCODE = 'P0001'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_eval_templates_guard BEFORE UPDATE OR DELETE ON evaluation_templates FOR EACH ROW EXECUTE FUNCTION fn_eval_template_guard();
CREATE TRIGGER trg_eval_criteria_guard BEFORE INSERT OR UPDATE OR DELETE ON evaluation_criteria FOR EACH ROW EXECUTE FUNCTION fn_eval_template_guard();

-- Programação automática (ex.: 30/60/90 dias após a admissão; anual em data fixa). Prazos configuráveis pela serventia.
CREATE TABLE evaluation_schedules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (length(trim(name)) >= 3),
  template_family    uuid NOT NULL,                -- usa a versão publicada mais recente do modelo
  trigger            text NOT NULL CHECK (trigger IN ('DIAS_APOS_ADMISSAO','ANUAL')),
  days_after         integer CHECK (days_after IS NULL OR days_after BETWEEN 1 AND 3650),
  annual_month       integer CHECK (annual_month IS NULL OR annual_month BETWEEN 1 AND 12),
  annual_day         integer CHECK (annual_day IS NULL OR annual_day BETWEEN 1 AND 28),
  lead_days          integer NOT NULL DEFAULT 7 CHECK (lead_days BETWEEN 0 AND 60),   -- cria com esta antecedência
  sector_id          uuid REFERENCES sectors(id),  -- nulo = todos
  active             boolean NOT NULL DEFAULT true,
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (trigger <> 'DIAS_APOS_ADMISSAO' OR days_after IS NOT NULL),
  CHECK (trigger <> 'ANUAL' OR (annual_month IS NOT NULL AND annual_day IS NOT NULL))
);

CREATE TABLE evaluations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id         uuid NOT NULL REFERENCES evaluation_templates(id),
  employee_id         uuid NOT NULL REFERENCES employees(id),
  evaluator_user_id   uuid NOT NULL REFERENCES users(id),
  period_label        text NOT NULL CHECK (length(trim(period_label)) >= 2),
  due_date            date NOT NULL,
  schedule_id         uuid REFERENCES evaluation_schedules(id),
  schedule_ref        text,                         -- referência da programação (data-base), para não duplicar
  status              text NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE','AGUARDANDO_CIENCIA','CONCLUIDA','CONCLUIDA_SEM_CIENCIA','CANCELADA')),
  self_submitted_at   timestamptz,
  strengths           text,
  improvements        text,
  feedback            text,
  overall_score       numeric(5,2),
  document_id         uuid REFERENCES documents(id),        -- versão congelada enviada para ciência
  sent_at             timestamptz,
  closed_at           timestamptz,
  close_notes         text,
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, employee_id, schedule_ref),
  CHECK (status IN ('PENDENTE','CANCELADA') OR (sent_at IS NOT NULL AND document_id IS NOT NULL)),
  CHECK (status NOT IN ('CONCLUIDA_SEM_CIENCIA','CANCELADA') OR length(trim(coalesce(close_notes, ''))) >= 5)
);
-- O avaliador nunca é o próprio avaliado.
CREATE FUNCTION fn_eval_not_self() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM employees WHERE id = NEW.employee_id AND user_id = NEW.evaluator_user_id) THEN
    RAISE EXCEPTION 'O avaliador não pode ser o próprio avaliado.' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('CONCLUIDA','CONCLUIDA_SEM_CIENCIA','CANCELADA') THEN
    RAISE EXCEPTION 'Avaliação encerrada é imutável.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_evaluations_guard BEFORE INSERT OR UPDATE ON evaluations FOR EACH ROW EXECUTE FUNCTION fn_eval_not_self();
CREATE TRIGGER trg_evaluations_no_delete BEFORE DELETE ON evaluations FOR EACH ROW EXECUTE FUNCTION fn_no_delete();

CREATE TABLE evaluation_scores (
  evaluation_id  uuid NOT NULL REFERENCES evaluations(id),
  criterion_id   uuid NOT NULL REFERENCES evaluation_criteria(id),
  source         text NOT NULL CHECK (source IN ('AVALIADOR','AUTOAVALIACAO')),
  score          integer NOT NULL CHECK (score BETWEEN 1 AND 10),
  comment        text,
  PRIMARY KEY (evaluation_id, criterion_id, source)
);
-- Notas congeladas após o envio para ciência (a autoavaliação, após entregue).
CREATE FUNCTION fn_eval_scores_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record;
BEGIN
  SELECT status, self_submitted_at INTO e FROM evaluations WHERE id = coalesce(NEW.evaluation_id, OLD.evaluation_id);
  IF e.status <> 'PENDENTE' OR (coalesce(NEW.source, OLD.source) = 'AUTOAVALIACAO' AND e.self_submitted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Notas congeladas: a avaliação já foi enviada.' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_eval_scores_guard BEFORE INSERT OR UPDATE OR DELETE ON evaluation_scores FOR EACH ROW EXECUTE FUNCTION fn_eval_scores_guard();

-- Plano de desenvolvimento individual (PDI): ações acordadas, com treinamento recomendado opcional.
CREATE TABLE pdi_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id  uuid REFERENCES evaluations(id),
  employee_id    uuid NOT NULL REFERENCES employees(id),
  goal           text NOT NULL CHECK (length(trim(goal)) >= 3),
  action         text NOT NULL CHECK (length(trim(action)) >= 3),
  training_id    uuid REFERENCES trainings(id),
  due_date       date NOT NULL,
  status         text NOT NULL DEFAULT 'ABERTO' CHECK (status IN ('ABERTO','EM_ANDAMENTO','CONCLUIDO','CANCELADO')),
  result_notes   text,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('CONCLUIDO','CANCELADO') OR length(trim(coalesce(result_notes, ''))) >= 3)
);
CREATE TRIGGER trg_pdi_no_delete BEFORE DELETE ON pdi_items FOR EACH ROW EXECUTE FUNCTION fn_no_delete();

-- Feedbacks documentados (fora do ciclo formal): o avaliado vê e pode registrar ciência e comentário.
CREATE TABLE feedback_notes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id      uuid NOT NULL REFERENCES employees(id),
  author_user_id   uuid NOT NULL REFERENCES users(id),
  kind             text NOT NULL CHECK (kind IN ('RECONHECIMENTO','ORIENTACAO','ALINHAMENTO')),
  content          text NOT NULL CHECK (length(trim(content)) >= 5),
  created_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_at  timestamptz,
  employee_comment text
);
CREATE FUNCTION fn_feedback_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Feedbacks não podem ser excluídos.' USING ERRCODE = 'P0001'; END IF;
  IF NEW.content <> OLD.content OR NEW.author_user_id <> OLD.author_user_id OR NEW.employee_id <> OLD.employee_id OR NEW.kind <> OLD.kind
     OR OLD.acknowledged_at IS NOT NULL THEN
    RAISE EXCEPTION 'Feedback registrado é imutável; somente a ciência do avaliado é registrada uma vez.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_feedback_guard BEFORE UPDATE OR DELETE ON feedback_notes FOR EACH ROW EXECUTE FUNCTION fn_feedback_guard();

-- ---------------------------------------------------------------------------
-- Painel configurável e automações
-- ---------------------------------------------------------------------------
CREATE TABLE dashboard_preferences (
  user_id     uuid PRIMARY KEY REFERENCES users(id),
  widgets     text[] NOT NULL,          -- ordem escolhida pela pessoa (catálogo fixo no código; cada bloco respeita as permissões)
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Regras "quando… então…" a partir de um catálogo fixo de gatilhos e ações seguras (somente avisos e tarefas).
CREATE TABLE automation_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL CHECK (length(trim(name)) >= 3),
  trigger        text NOT NULL,
  days           integer NOT NULL DEFAULT 0 CHECK (days BETWEEN 0 AND 365),
  sector_id      uuid REFERENCES sectors(id),     -- filtro opcional
  action         text NOT NULL CHECK (action IN ('NOTIFICAR_RESPONSAVEL','NOTIFICAR_PAPEL','NOTIFICAR_USUARIO','CRIAR_TAREFA','AVISO_CHAT')),
  target_role_id uuid REFERENCES roles(id),
  target_user_id uuid REFERENCES users(id),
  message        text,
  active         boolean NOT NULL DEFAULT true,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_run_at    timestamptz,
  CHECK (action <> 'NOTIFICAR_PAPEL' OR target_role_id IS NOT NULL),
  CHECK (action NOT IN ('NOTIFICAR_USUARIO','CRIAR_TAREFA') OR target_user_id IS NOT NULL)
);
CREATE TABLE automation_runs (
  id          bigserial PRIMARY KEY,
  rule_id     uuid NOT NULL REFERENCES automation_rules(id),
  entity_key  text NOT NULL,
  ran_at      timestamptz NOT NULL DEFAULT now(),
  outcome     text NOT NULL,
  UNIQUE (rule_id, entity_key)
);

-- ---------------------------------------------------------------------------
-- Permissões e parâmetros
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, module, description, sensitive, scopable) VALUES
  ('treinamentos.ver',        'Treinamentos', 'Consultar treinamentos e situação de capacitação (próprio, setor ou todos)', false, true),
  ('treinamentos.registrar',  'Treinamentos', 'Registrar participação e validar certificados', false, true),
  ('treinamentos.gerenciar',  'Treinamentos', 'Cadastrar treinamentos, turmas e avaliações de aprendizagem', false, false),
  ('avaliacoes.avaliar',      'Avaliações',   'Avaliar o desempenho de funcionários (setor ou todos)', true, true),
  ('avaliacoes.gerenciar',    'Avaliações',   'Modelos, programação, atribuição e acompanhamento de avaliações', true, false),
  ('automacoes.gerenciar',    'Administração','Configurar automações (avisos e tarefas)', false, false);

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'TODOS' FROM roles r, permissions p
WHERE r.code IN ('OFICIAL','SUBSTITUTA_LEGAL') AND p.code IN ('treinamentos.ver','treinamentos.registrar','treinamentos.gerenciar','avaliacoes.avaliar','avaliacoes.gerenciar','automacoes.gerenciar');
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'SETOR' FROM roles r, permissions p WHERE r.code = 'COORDENACAO_SETOR' AND p.code IN ('treinamentos.ver','treinamentos.registrar','avaliacoes.avaliar');
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'treinamentos.ver', 'PROPRIO' FROM roles r WHERE r.code = 'COLABORADOR';

INSERT INTO settings (key, value, description) VALUES
  ('treinamentos.aviso_vencimento_dias', '30', 'Antecedência do aviso de vencimento de treinamentos com reciclagem (dias)'),
  ('avaliacoes.prazo_ciencia_dias',      '10', 'Dias após o envio para que o avaliador possa encerrar a avaliação sem ciência (com justificativa)');
