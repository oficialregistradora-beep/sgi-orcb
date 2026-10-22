# ADR 0001 — Monólito modular em Next.js + PostgreSQL

**Status:** aceita (sujeita à aprovação da Alternativa A pela serventia — P-02). **Data:** 22/10/2026

**Contexto.** Organização com menos de 20 usuários, sem equipe de TI, que exige baixo custo, auditabilidade e regras trabalhistas testáveis.
**Alternativas.** (a) Monólito Next.js full-stack; (b) frontend Next + backend separado (NestJS/Fastify); (c) microserviços; (d) AppSheet.
**Decisão.** (a): um único container, com regras puras em `src/domain`, serviços em `src/server/modules` e telas em `app/`.
**Consequências.** Um deploy, um pipeline e uma linguagem. A separação modular é por pasta e convenção, e pode ser extraída no futuro se necessário. Risco: acoplamento à evolução do Next.js, mitigado porque a lógica de negócio não depende do framework (os serviços recebem `Ctx` e são testados sem Next).
