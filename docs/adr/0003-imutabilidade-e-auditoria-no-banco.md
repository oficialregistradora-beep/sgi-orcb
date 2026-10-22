# ADR 0003 — Imutabilidade e trilha de auditoria garantidas no banco

**Decisão.** Marcações, desconsiderações, razão do banco de horas, alocações, versões de documentos, assinaturas, histórico salarial e auditoria recebem triggers que bloqueiam UPDATE/DELETE. Correções são feitas por novos registros (correção aprovada, desconsideração, estorno). A auditoria é encadeada por SHA-256 em trigger (`fn_audit_chain`) e verificável por `fn_audit_verify()`.
**Limite conhecido.** O dono das tabelas pode desabilitar triggers. Mitigação: separação de papéis (`db/roles.sql`; a aplicação usa `sgi_app`, que não é dono) e detecção de adulteração pela cadeia (teste da Rodada 2).
