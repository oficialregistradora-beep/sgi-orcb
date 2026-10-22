-- SGI-ORCB — Migration 0005 (Fase 2c): incorporação do documento "Validação Jurídica — Requisitos do Sistema"
-- (consolidação de 22/10/2026). J-13: redução das férias por faltas (art. 130); J-07/J-14: regras jurídicas com
-- fundamento, fonte, vigência e responsável pela validação; modelos de checklist editáveis e versionados.

-- ---------------------------------------------------------------------------
-- J-13 — Conferência das faltas do período aquisitivo (exigida antes da aprovação das férias)
-- ---------------------------------------------------------------------------
CREATE TABLE vacation_period_reviews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id        uuid NOT NULL REFERENCES employees(id),
  period_start       date NOT NULL,
  unjustified_days   integer NOT NULL CHECK (unjustified_days >= 0),
  entitlement_days   integer NOT NULL CHECK (entitlement_days IN (0, 12, 18, 24, 30)),
  art133_loss        boolean NOT NULL DEFAULT false,      -- perda do direito (art. 133), tratada manualmente
  art133_reason      text,
  calculation        jsonb NOT NULL,                       -- memória de cálculo (datas, classificação, faixa)
  notes              text,
  reviewed_by        uuid NOT NULL REFERENCES users(id),
  reviewed_at        timestamptz NOT NULL DEFAULT now(),
  superseded_at      timestamptz,
  CHECK (NOT art133_loss OR (entitlement_days = 0 AND length(trim(coalesce(art133_reason, ''))) >= 5))
);
CREATE UNIQUE INDEX ux_vacation_review_current ON vacation_period_reviews (employee_id, period_start) WHERE superseded_at IS NULL;
CREATE TRIGGER trg_vacation_review_no_delete BEFORE DELETE ON vacation_period_reviews FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

-- ---------------------------------------------------------------------------
-- J-07 / J-14 — Instrumentos normativos e regras jurídicas parametrizadas por vigência
-- ---------------------------------------------------------------------------
CREATE TABLE legal_instruments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,              -- ex.: registro da CCT no Mediador
  kind         text NOT NULL CHECK (kind IN ('LEI','CCT','ACT','SUMULA','NORMA_INTERNA','OUTRO')),
  title        text NOT NULL,
  valid_from   date,
  valid_until  date,
  status       text NOT NULL CHECK (status IN ('VIGENTE_LEITURA_PENDENTE','VIGENTE_VALIDADO','HISTORICO')),
  source_url   text,
  notes        text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_legal_instruments_touch BEFORE UPDATE ON legal_instruments FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

CREATE TABLE legal_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL CHECK (code IN (
                    'SOBREAVISO_FRACAO','EFETIVO_DSR_FERIADO_ADICIONAL','ADICIONAL_HORA_EXTRA','DIVISOR_SALARIO_HORAS',
                    'BANCO_FATOR_CONVERSAO','BANCO_PRAZO','BANCO_COMUNICACAO_MINIMA','FERIAS_VEDAR_INICIO_FDS_FERIADO')),
  value           jsonb NOT NULL,
  valid_from      date NOT NULL,
  valid_until     date,
  status          text NOT NULL CHECK (status IN ('VALIDADO','PENDENTE_VALIDACAO','HISTORICO_NAO_APLICAR')),
  instrument_id   uuid REFERENCES legal_instruments(id),
  legal_basis     text NOT NULL,                 -- fundamento (artigo, súmula, cláusula)
  source          text NOT NULL,                 -- fonte consultada
  validated_by    text,                          -- responsável pela validação (nome e registro profissional)
  validated_at    date,
  notes           text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_by       uuid REFERENCES users(id),
  closed_at       timestamptz,
  CHECK (valid_until IS NULL OR valid_until >= valid_from),
  CHECK (status <> 'VALIDADO' OR (validated_by IS NOT NULL AND validated_at IS NOT NULL))
);
CREATE INDEX ix_legal_rules_code ON legal_rules (code, valid_from);
-- Garantia no banco (inclusive sob concorrência): uma única regra VALIDADA por tipo em cada data.
ALTER TABLE legal_rules ADD CONSTRAINT ex_legal_rules_validated_overlap
  EXCLUDE USING gist (code WITH =, daterange(valid_from, valid_until, '[]') WITH &&) WHERE (status = 'VALIDADO');

