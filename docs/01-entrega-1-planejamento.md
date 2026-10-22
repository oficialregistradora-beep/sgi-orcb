# Entrega 1 — Análise Técnica e Planejamento

**Projeto:** SGI-ORCB — Sistema de Gestão Integrada do Ofício de Registros de Capivari de Baixo/SC
**Data da análise:** 22/10/2026
**Situação deste documento:** proposta técnica, **pendente de aprovação da Oficial Registradora**.

> Convenção de status utilizada em toda a documentação:
> **Implementado** · **Testado** (testes automatizados executados) · **Homologado** (aprovado pela serventia) ·
> **Pendente** · **Dependente de configuração** · **Dependente de validação jurídica** · **Planejado (versão futura)**.
> Nenhum item está *Homologado* nesta data: a homologação depende da administração da serventia.

---

## 1. Diagnóstico do problema e requisitos

### 1.1 Situação atual
- Serventia com menos de 20 trabalhadores, quatro atribuições (RI, RCPN com Livro E, RTD, RCPJ) e cinco setores.
- Já possui Google Workspace com domínio próprio (edição contratada **não informada** — ver P-01).
- Não há repositório nem sistema anterior: o projeto começa do zero, sem dados a migrar.
- Os controles hoje estão, presumivelmente, espalhados entre planilhas, papel e e-mail. Não há trilha de auditoria única, assinatura vinculada a conteúdo nem um banco de horas apurado por regras parametrizadas.

### 1.2 Problemas centrais a resolver
1. **Risco trabalhista**: jornada, banco de horas, sobreaviso e compensações sem rastreabilidade expõem a serventia a passivo.
2. **Risco de conformidade**: o Provimento CNJ nº 74/2018 e os normativos posteriores, o PQTA e a LGPD exigem evidências (políticas, treinamentos, incidentes, backups) que hoje não estão centralizadas.
3. **Gestão**: falta uma visão consolidada de tarefas, projetos, despesas e indicadores.
4. **Custo**: a solução precisa ter custo recorrente mínimo e não depender de um fornecedor específico.

### 1.3 Requisitos críticos (não negociáveis)
| ID | Requisito | Origem |
|----|-----------|--------|
| RC-01 | Sistema fechado: sem cadastro público ou acesso anônimo; usuários pré-cadastrados | Prompt §6 |
| RC-02 | Autenticação Google Workspace com restrição ao domínio institucional + MFA | §6, §10 |
| RC-03 | Autorização verificada **no servidor**, por função, setor e recurso (menor privilégio) | §6, §21 |
| RC-04 | Marcações de jornada imutáveis: uma correção nunca apaga o registro original | §9.1 |
| RC-05 | Banco de horas sem descontos automáticos e sem descartar horas extras não autorizadas | §11 |
| RC-06 | Assinatura vinculada ao hash da versão exata; ciência ≠ aprovação ≠ concordância | §10.2 |
| RC-07 | Trilha de auditoria à prova de adulteração | §20, §21 |
| RC-08 | Valores monetários em `NUMERIC`; tempo tratado em America/Sao_Paulo | §20 |
| RC-09 | Dados pessoais sensíveis criptografados e com acesso restrito | §8.1, §21 |
| RC-10 | O sistema **não** substitui livros, protocolos, centrais nem sistemas oficiais; não faz qualificação registral | §15 |
| RC-11 | O controle de jornada é identificado como **controle administrativo interno**, e não como REP-P, até se demonstrar o contrário | §9.4 |

---

## 2. Comparação das três arquiteturas

### Alternativa A — Aplicação web própria (Next.js + PostgreSQL) em nuvem gerenciada
- **Prós:** controle total das regras trabalhistas e de auditoria; código e dados portáveis (PostgreSQL padrão, container OCI); integração Google via OIDC/APIs oficiais; custo de infraestrutura baixo e praticamente independente do número de usuários.
- **Contras:** exige manutenção por um desenvolvedor (atualizações de dependências, correções); responsabilidade própria pela segurança da aplicação.

