-- Situação inicial na implantação: funcionários admitidos antes de o sistema existir.
-- 1) Início do controle no sistema: a apuração da jornada começa nesta data (e não na admissão), para não gerar
--    "faltas" em todos os dias anteriores à implantação, em que não há marcações no sistema.
-- 2) Férias gozadas antes da implantação: lançadas como alocações de origem IMPLANTACAO (sem solicitação),
--    para que os períodos aquisitivos já quitados não apareçam como vencidos.

ALTER TABLE employees ADD COLUMN control_start_date date;
ALTER TABLE employees ADD CONSTRAINT ck_employee_control_start CHECK (control_start_date IS NULL OR control_start_date >= admission_date);
COMMENT ON COLUMN employees.control_start_date IS 'Início da apuração no sistema; nulo = desde a admissão';

ALTER TABLE vacation_allocations ALTER COLUMN request_id DROP NOT NULL;
ALTER TABLE vacation_allocations ADD COLUMN source text NOT NULL DEFAULT 'SOLICITACAO' CHECK (source IN ('SOLICITACAO', 'IMPLANTACAO'));
ALTER TABLE vacation_allocations ADD COLUMN note text;
ALTER TABLE vacation_allocations ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE vacation_allocations ADD CONSTRAINT ck_vacation_alloc_source
  CHECK ((source = 'SOLICITACAO' AND request_id IS NOT NULL) OR (source = 'IMPLANTACAO' AND request_id IS NULL AND note IS NOT NULL AND created_by IS NOT NULL));
