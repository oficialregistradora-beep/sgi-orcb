-- SGI-ORCB — Migration 0006: gestão documental (repositório institucional).
-- Categorias, ciclo de vida (rascunho → aprovação → vigente → obsoleto/arquivado), controle de acesso por público e
-- confidencialidade, arquivos com hash, ciência registrada por assinatura simples, revisões periódicas e retenção.
-- Os documentos pessoais (espelho, extrato, termo) continuam na mesma tabela com reference_type próprio.

-- ---------------------------------------------------------------------------
-- Categorias (parametrizáveis). Prazos de retenção NÃO são presumidos: ficam em branco até definição
-- da tabela de temporalidade pela administração, com validação jurídica (J-15).
-- ---------------------------------------------------------------------------
CREATE TABLE document_categories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{2,40}$'),
  name             text NOT NULL UNIQUE,
  description      text,
  review_months    integer CHECK (review_months IS NULL OR review_months BETWEEN 1 AND 120),
  retention_months integer CHECK (retention_months IS NULL OR retention_months BETWEEN 1 AND 1200),
  retention_basis  text,                       -- fundamento do prazo (obrigatório quando houver prazo)
  default_confidentiality text NOT NULL DEFAULT 'INTERNO' CHECK (default_confidentiality IN ('INTERNO','RESTRITO','CONFIDENCIAL')),
  active           boolean NOT NULL DEFAULT true,
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (retention_months IS NULL OR length(trim(coalesce(retention_basis, ''))) >= 5)
);

INSERT INTO document_categories (code, name, review_months, default_confidentiality, sort_order) VALUES
  ('CODIGO_ETICA',        'Código de Ética',                       24,   'INTERNO',      10),
  ('REGIMENTO',           'Regimento Interno',                     24,   'INTERNO',      20),
  ('MANUAL_PESSOAS',      'Manual de Gestão de Pessoas',           12,   'INTERNO',      30),
  ('MANUAL_ATENDIMENTO',  'Manual do Atendimento',                 12,   'INTERNO',      40),
  ('POP',                 'POPs por atribuição',                   12,   'INTERNO',      50),
  ('POLITICA',            'Políticas institucionais',              12,   'INTERNO',      60),
  ('PSI',                 'Política de Segurança da Informação',   12,   'INTERNO',      70),
  ('LGPD',                'Política de Privacidade e LGPD',        12,   'INTERNO',      80),
  ('TERMOS',              'Termos e declarações',                  NULL, 'RESTRITO',     90),
  ('CONTRATO_TRABALHO',   'Contratos de trabalho',                 NULL, 'CONFIDENCIAL', 100),
  ('CONTRATO_FORNECEDOR', 'Contratos de fornecedores',             12,   'RESTRITO',     110),
  ('CHECKLIST',           'Checklists',                            12,   'INTERNO',      120),
  ('FORMULARIO',          'Formulários',                           12,   'INTERNO',      130),
  ('RELATORIO',           'Relatórios',                            NULL, 'RESTRITO',     140),
  ('ATA',                 'Atas de reunião',                       NULL, 'INTERNO',      150),
  ('AUDITORIA',           'Auditorias',                            NULL, 'RESTRITO',     160),
  ('QUALIDADE',           'Documentos de qualidade',               12,   'INTERNO',      170),
  ('ENTENDIMENTOS',       'Matriz de entendimentos',               12,   'INTERNO',      180),
  ('PCN',                 'Plano de Continuidade de Negócios',     12,   'RESTRITO',     190),
  ('PRD',                 'Plano de Recuperação de Desastres',     12,   'RESTRITO',     200),
  ('TREINAMENTO',         'Registros de treinamentos',             NULL, 'INTERNO',      210);

-- ---------------------------------------------------------------------------
-- Arquivos: conteúdo binário no banco (cópia de segurança única), identificado por SHA-256.
-- Imutáveis; a única alteração admitida é o descarte do conteúdo após a retenção (metadados e hash preservados).
-- ---------------------------------------------------------------------------
CREATE TABLE document_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename      text NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),
  mime_type     text NOT NULL,
  size_bytes    integer NOT NULL CHECK (size_bytes > 0),
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  data          bytea,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  purged_at     timestamptz,
  purged_by     uuid REFERENCES users(id),
  purge_reason  text,
  CHECK ((data IS NULL) = (purged_at IS NOT NULL)),
  CHECK (purged_at IS NULL OR (purged_by IS NOT NULL AND length(trim(coalesce(purge_reason, ''))) >= 5))
);

