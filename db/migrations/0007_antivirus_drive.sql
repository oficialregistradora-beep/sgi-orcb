-- SGI-ORCB — Migration 0007: verificação antivírus dos anexos e armazenamento opcional no Google Drive.

ALTER TABLE document_files
  ADD COLUMN storage        text NOT NULL DEFAULT 'BANCO' CHECK (storage IN ('BANCO','DRIVE')),
  ADD COLUMN drive_file_id  text,
  ADD COLUMN scan_status    text NOT NULL DEFAULT 'NAO_VERIFICADO' CHECK (scan_status IN ('LIMPO','NAO_VERIFICADO')),
  ADD COLUMN scan_engine    text,
  ADD COLUMN scanned_at     timestamptz;

-- Arquivo no banco: conteúdo presente até o descarte. Arquivo no Drive: conteúdo fora do banco, identificado pelo id do Drive.
ALTER TABLE document_files DROP CONSTRAINT document_files_check;
ALTER TABLE document_files ADD CONSTRAINT ck_document_files_storage CHECK (
  (storage = 'BANCO' AND drive_file_id IS NULL AND (data IS NULL) = (purged_at IS NOT NULL))
  OR (storage = 'DRIVE' AND drive_file_id IS NOT NULL AND data IS NULL));
ALTER TABLE document_files ADD CONSTRAINT ck_document_files_scan CHECK ((scan_status = 'LIMPO') = (scanned_at IS NOT NULL AND scan_engine IS NOT NULL));

-- Imutável, exceto: (a) descarte do conteúdo, uma única vez; (b) registro de verificação antivírus posterior.
CREATE OR REPLACE FUNCTION fn_document_file_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Arquivos documentais não podem ser excluídos (somente descarte registrado do conteúdo).' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'Arquivo já descartado.' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.filename, NEW.mime_type, NEW.size_bytes, NEW.sha256, NEW.created_by, NEW.created_at, NEW.storage, NEW.drive_file_id)
     IS DISTINCT FROM (OLD.id, OLD.filename, OLD.mime_type, OLD.size_bytes, OLD.sha256, OLD.created_by, OLD.created_at, OLD.storage, OLD.drive_file_id) THEN
    RAISE EXCEPTION 'Arquivo documental imutável: somente o descarte do conteúdo é permitido.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.purged_at IS NULL THEN
    -- Sem descarte: só a verificação antivírus pode mudar, e o conteúdo permanece o mesmo.
    IF NEW.data IS DISTINCT FROM OLD.data THEN
      RAISE EXCEPTION 'Arquivo documental imutável: somente o descarte do conteúdo é permitido.' USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.data IS NOT NULL THEN
    RAISE EXCEPTION 'Arquivo documental imutável: somente o descarte do conteúdo é permitido.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
