# Backup e restauração

## Política proposta
| Camada | Mecanismo | Frequência | Retenção |
|---|---|---|---|
| Cloud SQL | Backup automático gerenciado | Diário | 30 dias |
| Cloud SQL | PITR (logs de transação) | Contínuo | 7 dias |
| Lógico | `pg_dump --format=custom` → Cloud Storage em outra região, bucket com retenção (Bucket Lock) | Semanal | 12 meses (prazo legal a validar — J-09) |
| Verificação | `scripts/backup-restore-test.sh` | **Trimestral** e antes de cada atualização de versão do banco | Relatório arquivado |

Chaves de criptografia de campo (Secret Manager) devem ter cópia sob custódia da Oficial, **separada** dos backups: sem a chave, os campos sensíveis restaurados são ilegíveis.

## Procedimento de restauração
1. PITR (erro humano recente): Cloud SQL → Clonar para um ponto no tempo → validar → apontar `DATABASE_URL` para o clone.
2. Restauração lógica: criar banco vazio com extensões → `pg_restore --no-owner -d <destino> <arquivo>` → `db/roles.sql` → `SELECT * FROM fn_audit_verify()` (deve retornar zero linhas).
3. Conferir as contagens contra o relatório do último backup e registrar o incidente.

## Teste executado (22/10/2026, ambiente local, dados fictícios)
`scripts/backup-restore-test.sh` → dump com hash SHA-256, restauração em banco temporário, **contagens idênticas em 33 tabelas** (Fase 1; 50 tabelas na Fase 3, incluindo os arquivos documentais em bytea; 77 tabelas na Fase 4b) e **cadeia de auditoria íntegra** no banco restaurado. O teste em infraestrutura de nuvem está pendente (depende de P-02).

## Arquivos no Google Drive (se `DOCUMENT_STORAGE=drive`)
Os arquivos gravados no Drive compartilhado **não** fazem parte do dump do banco (o banco guarda o registro, o id no Drive e o SHA-256). A política de backup deve incluir o Drive compartilhado (retenção no Google Vault ou exportação periódica) — decisão pendente da Oficial. Na restauração, os hashes do banco permitem conferir cada arquivo recuperado.
