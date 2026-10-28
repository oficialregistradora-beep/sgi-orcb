-- Decisão da serventia (homologação, 28/10/2026): a Oficial pode solicitar, aprovar e pagar a mesma despesa.
-- Vale só para a Oficial; para as demais pessoas a segregação continua. Cada ato segue auditado, com a indicação
-- de que a segregação foi dispensada. Alterável somente pela Oficial em Configurações → Parâmetros.
INSERT INTO settings (key, value, description) VALUES
  ('financeiro.oficial_sem_segregacao', 'true',
   'A Oficial pode aprovar e pagar despesas que ela mesma solicitou ou aprovou (dispensa da segregação de funções somente para a Oficial)');

-- A mesma regra vale na camada do banco (defesa em profundidade): a restrição fixa dá lugar a gatilhos que só
-- abrem exceção para a Oficial e enquanto o parâmetro estiver ligado.
CREATE FUNCTION fn_finance_owner_exempt(uid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM users WHERE id = uid AND is_owner)
     AND coalesce((SELECT value = 'true'::jsonb FROM settings WHERE key = 'financeiro.oficial_sem_segregacao'), false)
$$;

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'expenses'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%decided_by <> requested_by%';
  IF c IS NULL THEN RAISE EXCEPTION 'Restrição de segregação em expenses não encontrada.'; END IF;
  EXECUTE format('ALTER TABLE expenses DROP CONSTRAINT %I', c);
END $$;

CREATE FUNCTION fn_expense_decision_segregation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decided_by IS NOT NULL AND NEW.decided_by = NEW.requested_by AND NOT fn_finance_owner_exempt(NEW.decided_by) THEN
    RAISE EXCEPTION 'Segregação de funções: quem solicitou não aprova.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_expense_decision_segregation BEFORE INSERT OR UPDATE OF decided_by, requested_by ON expenses
  FOR EACH ROW EXECUTE FUNCTION fn_expense_decision_segregation();

CREATE OR REPLACE FUNCTION fn_expense_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e expenses%ROWTYPE;
BEGIN
  SELECT * INTO e FROM expenses WHERE id = NEW.expense_id FOR UPDATE;
  IF e.status <> 'APROVADA' THEN
    RAISE EXCEPTION 'Somente despesa aprovada pode ser paga.' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.paid_by = e.requested_by OR NEW.paid_by = e.decided_by) AND NOT fn_finance_owner_exempt(NEW.paid_by) THEN
    RAISE EXCEPTION 'Segregação de funções: quem solicitou ou aprovou não registra o pagamento.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
