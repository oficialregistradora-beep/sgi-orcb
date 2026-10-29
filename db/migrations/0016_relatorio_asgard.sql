-- Relatório XLS para importação no Asgard (livro de despesas da serventia).
-- O modelo é enviado pela própria serventia (exportado do Asgard) e fica guardado aqui; a lista de "Tipos"
-- é lida da aba de configuração do modelo. O sistema preenche o modelo com as despesas pagas no mês.

CREATE TABLE asgard_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename     text NOT NULL,
  content      bytea NOT NULL,
  sha256       text NOT NULL,
  types        text[] NOT NULL CHECK (cardinality(types) > 0),
  uploaded_by  uuid NOT NULL REFERENCES users(id),
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  replaced_at  timestamptz
);
CREATE UNIQUE INDEX ux_asgard_template_current ON asgard_templates ((true)) WHERE replaced_at IS NULL;
CREATE TRIGGER trg_asgard_templates_no_delete BEFORE DELETE ON asgard_templates FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- Correspondência padrão: o tipo do fornecedor prevalece sobre o da categoria.
ALTER TABLE finance_categories ADD COLUMN asgard_type text;
ALTER TABLE suppliers ADD COLUMN asgard_type text;

-- Ajustes por despesa (tipo específico, nº do documento fiscal, nº da autorização prévia).
CREATE TABLE expense_asgard (
  expense_id   uuid PRIMARY KEY REFERENCES expenses(id),
  asgard_type  text,
  fiscal_doc   text CHECK (fiscal_doc IS NULL OR length(fiscal_doc) <= 60),
  prior_auth   text CHECK (prior_auth IS NULL OR prior_auth ~ '^\d{1,15}$'),
  updated_by   uuid NOT NULL REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