-- Regras não são excluídas nem reescritas: muda-se apenas a situação, a validação ou o fim da vigência.
CREATE OR REPLACE FUNCTION fn_legal_rule_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Regras jurídicas não podem ser excluídas' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.value IS DISTINCT FROM OLD.value OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.legal_basis IS DISTINCT FROM OLD.legal_basis OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.instrument_id IS DISTINCT FROM OLD.instrument_id THEN
    RAISE EXCEPTION 'Conteúdo de regra jurídica é imutável: cadastre nova regra com nova vigência' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'HISTORICO_NAO_APLICAR' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'Regra histórica não pode ser reativada: cadastre nova regra a partir do instrumento vigente' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_legal_rule_guard BEFORE UPDATE OR DELETE ON legal_rules FOR EACH ROW EXECUTE FUNCTION fn_legal_rule_guard();

INSERT INTO legal_instruments (code, kind, title, valid_from, valid_until, status, source_url, notes) VALUES
  ('CLT', 'LEI', 'Consolidação das Leis do Trabalho (Decreto-Lei 5.452/1943)', NULL, NULL, 'VIGENTE_LEITURA_PENDENTE',
   'https://www.planalto.gov.br/ccivil_03/decreto-lei/del5452compilado.htm', 'Fundamento geral; parametrização sujeita à CCT e ao contrato'),
  ('SC000957/2026', 'CCT', 'CCT SINOREG/SC × STCSESC 2026/2027 (inclui Capivari de Baixo na base territorial)', '2026-02-01', '2027-01-31',
   'VIGENTE_LEITURA_PENDENTE', 'https://farolnormativo.com.br/ato/163824',
   'Identificada pela Circular CGFE n. 444/2026. Íntegra não recuperada no Mediador: cláusulas ainda não validadas (J-14)'),
  ('SC001745/2025', 'CCT', 'CCT SINOREG/SC × STCSESC 2025/2026 (anterior)', '2025-02-01', '2026-01-31', 'HISTORICO',
   'https://mediador.trabalho.gov.br/sistemas/mediador/Resumo/ResumoVisualizar?NrSolicitacao=MR037676%2F2025',
   'Regras históricas: não ativar sem confronto com a CCT vigente');

-- Regras de fundamento legal geral: PENDENTES de validação (usadas apenas em estimativas, sempre sinalizadas).
INSERT INTO legal_rules (code, value, valid_from, status, instrument_id, legal_basis, source, notes)
SELECT x.code, x.value::jsonb, '2020-01-01', 'PENDENTE_VALIDACAO', i.id, x.basis, 'Documento de validação jurídica da serventia (22/10/2026)', x.notes
FROM legal_instruments i, (VALUES
  ('SOBREAVISO_FRACAO', '{"numerador":1,"denominador":3}', 'CLT art. 244 §2º (aplicação por analogia); Súmula 428 TST', 'Parâmetro definitivo sujeito à CCT e ao contrato (J-07)'),
  ('EFETIVO_DSR_FERIADO_ADICIONAL', '{"percentual":100}', 'Súmula 146 TST (trabalho em domingos e feriados não compensado: pagamento em dobro)', 'Aplica-se ao trabalho efetivo pago, nunca às horas de espera'),
  ('ADICIONAL_HORA_EXTRA', '{"percentual":50}', 'CF art. 7º, XVI; CLT art. 59 §1º', 'CCT pode prever percentual maior (J-14)'),
  ('DIVISOR_SALARIO_HORAS', '{"horas":200}', 'Súmula 431 TST (jornada de 40 horas semanais)', 'Conferir jornada contratual de cada funcionário'),
  ('BANCO_PRAZO', '{"modo":"MESES","quantidade":6}', 'CLT art. 59 §5º (acordo individual escrito)', 'Sujeito à conferência da CCT vigente')
) AS x(code, value, basis, notes)
WHERE i.code = 'CLT';

