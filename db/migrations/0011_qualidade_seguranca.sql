-- SGI-ORCB — Migration 0011: qualidade, conformidade, riscos e segurança da informação (Fase 5a).
-- Ferramenta de APOIO à gestão da qualidade e a programas como o PQTA: o sistema não declara conformidade nem
-- certificação. Nenhum requisito normativo é pré-carregado — a serventia cadastra os requisitos a partir das fontes oficiais.

-- ---------------------------------------------------------------------------
-- Programa de conformidade: requisitos e evidências
-- ---------------------------------------------------------------------------
CREATE TABLE quality_requirements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9._/-]{0,29}$'),
  title           text NOT NULL CHECK (length(trim(title)) >= 3),
  source          text NOT NULL CHECK (length(trim(source)) >= 3),   -- norma/item/fonte consultada, como informado pela serventia
  area            text NOT NULL,
  owner_user_id   uuid NOT NULL REFERENCES users(id),
  status          text NOT NULL DEFAULT 'NAO_AVALIADO' CHECK (status IN ('NAO_AVALIADO','ATENDIDO','PARCIAL','NAO_ATENDIDO','NAO_APLICAVEL')),
  status_notes    text,
  review_months   integer NOT NULL DEFAULT 12 CHECK (review_months BETWEEN 1 AND 60),
  last_reviewed_at timestamptz,
  last_reviewed_by uuid REFERENCES users(id),
  next_review_on  date,
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'NAO_AVALIADO' OR last_reviewed_at IS NOT NULL),
  CHECK (status NOT IN ('PARCIAL','NAO_ATENDIDO','NAO_APLICAVEL') OR length(trim(coalesce(status_notes, ''))) >= 3)
);

CREATE TABLE requirement_evidences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id  uuid NOT NULL REFERENCES quality_requirements(id),
  description     text NOT NULL CHECK (length(trim(description)) >= 3),
  document_id     uuid REFERENCES documents(id),          -- documento do repositório (ex.: POP vigente)
  file_id         uuid REFERENCES document_files(id),     -- arquivo anexado (verificado pelo antivírus)
  added_by        uuid NOT NULL REFERENCES users(id),
  added_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_req_evidences_immutable BEFORE UPDATE OR DELETE ON requirement_evidences FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- Histórico de avaliações de cada requisito (imutável).
CREATE TABLE requirement_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id  uuid NOT NULL REFERENCES quality_requirements(id),
  status          text NOT NULL,
  notes           text,
  reviewed_by     uuid NOT NULL REFERENCES users(id),
  reviewed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_req_reviews_immutable BEFORE UPDATE OR DELETE ON requirement_reviews FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- ---------------------------------------------------------------------------
-- Auditorias internas (checklist de conformidade)
-- ---------------------------------------------------------------------------
CREATE TABLE audits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE,
  title             text NOT NULL CHECK (length(trim(title)) >= 3),
  kind              text NOT NULL CHECK (kind IN ('INTERNA','DOCUMENTAL','SEGURANCA_INFORMACAO','LGPD','PROCESSOS','OUTRA')),
  scope             text NOT NULL CHECK (length(trim(scope)) >= 3),
  audited_sector_id uuid REFERENCES sectors(id),
  lead_auditor_id   uuid NOT NULL REFERENCES users(id),
  planned_date      date NOT NULL,
  status            text NOT NULL DEFAULT 'PLANEJADA' CHECK (status IN ('PLANEJADA','EM_EXECUCAO','CONCLUIDA','CANCELADA')),
  conclusion        text,
  concluded_at      timestamptz,
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'CONCLUIDA') = (concluded_at IS NOT NULL)),
  CHECK (status <> 'CONCLUIDA' OR length(trim(coalesce(conclusion, ''))) >= 5)
);

