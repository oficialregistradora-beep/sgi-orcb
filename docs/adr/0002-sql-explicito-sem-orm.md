# ADR 0002 — SQL explícito (`pg`) e migrations SQL versionadas, sem ORM

**Status:** aceita. **Contexto.** Imutabilidade, trilha encadeada e restrições jurídicas precisam ser garantidas no próprio banco (triggers, CHECK, EXCLUDE), não só na aplicação.
**Decisão.** Driver `pg`, consultas parametrizadas e migrations `.sql` numeradas com checksum (`src/server/migrate.ts`). Uma migration alterada após aplicada interrompe a execução.
**Consequências.** Menos dependências e SQL auditável por qualquer DBA. Custo: tipagem manual dos resultados.
