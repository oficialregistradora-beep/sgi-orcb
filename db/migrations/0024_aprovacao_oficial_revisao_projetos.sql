-- Especificação da Oficial (25/11/2026): aprovação pela Oficial, fluxo de revisão e documentos em projetos.
-- (1) Responsável/Gestor(a) sem pré-seleção (marca de conferência dos já gravados);
-- (2) só a Oficial aprova, inclusive o que ela elaborou (autoaprovação registrada); a Substituta Legal só com autorização temporária;
-- (3) revisão opcional por uma ou mais revisoras antes da aprovação; retirar submissão; exclusão pela Oficial (arquivo guardado pela retenção);
-- (4) documentos no projeto, envio à Gestão documental e aprovação do projeto e de fases.

-- ---------------------------------------------------------------------------
-- Aprovação exclusiva da Oficial
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, module, description, sensitive, scopable) VALUES
  ('projetos.aprovar',   'Tarefas',    'Aprovar o projeto ou uma fase (somente a Oficial; Substituta Legal com autorização)', true, false),
  ('projetos.anexar',    'Tarefas',    'Anexar documentos ao projeto (próprio = projetos em que tem tarefa; setor = projetos do setor)', false, true),
  ('documentos.revisar', 'Documentos', 'Revisar documentos quando designada como revisora', false, false);
UPDATE permissions SET description = 'Aprovar versões (somente a Oficial, inclusive as próprias; Substituta Legal só com autorização da Oficial)'
 WHERE code = 'documentos.aprovar';
UPDATE permissions SET description = 'Elaborar documentos (setor) e submeter; a responsável e as revisoras editam o próprio documento'
 WHERE code = 'documentos.editar';

DELETE FROM role_permissions WHERE permission_code = 'documentos.aprovar'
   AND role_id IN (SELECT id FROM roles WHERE code <> 'OFICIAL');
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'projetos.aprovar', 'TODOS' FROM roles r WHERE r.code = 'OFICIAL';
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'projetos.anexar', s.scope FROM roles r
  JOIN (VALUES ('OFICIAL','TODOS'), ('SUBSTITUTA_LEGAL','TODOS'), ('COORDENACAO_SETOR','SETOR'), ('COLABORADOR','PROPRIO')) s(code, scope) ON s.code = r.code;
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'documentos.revisar', 'TODOS' FROM roles r WHERE r.code IN ('OFICIAL','SUBSTITUTA_LEGAL','COORDENACAO_SETOR','COLABORADOR');

-- Autorização temporária da Substituta Legal (Configurações → Gestão documental). Vale para quem tem o perfil SUBSTITUTA_LEGAL
-- enquanto estiver no prazo e não revogada; ao fim do prazo, volta sozinha a "—".
CREATE TABLE approval_delegations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  documents     boolean NOT NULL DEFAULT true,
  projects      boolean NOT NULL DEFAULT true,
  category_ids  uuid[],                      -- NULL = todas as categorias de documento
  starts_on     date NOT NULL,
  ends_on       date,
  reason        text NOT NULL CHECK (length(trim(reason)) >= 5),
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users(id),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CHECK (documents OR projects),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

-- ---------------------------------------------------------------------------
-- Decisões: autoaprovação da Oficial e retirada da submissão
-- ---------------------------------------------------------------------------
ALTER TABLE document_version_reviews DROP CONSTRAINT document_version_reviews_decision_check;
ALTER TABLE document_version_reviews ADD CONSTRAINT document_version_reviews_decision_check CHECK (decision IN ('APROVADA','REJEITADA','RETIRADA'));
ALTER TABLE document_version_reviews DROP CONSTRAINT document_version_reviews_check3;
ALTER TABLE document_version_reviews ADD COLUMN self_approved boolean NOT NULL DEFAULT false;