CREATE TABLE audit_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id         uuid NOT NULL REFERENCES audits(id),
  position         integer NOT NULL,
  question         text NOT NULL CHECK (length(trim(question)) >= 3),
  requirement_id   uuid REFERENCES quality_requirements(id),
  result           text NOT NULL DEFAULT 'PENDENTE' CHECK (result IN ('PENDENTE','CONFORME','NAO_CONFORME','OBSERVACAO','NAO_APLICAVEL')),
  evidence         text,
  file_id          uuid REFERENCES document_files(id),
  evaluated_by     uuid REFERENCES users(id),
  evaluated_at     timestamptz,
  UNIQUE (audit_id, position),
  CHECK (result = 'PENDENTE' OR (evaluated_by IS NOT NULL AND evaluated_at IS NOT NULL)),
  CHECK (result NOT IN ('NAO_CONFORME','OBSERVACAO') OR length(trim(coalesce(evidence, ''))) >= 3)
);

-- Auditoria concluída é imutável (itens e cabeçalho).
CREATE FUNCTION fn_audit_closed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  IF TG_TABLE_NAME = 'audits' THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Auditorias não podem ser excluídas.' USING ERRCODE = 'P0001'; END IF;
    IF OLD.status IN ('CONCLUIDA','CANCELADA') THEN RAISE EXCEPTION 'Auditoria encerrada é imutável.' USING ERRCODE = 'P0001'; END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO st FROM audits WHERE id = coalesce(NEW.audit_id, OLD.audit_id);
  IF st IN ('CONCLUIDA','CANCELADA') THEN RAISE EXCEPTION 'Auditoria encerrada é imutável.' USING ERRCODE = 'P0001'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_audits_guard BEFORE UPDATE OR DELETE ON audits FOR EACH ROW EXECUTE FUNCTION fn_audit_closed_guard();
CREATE TRIGGER trg_audit_items_guard BEFORE INSERT OR UPDATE OR DELETE ON audit_items FOR EACH ROW EXECUTE FUNCTION fn_audit_closed_guard();

-- ---------------------------------------------------------------------------
-- Incidentes (segurança da informação, dados pessoais, indisponibilidade…)
-- ---------------------------------------------------------------------------
CREATE TABLE incidents (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                    text NOT NULL UNIQUE,
  title                   text NOT NULL CHECK (length(trim(title)) >= 3),
  description             text NOT NULL CHECK (length(trim(description)) >= 5),
  category                text NOT NULL CHECK (category IN ('SEGURANCA_INFORMACAO','DADOS_PESSOAIS','INDISPONIBILIDADE','FISICO','OPERACIONAL','OUTRO')),
  severity                text NOT NULL DEFAULT 'MEDIA' CHECK (severity IN ('BAIXA','MEDIA','ALTA','CRITICA')),
  occurred_at             timestamptz,
  detected_at             timestamptz NOT NULL,
  reported_by             uuid NOT NULL REFERENCES users(id),
  reported_at             timestamptz NOT NULL DEFAULT now(),
  personal_data_involved  boolean NOT NULL DEFAULT false,
  containment             text,
  root_cause              text,
  lgpd_assessment         text,       -- avaliação sobre comunicação à ANPD e aos titulares (encarregado de dados)
  lgpd_assessed_by        uuid REFERENCES users(id),
  status                  text NOT NULL DEFAULT 'ABERTO' CHECK (status IN ('ABERTO','CONTIDO','ENCERRADO')),
  closed_at               timestamptz,
  closed_by               uuid REFERENCES users(id),
  CHECK (occurred_at IS NULL OR occurred_at <= detected_at),
  CHECK ((status = 'ENCERRADO') = (closed_at IS NOT NULL)),
  CHECK (status = 'ABERTO' OR length(trim(coalesce(containment, ''))) >= 3),
  CHECK (status <> 'ENCERRADO' OR length(trim(coalesce(root_cause, ''))) >= 3),
  CHECK (status <> 'ENCERRADO' OR NOT personal_data_involved OR (length(trim(coalesce(lgpd_assessment, ''))) >= 5 AND lgpd_assessed_by IS NOT NULL))
);
CREATE TABLE incident_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id  uuid NOT NULL REFERENCES incidents(id),
  user_id      uuid REFERENCES users(id),
  event        text NOT NULL,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_incident_events_immutable BEFORE UPDATE OR DELETE ON incident_events FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();
CREATE FUNCTION fn_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Registro não pode ser excluído.' USING ERRCODE = 'P0001'; END $$;
CREATE TRIGGER trg_incidents_no_delete BEFORE DELETE ON incidents FOR EACH ROW EXECUTE FUNCTION fn_no_delete();

