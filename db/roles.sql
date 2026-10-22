-- Separação de privilégios em produção (executar uma vez, como administrador do banco).
-- sgi_owner: dono do esquema, usado SOMENTE para migrations. sgi_app: usado pela aplicação, sem DDL.
-- Como sgi_app não é dono das tabelas, não consegue desabilitar os triggers de imutabilidade.
-- CREATE ROLE sgi_owner LOGIN PASSWORD '<segredo>';
-- CREATE ROLE sgi_app LOGIN PASSWORD '<segredo>';
GRANT USAGE ON SCHEMA public TO sgi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sgi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sgi_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO sgi_app;
-- Tabelas append-only: a aplicação não precisa de UPDATE/DELETE (o trigger já bloqueia; aqui reforça).
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log, time_punches, punch_annulments, hour_bank_entries,
  hour_bank_allocations, signatures, document_versions, salary_history FROM sgi_app;
ALTER DEFAULT PRIVILEGES FOR ROLE sgi_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sgi_app;
