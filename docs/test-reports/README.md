# Relatórios de testes — Fases 1, 2, 2b, 2c e 3

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


---

# Fase 2b — execução de 22/10/2026 (branch `fase-2b`)

| Conjunto | Resultado |
|---|---|
| Unitário (inclui 18 casos novos de férias, plantão e rodízio) | 72/72 |
| Rodada 1 — Funcional (inclui `phase2b.test.ts`, 13 casos) | 43/43 |
| Rodada 2 — Segurança (inclui `phase2b-security.test.ts`, 5 casos) | 30/30 · backup/restauração: contagens idênticas em 41 tabelas, cadeia íntegra |
| Rodada 3 — Simulação (inclui `phase2b-cycle.test.ts`: 55 plantões e 60 chamados em 6 meses + 2 anos de férias) | 10/10 · métricas em [rodada3-fase2b-metricas.json](rodada3-fase2b-metricas.json) |
| Ponta a ponta (Next.js 16.4.2) | 26/26 |
| **Total automatizado** | **155/155 + 26/26** |

```
✓ tests/simulation/six-months.test.ts (7 tests) 5317ms
 ✓ tests/integration/round1/journey-bank.test.ts (18 tests) 1170ms
 ✓ tests/integration/round1/phase2b.test.ts (13 tests) 1052ms
 ✓ tests/simulation/phase2b-cycle.test.ts (3 tests) 1209ms
 ✓ tests/integration/round2/security.test.ts (25 tests) 766ms
 ✓ tests/integration/round2/phase2b-security.test.ts (5 tests) 543ms
 ✓ tests/integration/round1/auth-users.test.ts (12 tests) 525ms
 ✓ tests/unit/security-primitives.test.ts (17 tests) 18ms
 ✓ tests/unit/vacation-oncall.test.ts (18 tests) 16ms
 ✓ tests/unit/journey.test.ts (22 tests) 10ms
 ✓ tests/unit/hourBank.test.ts (15 tests) 9ms
 Test Files  11 passed (11)
      Tests  155 passed (155)
```

## Defeitos encontrados e corrigidos na Fase 2b
| # | Origem | Defeito | Correção |
|---|---|---|---|
| D10 | Unit | O rodízio podia designar a mesma pessoa como responsável e substituta (cursor alterado durante a busca) | Função reescrita sem mutação durante a busca; invariante testada |
| D11 | Unit | Um terceiro período de férias podia deixar saldo impossível de gozar | Regra: o terceiro período deve esgotar o saldo |
| D12 | Revisão de teste | O caso "plantões preservados" era tautológico e apagava dados; revelou que plantões e chamados não tinham proteção no banco | Triggers: plantão fechado imutável, exclusões bloqueadas, chamados só anuláveis; teste significativo |
| D13 | Build | Next.js 16.4.0 com vulnerabilidades críticas publicadas | Atualizado para 16.4.2; `npm audit`: 0 vulnerabilidades; reteste completo |


---

# Fase 2c — execução de 22/10/2026 (branch `fase-2c`)

| Conjunto | Resultado |
|---|---|
| Unitário (inclui 18 casos: faixas do art. 130 nos limites exatos, direito reduzido, prazo e conversão por regra) | 90/90 |
| Rodada 1 — Funcional (inclui `phase2c.test.ts`, 11 casos) | 54/54 |
| Rodada 2 — Segurança (inclui `phase2c-security.test.ts`: concorrência em conferências, rascunhos e validações) | 33/33 |
| Rodada 3 — Simulação (inclui `phase2c-cycle.test.ts`: 1 ano, 5 funcionários, uma faixa do art. 130 cada) | 11/11 · [métricas](rodada3-fase2c-metricas.json) |
| Ponta a ponta | 31/31 |
| **Total automatizado** | **188/188 + 31/31** |

