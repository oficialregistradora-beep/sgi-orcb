-- Anexos nas solicitações à administração e pedido de "Atestado / ausência" (pedido da Oficial, 26/11/2026).
-- A funcionária anexa o arquivo (atestado, declaração, comprovante) logo abaixo da descrição do pedido.
-- No tipo ATESTADO, informa o período; quem tem a permissão de lançar ausências, ao atender, lança a ausência
-- (atestado médico ou falta justificada) e os dias ficam abonados no ponto. O atestado é dado de saúde (LGPD, art. 11):
-- além de quem pediu, só a Oficial e quem atende E pode lançar ausências veem o pedido e o anexo.

ALTER TABLE admin_requests DROP CONSTRAINT admin_requests_category_check;
ALTER TABLE admin_requests ADD CONSTRAINT admin_requests_category_check
  CHECK (category IN ('DOCUMENTO', 'MATERIAL', 'CADASTRO', 'PESSOAL', 'SUGESTAO', 'ATESTADO', 'OUTRO'));
ALTER TABLE admin_requests
  ADD COLUMN absence_start date,
  ADD COLUMN absence_end   date,
  ADD COLUMN absence_id    uuid REFERENCES absences(id),
  ADD CONSTRAINT ck_admin_requests_atestado CHECK (category <> 'ATESTADO' OR (absence_start IS NOT NULL AND absence_end IS NOT NULL AND absence_end >= absence_start));

CREATE TABLE admin_request_files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES admin_requests(id),
  file_id     uuid NOT NULL REFERENCES document_files(id),
  added_by    uuid NOT NULL REFERENCES users(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, file_id)
);
CREATE INDEX ix_admin_request_files ON admin_request_files (request_id);
-- Anexo enviado não se altera nem se apaga (o arquivo segue as regras de retenção dos arquivos documentais).
CREATE TRIGGER trg_admin_request_files_immutable BEFORE UPDATE OR DELETE ON admin_request_files FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();
