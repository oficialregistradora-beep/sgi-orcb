# Matriz de requisitos (rastreabilidade)

| Requisito (prompt) | Implementação | Teste | Status |
|---|---|---|---|
| §6 Sistema fechado, sem cadastro público | `loginWithGoogleIdentity` | auth-users: "sistema fechado" | Implementado · Testado |
| §6 Login Google Workspace | `src/server/auth/google.ts` | regras de claims (unit/integração) | Implementado · Testado (sem cliente OAuth real: dependente de configuração P-03) |
| §6/§10 MFA | `src/server/auth/mfa.ts`, `totp.ts` | vetores RFC 6238, bloqueio, anti-reuso | Implementado · Testado |
| §6 Sessão, inatividade, revogação imediata | `auth/session.ts` | sessões (rodada 1), desligamento (rodada 2) | Implementado · Testado |
| §6 Dispositivos autorizados | — | — | Planejado (avaliar Endpoint Management do Workspace) |
| §6 RBAC + escopo + menor privilégio | `authz.ts`, migration 0003 | IDOR/escopos (rodada 2) | Implementado · Testado |
| §6 Substituições temporárias | `user_roles.valid_until` | "substituição temporária" | Implementado · Testado |
| §6 Reautenticação em operações críticas | `requireStepUp` | "operações críticas exigem reautenticação" | Implementado · Testado |
| §7 Painéis por perfil | `dashboard.ts`, `/painel` | E2E | Implementado · Testado (E2E) |
| §8.1 Cadastro funcional e sensíveis | `people.ts` | rodadas 1 e 2 | Implementado · Testado |
| §8.2 Admissão / desligamento | `createEmployee`, `terminateEmployee` | rodadas 1, 2, 3 | Implementado (checklists: Pendente) |
| §8.3–8.4 Avaliações e treinamentos | — | — | Planejado (Fase 5) |
| §9 Marcação com horário do servidor | trigger `fn_punch_before_insert` | rodada 2 | Implementado · Testado |
| §9 Correção preservando o original | `requests.ts`, `punch_annulments` | rodada 1 | Implementado · Testado |
| §9.2 Jornada 08–12/13–17 e individuais | migration 0003, `createSchedule` | unit | Implementado · Testado |
| §9.3 Relatórios de frequência | `/jornada`, espelho, `/relatorios` | rodada 3 | Implementado (relatório diário por setor: no painel) |
| §9.4 Enquadramento jurídico | ressalva no espelho e na UI | — | Dependente de validação jurídica (J-01) |
| §10.2 Assinatura simples vinculada ao hash | `documents.ts` | rodadas 1 e 3 | Implementado · Testado |
| §11 Banco de horas completo | `hourbank.ts`, `ledger.ts`, `domain/hourBank.ts` | unit + rodadas 1–3 | Implementado · Testado · parâmetros dependentes de validação jurídica |
| §11.5 Custo estimado | `estimateCost` | unit | Implementado · Testado |
| §11.6 Fechamento e rescisão | `closePeriod`, `terminateEmployee` | rodadas 1 e 3 | Implementado · Testado |
| §12 Plantões RCPN | — | — | Planejado (Fase 2b) |
| §13 Gestão documental + Drive | base de versões/assinaturas | — | Planejado (Fase 3) |
| §14–16 Tarefas, processos, financeiro | — | — | Planejado (Fase 4) |
| §17 Qualidade e conformidade | — | — | Planejado (Fase 5) |
| §18 Calendar, Chat, Gmail | notificações internas | — | Planejado (Fase 4) |
| §19 Identidade visual e design system | `app/globals.css`, `src/ui` | E2E (inclui 390 px) | Implementado |
| §20 Integridade, decimal, fuso | migrations, `domain/time.ts` | unit | Implementado · Testado |
| §21 Controles OWASP ASVS (inclui limitação de taxa) | ver manual de segurança; `ratelimit.ts` | rodada 2 + unit | Implementado · Testado (verificação ASVS formal: Pendente) |
| §22 Notificações | `notifications.ts` | — | Implementado (internas) |
| §24 Três rodadas | `tests/` | relatórios | Executadas para as Fases 1–2 |
| §29 Autonomia da Oficial | telas de Configurações e Permissões | E2E | Implementado para os módulos existentes |
