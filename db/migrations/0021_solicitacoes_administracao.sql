-- Solicitações à administração (pedido da Oficial, 02/11/2026): qualquer pessoa abre um pedido livre
-- (declaração, material, ajuste cadastral, assunto pessoal…), acompanha a resposta e conversa com quem atende.
-- Atendem a Oficial e quem tiver a permissão (por padrão, a Substituta Legal; ajustável na matriz).
-- Pedido marcado "somente para a Oficial" não aparece para mais ninguém além de quem pediu.

INSERT INTO permissions (code, module, description, sensitive, scopable) VALUES
  ('solicitacoes.administracao.atender', 'Pessoas', 'Atender solicitações à administração', false, false);
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'solicitacoes.administracao.atender', 'TODOS' FROM roles r WHERE r.code IN ('OFICIAL', 'SUBSTITUTA_LEGAL');

CREATE TABLE admin_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id  uuid NOT NULL REFERENCES users(id),
  category      text NOT NULL CHECK (category IN ('DOCUMENTO', 'MATERIAL', 'CADASTRO', 'PESSOAL', 'SUGESTAO', 'OUTRO')),
  subject       text NOT NULL CHECK (length(trim(subject)) BETWEEN 3 AND 200),
  body          text NOT NULL CHECK (length(trim(body)) BETWEEN 5 AND 5000),
  only_owner    boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'ABERTA' CHECK (status IN ('ABERTA', 'EM_ANDAMENTO', 'ATENDIDA', 'RECUSADA', 'CANCELADA')),
  response      text,
  closed_by     uuid REFERENCES users(id),
  closed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('ATENDIDA', 'RECUSADA') OR (length(trim(coalesce(response, ''))) >= 3 AND closed_by IS NOT NULL))
);
CREATE INDEX ix_admin_requests_requester ON admin_requests (requester_id, created_at DESC);
CREATE INDEX ix_admin_requests_open ON admin_requests (status) WHERE status IN ('ABERTA', 'EM_ANDAMENTO');

CREATE TABLE admin_request_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES admin_requests(id),
  author_id   uuid NOT NULL REFERENCES users(id),
  body        text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 3000),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_admin_request_messages ON admin_request_messages (request_id, created_at);
-- Mensagens são o histórico da conversa: não se alteram nem se apagam.
CREATE TRIGGER trg_admin_request_messages_immutable BEFORE UPDATE OR DELETE ON admin_request_messages FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();