-- ---------------------------------------------------------------------------
-- Não conformidades e ações (ações são tarefas do módulo de tarefas)
-- ---------------------------------------------------------------------------
CREATE TABLE nonconformities (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  text NOT NULL UNIQUE,
  origin                text NOT NULL CHECK (origin IN ('AUDITORIA','INCIDENTE','RECLAMACAO','AUTOAVALIACAO','OUTRA')),
  audit_item_id         uuid UNIQUE REFERENCES audit_items(id),
  incident_id           uuid REFERENCES incidents(id),
  description           text NOT NULL CHECK (length(trim(description)) >= 5),
  severity              text NOT NULL DEFAULT 'MENOR' CHECK (severity IN ('MENOR','MAIOR','CRITICA')),
  sector_id             uuid REFERENCES sectors(id),
  responsible_user_id   uuid NOT NULL REFERENCES users(id),
  root_cause            text,
  status                text NOT NULL DEFAULT 'ABERTA' CHECK (status IN ('ABERTA','EM_TRATAMENTO','AGUARDANDO_VERIFICACAO','ENCERRADA','CANCELADA')),
  effectiveness_notes   text,
  verified_by           uuid REFERENCES users(id),
  closed_at             timestamptz,
  cancel_reason         text,
  created_by            uuid NOT NULL REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (origin <> 'AUDITORIA' OR audit_item_id IS NOT NULL),
  CHECK (status NOT IN ('AGUARDANDO_VERIFICACAO','ENCERRADA') OR length(trim(coalesce(root_cause, ''))) >= 3),
  CHECK ((status = 'ENCERRADA') = (closed_at IS NOT NULL AND verified_by IS NOT NULL)),
  CHECK (status <> 'ENCERRADA' OR (length(trim(coalesce(effectiveness_notes, ''))) >= 5 AND verified_by <> responsible_user_id)),
  CHECK (status <> 'CANCELADA' OR length(trim(coalesce(cancel_reason, ''))) >= 5)
);
CREATE TRIGGER trg_nc_no_delete BEFORE DELETE ON nonconformities FOR EACH ROW EXECUTE FUNCTION fn_no_delete();

CREATE TABLE risks (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                   text NOT NULL UNIQUE,
  title                  text NOT NULL CHECK (length(trim(title)) >= 3),
  description            text,
  category               text NOT NULL CHECK (category IN ('OPERACIONAL','SEGURANCA_INFORMACAO','DADOS_PESSOAIS','CONTINUIDADE','LEGAL_NORMATIVO','FINANCEIRO','PESSOAS','IMAGEM')),
  probability            integer NOT NULL CHECK (probability BETWEEN 1 AND 5),
  impact                 integer NOT NULL CHECK (impact BETWEEN 1 AND 5),
  level                  integer GENERATED ALWAYS AS (probability * impact) STORED,
  treatment              text NOT NULL CHECK (treatment IN ('MITIGAR','ACEITAR','TRANSFERIR','EVITAR')),
  controls               text,
  residual_probability   integer CHECK (residual_probability BETWEEN 1 AND 5),
  residual_impact        integer CHECK (residual_impact BETWEEN 1 AND 5),
  owner_user_id          uuid NOT NULL REFERENCES users(id),
  review_months          integer NOT NULL DEFAULT 6 CHECK (review_months BETWEEN 1 AND 36),
  next_review_on         date NOT NULL,
  status                 text NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('ATIVO','ENCERRADO')),
  accepted_by            uuid REFERENCES users(id),
  created_by             uuid NOT NULL REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK ((residual_probability IS NULL) = (residual_impact IS NULL)),
  CHECK (treatment <> 'ACEITAR' OR accepted_by IS NOT NULL)
);
CREATE TRIGGER trg_risks_no_delete BEFORE DELETE ON risks FOR EACH ROW EXECUTE FUNCTION fn_no_delete();
CREATE TABLE risk_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  risk_id      uuid NOT NULL REFERENCES risks(id),
  probability  integer NOT NULL, impact integer NOT NULL, treatment text NOT NULL,
  residual_probability integer, residual_impact integer,
  notes        text,
  reviewed_by  uuid NOT NULL REFERENCES users(id),
  reviewed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_risk_reviews_immutable BEFORE UPDATE OR DELETE ON risk_reviews FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- Ações corretivas, preventivas e de melhoria: cada ação é uma tarefa (responsável, prazo, evidências, aprovação).
