-- Despesas fixas mensais sem contrato formal (assinaturas, tributos, folha, benefícios…): modelo editável que
-- gera, a cada mês, uma solicitação de despesa junto com as mensalidades dos contratos. Pode ser carregado de uma
-- planilha no formato do Asgard (importação feita pela serventia; os dados não ficam no código).

CREATE TABLE recurring_expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  description     text NOT NULL CHECK (length(trim(description)) >= 3),
  supplier_id     uuid REFERENCES suppliers(id),
  cost_center_id  uuid NOT NULL REFERENCES cost_centers(id),
  category_id     uuid NOT NULL REFERENCES finance_categories(id),
  amount          numeric(14,2) CHECK (amount IS NULL OR amount > 0),   -- nulo = valor a informar (não é lançada)
  due_day         integer NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  asgard_type     text,
  notes           text,
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users(id),
  updated_at      timestamptz
);

ALTER TABLE expenses ADD COLUMN recurring_id uuid REFERENCES recurring_expenses(id);

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'expenses'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%origin%MANUAL%CONTRATO%';
  IF c IS NULL THEN RAISE EXCEPTION 'Restrição de origem em expenses não encontrada.'; END IF;
  EXECUTE format('ALTER TABLE expenses DROP CONSTRAINT %I', c);
END $$;
ALTER TABLE expenses ADD CONSTRAINT ck_expenses_origin CHECK (origin IN ('MANUAL', 'CONTRATO', 'RECORRENTE'));
ALTER TABLE expenses ADD CONSTRAINT ck_expenses_recurring CHECK ((origin = 'RECORRENTE') = (recurring_id IS NOT NULL));
CREATE UNIQUE INDEX ux_expenses_recurring_month ON expenses (recurring_id, competence) WHERE origin = 'RECORRENTE' AND status <> 'CANCELADA';
