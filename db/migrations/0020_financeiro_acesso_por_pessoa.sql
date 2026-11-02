-- Financeiro: ninguém vê nada além do que a Oficial habilitar (decisão de 02/11/2026).
-- O papel continua dizendo O QUE a pessoa pode fazer (ver, solicitar, aprovar, pagar, cadastrar);
-- ONDE ela pode fazer passa a ser só: (a) todo o financeiro — "administração" — ou (b) os centros de custo habilitados.
-- A Oficial vê sempre tudo. Quem não tiver habilitação não vê o módulo.

ALTER TABLE users ADD COLUMN IF NOT EXISTS finance_all boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS finance_access (
  user_id         uuid NOT NULL REFERENCES users(id),
  cost_center_id  uuid NOT NULL REFERENCES cost_centers(id),
  granted_by      uuid REFERENCES users(id),
  granted_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, cost_center_id)
);
CREATE INDEX IF NOT EXISTS ix_finance_access_cc ON finance_access (cost_center_id);