CREATE FUNCTION fn_document_review_segregation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decided_by IS NOT NULL AND NEW.decided_by = NEW.submitted_by AND NEW.decision <> 'RETIRADA'
     AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.decided_by AND is_owner) THEN
    RAISE EXCEPTION 'Segregação de funções: quem submeteu não decide (exceto a Oficial Registradora).' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_document_review_segregation BEFORE INSERT OR UPDATE OF decided_by, decision ON document_version_reviews
  FOR EACH ROW EXECUTE FUNCTION fn_document_review_segregation();

-- ---------------------------------------------------------------------------
-- Documentos: revisão, exclusão, origem no projeto, conferência da responsável
-- ---------------------------------------------------------------------------
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_status_check
  CHECK (status IS NULL OR status IN ('RASCUNHO','EM_APROVACAO','VIGENTE','OBSOLETO','ARQUIVADO','EXCLUIDO'));
ALTER TABLE documents
  ADD COLUMN in_review              boolean NOT NULL DEFAULT false,
  ADD COLUMN review_round           integer NOT NULL DEFAULT 0,
  ADD COLUMN review_sent_by         uuid REFERENCES users(id),
  ADD COLUMN deleted_at             timestamptz,
  ADD COLUMN deleted_by             uuid REFERENCES users(id),
  ADD COLUMN delete_reason          text,
  ADD COLUMN origin_project_id      uuid REFERENCES projects(id),
  ADD COLUMN responsible_checked_at timestamptz,
  ADD CONSTRAINT ck_documents_excluido CHECK (status IS DISTINCT FROM 'EXCLUIDO'
    OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL AND length(trim(coalesce(delete_reason, ''))) >= 5));

-- Revisoras de cada rodada de revisão (todas devolvem antes de seguir para a Oficial).
CREATE TABLE document_reviewers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES documents(id),
  round         integer NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id),
  assigned_by   uuid NOT NULL REFERENCES users(id),
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  returned_at   timestamptz,
  comment       text,
  cancelled_at  timestamptz,
  task_id       uuid REFERENCES tasks(id),
  UNIQUE (document_id, round, user_id),
  CHECK (returned_at IS NULL OR cancelled_at IS NULL)
);
CREATE INDEX ix_document_reviewers_user ON document_reviewers (user_id) WHERE returned_at IS NULL AND cancelled_at IS NULL;

-- Documentos já gravados com a responsável igual à primeira pessoa da lista (pré-seleção antiga): ficam para conferência
-- da Oficial, um a um. Nada é trocado automaticamente.
UPDATE documents SET responsible_checked_at = now()
 WHERE reference_type = 'REPOSITORIO'
   AND responsible_user_id IS DISTINCT FROM (SELECT id FROM users WHERE status = 'ATIVO' ORDER BY display_name LIMIT 1);

-- ---------------------------------------------------------------------------
-- Projetos: documentos, aprovação do projeto e das fases, conferência do(a) gestor(a)
-- ---------------------------------------------------------------------------
ALTER TABLE projects
  ADD COLUMN approved_at        timestamptz,
  ADD COLUMN approved_by        uuid REFERENCES users(id),
  ADD COLUMN approval_notes     text,
  ADD COLUMN owner_checked_at   timestamptz;
UPDATE projects SET owner_checked_at = now()
 WHERE owner_user_id IS DISTINCT FROM (SELECT id FROM users WHERE status = 'ATIVO' ORDER BY display_name LIMIT 1);
ALTER TABLE project_phases
  ADD COLUMN approved_at    timestamptz,
  ADD COLUMN approved_by    uuid REFERENCES users(id),
  ADD COLUMN approval_notes text;

CREATE TABLE project_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id),
  title          text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  file_id        uuid REFERENCES document_files(id),
  document_id    uuid REFERENCES documents(id),
  added_by       uuid NOT NULL REFERENCES users(id),
  added_at       timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz,
  removed_by     uuid REFERENCES users(id),
  remove_reason  text,
  CHECK (file_id IS NOT NULL OR document_id IS NOT NULL),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE INDEX ix_project_documents_project ON project_documents (project_id);
CREATE UNIQUE INDEX ux_project_documents_doc ON project_documents (project_id, document_id) WHERE document_id IS NOT NULL AND removed_at IS NULL;
