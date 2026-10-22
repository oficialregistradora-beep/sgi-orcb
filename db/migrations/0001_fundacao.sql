-- SGI-ORCB — Migration 0001: fundação (identidade, permissões, auditoria, configurações)
-- Convenções: UUID como chave; timestamptz para instantes; date para competências locais
-- (America/Sao_Paulo); NUMERIC para valores monetários; nomes de domínio em português nos enums.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Funções utilitárias
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Bloqueia UPDATE/DELETE em tabelas imutáveis (marcações, assinaturas, auditoria, razão do banco de horas).
CREATE OR REPLACE FUNCTION fn_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Tabela % é imutável: % não permitido', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Organização
-- ---------------------------------------------------------------------------
CREATE TABLE sectors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{2,20}$'),
  name        text NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  parent_id   uuid REFERENCES sectors(id),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_sectors_touch BEFORE UPDATE ON sectors FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

CREATE TABLE job_titles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  description text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_job_titles_touch BEFORE UPDATE ON job_titles FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Usuários e sessões
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+$'),
  display_name      text NOT NULL CHECK (length(trim(display_name)) > 0),
  google_sub        text UNIQUE,
  status            text NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('ATIVO','SUSPENSO','REVOGADO')),
  is_owner          boolean NOT NULL DEFAULT false,   -- Oficial Registradora (autoridade máxima)
  totp_secret_enc   text,
  totp_enabled_at   timestamptz,
  totp_last_step    bigint,                           -- impede reuso do mesmo código TOTP
  mfa_failed_count  integer NOT NULL DEFAULT 0,
  mfa_locked_until  timestamptz,
  last_login_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_users_email ON users (email);
CREATE UNIQUE INDEX ux_users_single_owner ON users (is_owner) WHERE is_owner;
CREATE TRIGGER trg_users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

CREATE TABLE sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  token_hash       text NOT NULL UNIQUE,              -- SHA-256 do token; o token em si só existe no cookie
  auth_method      text NOT NULL CHECK (auth_method IN ('GOOGLE','DEV')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,              -- limite absoluto
  mfa_verified_at  timestamptz,
  step_up_at       timestamptz,                       -- reautenticação para operações críticas
  ip               text,
  user_agent       text,
  revoked_at       timestamptz,
  revoked_reason   text
);
CREATE INDEX ix_sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Permissões (RBAC com escopo: PROPRIO, SETOR, TODOS)
-- ---------------------------------------------------------------------------
CREATE TABLE permissions (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z_]+(\.[a-z_]+)+$'),
  module      text NOT NULL,
  description text NOT NULL,
  sensitive   boolean NOT NULL DEFAULT false,         -- concessão exige reautenticação e é destacada na UI
  scopable    boolean NOT NULL DEFAULT true           -- false = permissão global (escopo sempre TODOS)
);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z_]{2,40}$'),
  name        text NOT NULL UNIQUE,
  description text,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_roles_touch BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

CREATE TABLE role_permissions (
  role_id          uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code  text NOT NULL REFERENCES permissions(code),
  scope            text NOT NULL CHECK (scope IN ('PROPRIO','SETOR','TODOS')),
  PRIMARY KEY (role_id, permission_code)
);

-- Atribuição de papel a usuário. sector_id define o setor coordenado para permissões de escopo SETOR
-- (nulo = setor de lotação do próprio usuário). Vigência permite substituições temporárias.
CREATE TABLE user_roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  role_id      uuid NOT NULL REFERENCES roles(id),
  sector_id    uuid REFERENCES sectors(id),
  valid_from   date NOT NULL DEFAULT current_date,
  valid_until  date,
  reason       text,
  granted_by   uuid REFERENCES users(id),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES users(id),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);
CREATE INDEX ix_user_roles_user ON user_roles (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Trilha de auditoria — append-only, encadeada por hash SHA-256 (detecção de adulteração)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id               bigserial PRIMARY KEY,
  occurred_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_user_id    uuid,
  actor_session_id uuid,
  action           text NOT NULL,
  entity_type      text NOT NULL,
  entity_id        text,
  summary          text NOT NULL,
  data             jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip               text,
  prev_hash        text NOT NULL,
  hash             text NOT NULL
);
CREATE INDEX ix_audit_entity ON audit_log (entity_type, entity_id);
CREATE INDEX ix_audit_actor ON audit_log (actor_user_id, occurred_at DESC);
CREATE INDEX ix_audit_time ON audit_log (occurred_at DESC);

CREATE OR REPLACE FUNCTION fn_audit_canonical(r audit_log) RETURNS text AS $$
  SELECT concat_ws('|',
    r.id::text,
    to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    coalesce(r.actor_user_id::text, ''),
    coalesce(r.actor_session_id::text, ''),
    r.action, r.entity_type, coalesce(r.entity_id, ''), r.summary,
    r.data::text, coalesce(r.ip, ''), r.prev_hash)
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION fn_audit_chain() RETURNS trigger AS $$
DECLARE
  last_hash text;
BEGIN
  -- Serializa inserções para garantir uma cadeia linear.
  PERFORM pg_advisory_xact_lock(7311001);
  SELECT hash INTO last_hash FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := coalesce(last_hash, repeat('0', 64));
  NEW.occurred_at := clock_timestamp();
  NEW.hash := encode(sha256(convert_to(fn_audit_canonical(NEW), 'UTF8')), 'hex');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fn_audit_chain();
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();
CREATE TRIGGER trg_audit_no_truncate BEFORE TRUNCATE ON audit_log EXECUTE FUNCTION fn_block_mutation();

-- Verificação integral da cadeia: retorna a primeira linha inconsistente (ou nenhuma).
CREATE OR REPLACE FUNCTION fn_audit_verify()
RETURNS TABLE (broken_id bigint, reason text) AS $$
DECLARE
  r audit_log;
  expected_prev text := repeat('0', 64);
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY id LOOP
    IF r.prev_hash <> expected_prev THEN
      broken_id := r.id; reason := 'prev_hash não corresponde ao registro anterior'; RETURN NEXT; RETURN;
    END IF;
    IF r.hash <> encode(sha256(convert_to(fn_audit_canonical(r), 'UTF8')), 'hex') THEN
      broken_id := r.id; reason := 'hash não corresponde ao conteúdo'; RETURN NEXT; RETURN;
    END IF;
    expected_prev := r.hash;
  END LOOP;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Configurações institucionais (chave/valor, alteradas pela Oficial sem modificar código)
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Notificações internas
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text,
  link        text,
  priority    text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('BAIXA','NORMAL','ALTA')),
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_notifications_user ON notifications (user_id, created_at DESC);
