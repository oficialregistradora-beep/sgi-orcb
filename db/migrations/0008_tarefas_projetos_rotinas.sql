-- SGI-ORCB — Migration 0008: tarefas, projetos, processos internos e rotinas (Fase 4a).
-- Gestão interna: o módulo não substitui livros, protocolos, centrais nem sistemas legalmente exigidos,
-- e não pratica nem qualifica atos registrais.

-- ---------------------------------------------------------------------------
-- Projetos
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text UNIQUE CHECK (code IS NULL OR code ~ '^[A-Z0-9][A-Z0-9._-]{1,29}$'),
  name            text NOT NULL CHECK (length(trim(name)) BETWEEN 3 AND 160),
  description     text,
  status          text NOT NULL DEFAULT 'PLANEJADO' CHECK (status IN ('PLANEJADO','EM_ANDAMENTO','PAUSADO','CONCLUIDO','CANCELADO')),
  owner_user_id   uuid NOT NULL REFERENCES users(id),
  sector_id       uuid NOT NULL REFERENCES sectors(id),
  start_date      date,
  due_date        date,
  estimated_cost  numeric(14,2) CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  CHECK (due_date IS NULL OR start_date IS NULL OR due_date >= start_date),
  CHECK ((status IN ('CONCLUIDO','CANCELADO')) = (closed_at IS NOT NULL))
);

CREATE TABLE project_members (
  project_id  uuid NOT NULL REFERENCES projects(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL DEFAULT 'MEMBRO' CHECK (role IN ('GESTOR','MEMBRO','LEITOR')),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE project_phases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id),
  name        text NOT NULL CHECK (length(trim(name)) >= 2),
  position    integer NOT NULL,
  start_date  date,
  due_date    date,
  CHECK (due_date IS NULL OR start_date IS NULL OR due_date >= start_date)
);

CREATE TABLE project_milestones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id),
  title       text NOT NULL CHECK (length(trim(title)) >= 2),
  due_date    date NOT NULL,
  done_at     timestamptz,
  done_by     uuid REFERENCES users(id)
);

-- Custos realizados lançados no projeto (gerencial; a integração com o financeiro vem na Fase 4b).
CREATE TABLE project_costs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id),
  description text NOT NULL CHECK (length(trim(description)) >= 3),
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  spent_on    date NOT NULL,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_project_costs_immutable BEFORE UPDATE OR DELETE ON project_costs FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

CREATE TABLE project_indicators (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id),
  name        text NOT NULL CHECK (length(trim(name)) >= 2),
  unit        text,
  target      numeric(14,2) NOT NULL,
  current     numeric(14,2) NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Rotinas (atividades recorrentes) e modelos de processo
-- ---------------------------------------------------------------------------
CREATE FUNCTION fn_int_array_within(a integer[], lo integer, hi integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT array_position(a, NULL) IS NULL AND coalesce(bool_and(x BETWEEN lo AND hi), true) FROM unnest(a) x
$$;

CREATE TABLE routines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (length(trim(name)) >= 3),
  description        text,
  area               text NOT NULL CHECK (area IN ('ATENDIMENTO','RI','RCPN','RTD','RCPJ','ADMINISTRACAO','DIRETORIA','PESSOAL')),
  sector_id          uuid NOT NULL REFERENCES sectors(id),
  assignee_user_id   uuid REFERENCES users(id),          -- sem responsável: tarefa do setor, a ser assumida
  frequency          text NOT NULL CHECK (frequency IN ('DIARIA','SEMANAL','MENSAL','ANUAL')),
  times              integer[] NOT NULL DEFAULT '{}',     -- horários (minutos desde 00:00); vazio = uma vez no dia
  weekdays           integer[] NOT NULL DEFAULT '{}',     -- SEMANAL: 0=domingo … 6=sábado
  month_day          integer CHECK (month_day IS NULL OR month_day BETWEEN 1 AND 31),
  month              integer CHECK (month IS NULL OR month BETWEEN 1 AND 12),
  business_days_only boolean NOT NULL DEFAULT true,
  priority           text NOT NULL DEFAULT 'MEDIA' CHECK (priority IN ('BAIXA','MEDIA','ALTA','URGENTE','IMEDIATA')),
  block_start        integer CHECK (block_start IS NULL OR block_start BETWEEN 0 AND 1439),
  block_end          integer CHECK (block_end IS NULL OR block_end BETWEEN 1 AND 1440),
  starts_on          date NOT NULL DEFAULT current_date,
  ends_on            date,
  active             boolean NOT NULL DEFAULT true,
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((block_start IS NULL) = (block_end IS NULL) AND (block_start IS NULL OR block_end > block_start)),
  CHECK (frequency <> 'SEMANAL' OR cardinality(weekdays) > 0),
  CHECK (frequency NOT IN ('MENSAL','ANUAL') OR month_day IS NOT NULL),
  CHECK (frequency <> 'ANUAL' OR month IS NOT NULL),
  CHECK (fn_int_array_within(times, 0, 1439) AND cardinality(times) <= 24),
  CHECK (fn_int_array_within(weekdays, 0, 6))
);