CREATE FUNCTION fn_document_file_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Arquivos documentais não podem ser excluídos (somente descarte registrado do conteúdo).' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'Arquivo já descartado.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.purged_at IS NULL OR NEW.data IS NOT NULL
     OR (NEW.id, NEW.filename, NEW.mime_type, NEW.size_bytes, NEW.sha256, NEW.created_by, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.filename, OLD.mime_type, OLD.size_bytes, OLD.sha256, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'Arquivo documental imutável: somente o descarte do conteúdo é permitido.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_document_files_guard BEFORE UPDATE OR DELETE ON document_files FOR EACH ROW EXECUTE FUNCTION fn_document_file_guard();

-- ---------------------------------------------------------------------------
-- Documentos do repositório (reference_type = 'REPOSITORIO').
-- ---------------------------------------------------------------------------
ALTER TABLE documents
  ADD COLUMN category_id          uuid REFERENCES document_categories(id),
  ADD COLUMN code                 text CHECK (code IS NULL OR code ~ '^[A-Z0-9][A-Z0-9._/-]{1,39}$'),
  ADD COLUMN summary              text,
  ADD COLUMN status               text CHECK (status IS NULL OR status IN ('RASCUNHO','EM_APROVACAO','VIGENTE','OBSOLETO','ARQUIVADO')),
  ADD COLUMN responsible_user_id  uuid REFERENCES users(id),
  ADD COLUMN review_months        integer CHECK (review_months IS NULL OR review_months BETWEEN 1 AND 120),
  ADD COLUMN next_review_on       date,
  ADD COLUMN effective_from       date,
  ADD COLUMN audience_type        text CHECK (audience_type IS NULL OR audience_type IN ('TODOS','SETORES','USUARIOS')),
  ADD COLUMN requires_acknowledgement boolean NOT NULL DEFAULT false,
  ADD COLUMN draft                jsonb,          -- rascunho editável: {texto, notaVersao, arquivoId}
  ADD COLUMN draft_updated_by     uuid REFERENCES users(id),
  ADD COLUMN draft_updated_at     timestamptz,
  ADD COLUMN pending_version_id   uuid REFERENCES document_versions(id),
  ADD COLUMN current_version_id   uuid REFERENCES document_versions(id),
  ADD COLUMN obsolete_at          timestamptz,
  ADD COLUMN archived_at          timestamptz,
  ADD COLUMN retention_until      date,
  ADD COLUMN updated_at           timestamptz NOT NULL DEFAULT now();

ALTER TABLE documents ADD CONSTRAINT ck_documents_repository CHECK (
  reference_type IS DISTINCT FROM 'REPOSITORIO' OR (
    category_id IS NOT NULL AND status IS NOT NULL AND audience_type IS NOT NULL AND responsible_user_id IS NOT NULL
    AND (status <> 'VIGENTE' OR (current_version_id IS NOT NULL AND effective_from IS NOT NULL))
    AND (status <> 'EM_APROVACAO' OR pending_version_id IS NOT NULL)
    AND (status <> 'ARQUIVADO' OR archived_at IS NOT NULL)
    AND (status <> 'OBSOLETO' OR obsolete_at IS NOT NULL)
  ));
CREATE UNIQUE INDEX ux_documents_repository_code ON documents (code) WHERE reference_type = 'REPOSITORIO' AND code IS NOT NULL;
CREATE INDEX ix_documents_repository ON documents (category_id, status) WHERE reference_type = 'REPOSITORIO';

-- Público destinatário (quando audience_type = SETORES ou USUARIOS) e lista de acesso dos confidenciais.
CREATE TABLE document_audience_sectors (
  document_id uuid NOT NULL REFERENCES documents(id),
  sector_id   uuid NOT NULL REFERENCES sectors(id),
  PRIMARY KEY (document_id, sector_id)
);
CREATE TABLE document_audience_users (
  document_id uuid NOT NULL REFERENCES documents(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (document_id, user_id)
);

-- Fluxo de cada versão submetida (a versão em si é imutável).
CREATE TABLE document_version_reviews (
  version_id      uuid PRIMARY KEY REFERENCES document_versions(id),
  submitted_by    uuid NOT NULL REFERENCES users(id),
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  file_id         uuid REFERENCES document_files(id),
  decision        text CHECK (decision IN ('APROVADA','REJEITADA')),
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  decision_notes  text,
  signature_id    uuid REFERENCES signatures(id),
  superseded_at   timestamptz,
  CHECK ((decision IS NULL) = (decided_at IS NULL) AND (decision IS NULL) = (decided_by IS NULL)),
  CHECK (decision IS DISTINCT FROM 'APROVADA' OR signature_id IS NOT NULL),
  CHECK (decision IS DISTINCT FROM 'REJEITADA' OR length(trim(coalesce(decision_notes, ''))) >= 5),
  CHECK (decided_by IS NULL OR decided_by <> submitted_by)
);

-- Decisão registrada não é reescrita; somente a marcação de substituição pode ser feita uma vez.
CREATE FUNCTION fn_document_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Revisões documentais não podem ser excluídas.' USING ERRCODE = 'P0001'; END IF;
  IF (OLD.version_id, OLD.submitted_by, OLD.submitted_at, OLD.file_id) IS DISTINCT FROM (NEW.version_id, NEW.submitted_by, NEW.submitted_at, NEW.file_id) THEN
    RAISE EXCEPTION 'Dados da submissão são imutáveis.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.decision IS NOT NULL AND (OLD.decision, OLD.decided_by, OLD.decided_at, OLD.decision_notes, OLD.signature_id)
     IS DISTINCT FROM (NEW.decision, NEW.decided_by, NEW.decided_at, NEW.decision_notes, NEW.signature_id) THEN
    RAISE EXCEPTION 'Decisão já registrada é imutável.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'Substituição já registrada.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_document_review_guard BEFORE UPDATE OR DELETE ON document_version_reviews FOR EACH ROW EXECUTE FUNCTION fn_document_review_guard();

-- Histórico de eventos do documento (alterações de metadados, acesso, arquivamento, descarte).
CREATE TABLE document_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES documents(id),
  user_id      uuid REFERENCES users(id),
  event        text NOT NULL,
  details      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_document_events_doc ON document_events (document_id, created_at);
CREATE TRIGGER trg_document_events_immutable BEFORE UPDATE OR DELETE ON document_events FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- ---------------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, module, description, sensitive, scopable) VALUES
  ('documentos.ver',       'Documentos', 'Consultar documentos vigentes destinados ao usuário', false, false),
  ('documentos.editar',    'Documentos', 'Elaborar documentos e revisões (setor responsável) e submeter à aprovação', false, true),
  ('documentos.aprovar',   'Documentos', 'Aprovar ou rejeitar versões submetidas (nunca a própria)', false, true),
  ('documentos.gerenciar', 'Documentos', 'Categorias, acesso, arquivamento, relatórios de ciência e exportação', true, false),
  ('documentos.descartar', 'Documentos', 'Descartar conteúdo de arquivos após o prazo de retenção', true, false);

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'TODOS' FROM roles r, permissions p
WHERE r.code = 'OFICIAL' AND p.code LIKE 'documentos.%';

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'TODOS' FROM roles r, permissions p
WHERE r.code = 'SUBSTITUTA_LEGAL' AND p.code IN ('documentos.ver','documentos.editar','documentos.aprovar','documentos.gerenciar');

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, CASE WHEN p.code = 'documentos.ver' THEN 'TODOS' ELSE 'SETOR' END FROM roles r, permissions p
WHERE r.code = 'COORDENACAO_SETOR' AND p.code IN ('documentos.ver','documentos.editar');

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'documentos.ver', 'TODOS' FROM roles r WHERE r.code = 'COLABORADOR';

INSERT INTO settings (key, value, description) VALUES
  ('documentos.arquivo_max_mb',        '15', 'Tamanho máximo de arquivo anexado (MB)'),
  ('documentos.revisao_aviso_dias',    '30', 'Antecedência do aviso de revisão periódica (dias)');
