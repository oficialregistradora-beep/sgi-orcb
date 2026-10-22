# Relatórios de testes — Fases 1 e 2

**Execução:** 22/10/2026 · ambiente local (Node 22.22, PostgreSQL 16.15, Chromium 1194 headless) · dados 100% fictícios · base de código: commit `8ccf487` + alterações deste commit de relatórios.

> Escopo: módulos implementados nas Fases 1–2 (autenticação, permissões, auditoria, pessoas, jornada, banco de horas, solicitações, assinaturas, interface). Módulos das Fases 2b–5 ainda não existem e **não foram testados**. Nenhum teste foi executado em infraestrutura de nuvem, e **não há homologação** pela serventia.

## Resultado consolidado
| Conjunto | Arquivo(s) | Resultado |
|---|---|---|
| Unitário | `tests/unit/*` | 54/54 aprovados |
| Rodada 1 — Funcional | `tests/integration/round1/*` | 30/30 aprovados |
| Rodada 2 — Segurança e integração | `tests/integration/round2/*` + backup/restauração | 25/25 aprovados · restauração aprovada |
| Rodada 3 — Simulação de 6 meses | `tests/simulation/*` | 7/7 aprovados (invariantes) |
| Ponta a ponta (interface) | `tests/e2e/smoke.mjs` | 19/19 verificações aprovadas |
| **Total automatizado** | | **116/116 + 19/19** |

Saída da execução final:
```
 ✓ tests/simulation/six-months.test.ts (7 tests) 7400ms
 ✓ tests/integration/round1/journey-bank.test.ts (18 tests) 1618ms
 ✓ tests/integration/round2/security.test.ts (25 tests) 887ms
 ✓ tests/integration/round1/auth-users.test.ts (12 tests) 540ms
 ✓ tests/unit/security-primitives.test.ts (17 tests) 24ms
 ✓ tests/unit/hourBank.test.ts (15 tests) 14ms
 ✓ tests/unit/journey.test.ts (22 tests) 9ms
 Test Files  7 passed (7)
      Tests  116 passed (116)
   Duration  13.57s (transform 569ms, setup 33ms, collect 1.43s, tests 10.49s, environment 2ms, prepare 526ms)
```

## Defeitos encontrados pelos testes e corrigidos
| # | Rodada | Defeito | Correção | Reteste |
|---|---|---|---|---|
| D1 | Revisão jurídica (antes dos testes) | O esquema permitia resolver HORA_EXTRA como "CIENTE", o que equivaleria a descartar horas trabalhadas | CHECK por tipo: extra → banco ou pagamento; negativa → abono, banco ou falta não justificada | Rodada 1 |
| D2 | 1 | Superar uma ocorrência **já resolvida** (correção posterior) violava a CHECK de status, impedindo o estorno automático do crédito | CHECKs separados (resolvida exige decisão; pendente não tem decisão; superada preserva a decisão) | Rodada 1: aprovado |
| D3 | 1 (unit) | Alocações de débitos **estornados** continuavam consumindo créditos | `buildLots` ignora alocações de débitos estornados | Unit + Rodada 3 |
| D4 | 2 | Contador de falhas do MFA seria desfeito se executado em transação; anti-reuso do TOTP sujeito a corrida | UPDATE condicional atômico; funções em autocommit | Rodada 1 (MFA) |
| D5 | Revisão de código | Server Action de admissão guardava o id criado em variável de módulo (vazamento entre requisições simultâneas) | Variável local | Typecheck + E2E |
| D6 | E2E | 286 px de rolagem horizontal no celular (barra superior) | Barra superior com quebra de linha em telas estreitas | E2E 390 px: 0 px |
| D7 | E2E (inspeção visual) | Alerta do art. 71 disparava para intervalos de 57–59 min (ruído); "marcação ímpar" no dia em curso | Tolerância por marcação aplicada ao intervalo (parâmetro sujeito a J-12); dia em curso sem esse alerta | Unit novo + E2E |
| D8 | E2E | `next start` força NODE_ENV=production, impedindo a homologação com usuários fictícios | `APP_ENV` separado; padrão "producao" recusa o login de teste | Unit (configuração segura) |
| D9 | Matriz de requisitos | Faltava limitação de taxa genérica (§21) | `ratelimit.ts` no login e na API | Unit |

Observação metodológica: nos primeiros testes de imutabilidade da auditoria, os casos "passavam" com a tabela **vazia** (trigger de linha não dispara sem linhas). O teste foi corrigido para gerar eventos reais e passou a verificar que existem linhas afetáveis antes de afirmar o bloqueio.

## Detalhes por rodada
- [Rodada 1 — Funcional](rodada-1-funcional.md)
- [Rodada 2 — Segurança e integração](rodada-2-seguranca.md)
- [Rodada 3 — Simulação operacional](rodada-3-simulacao.md) · métricas: [rodada3-metricas.json](rodada3-metricas.json)
- Capturas de tela da execução ponta a ponta: [telas/](telas/)