CREATE TABLE process_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL UNIQUE CHECK (length(trim(name)) >= 3),
  description  text,
  sector_id    uuid NOT NULL REFERENCES sectors(id),
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE process_template_steps (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id        uuid NOT NULL REFERENCES process_templates(id),
  position           integer NOT NULL,
  title              text NOT NULL CHECK (length(trim(title)) >= 2),
  instructions       text,
  inputs             text,
  outputs            text,
  required_documents text,
  responsible_role_id uuid REFERENCES roles(id),
  sla_days           integer NOT NULL DEFAULT 1 CHECK (sla_days BETWEEN 0 AND 365),
  requires_approval  boolean NOT NULL DEFAULT false,
  UNIQUE (template_id, position)
);

CREATE TABLE process_instances (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   uuid NOT NULL REFERENCES process_templates(id),
  title         text NOT NULL,
  template_snapshot jsonb NOT NULL,                     -- cópia das etapas usadas (alterações posteriores no modelo não afetam)
  status        text NOT NULL DEFAULT 'EM_ANDAMENTO' CHECK (status IN ('EM_ANDAMENTO','ENCERRADO','CANCELADO')),
  started_by    uuid NOT NULL REFERENCES users(id),
  started_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  closed_by     uuid REFERENCES users(id),
  close_notes   text,
  CHECK ((status = 'EM_ANDAMENTO') = (closed_at IS NULL))
);

-- ---------------------------------------------------------------------------
-- Tarefas
-- ---------------------------------------------------------------------------
CREATE TABLE tasks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid REFERENCES projects(id),
  phase_id              uuid REFERENCES project_phases(id),
  parent_task_id        uuid REFERENCES tasks(id),
  process_instance_id   uuid REFERENCES process_instances(id),
  process_step          integer,
  routine_id            uuid REFERENCES routines(id),
  occurrence_key        text,                            -- rotina: data + horário (gera uma única vez)
  title                 text NOT NULL CHECK (length(trim(title)) BETWEEN 2 AND 200),
  description           text,
  status                text NOT NULL DEFAULT 'A_FAZER' CHECK (status IN ('A_FAZER','EM_ANDAMENTO','EM_REVISAO','BLOQUEADA','CONCLUIDA','CANCELADA')),
  priority              text NOT NULL DEFAULT 'MEDIA' CHECK (priority IN ('BAIXA','MEDIA','ALTA','URGENTE','IMEDIATA')),
  sector_id             uuid NOT NULL REFERENCES sectors(id),
  assignee_user_id      uuid REFERENCES users(id),
  start_date            date,
  due_date              date,
  due_time              integer CHECK (due_time IS NULL OR due_time BETWEEN 0 AND 1439),
  block_start           integer CHECK (block_start IS NULL OR block_start BETWEEN 0 AND 1439),
  block_end             integer CHECK (block_end IS NULL OR block_end BETWEEN 1 AND 1440),
  requires_approval     boolean NOT NULL DEFAULT false,
  approver_user_id      uuid REFERENCES users(id),
  blocked_reason        text,
  escalation_level      text NOT NULL DEFAULT 'NENHUM' CHECK (escalation_level IN ('NENHUM','SUBSTITUTA','OFICIAL')),
  escalated_to_user_id  uuid REFERENCES users(id),
  escalation_reason     text,
  position              double precision NOT NULL DEFAULT 0,  -- ordenação no quadro
  created_by            uuid NOT NULL REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  completed_by          uuid REFERENCES users(id),
  approved_by           uuid REFERENCES users(id),
  CHECK (due_date IS NULL OR start_date IS NULL OR due_date >= start_date),
  CHECK ((block_start IS NULL) = (block_end IS NULL) AND (block_start IS NULL OR block_end > block_start)),
  CHECK ((status = 'CONCLUIDA') = (completed_at IS NOT NULL)),
  CHECK (status <> 'BLOQUEADA' OR length(trim(coalesce(blocked_reason, ''))) >= 3),
  CHECK (NOT requires_approval OR approver_user_id IS NOT NULL),
  CHECK (approver_user_id IS NULL OR approver_user_id IS DISTINCT FROM assignee_user_id),
  CHECK (approved_by IS NULL OR (approved_by IS DISTINCT FROM assignee_user_id AND approved_by IS DISTINCT FROM completed_by)),
  CHECK (parent_task_id IS NULL OR parent_task_id <> id),
  CHECK ((escalation_level = 'NENHUM') = (escalated_to_user_id IS NULL)),
  CHECK ((routine_id IS NULL) = (occurrence_key IS NULL)),
  UNIQUE (routine_id, occurrence_key),
  UNIQUE (process_instance_id, process_step)
);
CREATE INDEX ix_tasks_assignee ON tasks (assignee_user_id, status);
CREATE INDEX ix_tasks_project ON tasks (project_id, status);
CREATE INDEX ix_tasks_due ON tasks (due_date) WHERE status NOT IN ('CONCLUIDA','CANCELADA');