-- Regras históricas da CCT anterior: registradas para rastreabilidade, NUNCA aplicadas.
INSERT INTO legal_rules (code, value, valid_from, valid_until, status, instrument_id, legal_basis, source, notes)
SELECT x.code, x.value::jsonb, '2025-02-01', '2026-01-31', 'HISTORICO_NAO_APLICAR', i.id, x.basis, 'CCT SC001745/2025 (Mediador MR037676/2025)', 'Não ativar sem confronto com a CCT SC000957/2026'
FROM legal_instruments i, (VALUES
  ('BANCO_FATOR_CONVERSAO', '{"minutosFolgaPorHora":90}', 'CCT 2025/2026 — banco de horas: 1 hora trabalhada por 1h30 de folga; acordo individual escrito'),
  ('BANCO_PRAZO', '{"modo":"DIAS_APOS_MES","quantidade":90}', 'CCT 2025/2026 — compensação nos 90 dias subsequentes ao mês da acumulação'),
  ('BANCO_COMUNICACAO_MINIMA', '{"horas":48}', 'CCT 2025/2026 — comunicação da folga com 48 horas de antecedência'),
  ('FERIAS_VEDAR_INICIO_FDS_FERIADO', '{"ativo":true}', 'CCT 2025/2026 — início das férias não pode coincidir com sábado, domingo, feriado ou dia de compensação do repouso semanal')
) AS x(code, value, basis)
WHERE i.code = 'SC001745/2025';

INSERT INTO permissions (code, module, description, sensitive, scopable) VALUES
  ('regras.juridicas.gerenciar',   'Administração', 'Cadastrar e validar regras jurídicas e instrumentos (CCT, súmulas)', true, false),
  ('checklists.modelos.editar',    'Pessoas',       'Criar e editar rascunhos de modelos de checklist', false, false),
  ('checklists.modelos.publicar',  'Pessoas',       'Publicar e inativar versões de modelos de checklist', true, false);
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'TODOS' FROM roles r, permissions p
WHERE r.code = 'OFICIAL' AND p.code IN ('regras.juridicas.gerenciar','checklists.modelos.editar','checklists.modelos.publicar');
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'checklists.modelos.editar', 'TODOS' FROM roles r WHERE r.code = 'SUBSTITUTA_LEGAL';

-- ---------------------------------------------------------------------------
-- Modelos de checklist versionados
-- ---------------------------------------------------------------------------
ALTER TABLE checklist_templates DROP CONSTRAINT checklist_templates_name_key;
ALTER TABLE checklist_templates
  ADD COLUMN family_id uuid,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN status text NOT NULL DEFAULT 'PUBLICADO' CHECK (status IN ('RASCUNHO','PUBLICADO','INATIVO')),
  ADD COLUMN created_by uuid REFERENCES users(id),
  ADD COLUMN published_by uuid REFERENCES users(id),
  ADD COLUMN published_at timestamptz;
UPDATE checklist_templates SET family_id = id, published_at = created_at;
ALTER TABLE checklist_templates ALTER COLUMN family_id SET NOT NULL;
ALTER TABLE checklist_templates ADD CONSTRAINT ux_template_family_version UNIQUE (family_id, version);
CREATE UNIQUE INDEX ux_template_one_draft ON checklist_templates (family_id) WHERE status = 'RASCUNHO';

ALTER TABLE checklist_template_items
  ADD COLUMN required boolean NOT NULL DEFAULT false,
  ADD COLUMN evidence_required boolean NOT NULL DEFAULT false,
  ADD COLUMN responsible_role_id uuid REFERENCES roles(id);
ALTER TABLE checklist_template_items DROP CONSTRAINT checklist_template_items_template_id_position_key;
ALTER TABLE checklist_template_items ADD CONSTRAINT ux_template_item_position UNIQUE (template_id, position) DEFERRABLE INITIALLY DEFERRED;

-- Itens dos checklists guardam a cópia das exigências da versão usada (preservação).
ALTER TABLE checklist_items
  ADD COLUMN required boolean NOT NULL DEFAULT false,
  ADD COLUMN evidence_required boolean NOT NULL DEFAULT false,
  ADD COLUMN responsible_role_id uuid REFERENCES roles(id),
  ADD COLUMN evidence text;

-- Itens de modelo só podem ser alterados enquanto a versão estiver em rascunho.
CREATE OR REPLACE FUNCTION fn_template_item_guard() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM checklist_templates WHERE id = coalesce(NEW.template_id, OLD.template_id);
  IF st IS DISTINCT FROM 'RASCUNHO' THEN
    RAISE EXCEPTION 'Itens de modelo publicado ou inativo são imutáveis: crie nova versão' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_template_item_guard BEFORE INSERT OR UPDATE OR DELETE ON checklist_template_items FOR EACH ROW EXECUTE FUNCTION fn_template_item_guard();