CREATE TABLE quality_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('CORRECAO_IMEDIATA','CORRETIVA','PREVENTIVA','MELHORIA')),
  nc_id       uuid REFERENCES nonconformities(id),
  risk_id     uuid REFERENCES risks(id),
  incident_id uuid REFERENCES incidents(id),
  task_id     uuid NOT NULL UNIQUE REFERENCES tasks(id),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(nc_id, risk_id, incident_id) = 1),
  CHECK (kind <> 'CORRETIVA' OR nc_id IS NOT NULL)
);
CREATE TRIGGER trg_quality_actions_immutable BEFORE UPDATE OR DELETE ON quality_actions FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- ---------------------------------------------------------------------------
-- Ativos, equipamentos, backups e vulnerabilidades
-- ---------------------------------------------------------------------------
CREATE TABLE assets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag                  text NOT NULL UNIQUE CHECK (length(trim(tag)) >= 1),   -- nº de patrimônio/identificação
  name                 text NOT NULL CHECK (length(trim(name)) >= 2),
  kind                 text NOT NULL CHECK (kind IN ('COMPUTADOR','NOTEBOOK','IMPRESSORA','SCANNER','SERVIDOR','REDE','NOBREAK','SOFTWARE_LICENCA','CERTIFICADO_DIGITAL','TOKEN_SMARTCARD','CELULAR','MOBILIARIO','OUTRO')),
  serial               text,
  location             text,
  sector_id            uuid REFERENCES sectors(id),
  responsible_user_id  uuid REFERENCES users(id),
  criticality          text NOT NULL DEFAULT 'MEDIA' CHECK (criticality IN ('BAIXA','MEDIA','ALTA')),
  acquired_on          date,
  warranty_until       date,
  expires_on           date,          -- licença ou certificado digital
  status               text NOT NULL DEFAULT 'EM_USO' CHECK (status IN ('EM_USO','ESTOQUE','MANUTENCAO','BAIXADO')),
  disposal_reason      text,
  notes                text,
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'BAIXADO' OR length(trim(coalesce(disposal_reason, ''))) >= 3)
);
CREATE TRIGGER trg_assets_no_delete BEFORE DELETE ON assets FOR EACH ROW EXECUTE FUNCTION fn_no_delete();
CREATE TABLE asset_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    uuid NOT NULL REFERENCES assets(id),
  event       text NOT NULL CHECK (event IN ('CADASTRO','MOVIMENTACAO','MANUTENCAO','ALTERACAO','BAIXA')),
  notes       text,
  user_id     uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_asset_events_immutable BEFORE UPDATE OR DELETE ON asset_events FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

CREATE TABLE backup_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('BACKUP','TESTE_RESTAURACAO')),
  system        text NOT NULL CHECK (length(trim(system)) >= 2),     -- ex.: SGI, sistema registral, arquivos digitalizados
  performed_on  date NOT NULL,
  result        text NOT NULL CHECK (result IN ('SUCESSO','PARCIAL','FALHA')),
  notes         text,
  file_id       uuid REFERENCES document_files(id),
  recorded_by   uuid NOT NULL REFERENCES users(id),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (result = 'SUCESSO' OR length(trim(coalesce(notes, ''))) >= 3)
);
CREATE TRIGGER trg_backup_records_immutable BEFORE UPDATE OR DELETE ON backup_records FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