-- Tarefas não são excluídas (cancela-se); a exclusão é bloqueada no banco.
CREATE FUNCTION fn_tasks_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Tarefas não podem ser excluídas; use o cancelamento.' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER trg_tasks_no_delete BEFORE DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION fn_tasks_no_delete();
CREATE TRIGGER trg_projects_no_delete BEFORE DELETE ON projects FOR EACH ROW EXECUTE FUNCTION fn_tasks_no_delete();

CREATE TABLE task_dependencies (
  task_id        uuid NOT NULL REFERENCES tasks(id),
  depends_on_id  uuid NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);

CREATE TABLE task_checklist_items (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id   uuid NOT NULL REFERENCES tasks(id),
  position  integer NOT NULL,
  title     text NOT NULL CHECK (length(trim(title)) >= 1),
  done_at   timestamptz,
  done_by   uuid REFERENCES users(id),
  CHECK ((done_at IS NULL) = (done_by IS NULL))
);

-- Comentários internos: imutáveis (correção = novo comentário).
CREATE TABLE task_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES tasks(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  body        text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 5000),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_task_comments_immutable BEFORE UPDATE OR DELETE ON task_comments FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- Anexos: arquivos verificados pelo antivírus e guardados como os documentais (document_files).
CREATE TABLE task_attachments (
  task_id     uuid NOT NULL REFERENCES tasks(id),
  file_id     uuid NOT NULL REFERENCES document_files(id),
  added_by    uuid NOT NULL REFERENCES users(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, file_id)
);
CREATE TRIGGER trg_task_attachments_immutable BEFORE UPDATE OR DELETE ON task_attachments FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

CREATE TABLE task_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES tasks(id),
  user_id     uuid REFERENCES users(id),
  event       text NOT NULL,
  details     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_task_events_task ON task_events (task_id, created_at);
CREATE TRIGGER trg_task_events_immutable BEFORE UPDATE OR DELETE ON task_events FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- ---------------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, module, description, sensitive, scopable) VALUES
  ('tarefas.ver',         'Tarefas', 'Ver tarefas do setor (próprio: tarefas atribuídas, criadas ou de projetos de que participa)', false, true),
  ('tarefas.criar',       'Tarefas', 'Criar tarefas', false, true),
  ('tarefas.gerenciar',   'Tarefas', 'Atribuir, editar, cancelar e reabrir tarefas de terceiros', false, true),
  ('projetos.gerenciar',  'Tarefas', 'Criar e gerir projetos', false, true),
  ('rotinas.gerenciar',   'Tarefas', 'Configurar rotinas recorrentes e modelos de processo', false, false);

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'TODOS' FROM roles r, permissions p
WHERE r.code IN ('OFICIAL','SUBSTITUTA_LEGAL') AND p.code IN ('tarefas.ver','tarefas.criar','tarefas.gerenciar','projetos.gerenciar','rotinas.gerenciar');

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'SETOR' FROM roles r, permissions p
WHERE r.code = 'COORDENACAO_SETOR' AND p.code IN ('tarefas.ver','tarefas.criar','tarefas.gerenciar','projetos.gerenciar');

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'PROPRIO' FROM roles r, permissions p
WHERE r.code = 'COLABORADOR' AND p.code IN ('tarefas.ver','tarefas.criar');

INSERT INTO settings (key, value, description) VALUES
  ('tarefas.aviso_prazo_dias', '1', 'Antecedência do aviso de prazo de tarefa (dias)');