### Alternativa B — Google AppSheet
- **Licença:** o AppSheet Core vem incluído nas edições Business Starter, Standard e Plus do Workspace, desde que o domínio esteja verificado ([anúncio Google, 2023](https://workspaceupdates.googleblog.com/2023/07/appsheet-core-licenses-included-by-default-for-more-google-workspace-editions.html); [Xebia, 2026](https://xebia.com/blog/appsheet-is-now-available-in-google-workspace/)). **Confirmar no Admin Console da serventia (P-01).**
- **Limitações contra os requisitos críticos:**
  - RC-04/RC-07: com dados em Planilhas Google, o proprietário da planilha pode editá-la diretamente, sem trilha. Não há imutabilidade nem auditoria encadeada.
  - RC-06: não há assinatura com hash do conteúdo, manifestação expressa e evidência de autenticação vinculadas.
  - RC-09: não há criptografia por campo; os arquivos no Drive seguem as permissões do Drive, e não as do app.
  - RC-05: as regras de banco de horas (vencimento FIFO, tolerância do art. 58 §1º, ocorrências pendentes de análise) ficam difíceis de expressar e de testar.
  - Testes automatizados, controle de versão e as três rodadas de testes exigidas são precários.
- **Conclusão:** serve para formulários simples complementares, mas **não atende ao núcleo** (jornada, banco de horas, assinaturas e auditoria).

### Alternativa C — Aplicação instalada localmente (servidor na serventia)
- **Prós:** sem mensalidade de nuvem; dados fisicamente na serventia.
- **Contras:** investimento inicial em servidor, nobreak e licenças; risco físico (incêndio, furto, ransomware) concentrado no mesmo local do acervo; exige VPN para acesso remoto e plantões; backup externo obrigatório (que é um custo de nuvem de qualquer modo); patches de sistema operacional e de banco de dados ficam a cargo da serventia; disponibilidade depende da energia e do link local.
- **Conclusão:** maior custo total e maior risco operacional para uma equipe sem profissional de TI dedicado.

### 2.1 Quadro comparativo (1 = pior, 5 = melhor)
| Critério | A — Web própria | B — AppSheet | C — Local |
|---|:-:|:-:|:-:|
| Custo inicial | 4 | 5 | 1 |
| Custo mensal de infraestrutura | 4 | 5 | 3 |
| Custo de manutenção | 3 | 4 | 2 |
| Licenças adicionais | 5 | 4 (depende da edição) | 3 |
| Segurança (requisitos RC) | 5 | 2 | 3 |
| Backup e recuperação | 5 (gerenciado + PITR) | 3 | 2 |
| Escalabilidade | 5 | 3 | 2 |
| Facilidade de atualização | 4 (deploy por container) | 5 | 2 |
| Facilidade de operação | 4 | 5 | 2 |
| Integração Google Workspace | 5 | 5 | 3 |
| Dependência de terceiros | 4 (portável) | 1 (lock-in) | 4 |
| Disponibilidade | 4 | 5 | 2 |
| Recuperação de incidentes | 5 | 3 | 2 |
| Custo de migração futura | 5 (PostgreSQL/OCI padrão) | 1 | 4 |
| **Atende aos requisitos críticos** | **Sim** | **Não** | Sim, com custo/risco maior |

---

## 3. Recomendação

**Alternativa A**, com a seguinte composição, toda na região **southamerica-east1 (São Paulo)** para manter os dados no Brasil:

- **Google Cloud Run**: um único container (monólito modular Next.js), escalando de 0 a 2 instâncias.
- **Cloud SQL para PostgreSQL**: a menor instância, com backups automáticos diários e recuperação a um ponto no tempo (PITR).
- **Cloud Storage**: arquivos anexos e exportações de backup lógico.
- **Secret Manager**: chaves de criptografia de campo, segredo OAuth e chave de sessão.
- **Google Workspace** (já contratado): login OIDC, Drive, Calendar, Chat e Gmail, conforme a Fase 3–4.

A arquitetura é portável: o mesmo container e o mesmo PostgreSQL rodam em qualquer VPS ou servidor local (Docker Compose incluído). Isso reduz o custo de saída caso a serventia queira migrar no futuro.

**Variante de custo mínimo** (pendente de decisão, P-02): uma única VM pequena com Docker Compose (aplicação + PostgreSQL) e backup para o Cloud Storage. Custa menos, mas transfere à serventia a responsabilidade por patches do sistema operacional e do banco. Não é a recomendação principal.

---

## 4. Estimativa de custos

**Premissas:** preços públicos consultados em 10/2026, sujeitos a confirmação na calculadora oficial antes da contratação; câmbio de referência **US$ 1 = R$ 5,50** (premissa, não cotação). Nenhuma hospedagem foi presumida gratuita: os níveis gratuitos aparecem como redução **possível**, não garantida.

Referências: [Cloud Run pricing](https://cloud.google.com/run/pricing) (cota mensal gratuita de vCPU-s, GiB-s e requisições; a região São Paulo é Tier 2) · Cloud SQL db-f1-micro em São Paulo: fontes de terceiros divergem entre ~US$ 12 e ~US$ 38/mês ([Bytebase](https://www.bytebase.com/dbcost/cloudsql/instance/db-f1-micro/), [Spare Cores](https://sparecores.com/database/gcp/db-f1-micro)) · [Cloud Storage pricing](https://cloud.google.com/storage/pricing) (Standard São Paulo ≈ US$ 0,035/GB-mês).

### 4.1 Alternativa A — infraestrutura mensal (US$)
| Item | 10 usuários | 20 usuários | 30 usuários | Observação |
|---|---:|---:|---:|---|
| Cloud Run (aplicação) | 0 – 5 | 0 – 8 | 0 – 12 | Pode ficar dentro da cota gratuita; com instância mínima = 1 (sem partida a frio às 8h), **+US$ 10–20** |
| Cloud SQL PostgreSQL (computação) | 12 – 38 | 12 – 38 | 12 – 38 | Menor instância; não varia com o número de usuários nessa faixa |
| Cloud SQL — 10 GB SSD + backups + PITR | 3 – 6 | 3 – 6 | 4 – 8 | |
| Cloud Storage (anexos + backups lógicos, ~20–60 GB) | 1 – 2 | 1 – 2 | 2 – 3 | |
| Secret Manager, Artifact Registry, Logging | 0 – 2 | 0 – 2 | 0 – 2 | Em geral, dentro das cotas gratuitas |
| Domínio | 0 | 0 | 0 | Já existente |
| Licenças de software | 0 | 0 | 0 | Todas as dependências são open source (inventário em `docs/19-inventario-dependencias.md`) |
| **Total infraestrutura/mês** | **16 – 53** | **16 – 56** | **18 – 63** | |
| **Em R$/mês (premissa de câmbio)** | **≈ 90 – 290** | **≈ 90 – 310** | **≈ 100 – 350** | |
| **Em R$/ano** | **≈ 1.060 – 3.500** | **≈ 1.060 – 3.700** | **≈ 1.190 – 4.160** | |

### 4.2 Custos não relacionados à infraestrutura (valem para A e C)
| Item | Estimativa | Natureza |
|---|---|---|
| Manutenção evolutiva e corretiva (dev. terceirizado, 4–8 h/mês) | R$ 400 – 1.600/mês | Variável; é o **maior custo real** do projeto |
| Monitoramento | R$ 0 (Cloud Monitoring, cota gratuita) | |
| Testes de restauração trimestrais | ~2 h/trimestre | Interno ou terceirizado |
| Validação jurídica (trabalhista/LGPD) | Por demanda | Ver seção 9 |

### 4.3 Comparativo anual consolidado (20 usuários, R$)
| | A — Web própria | B — AppSheet | C — Local |
|---|---:|---:|---:|
| Investimento inicial | 0 (sem hardware) | 0 | 8.000 – 15.000 (servidor, nobreak, licenças) |
| Infraestrutura/ano | 1.060 – 3.700 | 0 (se Core incluso) – custo de Cloud SQL, se usado | 600 – 1.800 (backup externo, VPN, energia) |
| Manutenção/ano | 4.800 – 19.200 | 1.200 – 6.000 | 6.000 – 24.000 (inclui SO/hardware) |
| **Atende ao núcleo?** | **Sim** | **Não** | Sim |

> O custo de infraestrutura é praticamente **fixo** entre 10 e 30 usuários, porque a carga de uma serventia desse porte é muito inferior à capacidade mínima de qualquer instância.

---

## 5. Arquitetura proposta

```
 Navegador (computador do funcionário)
        │  HTTPS (TLS 1.2+)
        ▼
 ┌───────────────────────── Cloud Run (container único) ─────────────────────────┐
 │  Next.js (App Router) — monólito modular                                       │
 │  ├─ app/ (telas, Server Components, Server Actions, rotas /api/v1)            │
 │  ├─ src/server/auth      (OIDC Google, sessões, TOTP, step-up)                 │
 │  ├─ src/server/authz     (RBAC + escopo por setor/recurso + delegações)        │
 │  ├─ src/server/audit     (trilha encadeada por hash SHA-256)                  │
 │  ├─ src/server/modules/* (pessoas, jornada, banco de horas, solicitações,     │
 │  │                        assinaturas, documentos, tarefas, financeiro…)      │
 │  └─ src/domain/*         (regras puras: cálculo de jornada e banco de horas)  │
 └───────────────┬───────────────────────┬───────────────────────────────────────┘
                 │ SQL (TLS, IAM/privado)│ HTTPS (OAuth, escopos mínimos)
                 ▼                       ▼
       Cloud SQL PostgreSQL 16     Google Workspace APIs
       (backups + PITR)            (Identity, Drive, Calendar, Chat, Gmail)
                 │
                 ▼
       Cloud Storage (anexos; exportações de backup lógico)
```

**Princípios adotados**
- **Monólito modular**: um único deploy, com módulos isolados por pasta e sem acesso cruzado às tabelas de outro módulo fora de serviços. Não há microserviços.
- **Regras de negócio puras** em `src/domain`, sem I/O, testadas unitariamente. Os cálculos trabalhistas são os que mais exigem testes.
- **Autorização no servidor** em toda leitura e escrita (`requirePermission`). A interface apenas oculta o que o servidor já bloqueia.
- **SQL explícito** (`pg` + migrations SQL versionadas), sem ORM, o que reduz dependências e facilita auditoria e manutenção futuras.
- **Imutabilidade garantida no banco** (triggers): marcações, trilha de auditoria e assinaturas não aceitam `UPDATE`/`DELETE`.

Decisões detalhadas em `docs/adr/`.

---

## 6. Matriz de módulos

| # | Módulo | Fase | Status nesta data |
|---|---|:-:|---|
| 1 | Autenticação (Google OIDC + TOTP + sessões + step-up) | 1 | Implementado; Google depende de configuração (P-03) |
| 2 | Usuários, setores, cargos, permissões, delegações | 1 | Implementado |
| 3 | Trilha de auditoria encadeada | 1 | Implementado |
| 4 | Design system e telas-base | 1 | Implementado (base) |
| 5 | Cadastro funcional (pessoas) | 2 | Implementado (núcleo); admissão/desligamento com checklist: parcial |
| 6 | Jornada e frequência (controle administrativo interno) | 2 | Implementado |
| 7 | Banco de horas | 2 | Implementado; parâmetros dependem de validação jurídica |
| 8 | Solicitações e aprovações | 2 | Implementado (correções de ponto, compensações, tratamento de ocorrências) |
| 9 | Assinatura eletrônica simples (espelho, extrato) | 2 | Implementado para espelho mensal e extrato do banco |
| 10 | Férias e afastamentos | 2 | Afastamentos/férias como eventos de calendário: implementado; fluxo de solicitação de férias: pendente |
| 11 | Plantões e sobreaviso (RCPN) | 2 | Planejado (próxima iteração) |
| 12 | Gestão documental + Google Drive | 3 | Planejado |
| 13 | Tarefas, projetos (Kanban/Gantt), processos e rotinas | 4 | Planejado |
| 14 | Financeiro gerencial | 4 | Planejado |
| 15 | Calendário e notificações (Calendar/Chat/Gmail) | 4 | Notificações internas: implementado (base); Google: planejado |
| 16 | Qualidade, conformidade, riscos, incidentes | 5 | Planejado |
| 17 | Treinamentos e avaliações de desempenho | 5 | Planejado |
| 18 | Dashboards e indicadores | 5 | Painel inicial por perfil: implementado (jornada/banco); demais: planejado |

---

## 7. Modelo inicial de banco de dados

O modelo completo, com dicionário de dados, está em `docs/05-modelo-de-dados.md`, e o DDL executável em `db/migrations/`. Entidades principais da Fase 1–2:

```
sectors ─┐            roles ── role_permissions ── permissions
         │              │
job_titles              user_roles (escopo por setor, vigência)
   │                    │
employees ── users ── sessions / totp / delegations
   │   └── employee_sensitive (criptografado) · salary_history (restrito)
   │
   ├── work_schedules ── work_schedule_days
   ├── employee_schedule_assignments (vigência)
   ├── hour_bank_agreements (acordo individual/coletivo, prazo em meses)
   ├── absences (férias, afastamentos, folgas)          holidays
   ├── time_punches (IMUTÁVEL) ── punch_annulments
   ├── daily_occurrences (extra/falta pendentes de análise)
   ├── hour_bank_entries (razão: crédito, compensação, pagamento, ajuste)
   └── requests ── request_approvals (correção de ponto, compensação…)

documents ── document_versions (hash SHA-256) ── signatures (IMUTÁVEL)
audit_log (IMUTÁVEL, encadeado por hash) · notifications · settings
```

---

## 8. Matriz inicial de permissões

Detalhada e configurável em `docs/06-matriz-de-permissoes.md` e na tela **Permissões**. Resumo (escopos: **T** = todos, **S** = setor sob coordenação, **P** = próprio, — = sem acesso):

| Permissão | Oficial | Substituta Legal | Escrevente Substituta | Escrevente | Atendente | Aux. serviços gerais |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Registrar o próprio ponto | P | P | P | P | P | P |
| Ver jornada / banco de horas | T | T | S | P | P | P |
| Aprovar correções de ponto | T | T | S¹ | — | — | — |
| Aprovar compensações / tratar ocorrências | T | T | — | — | — | — |
| Cadastro funcional (leitura) | T | T | S | P | P | P |
| Cadastro funcional (edição) | T | T¹ | — | — | — | — |
| Dados sensíveis / salário | T | —¹ | — | — | — | — |
| Usuários e permissões | T | —¹ | — | — | — | — |
| Trilha de auditoria | T | —¹ | — | — | — | — |
| Configurações (jornadas, feriados, acordos) | T | T¹ | — | — | — | — |

¹ Delegável pela Oficial, com vigência, sem alterar código.

---

## 9. Requisitos jurídicos pendentes de validação

A matriz completa, com status, está em `docs/22-matriz-conformidade.md`. Pontos críticos:

| ID | Questão | Decisão provisória no sistema | Status |
|---|---|---|---|
| J-01 | Enquadramento do controle de jornada (CLT art. 74 §2º; Portaria MTP 671/2021) | Identificado como **controle administrativo interno**. Não se declara REP-P. O espelho traz essa ressalva | Dependente de validação jurídica |
| J-02 | Convenção coletiva aplicável (sindicato da categoria em SC) | Parâmetros do banco de horas configuráveis; nenhum valor de CCT foi presumido | Pendente (documento não fornecido) |
| J-03 | Banco de horas por acordo individual escrito, com compensação em até 6 meses (CLT art. 59 §5º) | Prazo padrão de 6 meses, configurável por acordo; exige acordo cadastrado e vigente | Dependente de validação jurídica |
| J-04 | Tolerância de 5 min por marcação, limitada a 10 min diários (CLT art. 58 §1º; Súmula 366 TST) | Implementado como parâmetro ativo, que pode ser desligado | Dependente de validação jurídica |
| J-05 | Horas não compensadas no prazo (CLT art. 59 §3º) | O sistema **não** apaga créditos vencidos: marca-os "vencido — requer pagamento/análise" | Dependente de validação jurídica |
| J-06 | Saldos negativos | **Nunca** são debitados automaticamente; viram ocorrência para análise | Dependente de validação jurídica |
| J-07 | Sobreaviso no RCPN (CLT art. 244 §2º por analogia; Súmula 428 TST) e gratificações | Cálculos separados; parâmetros em regras com vigência (Fase 2c) | Fundamento geral confirmado; parâmetros dependem da CCT |
| J-08 | Assinatura eletrônica simples (Lei 14.063/2020, art. 4º, I) nos documentos administrativos listados | Usada apenas em atos internos; assinatura avançada ou qualificada não é substituída | Dependente de validação jurídica |
| J-09 | Prazos de retenção (trabalhista, previdenciário, LGPD) | Retenção configurável por tipo; padrão provisório de 5 anos após o desligamento, sem expurgo automático | Dependente de validação jurídica |
| J-10 | Bases legais LGPD e RIPD para dados de funcionários | Inventário de dados em `docs/10-manual-seguranca.md` | Pendente (encarregado/DPO) |
| J-11 | Provimento CNJ nº 74/2018 e normativos posteriores; Código de Normas da CGJ/SC | Funcionalidades de apoio (Fase 5); nenhuma conformidade é declarada | Pendente de consulta às versões oficiais vigentes |
| J-13 | Redução de férias por faltas injustificadas (CLT art. 130) | Faixas implementadas com conferência obrigatória (Fase 2c) | Base legal identificada (22/10/2026); art. 133 manual |
| J-14 | Regras de férias e de plantão previstas na CCT | CCT SC000957/2026 cadastrada; regras da CCT anterior como histórico, sem aplicação | Instrumento identificado; leitura das cláusulas pendente |
| J-12 | Intervalos (CLT arts. 66 e 71) e limite de 2 h extras diárias (art. 59) | O sistema gera **alertas**, sem bloquear o registro | Dependente de validação jurídica |

---

## 10. Plano de desenvolvimento por fases

| Fase | Entregas | Critério objetivo de aprovação |
|---|---|---|
| 1 — Fundação | Arquitetura, migrations, autenticação, MFA, sessões, RBAC, auditoria, design system, usuários | Testes automatizados de autenticação/autorização aprovados; verificação da cadeia de auditoria íntegra; nenhuma rota sem autenticação |
| 2 — Pessoas | Cadastro funcional, jornada, banco de horas, solicitações, assinaturas de espelho/extrato; depois férias e plantões | Bateria de casos de cálculo (tolerância, extras, faltas, feriados, vencimento FIFO) com 100% de aprovação; marcações imutáveis comprovadas por teste |
| 3 — Documental | Repositório, versões, aprovações, assinaturas, busca, Drive | Hash da versão conferido; acesso direto negado sem permissão |
| 4 — Empresarial | Tarefas, projetos, processos, financeiro, calendário, notificações | Segregação de funções no financeiro testada |
| 5 — Qualidade e BI | Auditorias, NC/CAPA, indicadores, automações | Indicadores conferidos contra a massa de teste |
| 6 — Homologação | Três rodadas, restauração, revisão de segurança, treinamento, validação jurídica | Aceite formal da Oficial |

---

## 11. Estratégia das três rodadas de testes

Plano completo em `docs/15-plano-de-testes.md`.

- **Contínuo (desenvolvimento):** Vitest. Testes unitários das regras de domínio e testes de integração contra PostgreSQL real (banco `sgi_test`, recriado a cada execução).
- **Rodada 1 — Funcional:** casos por módulo (válidos, inválidos, limites), executados por `npm run test:round1`.
- **Rodada 2 — Segurança e integração:** acesso indevido entre perfis e setores, IDOR, sessões revogadas, step-up, imutabilidade, concorrência (marcações duplicadas simultâneas), restauração de backup (`scripts/backup-restore-test.sh`), integrações Google com falha simulada.
- **Rodada 3 — Simulação operacional:** gerador determinístico de 6 meses de dados fictícios (`npm run simulate`), com jornadas, extras, faltas, feriados, férias, compensações, admissão e desligamento, e perfis distintos. Inclui conferência de saldos contra totais esperados.
- Cada rodada gera um relatório em `docs/test-reports/`, com data, versão (commit), resultado e falhas encontradas/corrigidas. **Nenhum relatório é escrito sem execução efetiva.**

---

## 12. Estrutura inicial do repositório

```
sgi-orcb/
├── app/                    # Next.js App Router (telas e rotas /api)
│   ├── (auth)/login, mfa   # login e segundo fator
│   ├── (app)/…             # área autenticada (painel, jornada, banco, equipe…)
│   └── api/                # auth/google, v1/*
├── src/
│   ├── domain/             # regras puras (tempo, jornada, banco de horas)
│   ├── server/             # db, auth, authz, audit, crypto, módulos
│   └── ui/                 # design system (componentes)
├── db/
│   ├── migrations/         # SQL versionado (0001_…sql)
│   └── seed/               # dados fictícios de desenvolvimento/homologação
├── scripts/                # migrate, seed, simulate, backup/restore
├── tests/                  # unit/, integration/, simulation/
├── docs/                   # documentação obrigatória + ADRs + relatórios
├── Dockerfile · docker-compose.yml · .env.example
└── package.json
```

---

## Pendências que dependem da serventia

| ID | Pendência | Necessário para |
|---|---|---|
| P-01 | Informar a edição do Google Workspace contratada | Confirmar AppSheet, Chat API e cotas |
| P-02 | Aprovar a Alternativa A (Cloud Run + Cloud SQL) ou a variante VM | Contratação de infraestrutura (projeto GCP com faturamento) |
| P-03 | Criar o projeto no Google Cloud e o cliente OAuth (tipo "Aplicativo da Web", interno) | Login Google real |
| P-04 | Fornecer a convenção coletiva vigente e os modelos de acordo individual de banco de horas | Parametrização jurídica |
| P-05 | Indicar profissional jurídico para validar a seção 9 | Homologação |
| P-06 | Indicar encarregado(a) de dados (LGPD) | Governança |