CREATE TABLE vulnerabilities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL CHECK (length(trim(title)) >= 3),
  source        text NOT NULL CHECK (length(trim(source)) >= 2),
  asset_id      uuid REFERENCES assets(id),
  severity      text NOT NULL CHECK (severity IN ('BAIXA','MEDIA','ALTA','CRITICA')),
  detected_on   date NOT NULL,
  due_on        date NOT NULL,
  status        text NOT NULL DEFAULT 'ABERTA' CHECK (status IN ('ABERTA','EM_TRATAMENTO','CORRIGIDA','RISCO_ACEITO')),
  resolution    text,
  closed_by     uuid REFERENCES users(id),
  closed_at     timestamptz,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (due_on >= detected_on),
  CHECK ((status IN ('CORRIGIDA','RISCO_ACEITO')) = (closed_at IS NOT NULL)),
  CHECK (status NOT IN ('CORRIGIDA','RISCO_ACEITO') OR (length(trim(coalesce(resolution, ''))) >= 5 AND closed_by IS NOT NULL))
);
CREATE TRIGGER trg_vuln_no_delete BEFORE DELETE ON vulnerabilities FOR EACH ROW EXECUTE FUNCTION fn_no_delete();

-- Avisos periódicos já enviados (evita repetir o mesmo lembrete).
CREATE TABLE reminder_log (key text PRIMARY KEY, sent_at timestamptz NOT NULL DEFAULT now());

-- Numeração sequencial por tipo e ano (NC-2026-001, INC-2026-001…).
CREATE TABLE quality_counters (prefix text NOT NULL, year integer NOT NULL, last integer NOT NULL, PRIMARY KEY (prefix, year));

-- ---------------------------------------------------------------------------
-- Permissões e parâmetros
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, module, description, sensitive, scopable) VALUES
  ('qualidade.ver',          'Qualidade', 'Consultar requisitos, auditorias, não conformidades, riscos e indicadores', false, true),
  ('qualidade.gerenciar',    'Qualidade', 'Cadastrar requisitos, não conformidades, riscos e ações; verificar eficácia', false, false),
  ('qualidade.auditar',      'Qualidade', 'Planejar e executar auditorias internas', false, false),
  ('incidentes.registrar',   'Segurança', 'Comunicar incidentes (todos devem poder comunicar)', false, true),
  ('incidentes.gerenciar',   'Segurança', 'Tratar incidentes, avaliação LGPD e encerramento', true, false),
  ('ativos.gerenciar',       'Segurança', 'Inventário de ativos, backups e vulnerabilidades', false, false);

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'TODOS' FROM roles r, permissions p
WHERE r.code = 'OFICIAL' AND p.code IN ('qualidade.ver','qualidade.gerenciar','qualidade.auditar','incidentes.registrar','incidentes.gerenciar','ativos.gerenciar');
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'TODOS' FROM roles r, permissions p
WHERE r.code = 'SUBSTITUTA_LEGAL' AND p.code IN ('qualidade.ver','qualidade.gerenciar','qualidade.auditar','incidentes.registrar','incidentes.gerenciar','ativos.gerenciar');
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'SETOR' FROM roles r, permissions p WHERE r.code = 'COORDENACAO_SETOR' AND p.code IN ('qualidade.ver','incidentes.registrar');
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'incidentes.registrar', 'PROPRIO' FROM roles r WHERE r.code = 'COLABORADOR';

-- Prazos de tratamento de vulnerabilidades por severidade e periodicidade do teste de restauração:
-- parâmetros INICIAIS de política interna, ajustáveis pela administração (não são exigências normativas).
INSERT INTO settings (key, value, description) VALUES
  ('seguranca.vulnerabilidade_prazo_critica', '7',   'Prazo de correção de vulnerabilidade crítica (dias) — política interna ajustável'),
  ('seguranca.vulnerabilidade_prazo_alta',    '30',  'Prazo de correção de vulnerabilidade alta (dias) — política interna ajustável'),
  ('seguranca.vulnerabilidade_prazo_media',   '90',  'Prazo de correção de vulnerabilidade média (dias) — política interna ajustável'),
  ('seguranca.vulnerabilidade_prazo_baixa',   '180', 'Prazo de correção de vulnerabilidade baixa (dias) — política interna ajustável'),
  ('seguranca.teste_restauracao_dias',        '90',  'Intervalo máximo entre testes de restauração bem-sucedidos (dias) — política interna ajustável'),
  ('seguranca.aviso_vencimento_ativos_dias',  '60',  'Antecedência do aviso de vencimento de garantias, licenças e certificados digitais (dias)');
