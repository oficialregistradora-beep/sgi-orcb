-- SGI-ORCB — Migration 0010: integrações com Google Agenda, Gmail e Chat (Fase 4c).
-- O banco é a fonte da verdade. Envios externos saem de uma fila gravada na MESMA transação do fato que os origina
-- (se a operação falhar, nada é enviado; se o Google falhar, a operação não é desfeita) e são reenviados com espera crescente.
-- O calendário é reconciliado a partir do banco (cria, atualiza e remove eventos), sem depender de ganchos em cada módulo.

CREATE TABLE integration_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel          text NOT NULL CHECK (channel IN ('GMAIL','CHAT')),
  event_key        text NOT NULL UNIQUE,              -- idempotência: o mesmo fato nunca gera dois envios
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE','ENVIADO','FALHA','DESCARTADO')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  CHECK ((status = 'ENVIADO') = (sent_at IS NOT NULL))
);
CREATE INDEX ix_outbox_pending ON integration_outbox (next_attempt_at) WHERE status = 'PENDENTE';

-- Vínculo entre um fato do sistema e o evento criado na Agenda Google (para atualizar/remover).
CREATE TABLE calendar_links (
  source_type     text NOT NULL CHECK (source_type IN ('FERIAS','PLANTAO','MARCO','COMPENSACAO','EVENTO')),
  source_id       uuid NOT NULL,
  google_event_id text NOT NULL,
  payload_sha256  text NOT NULL,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_type, source_id)
);

-- Calendário institucional: reuniões, prazos administrativos, treinamentos e demais eventos cadastrados no sistema.
CREATE TABLE institutional_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('REUNIAO','PRAZO','TREINAMENTO','INSTITUCIONAL')),
  title         text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 200),
  description   text,
  start_date    date NOT NULL,
  end_date      date NOT NULL,
  start_time    integer CHECK (start_time IS NULL OR start_time BETWEEN 0 AND 1439),
  end_time      integer CHECK (end_time IS NULL OR end_time BETWEEN 1 AND 1440),
  sector_id     uuid REFERENCES sectors(id),            -- nulo = toda a serventia
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  cancelled_at  timestamptz,
  cancelled_by  uuid REFERENCES users(id),
  CHECK (end_date >= start_date),
  CHECK ((start_time IS NULL) = (end_time IS NULL)),
  CHECK (start_time IS NULL OR start_date < end_date OR end_time > start_time)
);

-- Sincronizações do calendário (resumo, para diagnóstico).
CREATE TABLE calendar_sync_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at  timestamptz NOT NULL DEFAULT now(),
  created     integer NOT NULL DEFAULT 0,
  updated     integer NOT NULL DEFAULT 0,
  deleted     integer NOT NULL DEFAULT 0,
  failed      integer NOT NULL DEFAULT 0,
  detail      text
);

INSERT INTO permissions (code, module, description, sensitive, scopable) VALUES
  ('integracoes.gerenciar', 'Administração', 'Ativar integrações Google, sincronizar e reenviar mensagens', true, false),
  ('agenda.eventos',        'Agenda', 'Cadastrar reuniões, prazos e eventos do calendário institucional', false, false),
  ('chat.avisos',           'Agenda', 'Publicar avisos administrativos no espaço do Google Chat', false, false);

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'TODOS' FROM roles r, permissions p WHERE r.code = 'OFICIAL' AND p.code IN ('integracoes.gerenciar','agenda.eventos','chat.avisos');
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'TODOS' FROM roles r, permissions p WHERE r.code = 'SUBSTITUTA_LEGAL' AND p.code IN ('agenda.eventos','chat.avisos');

-- Tudo desligado por padrão: cada integração é ativada pela administração depois de configurada (P-03).
INSERT INTO settings (key, value, description) VALUES
  ('integracoes.calendar.ativo',        'false', 'Publicar eventos na Agenda Google institucional'),
  ('integracoes.calendar.ferias',       'true',  'Agenda: incluir férias (nome da pessoa e período) — avaliar com o encarregado de dados'),
  ('integracoes.calendar.plantoes',     'true',  'Agenda: incluir plantões RCPN (responsável e substituto)'),
  ('integracoes.calendar.marcos',       'true',  'Agenda: incluir marcos de projetos'),
  ('integracoes.calendar.compensacoes', 'false', 'Agenda: incluir compensações aprovadas do banco de horas (dado pessoal; desligado por padrão)'),
  ('integracoes.calendar.eventos',      'true',  'Agenda: incluir reuniões, prazos e eventos institucionais'),
  ('integracoes.gmail.ativo',           'false', 'Enviar notificações por e-mail institucional (Gmail)'),
  ('integracoes.gmail.somente_alta',    'true',  'E-mail somente para notificações de prioridade alta'),
  ('integracoes.chat.ativo',            'false', 'Publicar avisos administrativos no espaço do Google Chat');
