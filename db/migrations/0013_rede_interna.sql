-- SGI-ORCB — Migration 0013: restrição de acesso à rede da serventia.
-- Quando ativada, o sistema só é usado a partir dos endereços de internet cadastrados (IP fixo do cartório),
-- com exceções por permissão, por liberação temporária justificada e durante o plantão do RCPN.
-- A Oficial nunca é bloqueada (evita trancar a administração para fora do sistema).

INSERT INTO settings (key, value, description) VALUES
  ('rede.restricao_ativa',     'false', 'Restringe o uso do sistema aos endereços de internet da serventia'),
  ('rede.ips_permitidos',      '[]',    'Endereços (IP fixo) e faixas da serventia permitidos'),
  ('rede.ponto_somente_interno', 'true', 'Marcação de ponto apenas a partir da rede da serventia (quando há endereços cadastrados)'),
  ('rede.plantao_folga_minutos', '60',  'Antes e depois do plantão, por quantos minutos o plantonista pode acessar de fora');

INSERT INTO permissions (code, module, description, sensitive, scopable) VALUES
  ('acesso.externo', 'Administração', 'Usar o sistema fora da rede da serventia quando a restrição estiver ativa', true, false);
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'acesso.externo', 'TODOS' FROM roles r WHERE r.code = 'SUBSTITUTA_LEGAL';

-- Liberações temporárias (ex.: trabalho externo autorizado), sempre com prazo e motivo.
CREATE TABLE network_exceptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  valid_until   timestamptz NOT NULL,
  reason        text NOT NULL CHECK (length(trim(reason)) >= 5),
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users(id),
  CHECK (valid_until > created_at),
  CHECK (valid_until <= created_at + interval '31 days'),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX ix_network_exceptions_user ON network_exceptions (user_id, valid_until) WHERE revoked_at IS NULL;
CREATE TRIGGER trg_network_exceptions_no_delete BEFORE DELETE ON network_exceptions FOR EACH ROW EXECUTE FUNCTION fn_no_delete();
