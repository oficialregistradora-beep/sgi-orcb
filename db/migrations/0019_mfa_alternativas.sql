-- Segundo fator alternativo ao aplicativo autenticador:
-- (1) códigos de reserva de uso único, gerados pela própria pessoa (guardados só como HMAC);
-- (2) código de 6 dígitos enviado ao e-mail pessoal, liberado pela Oficial pessoa a pessoa.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_email_enc text,                 -- e-mail pessoal para códigos (cifrado); NULL = não liberado
  ADD COLUMN IF NOT EXISTS mfa_email_code_hash text,           -- HMAC do código enviado (uso único)
  ADD COLUMN IF NOT EXISTS mfa_email_code_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS mfa_email_code_sent_at timestamptz;

CREATE TABLE IF NOT EXISTS mfa_backup_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  code_hash   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz,
  UNIQUE (user_id, code_hash)
);
CREATE INDEX IF NOT EXISTS ix_mfa_backup_open ON mfa_backup_codes (user_id) WHERE used_at IS NULL;