```
✓ tests/simulation/six-months.test.ts (7 tests) 5791ms
 ✓ tests/simulation/phase2c-cycle.test.ts (1 test) 4711ms
 ✓ tests/integration/round1/phase2b.test.ts (13 tests) 1694ms
 ✓ tests/integration/round1/phase2c.test.ts (11 tests) 1382ms
 ✓ tests/integration/round1/journey-bank.test.ts (18 tests) 1209ms
 ✓ tests/simulation/phase2b-cycle.test.ts (3 tests) 1200ms
 ✓ tests/integration/round2/phase2c-security.test.ts (3 tests) 822ms
 ✓ tests/integration/round2/security.test.ts (25 tests) 979ms
 ✓ tests/integration/round2/phase2b-security.test.ts (5 tests) 592ms
 ✓ tests/integration/round1/auth-users.test.ts (12 tests) 563ms
 ✓ tests/unit/security-primitives.test.ts (17 tests) 25ms
 ✓ tests/unit/vacation-oncall.test.ts (18 tests) 22ms
 ✓ tests/unit/hourBank.test.ts (15 tests) 10ms
 ✓ tests/unit/journey.test.ts (22 tests) 10ms
 ✓ tests/unit/phase2c.test.ts (18 tests) 10ms
 Test Files  15 passed (15)
      Tests  188 passed (188)
```

## Defeitos encontrados e corrigidos na Fase 2c
| # | Origem | Defeito | Correção |
|---|---|---|---|
| D14 | Unit | A exigência de um período com 14 dias ou mais era aplicada sem fracionamento, o que recusava férias legítimas em período único (ex.: 18 dias = 12 de gozo + 6 de abono) | A regra só se aplica quando há fracionamento (art. 134, §1º) |
| D15 | Rodada 2 (concorrência) | Duas validações simultâneas de regras com vigências sobrepostas eram aceitas | Restrição de exclusão no banco: uma regra validada por tipo em cada data |
| D16 | E2E (inspeção visual) | Avisos com texto em negrito eram exibidos picados em colunas | Caixa de alerta passou a ser bloco (design system) |
| — | Revisão dos próprios testes | Três casos estavam fracos (um retornava sem testar, um comparava data de forma aproximada, um usava valor inválido com desvio) | Reescritos com afirmações exatas |


---

# Fase 3 — execução de 22/10/2026 (branch `fase-3`)

Escopo: gestão documental (repositório, versões, aprovação, ciência, acesso, ciclo de vida, retenção, arquivos, exportação). Dados 100% fictícios; ambiente local; **sem homologação** pela serventia.

| Conjunto | Resultado |
|---|---|
| Unitário (inclui `phase3.test.ts`, 10 casos: formatos conferidos pelo conteúdo, nomes seguros, regras de acesso por público e confidencialidade) | 100/100 |
| Rodada 1 — Funcional (inclui `phase3.test.ts`, 18 casos: ciclo completo, rejeição, revisão, ciência e cobertura, pesquisa, download, retenção e descarte, confidencialidade) | 72/72 |
| Rodada 2 — Segurança (inclui `phase3-security.test.ts`, 14 casos: imutabilidade no banco, reautenticação, segregação, concorrência de aprovação e submissão, IDOR, revogação, adulteração de conteúdo e de arquivo, cadeia de auditoria) | 47/47 · backup/restauração: contagens idênticas em 50 tabelas, cadeia íntegra |
| Rodada 3 — Simulação (inclui `phase3-cycle.test.ts`: 40 documentos nas 21 categorias, 3 ciclos, 112 versões, 32 rejeições, 326 ciências, 400 verificações de acesso) | 20/20 · [métricas](rodada3-fase3-metricas.json) |
| Ponta a ponta (inclui 11 verificações da Fase 3) | 42/42 |
| **Total automatizado** | **239/239 + 42/42** · `npm audit`: 0 vulnerabilidades |

