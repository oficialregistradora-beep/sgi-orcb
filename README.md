# SGI-ORCB — Sistema de Gestão Integrada

Ofício de Registros de Capivari de Baixo/SC — software **privado e de uso interno** (gestão de pessoas, jornada, banco de horas, solicitações e assinaturas; demais módulos planejados por fases).

> Não substitui livros, protocolos, centrais ou sistemas registrais oficiais. O controle de jornada é **administrativo interno** (não é REP — Portaria MTP 671/2021).

## Situação (22/10/2026)
| Fase | Situação |
|---|---|
| 1 — Fundação (autenticação Google + TOTP, sessões, permissões, auditoria encadeada, design system) | Implementado · Testado |
| 2 — Pessoas, jornada, banco de horas, solicitações, espelho/extrato assinados | Implementado · Testado (plantões, solicitação de férias e checklists: pendentes) |
| 3–5 — Documental, tarefas/projetos/processos, financeiro, qualidade, BI | Planejado |
| Homologação pela serventia · validação jurídica · produção | **Pendentes** |

## Comandos
```bash
npm ci && cp .env.example .env    # configurar
npm run db:migrate && npm run db:seed   # seed: somente dados fictícios
npm run build && npm run start
npm test                          # unitários + rodadas 1, 2 e 3
node tests/e2e/smoke.mjs          # ponta a ponta (servidor em execução)
```

## Estrutura
`app/` telas, Server Actions e API · `src/domain` regras puras · `src/server` serviços, segurança e banco · `src/ui` design system · `db/migrations` SQL versionado · `tests/` · `docs/` (comece por [docs/README.md](docs/README.md) e [docs/01-entrega-1-planejamento.md](docs/01-entrega-1-planejamento.md)).
