# Plano de testes

## Níveis e comandos
| Nível | Escopo | Comando |
|---|---|---|
| Unitário | Regras de domínio (jornada, tolerância, alertas, PEPS, vencimento, custo), criptografia, TOTP (vetores RFC), tempo/fuso, limitação de taxa, configuração segura | `npm run test:unit` |
| Rodada 1 — Funcional | Autenticação, sessões, MFA, usuários, papéis e vigências, admissão, marcação, apuração, ocorrências, banco, correções, compensações, autorização prévia, vencimento e pagamento, espelho assinado, fechamento | `npm run test:round1` |
| Rodada 2 — Segurança/integração | Imutabilidade no banco, horário do servidor, detecção de adulteração da auditoria, IDOR/escopos, dados sensíveis cifrados e fora da auditoria, segregação de funções, reautenticação, concorrência (cliques, créditos, decisões), revogação no desligamento, imutabilidade do razão; backup/restauração (`scripts/backup-restore-test.sh`) | `npm run test:round2` |
| Rodada 3 — Simulação operacional | Seis meses de operação fictícia pelos serviços reais, com invariantes verificadas por recálculo independente | `npm run test:round3` |
| Ponta a ponta (UI) | Fluxos de todos os módulos por perfil, bloqueios, CSRF, CSP, celular (390 px) | `node tests/e2e/smoke.mjs` (servidor em execução, seed recém-aplicado) |
| Sondagem de segurança | Todas as rotas sem sessão, cabeçalhos, cookie, logout, CSRF, IDOR em todos os módulos, erros 5xx | `node tests/e2e/security-probe.mjs` |
| Matriz de perfis | Todas as consultas de todos os módulos × todos os perfis, sobre a carga completa | `npx vitest run tests/integration/round2/phase6-role-matrix.test.ts` |
| Sistema inteiro | Rotina diária completa idempotente; hashes de versões, assinaturas e arquivos; auditoria | `npx vitest run tests/simulation/phase6-system.test.ts` |
| Acessibilidade | axe-core, WCAG 2.1 A/AA, todas as telas (claro, escuro, celular) e telas de detalhe | `node tests/e2e/a11y.mjs` |
| Carga | Equipe inteira simultânea (3 navegações por pessoa) | `node --experimental-strip-types scripts/load-test.ts <url> 10 3` |

Os testes de integração usam o banco `sgi_test`, recriado a cada arquivo; todos os dados são fictícios (domínio `cartorio-teste.example`).

## Critérios objetivos de aprovação
100% dos testes automatizados aprovados; cadeia de auditoria íntegra; nenhuma violação de CSP; nenhuma rota interna sem autenticação; nenhuma recusa com erro 5xx; invariantes da Rodada 3 satisfeitas; restauração com contagens idênticas; 0 violações graves de acessibilidade; carga sem erros com p95 abaixo de 1 s.

## Testes de aceite (homologação humana — pendente)
Roteiro completo de todos os módulos: [25-roteiro-homologacao.md](25-roteiro-homologacao.md). Resumo da jornada:
Roteiro para a Oficial/Substituta: (1) admitir funcionário fictício; (2) marcar 4 pontos; (3) pedir e aprovar correção; (4) decidir extra para o banco e diferença por abono; (5) pedir e aprovar compensação; (6) gerar, assinar e aprovar o espelho; (7) fechar a competência; (8) suspender usuário e confirmar o bloqueio; (9) verificar a cadeia de auditoria. Registrar o aceite por escrito.