```
 ✓ tests/simulation/six-months.test.ts (7 tests)
 ✓ tests/simulation/phase2c-cycle.test.ts (1 test)
 ✓ tests/simulation/phase3-cycle.test.ts (9 tests)
 ✓ tests/integration/round1/phase2b.test.ts (13 tests)
 ✓ tests/integration/round1/phase2c.test.ts (11 tests)
 ✓ tests/simulation/phase2b-cycle.test.ts (3 tests)
 ✓ tests/integration/round1/journey-bank.test.ts (18 tests)
 ✓ tests/integration/round2/security.test.ts (25 tests)
 ✓ tests/integration/round2/phase2c-security.test.ts (3 tests)
 ✓ tests/integration/round2/phase3-security.test.ts (14 tests)
 ✓ tests/integration/round1/phase3.test.ts (18 tests)
 ✓ tests/integration/round1/auth-users.test.ts (12 tests)
 ✓ tests/integration/round2/phase2b-security.test.ts (5 tests)
 ✓ tests/unit/security-primitives.test.ts (17 tests)
 ✓ tests/unit/vacation-oncall.test.ts (18 tests)
 ✓ tests/unit/phase3.test.ts (10 tests)
 ✓ tests/unit/phase2c.test.ts (18 tests)
 ✓ tests/unit/hourBank.test.ts (15 tests)
 ✓ tests/unit/journey.test.ts (22 tests)
 Test Files  19 passed (19)
      Tests  239 passed (239)
```

Capturas: [14-repositorio.png](telas/14-repositorio.png), [15-documento-vigente.png](telas/15-documento-vigente.png).

## Ocorrências da Fase 3
Nenhum defeito do sistema foi encontrado pelas rodadas desta fase. As falhas observadas durante a execução foram **dos próprios testes** e estão registradas por transparência:
| Origem | Falha | Causa | Correção |
|---|---|---|---|
| E2E | 2 verificações falharam na primeira execução | Seletores casavam com a opção oculta "Código de Ética"/"Plano de Continuidade" do filtro de categorias | Seletores restritos aos links da tabela |
| Unit | Arquivo ODF de teste recusado | O arquivo fictício não tinha o cabeçalho que separa as entradas de um ODF real | Arquivo de teste corrigido (a validação estava correta) |
| Rodada 3 | Pendências ao fim do ciclo; Substituta "não encontrava" confidencial para arquivar | Roteiro da simulação: limite de tentativas após rejeições e uso da Substituta para documento confidencial que ela, corretamente, não alcança | Roteiro ajustado; a recusa confirmou a regra de confidencialidade |
| Rodada 2 | Teste de CHECK ambíguo (duas restrições violadas ao mesmo tempo) | Cenário mal isolado | Separado em dois casos, com o nome exato da restrição |

Limitações conhecidas (não testadas por não existirem): integração com Google Drive, antivírus de anexos, vigência futura, pré-visualização de PDF.


---

# Fase 3b — antivírus e Google Drive — execução de 22/10/2026 (branch `fase-3b`)

| Conjunto | Resultado |
|---|---|
| Suíte completa (unitário + rodadas 1, 2 e 3) | **258/258** (19 casos novos em `round2/phase3b-antivirus-drive.test.ts`) |
| Antivírus com **ClamAV 1.5.4 real** (clamd por TCP) | limpo aceito e registrado; EICAR recusado, não gravado e auditado; EICAR embutido em arquivo de 300 KB (5 blocos) detectado; antivírus fora do ar → recusa; produção sem antivírus → recusa; verificação no download de arquivo não verificado; aprovação bloqueada para arquivo malicioso antigo |
| Google Drive com **API do Google simulada** (token da conta de serviço com assinatura RS256 conferida) | envio ao Drive compartilhado sem conteúdo no banco; aprovação, download e exportação; adulteração no Drive detectada; Drive indisponível; MD5 divergente → lixeira; chave não reconhecida; descarte → lixeira; proteção do registro no banco |
| Ponta a ponta (antivírus ligado na homologação local) | **45/45** — inclui envio do EICAR pela tela (bloqueado) e a aba *Integrações* |
| `npm audit` | 0 vulnerabilidades |

**Limites honestos desta execução:** a base **oficial** de assinaturas do ClamAV não pôde ser baixada (rede do ambiente de desenvolvimento bloqueia `database.clamav.net`); os testes usaram o mecanismo real com assinaturas **locais** de teste (EICAR por hash e por conteúdo). Em produção, a imagem `clamav/clamav` baixa a base oficial sozinha. O Drive **real** da serventia não foi acessado (depende das credenciais e dos passos do guia `docs/23`).

Capturas: [16-antivirus-bloqueio.png](telas/16-antivirus-bloqueio.png), [17-integracoes.png](telas/17-integracoes.png).
